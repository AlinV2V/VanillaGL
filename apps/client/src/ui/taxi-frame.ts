/** Asset conversion utility. */
import { WORLD_MAP_AREAS } from '../data/world-map';
import type { TaxiState } from '../world';
import { formatMoneyText } from './money';
import { CanvasPanel, type PanelHit } from './panel-kit';

type TaxiNode = { id: number; map: number; x: number; y: number; name: string };
type TaxiPath = { id: number; from: number; to: number; cost: number };

const MAP_RECT = { x: 24, y: 78, width: 302, height: 336 };
const TAXI = '/ui/Interface/TaxiFrame';

/**
 * TaxiNodes.dbc ids are 1-based, but the SMSG_SHOWTAXINODES bitmask is 0-based: vMaNGOS writes
 * node N at word (N-1)/32, bit (N-1)%32 (PlayerTaxi.h SetTaximaskNode/IsTaximaskNodeKnown).
 * Indexing with the raw id shifted every lookup by one bit, so known flight points read their
 * neighbour's state — showing unlocked routes as locked and vice versa across the whole map.
 */
const nodeKnown = (mask: number[], id: number) => {
  const bit = id - 1;
  if (bit < 0) return 0;
  return ((mask[bit >>> 5] ?? 0) >>> (bit & 31)) & 1;
};

export class TaxiCanvasPanel extends CanvasPanel {
  private current?: TaxiState;
  private nodes: TaxiNode[] = [];
  private paths: TaxiPath[] = [];
  private loaded?: Promise<void>;
  private hoverNodeId = 0;

  constructor(private readonly host: HTMLElement, private readonly deps: {
    playUi: (name: string) => void;
    activateTaxi: (guid: string, sourceNode: number, destinationNode: number) => void;
    getUnitName: (guid: string) => string | undefined;
  }) {
    super(host, 384, 512, 'wow-native-panel-canvas', { playUi: deps.playUi });
  }

  private load() {
    this.loaded ??= fetch('/taxi/taxi.json', { cache: 'no-cache' })
      .then((res) => {
        if (!res.ok) throw new Error(`taxi data request failed (${res.status})`);
        return res.json();
      })
      .then((data: { nodes: TaxiNode[]; paths: TaxiPath[] }) => {
        this.nodes = data.nodes;
        this.paths = data.paths;
      })
      .catch((error) => {
        this.loaded = undefined;
        throw error;
      });
    return this.loaded;
  }

  show(state: TaxiState) {
    this.current = state;
    this.host.classList.remove('is-hidden');
    this.playUi('igCharacterInfoOpen');
    void this.load().then(() => this.surface.requestRender()).catch(() => { /* retry on next open */ });
  }

  hide() {
    this.host.classList.add('is-hidden');
  }

  isOpen() {
    return !this.host.classList.contains('is-hidden');
  }

  private nodeById(id: number) {
    return this.nodes.find((node) => node.id === id);
  }

  private mapPoint(node: TaxiNode) {
    // The continent-wide WorldMapArea record (areaId 0) carries the world-yard
    // rect the map art covers — same transform world-map.ts uses.
    const area = WORLD_MAP_AREAS.find((candidate) => candidate.mapId === node.map && candidate.areaId === 0);
    if (!area) return undefined;
    const u = (node.y - area.left) / (area.right - area.left);
    const v = (node.x - area.top) / (area.bottom - area.top);
    if (u < -0.05 || u > 1.05 || v < -0.05 || v > 1.05) return undefined;
    return { x: MAP_RECT.x + u * MAP_RECT.width, y: MAP_RECT.y + v * MAP_RECT.height };
  }

