import { updateActiveMovementTile } from './active-movement-tile';
import * as THREE from 'three';
import { FirstPersonVisibility } from './first-person-visibility';
import { FollowCameraBob } from './follow-camera-bob';
import { qaGlobals } from '../qa-globals.ts';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ClientTransportMovement, MoveKind, RealmWorldClient } from '../world';
import { PLAYER_COLLISION_CYLINDER, clampSegmentToHeightfield, type WorldCollision } from '../world-collision';
import { TILE_HALF, shouldAllowWmoBelowTerrain, tileForCharacter, type TileEntry } from '../tile-utils';
import type { PlayerAnimState } from '../model-loader';
import type { LoadedTile } from '../wow-app-types';
import { movementRestrictions } from './movement-restrictions';
import { FollowCameraZoom } from './camera-zoom';
import {
  CAMERA_COLLISION_SKIN,
  CAMERA_FIRST_PERSON_DISTANCE,
  CAMERA_PIVOT_FALLBACK_HEIGHT,
  advanceSmartPivot,
} from './camera-options';
import { travelAngleFor } from './remote-extrapolation';
import { getInterfaceCvars } from '../ui/interface-runtime';
import type { InterfaceCvars } from '../ui/interface-cvars';
import type { SplineInfo } from '../world-entities';
import { groundLocomotionState, UnitFollowController } from './locomotion-input';
import { autoFollowCameraYaw } from './camera-follow';
import { applyMouseSteeringBasis, CAMERA_STEER_RIGHT, installCameraMouseButtons } from './mouse-look-input';
import { fallTerminalVelocity, swimHorizontalScale } from './movement-physics';
import {
  buildServerSplinePath,
  sampleServerSpline,
  type ServerSplinePath,
  type ServerSplineSample,
} from './server-spline';
// Vanilla baseline speeds (yd/s). The server is authoritative: SMSG_FORCE_*_SPEED_CHANGE
// (mounts, speed buffs, dazes) overrides these at runtime via setServerSpeed().
const WALK_SPEED = 2.5;
const RUN_SPEED = 7.0;
const RUN_BACK_SPEED = 4.5;
const SWIM_SPEED = 4.7222;
const SWIM_BACK_SPEED = 2.5;
export type ServerSpeedKind = 'walk' | 'run' | 'runBack' | 'swim' | 'swimBack' | 'turnRate';
const SWIM_VERT_SPEED = 3.0;
const SWIM_ENTER_DEPTH = 1.5;
const SWIM_FLOAT_OFFSET = 1.1;
// Turning on the spot runs at the full MOVE_TURN_RATE (vmangos Unit.cpp:73 baseMoveSpeed, and
// Unit.cpp:3195 integrates the bare rate for a stationary turner). Turning WHILE MOVING runs at
// three quarters of it — vmangos Unit.cpp:3172 `0.75f * GetSpeed(MOVE_TURN_RATE)`, and eight turn
// segments in the recorded 1.12 client stream (BattleBotWaypoints.cpp:264-304) measure
// 2.35619 rad/s against 3*pi/4 = 2.35619. Observers reconstruct our arc from this rate, so the two
// have to agree; see remote-extrapolation.ts.
const TURN_RATE = Math.PI;
const JUMP_VELOCITY = 7.95797334;
const GRAVITY = 19.29110527;
const MOVEMENT_HEARTBEAT_MS = 500;
const FACING_UPDATE_THRESHOLD = 0.1;
const FACING_WHILE_MOVING_MIN_MS = 100;
const AIRBORNE_HEARTBEAT_AFTER_MS = 500;
const MF_FORWARD = 0x00000001;
const MF_BACKWARD = 0x00000002;
const MF_STRAFE_LEFT = 0x00000004;
const MF_STRAFE_RIGHT = 0x00000008;
const MF_TURN_LEFT = 0x00000010;
const MF_TURN_RIGHT = 0x00000020;
const MF_WALK_MODE = 0x00000100;
const MF_JUMPING = 0x00002000;
// Vanilla names this MOVEFLAG_FALLINGFAR. vMaNGOS Player::HandleFall requires
// the pre-landing MovementInfo to carry it before fall damage is evaluated.
const MF_FALLING_FAR = 0x00004000;
const MF_SWIMMING = 0x00200000;
const MF_ONTRANSPORT = 0x02000000; const MF_SAFE_FALL = 0x20000000;
const MF_XY = MF_FORWARD | MF_BACKWARD | MF_STRAFE_LEFT | MF_STRAFE_RIGHT;
const MF_TURN = MF_TURN_LEFT | MF_TURN_RIGHT;
const MF_ROOT = 0x00001000;

export type MovementDebugState = {
  x: number;
  y: number;
  z: number;
  grounded: boolean;
  moving: boolean;
  collision: {
    blocked: boolean;
    lastBlock: unknown;
    groundSource: 'terrain' | 'wmo';
    queryMs: number;
    shape: 'cylinder';
    resolution: string;
    controller: typeof PLAYER_COLLISION_CYLINDER;
  } & Record<string, unknown>;
};

export class PlayerMovementController {
  private xrInput = false;
  setXrInput(active: boolean, keys: readonly string[]) {
    if (active !== this.xrInput) this.clearInput();
    this.xrInput = active;
    if (active) {
      this.keys.clear();
      if (!this.deps.isInputBlocked(null)) for (const key of keys) this.keys.add(key);
      this.firstPersonVisibility.update(this.deps.playerRoot, false);
    }
  }
  snapXrTurn(delta: number) {
    if (!this.xrInput || !delta || this.deps.isInputBlocked(null)
      || movementRestrictions(this.inputLocked || !this.clientControlAllowed, this.serverRooted, this.stunned).turningLocked) return;
    this.serverOrientation = this.normalizeYaw(this.serverOrientation + delta);
    this.movementRoot.rotation.z = this.serverOrientation;
  }
  private readonly horizontalResult = { delta: new THREE.Vector3(), blocked: false };
  private readonly stepResult = { delta: new THREE.Vector3(), blocked: false };
  readonly keys = new Set<string>();
  charPos: THREE.Vector3;
  private movementRoot: THREE.Object3D;
  private controlledMoverGuid?: string;

  private readonly fwd = new THREE.Vector3();
  private readonly swimForward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly move = new THREE.Vector3();
  private readonly camDelta = new THREE.Vector3();
  private readonly tgt = new THREE.Vector3();
  private readonly stepProbe = new THREE.Vector3();
  private readonly zAxis = new THREE.Vector3(0, 0, 1);
  /** User-requested orbit radius, kept separate from the collision-shortened camera position. */
  private readonly cameraZoom = new FollowCameraZoom();

  // Live speeds; server force-speed packets (mounts/buffs) overwrite these.
  private readonly serverSpeeds: Record<ServerSpeedKind, number> = {
    walk: WALK_SPEED,
    run: RUN_SPEED,
    runBack: RUN_BACK_SPEED,
    swim: SWIM_SPEED,
    swimBack: SWIM_BACK_SPEED,
    turnRate: TURN_RATE,
  };

  /** Apply a server-authoritative speed (SMSG_FORCE_*_SPEED_CHANGE — mounts, buffs, dazes). */
  setServerSpeed(kind: ServerSpeedKind, speed: number): void {
    if (Number.isFinite(speed) && speed > 0.01 && speed < 100) this.serverSpeeds[kind] = speed;
  }

