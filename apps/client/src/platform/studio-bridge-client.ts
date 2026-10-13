import { installStudioLiveReceiver } from '../editor/studio-live-runtime';

/**
 * CleanClientMMO platform entry point for WowserGL Studio live authoring.
 *
 * The heavy scene-binding implementation stays isolated in editor/studio-live-runtime so normal
 * gameplay bundles only load it when the explicit `?studioBridge=<ws-url>` opt-in is present.
 * The receiver connects as the runtime peer, applies transforms/materials/spawn/delete against the
 * active Three.js world, and sends acknowledgements/runtime state back through the same bridge.
 */
export function installStudioBridgeClient() {
  installStudioLiveReceiver();
}