  /** Fewest-hops route current -> target over the TaxiPath graph. */
  private route(targetId: number): { legs: number[]; cost: number } | undefined {
    const start = this.current?.currentNode ?? 0;
    if (!start || start === targetId) return undefined;
    const previous = new Map<number, { node: number; cost: number }>();
    const queue = [start];
    const seen = new Set([start]);
    while (queue.length) {
      const at = queue.shift()!;
      if (at === targetId) break;
      for (const path of this.paths) {
        if (path.from !== at || seen.has(path.to)) continue;
        seen.add(path.to);
        previous.set(path.to, { node: at, cost: path.cost });
        queue.push(path.to);
      }
    }
    if (!previous.has(targetId)) return undefined;
    const legs = [targetId];
    let cost = 0;
    for (let at = targetId; at !== start;) {
      const step = previous.get(at)!;
      cost += step.cost;
      legs.unshift(step.node);
      at = step.node;
    }
    return { legs, cost };
  }

  protected paint() {
    const s = this.surface;
    s.clear();
    this.hoverNodeId = this.hover?.id.startsWith('node:') ? (this.hover.data as number) : 0;
    const state = this.current;
    const currentNode = state ? this.nodeById(state.currentNode) : undefined;
    const mapId = currentNode?.map ?? 0;
    // Frame first: the quadrant art's window interior is opaque parchment-dark,
    // so the continent map must composite over it, then dots over the map.
    s.fourSlice(TAXI, ['UI-TaxiFrame-TopLeft', 'UI-TaxiFrame-TopRight', 'UI-TaxiFrame-BotLeft', 'UI-TaxiFrame-BotRight']);
    s.image(`${TAXI}/TAXIMAP${mapId === 1 ? 1 : 0}.png`, MAP_RECT.x, MAP_RECT.y, MAP_RECT.width, MAP_RECT.height);
    const master = state && this.deps.getUnitName(state.guid);
    s.text(master || 'Flight Master', 192, 24, { size: 13, color: '#ffffff', align: 'center', baseline: 'middle', maxWidth: 270 });
    s.closeButton(323, 8, this.state('close') === 'down' ? 'down' : this.state('close') === 'hover' ? 'hover' : 'normal');
    this.hit('close', { x: 323, y: 8, width: 32, height: 32 });
    if (!state) return;

    // Hover route polyline under the dots.
    if (this.hoverNodeId) {
      const route = this.route(this.hoverNodeId);
      if (route) {
        const ctx = s.ctx;
        ctx.save();
        ctx.strokeStyle = '#ffd100';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        route.legs.forEach((legId, index) => {
          const node = this.nodeById(legId);
          const point = node && this.mapPoint(node);
          if (!point) return;
          if (index === 0) ctx.moveTo(point.x, point.y);
          else ctx.lineTo(point.x, point.y);
        });
        ctx.stroke();
        ctx.restore();
      }
    }

    for (const node of this.nodes) {
      if (node.map !== mapId) continue;
      const known = nodeKnown(state.knownMask, node.id);
      const isCurrent = node.id === state.currentNode;
      if (!known && !isCurrent) continue; // vanilla hides undiscovered nodes
      const point = this.mapPoint(node);
      if (!point) continue;
      const icon = isCurrent ? 'Green' : this.hoverNodeId === node.id ? 'Red' : 'Yellow';
      s.image(`${TAXI}/UI-Taxi-Icon-${icon}.png`, point.x - 8, point.y - 8, 16, 16);
      const route = isCurrent ? undefined : this.route(node.id);
      this.hit(`node:${node.id}`, { x: point.x - 9, y: point.y - 9, width: 18, height: 18 }, {
        data: node.id,
        disabled: isCurrent,
        tooltip: () => [
          { text: node.name, color: '#ffffff' },
          isCurrent
            ? { text: 'You are here', color: '#1eff00' }
            : route
              ? { text: `Cost: ${formatMoneyText(route.cost)}`, color: '#ffd100' }
              : { text: 'No route available', color: '#e60b0b' },
        ],
      });
    }
  }

  protected activate(hit: PanelHit) {
    if (hit.id === 'close') {
      this.playUi('igCharacterInfoClose');
      this.hide();
      return;
    }
    if (hit.id.startsWith('node:') && this.current) {
      const target = hit.data as number;
      if (!this.route(target)) return;
      this.playUi('igMainMenuOptionCheckBoxOn');
      this.deps.activateTaxi(this.current.guid, this.current.currentNode, target);
      this.hide();
    }
  }
}