  private serverOrientation = 0;
  private lastHeartbeatAt = 0;
  private lastHeartbeatX = Number.NaN;
  private lastHeartbeatY = Number.NaN;
  private lastHeartbeatZ = Number.NaN;
  private playerMoving = false;
  private playerAnimState: PlayerAnimState = 'stand'; private readonly follow = new UnitFollowController();
  private charVelZ = 0;
  private grounded = true;
  private readonly cameraBob = new FollowCameraBob(); private readonly cameraMouseButtons: () => number;
  /** Orbit pivot height above charPos, replaced with the model-derived figure once one loads. */
  private cameraPivotHeight = CAMERA_PIVOT_FALLBACK_HEIGHT;
  /** True only while applyFirstPersonHide() is the reason the player model is invisible. */
  private readonly firstPersonVisibility = new FirstPersonVisibility();
  /** Smart Pivot's banked lift (client field 0x104), applied to the orbit pivot height. */
  private smartPivotLift = 0;
  /** Previous frame's orbit angles, so the drag can be measured without hooking OrbitControls. */
  private lastOrbit?: { elevation: number; azimuth: number };
  private swimming = false;
  private swimPitch = 0;
  private airborneMs = 0;
  private landingMs = 0;
  private collisionBlocked = false;
  private collisionQueryMs = 0;
  private groundSource: 'terrain' | 'wmo' = 'terrain';
  private groundTerrainType = 0;
  private lastCollisionLogAt = 0;
  private lastSentO = 0;
  private lastFacingSentAt = 0;
  /** Horizontal velocity locked in at takeoff; the exact pair we put on the wire as the jump block. */
  private airLock?: { angle: number; speed: number };
  /** Server-authored knockback arc waiting to be advertised on the next movement packet. */
  private pendingKnockback?: { velocity: number; cosAngle: number; sinAngle: number; xySpeed: number };
  private lastServerMoveFlags = 0;
  private activeTransport?: ClientTransportMovement;
  // True while the local player is a dead body awaiting spirit release. vMaNGOS roots the
  // corpse (Unit::SetDeathState(JUST_DIED) -> SetRooted(true)); a ghost is un-rooted in
  // BuildPlayerRepop. We mirror that here so a corpse cannot be walked around client-side.
  private inputLocked = false;
  private clientControlAllowed = true;
  // SMSG_FORCE_MOVE_ROOT blocks translation and jumping but still permits facing changes.
  private serverRooted = false;
  // UNIT_FLAG_STUNNED adds the Vanilla turn restriction on top of the server root.
  private stunned = false; private featherFalling = false;
  // Taxi is the one Vanilla player movement mode owned by SMSG_MONSTER_MOVE. Keeping it explicit
  // avoids re-enabling player splines globally (which makes ordinary remote players slide).
  private taxiFlightActive = false;
  private taxiSpline?: SplineInfo;
  private taxiPath?: ServerSplinePath;
  private acknowledgedTaxiSplineId?: number;

  constructor(private readonly deps: {
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    marker: THREE.Object3D;
    playerRoot: THREE.Object3D;
    worldCollision: WorldCollision;
    tileIndex: TileEntry[];
    loadedTiles: Map<string, LoadedTile>;
    loadingTiles: Map<string, Promise<LoadedTile>>;
    charPos: THREE.Vector3;
    getWorld: () => RealmWorldClient | undefined;
    getCurrentMap: () => number;
    getCurrentTile: () => LoadedTile | null;
    setCurrentTile: (tile: LoadedTile) => void;
    isInputBlocked: (eventTarget: EventTarget | null) => boolean;
    /**
     * True while something else is driving the camera outright — currently the cinematic
     * flythrough. `updateCameraFollow` re-seats the camera on the player EVERY frame, so without
     * this the flythrough is overwritten the instant it is written and the camera appears pinned
     * behind the character no matter where the path goes.
     */
    isCameraExternallyOwned?: () => boolean;
    sampleHeight: (rx: number, ry: number) => number; sampleLoadedHeight: (rx: number, ry: number) => number | null;
    sampleTerrainType: (rx: number, ry: number) => number;
    sampleWaterLevel: (rx: number, ry: number) => number;
    localToWorld: (rx: number, ry: number) => { x: number; y: number } | null;
    worldToLocal: (wx: number, wy: number) => { x: number; y: number };
    getTransportFrame: () => ({ guid: string; x: number; y: number; z: number; o: number; localX: number; localY: number; localZ: number; localO: number } | undefined);
    ensureTileNeighborhood: (entry: TileEntry) => Promise<LoadedTile>;
    updateInteriorLighting: () => void;
    applyLighting: (map: number, worldX?: number, worldY?: number, worldZ?: number, force?: boolean) => void;
    updateAreaTriggers: (worldX: number, worldY: number, worldZ: number) => void;
    log: (message: string) => void;
    collisionLogEnabled: () => boolean;
  }) {
    this.charPos = deps.charPos;
    this.movementRoot = deps.playerRoot;
    window.addEventListener('keydown', (event) => {
      if (this.xrInput || deps.isInputBlocked(event.target)) return;
      this.keys.add(event.code);
      deps.controls.autoRotate = false;
      if (event.code === 'Space' || event.code.startsWith('Arrow')) event.preventDefault();
    });
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
    this.cameraMouseButtons = installCameraMouseButtons(deps.controls.domElement);
  }
  /**
   * Set the orbit pivot height from the loaded character model (see `cameraPivotHeight`).
   * Ignores nonsense so a half-built model cannot drop the camera into the floor.
   */
  setCameraPivotHeight(height: number): void {
    if (Number.isFinite(height) && height > 0.2 && height < 10) this.cameraPivotHeight = height;
  }

  /** Yards above charPos the camera orbits — also what the spawn/teleport seeds should aim at. */
  getCameraPivotHeight(): number {
    return this.cameraPivotHeight;
  }

  getServerOrientation() {
    return this.serverOrientation;
  }

  getPlayerMoving() {
    return this.playerMoving;
  }

  /** Lock/unlock local movement input. Used to root the player while dead (pre-release). */
  setInputLocked(locked: boolean) {
    if (locked && !this.inputLocked) {
      // Drop any held keys so the body stops immediately and no residual MSG_MOVE flags leak out.
      this.keys.clear();
      this.move.set(0, 0, 0);
      this.playerMoving = false;
    }
    this.inputLocked = locked;
  }

  /** Apply SMSG_CLIENT_CONTROL_UPDATE without conflating it with death/UI input locks. */
  setClientControlAllowed(allowed: boolean) {
    if (!allowed && this.clientControlAllowed) this.clearInput();
    this.clientControlAllowed = allowed;
  }

  /**
   * Switch the local simulation/camera subject while preserving the logged-in character identity.
   * Passing no frame restores the player's permanent root and position vector.
   */
  setControlledMover(
    guid: string | undefined,
    frame?: { position: THREE.Vector3; root: THREE.Object3D },
  ) {
    this.clearInput();
    this.controlledMoverGuid = guid;
    this.charPos = frame?.position ?? this.deps.charPos;
    this.movementRoot = frame?.root ?? this.deps.playerRoot;
    this.serverOrientation = this.movementRoot.rotation.z;
    this.lastHeartbeatAt = 0;
    this.lastHeartbeatX = Number.NaN;
    this.lastHeartbeatY = Number.NaN;
    this.lastHeartbeatZ = Number.NaN;
    this.lastSentO = this.serverOrientation;
    this.lastFacingSentAt = 0;
    this.activeTransport = undefined;
    this.pendingKnockback = undefined;
    this.airLock = undefined;
  }

  getControlledMoverGuid() {
    return this.controlledMoverGuid;
  }

  setServerRooted(rooted: boolean) {
    this.serverRooted = rooted;
    if (rooted) {
      this.move.set(0, 0, 0);
      this.playerMoving = false;
    }
  }

  setStunned(stunned: boolean) {
    this.stunned = stunned;
    if (stunned) {
      this.move.set(0, 0, 0);
      this.playerMoving = false;
    }
  }

  setFeatherFalling(active: boolean) { this.featherFalling = active; }
  /** Follow the local player's server-owned taxi spline and suppress ordinary ground input. */
  setTaxiFlight(active: boolean, spline?: SplineInfo) {
    const wasActive = this.taxiFlightActive;
    if (active && !wasActive) {
      this.clearInput();
      this.charVelZ = 0;
      this.airLock = undefined;
      this.pendingKnockback = undefined;
      this.swimming = false;
      this.grounded = false;
    }

    // SMSG_MONSTER_MOVE can be chunked while retaining its spline id. Object identity changes on
    // every received chunk, so replacing this path also cancels completion of the older chunk.
    if ((active || wasActive) && spline && spline !== this.taxiSpline) {
      this.taxiSpline = spline;
      this.taxiPath = buildServerSplinePath(spline);
      if (!spline.fullTime) {
        // MonsterMoveStop is still a player-owned spline and vMaNGOS explicitly expects a DONE ack.
        const stopped = this.splineStartSample(spline);
        if (stopped) {
          this.applyTaxiSample(stopped);
          this.acknowledgeTaxiSpline(spline, stopped);
        }
      }
    }

    this.taxiFlightActive = active;
    if (active) return;
    if (!wasActive) return;

    if (wasActive && this.taxiSpline && this.acknowledgedTaxiSplineId !== this.taxiSpline.id) {
      // The server can publish UNIT_FLAG_TAXI_FLIGHT=false on its simulation tick before our next
      // animation frame reaches 100%. That transition proves it reached the destination: finish the
      // local sample and acknowledge the pending id instead of leaving all later movement blocked.
      const final = this.taxiPath
        ? sampleServerSpline(this.taxiPath, (this.taxiSpline.startedAt ?? performance.now()) + this.taxiSpline.fullTime)
        : this.splineStartSample(this.taxiSpline);
      if (final) {
        this.applyTaxiSample(final);
        this.acknowledgeTaxiSpline(this.taxiSpline, final);
      }
    }
    this.keys.clear();
    this.taxiSpline = undefined;
    this.taxiPath = undefined;
    this.playerMoving = false;
    this.playerAnimState = 'stand';
  }

  /**
   * Server-authored knockback (SMSG_MOVE_KNOCK_BACK).
   *
   * A vanilla knockback is literally a jump the server authored: it ships the same four floats the
   * jump block carries — (cosAngle, sinAngle) horizontal direction, xy speed, z speed — and the
   * client flies the resulting arc under normal gravity. Reusing `airLock` is therefore not an
   * approximation but the same mechanism: it is the pair vmangos re-derives the whole airborne path
   * from (Unit.cpp:3156-3165), and it is what we already put on the wire in every airborne
   * MovementInfo, so what observers see matches what the server simulated.
   *
   * A root or stun holds a unit in place in 1.12, and the server does not knock back a rooted
   * target, so an active root is respected here rather than fighting it mid-air.
   */
  applyKnockback(cosAngle: number, sinAngle: number, speedXY: number, speedZ: number) {
    if (this.serverRooted || this.inputLocked || !this.clientControlAllowed) return;
    this.airLock = { angle: Math.atan2(sinAngle, cosAngle), speed: Math.max(0, speedXY) };
    // Vanilla's wire convention is inverted relative to our Z-up integrator. vMaNGOS
    // Unit::KnockBack sends `-verticalSpeed` in SMSG_MOVE_KNOCK_BACK, while retaining the positive
    // value in SetJumpInitialSpeed for its own `z -= computeFallElevation(..., -initialSpeed)`
    // reconstruction (Unit.cpp:10205-10209 and 3154-3165). Echo the raw negative value in the ack,
    // but negate it for local upward velocity or every knockback launches the player into the floor.
    this.charVelZ = -speedZ;
    this.grounded = false;
    this.airborneMs = 0;
    this.landingMs = 0;
    // Advertise the server's own arc rather than letting resolveJumpInfo() invent a default jump
    // from the facing — observers reconstruct the flight from exactly these four floats.
    this.pendingKnockback = { velocity: speedZ, cosAngle, sinAngle, xySpeed: Math.max(0, speedXY) };
  }

  clearInput() {
    const wasMoving = this.keys.size > 0 || this.playerMoving || this.lastServerMoveFlags !== 0;
    this.keys.clear();
    this.move.set(0, 0, 0);

    this.playerMoving = false;
    this.follow.cancel();
    this.lastServerMoveFlags = 0;
    if (this.grounded) this.playerAnimState = 'stand';
    return wasMoving;
  }

  getPlayerAnimState() {
    return this.playerAnimState;
  }

  isGrounded() {
    return this.grounded;
  }

  isSwimming() {
    return this.swimming;
  }

  getSwimPitch() {
    return this.swimPitch;
  }

  getGroundSource() {
    return this.groundSource;
  }

  getGroundTerrainType() {
    return this.groundTerrainType;
  }

  normalizeYaw(angle: number) {
    angle %= Math.PI * 2;
    return angle < 0 ? angle + Math.PI * 2 : angle;
  }

  resetForSpawn(orientation = 0) {
    this.serverOrientation = orientation;
    this.playerAnimState = 'stand';
    this.charVelZ = 0;
    this.grounded = true;
    this.swimming = false;
    this.swimPitch = 0;
    this.airborneMs = 0;
    this.landingMs = 0;
    this.collisionBlocked = false;
    this.collisionQueryMs = 0;
    this.groundTerrainType = 0;
    this.lastHeartbeatAt = 0;
    this.lastHeartbeatX = Number.NaN;
    this.lastHeartbeatY = Number.NaN;
    this.lastHeartbeatZ = Number.NaN;
    this.lastServerMoveFlags = 0; this.follow.cancel();
    this.lastSentO = 0;
    this.lastFacingSentAt = 0;
    this.activeTransport = undefined;
    this.serverRooted = false;
    this.stunned = false;
    this.taxiFlightActive = false;
    this.taxiSpline = undefined;
    this.taxiPath = undefined;
    this.acknowledgedTaxiSplineId = undefined;
    this.cameraZoom.reset();
  }

  
  zoomCameraSteps(steps: number) {
    this.cameraZoom.notch(steps, this.deps.controls.minDistance, this.deps.controls.maxDistance);
  }

  /** The orbit radius the wheel is currently gliding toward, for QA/verification. */
  getCameraZoomState() {
    return this.cameraZoom.state();
  }

  /**
   * Restore the user's orbit radius before OrbitControls consumes orbit input.
   * `updateCameraFollow` collision-shortens the rendered position later in the same frame.
   *
   * This is also where wheel zoom lands. OrbitControls cannot own it: three.js r176 applies a
   * wheel dolly inside its own event handler (`_handleMouseWheel` calls `update()` and resets
   * `_scale` to 1 at OrbitControls.js:1078/806), so by the next animation frame the dolly is
   * already baked into `camera.position` and nothing is left for our `controls.update()` to
   * consume — the unconditional restore below then threw it away. Owning the radius here keeps
   * one writer and lets a notch mean a yard even while the camera is clamped against a wall.
   */
  prepareCameraControls(dt = 0) {
    if (this.xrInput) return;
    if (qaGlobals.__wowFreeCamEnabled) {
      // Free-cam hands the radius back to OrbitControls; re-seed from the flown-to distance
      // on the next normal frame instead of snapping back to the pre-freecam zoom.
      this.cameraZoom.releaseTarget();
      return;
    }
    const radius = this.cameraZoom.advance(dt, this.deps.controls.minDistance, this.deps.controls.maxDistance);
    if (radius === undefined) return;
    this.camDelta.subVectors(this.deps.camera.position, this.deps.controls.target);
    if (this.camDelta.lengthSq() < 1e-8) return;
    this.deps.camera.position.copy(this.deps.controls.target).add(this.camDelta.setLength(radius));
  }

  updateFly(dt: number) {
    const speed = 120;
    this.move.set(0, 0, 0);
    this.updateCameraBasis();
    if (this.keys.has('KeyW')) this.move.add(this.fwd);
    if (this.keys.has('KeyS')) this.move.addScaledVector(this.fwd, -1);
    if (this.keys.has('KeyD')) this.move.add(this.right);
    if (this.keys.has('KeyA')) this.move.addScaledVector(this.right, -1);
    if (this.keys.has('Space')) this.move.z += 1;
    if (this.keys.has('KeyC') || this.keys.has('ControlLeft')) this.move.z -= 1;
    if (this.move.lengthSq() > 0) {
      this.move.normalize().multiplyScalar(speed * dt);
      this.deps.camera.position.add(this.move);
      this.deps.controls.target.add(this.move);
    }
  }

  updateWalk(dt: number) {
    if (this.taxiFlightActive) {
      this.updateTaxiFlight(dt);
      return;
    }
    this.applyTransportFrame();
    const collisionStartedAt = performance.now();
    this.collisionBlocked = false;
    let headingAngle = this.xrInput ? this.updateCameraBasis() : applyMouseSteeringBasis(this.updateCameraBasis(), this.serverOrientation, (this.cameraMouseButtons() & CAMERA_STEER_RIGHT) !== 0, this.fwd, this.right, this.deps.camera.up);
    this.move.set(0, 0, 0);
    if (this.deps.sampleLoadedHeight(this.charPos.x, this.charPos.y) === null) {
      // Streaming absence is not a ledge. Preserve support and airborne state until
      // exact terrain/collision ownership returns, while keeping camera/network alive.
      this.playerMoving = false; this.collisionBlocked = true;
      this.updateActiveTile(); this.updateCameraFollow(dt, headingAngle);
      if (!this.inputLocked && this.clientControlAllowed) this.sendHeartbeat();
      return;
    }
    // While a rooted corpse, ignore all locomotion/turn keys but keep gravity + ground settle
    // below so the body still falls/rests where it died. Camera orbit (mouse) stays free.
    const { translationLocked, turningLocked, jumpingLocked } = movementRestrictions(
      this.inputLocked || !this.clientControlAllowed,
      this.serverRooted,
      this.stunned,
    );
    const fwdKey = !translationLocked && this.keys.has('KeyW');
    const backKey = !translationLocked && this.keys.has('KeyS');
    const strafeLeftKey = !translationLocked && this.keys.has('KeyQ') && !this.keys.has('KeyE');
    const strafeRightKey = !translationLocked && this.keys.has('KeyE') && !this.keys.has('KeyQ');
    const turnLeftKey = !turningLocked && this.keys.has('KeyA') && !this.keys.has('KeyD');
    const turnRightKey = !turningLocked && this.keys.has('KeyD') && !this.keys.has('KeyA');
    const turnInput = (turnLeftKey ? 1 : 0) - (turnRightKey ? 1 : 0);
    const translating = fwdKey || backKey || strafeLeftKey || strafeRightKey;
    const turnDelta = turnInput
      * (translating ? this.serverSpeeds.turnRate * 0.75 : this.serverSpeeds.turnRate)
      * dt;
    if (turnDelta) {
      this.rotateCameraAroundTarget(turnDelta);
      headingAngle = applyMouseSteeringBasis(this.updateCameraBasis(), this.normalizeYaw(headingAngle + turnDelta), (this.cameraMouseButtons() & CAMERA_STEER_RIGHT) !== 0, this.fwd, this.right, this.deps.camera.up);
    }

    if (fwdKey) this.move.add(this.fwd);
    if (backKey) this.move.addScaledVector(this.fwd, -1);
    if (strafeLeftKey) this.move.addScaledVector(this.right, -1);
    if (strafeRightKey) this.move.add(this.right);
    const followAngle = this.follow.travelAngle(this.charPos, translationLocked, translating, (guid) => { const target = this.deps.getWorld()?.getEntity(guid); return target?.x === undefined || target.y === undefined ? undefined : this.deps.worldToLocal(target.x, target.y); });
    if (followAngle !== undefined) { headingAngle = this.normalizeYaw(followAngle); this.move.set(Math.cos(headingAngle), Math.sin(headingAngle), 0); }
    this.playerMoving = this.move.lengthSq() > 0;

    const walkMode = this.keys.has('Slash');
    let speed = this.swimming
      ? (backKey && !fwdKey ? this.serverSpeeds.swimBack : this.serverSpeeds.swim)
      : backKey && !fwdKey ? this.serverSpeeds.runBack : walkMode ? this.serverSpeeds.walk : this.serverSpeeds.run;

    // A jump locks horizontal velocity for its whole flight. MSG_MOVE_JUMP carries exactly ONE
    // (cosAngle, sinAngle, xyspeed), vmangos re-derives the entire airborne path from just those
    // three floats (Unit.cpp:3156-3165), and MovementAnticheat.cpp:1292-1308 then measures the
    // reported position against that path and feeds the shortfall to its speed-hack counter. Air
    // steering is therefore not merely unrepresentable on the wire, it is a cheat signal — and
    // observers, rendering the locked vector we sent them, watched us curve away and snap back on
    // landing. Swimming is genuinely free-steering and keeps live input.
    const airLock = !this.grounded && !this.swimming ? this.airLock : undefined;
    if (airLock) {
      this.move.set(Math.cos(airLock.angle), Math.sin(airLock.angle), 0);
      this.playerMoving = airLock.speed > 0;
      speed = airLock.speed;
    }
    const preserveSubterraneanWmo = this.playerMoving ? shouldAllowWmoBelowTerrain(this.charPos.z, this.deps.sampleHeight(this.charPos.x, this.charPos.y)) : undefined;
    if (this.playerMoving) {
      this.move.normalize().multiplyScalar(speed * dt * (this.swimming ? swimHorizontalScale(this.swimPitch) : 1));
      const destinationReady = this.deps.sampleLoadedHeight(this.charPos.x + this.move.x, this.charPos.y + this.move.y) !== null;
      if (!destinationReady) { this.move.set(0, 0, 0); this.playerMoving = false; } let resolved = this.deps.worldCollision.resolveHorizontal(this.charPos, this.move, this.horizontalResult);
      if (this.grounded && resolved.blocked) {
        const desiredX = this.charPos.x + this.move.x;
        const desiredY = this.charPos.y + this.move.y;
        const desiredTerrainZ = this.deps.sampleHeight(desiredX, desiredY);
        const desiredGround = this.deps.worldCollision.sampleGround(
          desiredX,
          desiredY,
          this.charPos.z + PLAYER_COLLISION_CYLINDER.maxStepUp,
          desiredTerrainZ,
          { allowWmoBelowTerrain: preserveSubterraneanWmo },
        );
        const stepRise = desiredGround.height - this.charPos.z;
        if (stepRise > PLAYER_COLLISION_CYLINDER.skin && stepRise <= PLAYER_COLLISION_CYLINDER.maxStepUp + PLAYER_COLLISION_CYLINDER.skin) {
          this.stepProbe.copy(this.charPos);
          this.stepProbe.z = desiredGround.height;
          const stepped = this.deps.worldCollision.resolveHorizontal(this.stepProbe, this.move, this.stepResult);
          if (stepped.delta.lengthSq() > resolved.delta.lengthSq() + 1e-6) resolved = stepped;
        }
      }
      let nextX = this.charPos.x + resolved.delta.x;
      let nextY = this.charPos.y + resolved.delta.y;
      const resolvedReady = this.deps.sampleLoadedHeight(nextX, nextY) !== null;
      if (!resolvedReady) { nextX = this.charPos.x; nextY = this.charPos.y; this.playerMoving = false; }
      this.collisionBlocked = resolved.blocked || !destinationReady || !resolvedReady;
      if (this.grounded) {
        const terrainZ = this.deps.sampleHeight(nextX, nextY);
        const nextGround = this.deps.worldCollision.sampleGround(
          nextX,
          nextY,
          this.charPos.z + PLAYER_COLLISION_CYLINDER.maxStepUp,
          terrainZ,
          { allowWmoBelowTerrain: preserveSubterraneanWmo },
        );
        if (nextGround.height > this.charPos.z + PLAYER_COLLISION_CYLINDER.maxStepUp) {
          this.collisionBlocked = true;
        } else {
          this.charPos.x = nextX;
          this.charPos.y = nextY;
        }
      } else {
        // The horizontal cylinder sweep deliberately ignores walkable faces. While airborne, probe
        // the destination from the real 0.75-yard step ceiling: if a rising WMO/terrain surface is
        // still above the player's feet, moving there would put the ground ray underneath it and
        // let the player fall through. Hold X/Y until the jump itself has risen above the surface.
        const terrainZ = this.deps.sampleHeight(nextX, nextY);
        const nextGround = this.deps.worldCollision.sampleGround(
          nextX,
          nextY,
          this.charPos.z + PLAYER_COLLISION_CYLINDER.maxStepUp,
          terrainZ,
          { allowWmoBelowTerrain: preserveSubterraneanWmo },
        );
        if (nextGround.height > this.charPos.z + PLAYER_COLLISION_CYLINDER.skin) {
          this.collisionBlocked = true;
        } else {
          this.charPos.x = nextX;
          this.charPos.y = nextY;
        }
      }
      this.updateActiveTile();
    }

    const terrainZ = this.deps.sampleHeight(this.charPos.x, this.charPos.y);
    const ground = this.deps.worldCollision.sampleGround(
      this.charPos.x,
      this.charPos.y,
      this.charPos.z + (this.grounded ? PLAYER_COLLISION_CYLINDER.maxStepUp : PLAYER_COLLISION_CYLINDER.skin),
      terrainZ,
      { allowWmoBelowTerrain: preserveSubterraneanWmo ?? shouldAllowWmoBelowTerrain(this.charPos.z, terrainZ) },
    );
    const groundZ = ground.height;
    this.groundSource = ground.source;
    this.groundTerrainType = ground.terrainType ?? this.deps.sampleTerrainType(this.charPos.x, this.charPos.y);
    let jumped = false;
    let startedFalling = false;
    let landed = false;
    if (this.grounded) {
      // Do not glue the player to a floor that dropped farther than Vanilla's
      // step height. Walking off a ledge begins a real fall instead of snapping
      // vertically to the lower terrain/WMO surface.
      const ledgeDrop = this.charPos.z - groundZ;
      if (!this.swimming && ledgeDrop > PLAYER_COLLISION_CYLINDER.maxStepUp + PLAYER_COLLISION_CYLINDER.skin) {
        this.grounded = false;
        this.charVelZ = 0;
        this.airborneMs = 0;
        this.landingMs = 0;
        startedFalling = true;
      } else {
        this.charPos.z = groundZ;
        this.airborneMs = 0;
      }
      if (this.grounded && !jumpingLocked && this.keys.has('Space')) {
        this.charVelZ = JUMP_VELOCITY;
        this.grounded = false;
        jumped = true;
        this.landingMs = 0;
      }
    } else if (this.serverRooted || this.stunned) {
      // Vanilla 1.12 interrupts the fall when a root or stun lands mid-air; the character hangs
      // until the effect drops. vMaNGOS treats a client that keeps falling while rooted as a 1.14
      // client -- HandleMoveRootAck logs "Client sent root apply ack, but continues falling. Using
      // 1.14 client?" and only tolerates it through UNIT_STATE_ROOT_ON_LANDING
      // (Handlers/MovementHandler.cpp:715-731), which is compiled in for builds above 1.8.4.
      // Holding Z here is what lets movementFlags() drop JUMPING/FALLINGFAR honestly: the reported
      // flags and the simulated motion have to agree, or the position drifts from the state we
      // advertise. The death lock is deliberately excluded -- a corpse still falls to the ground.
    } else {
      this.airborneMs += dt * 1000;
      this.charVelZ = Math.max(this.charVelZ - GRAVITY * dt, -fallTerminalVelocity(this.featherFalling));
      const verticalDelta = this.charVelZ * dt;
      if (verticalDelta > 0) {
        const allowedRise = this.deps.worldCollision.clampVerticalRise(this.charPos, verticalDelta);
        this.charPos.z += allowedRise;
        if (allowedRise + PLAYER_COLLISION_CYLINDER.skin < verticalDelta) this.charVelZ = 0;
      } else {
        this.charPos.z += verticalDelta;
      }
      if (this.charPos.z <= groundZ) {
        this.charPos.z = groundZ;
        this.charVelZ = 0;
        this.grounded = true;
        // Release the takeoff velocity here rather than in sendMovementPackets, which a rooted
        // corpse or a missing world skips entirely — a stale lock would hijack the next jump.
        this.airLock = undefined;
        landed = true;
        this.landingMs = 450;
      }
    }
    if (!landed && this.landingMs > 0) this.landingMs = Math.max(0, this.landingMs - dt * 1000);

    this.updateSwimming(ground, groundZ, dt);
    this.updateTransportOffset();
    this.updatePlayerPlacementAndAnim(headingAngle, turnInput, fwdKey, backKey, strafeLeftKey, strafeRightKey, turnLeftKey, turnRightKey, walkMode);
    this.updateCameraFollow(dt, headingAngle);
    this.updateLightingAndDebug(collisionStartedAt);
    // A rooted corpse must not emit MSG_MOVE_* — the server rejects movement from the dead and
    // anticheat can flag it. Position still settles above; we simply stop advertising motion.
    if (!this.inputLocked && this.clientControlAllowed) {
      this.sendMovementPackets(headingAngle, jumped, startedFalling, landed, speed);
    }
  }

  private splineStartSample(spline: SplineInfo): ServerSplineSample | undefined {
    if (spline.startX === undefined || spline.startY === undefined || spline.startZ === undefined) return undefined;
    return {
      x: spline.startX,
      y: spline.startY,
      z: spline.startZ,
      o: this.serverOrientation,
      complete: true,
    };
  }

  private applyTaxiSample(sample: ServerSplineSample) {
    const local = this.deps.worldToLocal(sample.x, sample.y);
    this.charPos.set(local.x, local.y, sample.z);
    this.serverOrientation = this.normalizeYaw(sample.o);
    this.movementRoot.position.copy(this.charPos);
    this.movementRoot.rotation.z = this.serverOrientation;
    this.deps.marker.position.set(this.charPos.x, this.charPos.y, this.charPos.z + 3);
  }

  private acknowledgeTaxiSpline(spline: SplineInfo, sample: ServerSplineSample) {
    if (this.acknowledgedTaxiSplineId === spline.id) return;
    const world = this.deps.getWorld();
    if (!world) return;
    world.sendMoveSplineDone({
      x: sample.x,
      y: sample.y,
      z: sample.z,
      o: this.normalizeYaw(sample.o),
      splineId: spline.id,
    });
    this.acknowledgedTaxiSplineId = spline.id;
  }

  private updateTaxiFlight(dt: number) {
    const startedAt = performance.now();
    this.keys.clear();
    this.move.set(0, 0, 0);
    this.collisionBlocked = false;
    const sample = this.taxiPath ? sampleServerSpline(this.taxiPath, startedAt) : undefined;
    if (sample && this.taxiSpline) {
      this.applyTaxiSample(sample);
      this.playerMoving = !sample.complete;
      this.playerAnimState = sample.complete ? 'stand' : 'run';
      if (sample.complete) this.acknowledgeTaxiSpline(this.taxiSpline, sample);
      this.updateActiveTile();
    } else {
      this.playerMoving = false;
      this.playerAnimState = 'stand';
    }
    this.updateCameraFollow(dt);
    this.updateLightingAndDebug(startedAt);
  }

  /**
   * Should this frame emit MSG_MOVE_SET_FACING?
   *
   * Standing still, any yaw change past the threshold goes out immediately — that path is unchanged.
   * While moving we also report, because otherwise a mouse turn is invisible to observers for a full
   * heartbeat, but we rate-limit it: A/D turning already tells them everything (they integrate the
   * turn rate from the flags), and an unthrottled mouse drag would emit a packet every frame.
   *
   * FACING_WHILE_MOVING_MIN_MS is a chosen bound, not a measured vanilla cadence: it caps the yaw
   * an observer can be wrong by at one tick's worth of turning rather than 500 ms of it.
   */
  private shouldSendFacing(yawDelta: number, flags: number) {
    if (yawDelta <= FACING_UPDATE_THRESHOLD) return false;
    if (!this.playerMoving) return true;
    if ((flags & MF_TURN) !== 0) return false;
    return performance.now() - this.lastFacingSentAt >= FACING_WHILE_MOVING_MIN_MS;
  }

  sendHeartbeat(force = false) {
    const activeWorld = this.deps.getWorld();
    if (!activeWorld || !this.deps.getCurrentTile()) return;
    const world = this.deps.localToWorld(this.charPos.x, this.charPos.y);
    if (!world) return;
    const now = performance.now();
    const moved =
      Number.isNaN(this.lastHeartbeatX) ||
      Math.hypot(world.x - this.lastHeartbeatX, world.y - this.lastHeartbeatY, this.charPos.z - this.lastHeartbeatZ) > 0.75;
    if (!force && (!moved || now - this.lastHeartbeatAt < MOVEMENT_HEARTBEAT_MS)) return;
    if (!this.follow.followingForward && (this.cameraMouseButtons() & CAMERA_STEER_RIGHT) !== 0) this.serverOrientation = this.updateCameraBasis();
    activeWorld.sendHeartbeat(
      world.x,
      world.y,
      this.charPos.z,
      this.serverOrientation,
      this.movementFlags(),
      { swimPitch: this.swimming ? this.swimPitch : undefined, transport: this.activeTransport },
    );
    this.lastHeartbeatAt = now;
    this.lastHeartbeatX = world.x;
    this.lastHeartbeatY = world.y;
    this.lastHeartbeatZ = this.charPos.z;
  }

  private updateCameraBasis() {
    if (this.xrInput) {
      this.fwd.set(Math.cos(this.serverOrientation), Math.sin(this.serverOrientation), 0);
      this.right.crossVectors(this.fwd, this.deps.camera.up).normalize(); this.swimForward.copy(this.fwd); this.swimPitch = 0;
      return this.serverOrientation;
    }
    this.deps.camera.getWorldDirection(this.fwd);
    this.swimForward.copy(this.fwd).normalize();
    this.swimPitch = this.swimming
      ? Math.asin(Math.max(-1, Math.min(1, this.swimForward.z)))
      : 0;
    this.fwd.z = 0;
    if (this.fwd.lengthSq() < 1e-8) this.fwd.set(Math.cos(this.serverOrientation), Math.sin(this.serverOrientation), 0);
    else this.fwd.normalize();
    this.right.crossVectors(this.fwd, this.deps.camera.up).normalize();
    return this.normalizeYaw(Math.atan2(this.fwd.y, this.fwd.x));
  }

  private movementFlags() {
    let flags = 0;
    // Key-derived flags must mirror `updateWalk()` exactly, or the client reports locomotion it
    // never simulated. Two ways that used to diverge:
    //   - `inputLocked` (rooted corpse) suppresses movement locally but was still transmitted;
    //   - opposing keys cancel locally, but both bits were sent (STRAFE_LEFT|STRAFE_RIGHT).
    // Physics-derived bits below (swim/fall/transport) stay unconditional: they hold while rooted.
    const { translationLocked, turningLocked } = movementRestrictions(
      this.inputLocked || !this.clientControlAllowed,
      this.serverRooted,
      this.stunned,
    );
    if (!translationLocked) {
      if (this.keys.has('KeyW')) flags |= MF_FORWARD;
      if (this.keys.has('KeyS')) flags |= MF_BACKWARD;
      if (this.keys.has('KeyQ') && !this.keys.has('KeyE')) flags |= MF_STRAFE_LEFT;
      if (this.keys.has('KeyE') && !this.keys.has('KeyQ')) flags |= MF_STRAFE_RIGHT;
      if (this.follow.followingForward) flags |= MF_FORWARD;
    }
    if (!turningLocked) {
      if (this.keys.has('KeyA') && !this.keys.has('KeyD')) flags |= MF_TURN_LEFT;
      if (this.keys.has('KeyD') && !this.keys.has('KeyA')) flags |= MF_TURN_RIGHT;
    }
    if (!this.inputLocked && this.clientControlAllowed) {
      if (this.keys.has('Slash')) flags |= MF_WALK_MODE;
    }
    const rooted = this.serverRooted || this.stunned || this.inputLocked || !this.clientControlAllowed;
    if (rooted) flags |= MF_ROOT;
    if (this.swimming) flags |= MF_SWIMMING;
    else if (!this.grounded && !rooted) {
      // FALLING_FAR is additive to JUMPING in the 1.12 movement mask. Keeping
      // JUMPING set preserves the required four-float jump/fall block and the
      // monotonically increasing fallTime on airborne heartbeats.
      //
      // Both bits are suppressed while rooted. JUMPING and FALLINGFAR are members of
      // MOVEFLAG_MASK_MOVING, which Objects/MovementInfo.h:64 annotates "Can not be present with
      // MOVEFLAG_ROOT (otherwise client freeze)". Sending the pair costs us twice on a vMaNGOS
      // realm: MovementAnticheat::HandleFlagTests raises CHEAT_TYPE_ROOT_MOVE and strips the
      // moving bits, and Objects/Object.cpp:165 treats it as a spoofing attempt when relaying to
      // observers because "It will freeze clients that receive this player's movement info."
      flags |= MF_JUMPING;
      if (this.charVelZ <= 0) flags |= MF_FALLING_FAR;
    }
    if (this.activeTransport) flags |= MF_ONTRANSPORT; if (this.featherFalling) flags |= MF_SAFE_FALL;
    return flags;
  }

  private applyTransportFrame() {
    const frame = this.deps.getTransportFrame();
    if (!frame) {
      this.activeTransport = undefined;
      return;
    }
    if (!this.activeTransport || this.activeTransport.guid !== frame.guid) {
      this.activeTransport = {
        guid: frame.guid,
        x: frame.localX,
        y: frame.localY,
        z: frame.localZ,
        o: frame.localO,
      };
    }
    const c = Math.cos(frame.o);
    const s = Math.sin(frame.o);
    const worldX = frame.x + c * this.activeTransport.x - s * this.activeTransport.y;
    const worldY = frame.y + s * this.activeTransport.x + c * this.activeTransport.y;
    const render = this.deps.worldToLocal(worldX, worldY);
    const nextZ = frame.z + this.activeTransport.z;
    const dx = render.x - this.charPos.x;
    const dy = render.y - this.charPos.y;
    const dz = nextZ - this.charPos.z;
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1e-7) {
      this.charPos.set(render.x, render.y, nextZ);
      this.deps.camera.position.add(new THREE.Vector3(dx, dy, dz));
      this.deps.controls.target.add(new THREE.Vector3(dx, dy, dz));
    }
  }

  private updateTransportOffset() {
    const frame = this.deps.getTransportFrame();
    if (!frame || !this.activeTransport || this.activeTransport.guid !== frame.guid) return;
    const world = this.deps.localToWorld(this.charPos.x, this.charPos.y);
    if (!world) return;
    const dx = world.x - frame.x;
    const dy = world.y - frame.y;
    const c = Math.cos(frame.o);
    const s = Math.sin(frame.o);
    this.activeTransport.x = c * dx + s * dy;
    this.activeTransport.y = -s * dx + c * dy;
    this.activeTransport.z = this.charPos.z - frame.z;
    this.activeTransport.o = this.normalizeYaw(this.serverOrientation - frame.o);
  }

  private sendFlagTransitions(finalFlags: number, base: { x: number; y: number; z: number; o: number; flags: number }) {
    const world = this.deps.getWorld();
    if (!world) return false;
    let sent = false;
    let state = this.lastServerMoveFlags;
    const send = (kind: MoveKind, flags: number) => {
      world.sendMove(kind, { ...base, flags });
      sent = true;
    };
    const startStop = (bit: number, startKind: MoveKind, stopKind: MoveKind) => {
      const wants = (finalFlags & bit) !== 0;
      const had = (state & bit) !== 0;
      if (wants === had) return;
      if (wants) {
        state |= bit;
        send(startKind, state);
      } else {
        state &= ~bit;
        send(stopKind, state);
      }
    };
    startStop(MF_FORWARD, 'start_forward', 'stop');
    startStop(MF_BACKWARD, 'start_backward', 'stop');
    startStop(MF_STRAFE_LEFT, 'start_strafe_left', 'stop_strafe');
    startStop(MF_STRAFE_RIGHT, 'start_strafe_right', 'stop_strafe');
    startStop(MF_TURN_LEFT, 'start_turn_left', 'stop_turn');
    startStop(MF_TURN_RIGHT, 'start_turn_right', 'stop_turn');
    this.lastServerMoveFlags = finalFlags;
    return sent;
  }

  private rotateCameraAroundTarget(deltaYaw: number) {
    if (!deltaYaw) return;
    this.camDelta.subVectors(this.deps.camera.position, this.deps.controls.target);
    this.camDelta.applyAxisAngle(this.zAxis, deltaYaw);
    this.deps.camera.position.copy(this.deps.controls.target).add(this.camDelta);
    this.deps.controls.update();
  }

  private updateActiveTile() { updateActiveMovementTile(this.deps, this.charPos); }

  private updateSwimming(ground: { source: 'terrain' | 'wmo' }, groundZ: number, dt: number) {
    const waterZ = this.deps.sampleWaterLevel(this.charPos.x, this.charPos.y);
    const waterDepth = waterZ > -Infinity ? waterZ - groundZ : -1;
    // Interior/exterior is a lighting and ambience property, not a movement
    // state. Instance dungeons contain valid deep water over WMO floors, so
    // swimming must follow the sampled liquid surface and depth alone.
    void ground;
    if (this.swimming) {
      if (waterDepth < SWIM_ENTER_DEPTH - 0.4) this.swimming = false;
    } else if (waterDepth > SWIM_ENTER_DEPTH && this.charPos.z < waterZ - 0.6) {
      this.swimming = true;
    }
    if (this.swimming) {
      this.grounded = false;
      this.charVelZ = 0;
      this.airborneMs = 0;
      this.landingMs = 0;
      const pitchDirection = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
      if (this.keys.has('Space')) this.charPos.z = Math.min(waterZ - 0.2, this.charPos.z + SWIM_VERT_SPEED * dt);
      else if (this.keys.has('ControlLeft') || this.keys.has('ControlRight')) this.charPos.z = Math.max(groundZ, this.charPos.z - SWIM_VERT_SPEED * dt);
      else if (pitchDirection && Math.abs(this.swimPitch) > 0.015) {
        this.charPos.z = Math.max(
          groundZ,
          Math.min(waterZ - 0.2, this.charPos.z + Math.sin(this.swimPitch) * pitchDirection * this.serverSpeeds.swim * dt),
        );
      } else this.charPos.z += (waterZ - SWIM_FLOAT_OFFSET - this.charPos.z) * Math.min(1, dt * 5);
      if (this.charPos.z < groundZ) this.charPos.z = groundZ;
    }
  }

  private updatePlayerPlacementAndAnim(
    headingAngle: number,
    turnInput: number,
    fwdKey: boolean,
    backKey: boolean,
    strafeLeftKey: boolean,
    strafeRightKey: boolean,
    turnLeftKey: boolean,
    turnRightKey: boolean,
    walkMode: boolean,
  ) {
    this.deps.marker.position.set(this.charPos.x, this.charPos.y, this.charPos.z + 3);
    this.movementRoot.position.set(this.charPos.x, this.charPos.y, this.charPos.z);
    if (this.playerMoving || turnInput) this.movementRoot.rotation.z = headingAngle;

    if (this.swimming) {
      this.playerAnimState = this.playerMoving ? 'swim' : 'swimIdle';
    } else if (!this.grounded) {
      this.playerAnimState = this.airborneMs < 250 ? 'jumpStart' : 'jump';
    } else if (this.landingMs > 0) {
      this.playerAnimState = 'jumpEnd';
    } else if (this.playerMoving) {
      this.playerAnimState = groundLocomotionState({ moving: true, strafeLeft: strafeLeftKey, strafeRight: strafeRightKey, backward: backKey, forward: fwdKey, walking: walkMode });
    } else if (turnLeftKey) {
      this.playerAnimState = 'turnLeft';
    } else if (turnRightKey) {
      this.playerAnimState = 'turnRight';
    } else {
      this.playerAnimState = 'stand';
    }
  }

  private updateCameraFollow(dt: number, facing = this.serverOrientation) {
    if (this.xrInput) return;
    // QA freecam (`__wowFreeCam(true)`): skip both the follow and the collision clamp below, so the
    // camera can be flown anywhere with OrbitControls. The clamp normally pulls the camera back to
    // the first terrain/WMO hit along the segment from the player, which makes zooming out inside a
    // city look like it simply does not work.
    if (qaGlobals.__wowFreeCamEnabled) return;
    // Same reasoning as freecam: while a cinematic owns the camera, both the follow and the
    // collision clamp have to stand down. Returning BEFORE camDelta is recomputed matters — the
    // delta would otherwise be reseated from a camera hundreds of yards away and fling the follow
    // camera across the zone when the flythrough ends.
    if (this.deps.isCameraExternallyOwned?.()) return;
    const cvars = getInterfaceCvars(); autoFollowCameraYaw(this.deps.camera, this.deps.controls, this.camDelta, facing, dt, this.playerMoving, cvars.cameraSmoothStyle, cvars.cameraYawSmoothSpeed, this.cameraMouseButtons());

    // the PIVOT, not on the camera: the client adds field 0x104 into the camera height and then
    // does `unitPos.z += height` to build the orbit centre, so a blocked downward drag raises what
    // the camera is looking at while the camera itself stays pinned on the ground.
    this.tgt.set(
      this.charPos.x,
      this.charPos.y,
      this.charPos.z + this.cameraPivotHeight + this.smartPivotLift + this.cameraBob.sample(Number(cvars.cameraBobbing) === 1, this.grounded, this.swimming, this.getPlayerAnimState(), dt),
    );
    this.camDelta.subVectors(this.deps.camera.position, this.deps.controls.target);
    this.deps.controls.target.copy(this.tgt);
    this.deps.camera.position.copy(this.tgt).add(this.camDelta);
    // At this point OrbitControls has already applied this frame's scroll input to the restored
    // (unobstructed) radius. Remember it before collision shortens only the rendered position.
    this.cameraZoom.observeRadius(this.camDelta.length());
    // Pull back from the hit by the client's own skin (_DAT_00808a00 = 1/9yd). The pad used to be
    // 0.5 to stop the projection near plane crossing walls — that was compensating for a near plane
    // of 1.0, which is now the client's 0.1, so the pad no longer has to cover for it.
    const unobstructedRadius = this.camDelta.length();
    this.deps.camera.position.copy(this.clampCameraSegment(this.deps.camera.position));
    this.applyCameraWaterCollision(cvars);
    // Segment clamping only guarantees the camera ORIGIN cleared the surface. Sighting along a
    // slope leaves the origin above ground while the near plane's lower edge is under it, which is
    // the residual "you can still see a sliver of under-terrain" case.
    this.applyGroundClearance();


    const blocked = unobstructedRadius - this.deps.camera.position.distanceTo(this.tgt) > 1e-3;
    this.updateSmartPivot(cvars, blocked);
    this.firstPersonVisibility.update(this.deps.playerRoot, this.deps.camera.position.distanceTo(this.tgt) <= CAMERA_FIRST_PERSON_DISTANCE + 1e-4);
  }

  /**
   * Keep the camera a skin's width above the terrain, whatever the segment clamp decided.
   *
   * Only ever raises, and only when the pivot itself is above ground — below it we are in a cave or
   * a buried WMO where the heightfield is not a surface, the same exclusion
   * `clampSegmentToHeightfield` makes.
   */
  private applyGroundClearance() {
    const camera = this.deps.camera.position;
    if (this.tgt.z <= this.deps.sampleHeight(this.tgt.x, this.tgt.y)) return;
    const floor = this.deps.sampleHeight(camera.x, camera.y) + CAMERA_COLLISION_SKIN;
    if (camera.z < floor) camera.z = floor;
  }

  
  private clampCameraSegment(wanted: THREE.Vector3): THREE.Vector3 {
    const afterWmo = this.deps.worldCollision.clampSegment(this.tgt, wanted, CAMERA_COLLISION_SKIN);
    return clampSegmentToHeightfield(this.tgt, afterWmo, this.deps.sampleHeight, CAMERA_COLLISION_SKIN, afterWmo);
  }

  
  /**
   * "Smart Pivot" (cameraPivot). Without it, a camera that runs into the ground behind you
   * is simply pulled in until it sits on your back. With it, the camera keeps its distance
   * and rides up over the obstruction instead — the pivot slides up rather than in.
   */
  private updateSmartPivot(cvars: InterfaceCvars, blocked: boolean) {
    // Orbit angles this frame, so the drag can be measured without reaching into OrbitControls'
    // input handling. Elevation is negative with the camera below the pivot, matching the client's

    this.camDelta.subVectors(this.deps.camera.position, this.tgt);
    const radius = this.camDelta.length();
    const elevation = radius > 1e-5 ? Math.asin(this.camDelta.z / radius) : 0;
    const azimuth = Math.atan2(this.camDelta.y, this.camDelta.x);
    const previous = this.lastOrbit;
    this.lastOrbit = { elevation, azimuth };
    if (!previous) return;

    const pitchDelta = elevation - previous.elevation;
    let yawDelta = azimuth - previous.azimuth;
    if (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
    else if (yawDelta < -Math.PI) yawDelta += Math.PI * 2;

    this.smartPivotLift = advanceSmartPivot({
      lift: this.smartPivotLift,
      pitchDelta,
      yawDelta,
      elevation,
      pivotEnabled: Number(cvars.cameraPivot) === 1,
      moving: this.playerMoving,
      blocked,
    });
  }

  /**
   * "Camera Water Collision" (cameraWaterCollision). Keeps the camera from dropping through
   * the water surface while the player is above it, which otherwise flips the whole screen
   * to the underwater fog for a frame whenever you look up a shoreline.
   */
  private applyCameraWaterCollision(cvars: InterfaceCvars) {
    if (Number(cvars.cameraWaterCollision) !== 1 || this.swimming) return;
    const waterZ = this.deps.sampleWaterLevel(this.deps.camera.position.x, this.deps.camera.position.y);
    if (!Number.isFinite(waterZ) || waterZ <= 0) return;
    // Only lift when the player themselves is dry; while wading, the camera belongs under.
    if (this.charPos.z < waterZ) return;
    if (this.deps.camera.position.z < waterZ + 0.35) this.deps.camera.position.z = waterZ + 0.35;
  }

  private updateLightingAndDebug(collisionStartedAt: number) {
    const dbgWorld = this.deps.localToWorld(this.charPos.x, this.charPos.y);
    this.deps.updateInteriorLighting();
    if (dbgWorld) this.deps.applyLighting(this.deps.getCurrentMap(), dbgWorld.x, dbgWorld.y, this.charPos.z);
    this.collisionQueryMs = performance.now() - collisionStartedAt;
    if (this.collisionBlocked && this.deps.collisionLogEnabled()) {
      const now = performance.now();
      if (now - this.lastCollisionLogAt > 500) {
        this.lastCollisionLogAt = now;
        this.deps.log(`collision block: ${JSON.stringify(this.deps.worldCollision.lastHorizontalBlock)}`);
      }
    }
    qaGlobals.__wowPlayer = {
      x: dbgWorld?.x ?? this.charPos.x,
      y: dbgWorld?.y ?? this.charPos.y,
      z: this.charPos.z,
      grounded: this.grounded,
      moving: this.playerMoving,
      collision: {
        blocked: this.collisionBlocked,
        lastBlock: this.deps.worldCollision.lastHorizontalBlock,
        groundSource: this.groundSource,
        queryMs: this.collisionQueryMs,
        ...this.deps.worldCollision.stats,
        shape: 'cylinder',
        resolution: 'ray-sampled sweep/slide approximation',
        controller: PLAYER_COLLISION_CYLINDER,
      },
    } satisfies MovementDebugState;
  }

  private sendMovementPackets(headingAngle: number, jumped: boolean, startedFalling: boolean, landed: boolean, speed: number) {
    const activeWorld = this.deps.getWorld();
    if (!activeWorld || !this.deps.getCurrentTile()) return;
    const world = this.deps.localToWorld(this.charPos.x, this.charPos.y);
    if (!world) return;
    this.deps.updateAreaTriggers(world.x, world.y, this.charPos.z);
    this.serverOrientation = headingAngle;
    const flags = this.movementFlags();
    const base = {
      x: world.x,
      y: world.y,
      z: this.charPos.z,
      o: this.serverOrientation,
      flags,
      swimPitch: this.swimming ? this.swimPitch : undefined,
      transport: this.activeTransport,
    };
    let yawDelta = Math.abs(this.serverOrientation - this.lastSentO);
    if (yawDelta > Math.PI) yawDelta = Math.PI * 2 - yawDelta;
    // MSG_MOVE_JUMP's cosAngle/sinAngle are the horizontal VELOCITY direction, not the facing:
    // vmangos advances a jumper with `x += jump.cosAngle * jump.xyspeed * diffT` (Unit.cpp:3163-3164)
    // and never looks at the facing or the movement flags while airborne, unlike its grounded branch
    // which does apply the strafe/backpedal offsets. Reporting the raw facing therefore sent a
    // backwards jump FORWARDS on every observer's screen for the whole flight, then yanked the
    // player back when the grounded solver took over on landing.
    const travelAngle = travelAngleFor(this.serverOrientation, flags) ?? this.serverOrientation;
    // Lock the local simulation to the same two numbers we are about to transmit, so what we render
    // for ourselves and what every observer reconstructs are the same flight by construction.
    if (jumped || startedFalling) this.airLock = { angle: travelAngle, speed: this.playerMoving ? speed : 0 };
    if (this.pendingKnockback) {
      // A knockback took off outside the normal jump path (no Space press, no ledge). Publish the
      // server's arc and push one immediate MovementInfo so observers start the same flight we do.
      const knockback = this.pendingKnockback;
      this.pendingKnockback = undefined;
      activeWorld.setActiveJump(knockback);
      this.sendHeartbeat(true);
      this.lastServerMoveFlags = flags;
      this.lastSentO = this.serverOrientation;
    } else if (jumped) {
      const jumpInfo = {
        velocity: JUMP_VELOCITY,
        sinAngle: Math.sin(travelAngle),
        cosAngle: Math.cos(travelAngle),
        xySpeed: this.playerMoving ? speed : 0,
      };
      activeWorld.setActiveJump(jumpInfo);
      activeWorld.sendMove('jump', { ...base, jump: jumpInfo });
      this.lastServerMoveFlags = flags;
      this.lastSentO = this.serverOrientation;
    } else if (startedFalling) {
      // A ledge drop has no MSG_MOVE_JUMP transition, but the server still needs
      // an immediate MovementInfo snapshot with FALLING_FAR before the eventual
      // MSG_MOVE_FALL_LAND. Start the fall clock at zero vertical velocity.
      activeWorld.setActiveJump({
        velocity: 0,
        sinAngle: Math.sin(travelAngle),
        cosAngle: Math.cos(travelAngle),
        xySpeed: this.playerMoving ? speed : 0,
      });
      this.sendHeartbeat(true);
      this.lastServerMoveFlags = flags;
      this.lastSentO = this.serverOrientation;
    } else if (landed) {
      activeWorld.sendMove('fall_land', { ...base, fallTime: Math.max(0, Math.floor(this.airborneMs)) });
      activeWorld.setActiveJump(undefined);
      this.lastServerMoveFlags = flags;
    } else if (this.sendFlagTransitions(flags, base)) {
      if (flags & (MF_XY | MF_TURN)) this.lastSentO = this.serverOrientation;
    } else if (this.shouldSendFacing(yawDelta, flags)) {
      // Mouse turning is MSG_MOVE_SET_FACING — vmangos classifies exactly this opcode as
      // TURN_MOUSE (MovementAnticheat.cpp:1432) while A/D turning arrives as START/STOP_TURN. This
      // used to be gated on `!this.playerMoving`, so turning the camera while running sent nothing
      // at all: observers had no turn flags to integrate and no new yaw either, and were stuck
      // extrapolating a straight line along a stale heading until the 500 ms heartbeat corrected
      // them all at once.
      activeWorld.sendMove('facing', base);
      this.lastSentO = this.serverOrientation;
      this.lastFacingSentAt = performance.now();
    } else {
      const airborneHeartbeat = !this.grounded && this.airborneMs > AIRBORNE_HEARTBEAT_AFTER_MS;
      if (this.grounded || airborneHeartbeat) this.sendHeartbeat();
      if (this.playerMoving || (flags & MF_TURN) !== 0) this.lastSentO = this.serverOrientation;
    }
  }
}
