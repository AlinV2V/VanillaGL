/** Deliberately bounded FrameXML loader for MirrorTimer.xml, not a general UI parser. */
export type UiNode = {
  name: string; kind: string; parent?: string; root: string; hidden: boolean;
  width: number; height: number; point: string; relativePoint: string; relativeTo?: string;
  offsetX: number; offsetY: number; layer: number; texture?: string; color?: number[];
  font?: string; scripts: Record<string, string>; text: string;
  minimum: number; maximum: number; value: number; level: number;
};
const child = (element: Element, name: string) => Array.from(element.children).find(e => e.localName === name);
const num = (element: Element | undefined, key: string, fallback = 0) => {
  const value = element?.getAttribute(key);
  return value === null || value === undefined ? fallback : Number(value);
};
export function readMirrorXml(xml: string): UiNode[] {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('Invalid mirror timer XML');
  const templates = new Map<string, Element>();
  const nodes: UiNode[] = [];
  const instantiate = (element: Element, parent: UiNode | undefined, root?: string, layer = 1): UiNode => {
    const inherited = element.getAttribute('inherits');
    const template = inherited ? templates.get(inherited) : undefined;
    if (inherited && !template && inherited !== 'GameFontHighlight') throw new Error(`Unsupported template ${inherited}`);
    const base = template ?? element;
    const get = (key: string) => element.getAttribute(key) ?? base.getAttribute(key);
    const name = (get('name') ?? `${parent?.name ?? 'root'}__${nodes.length}`).replaceAll('$parent', parent?.name ?? '');
    const dimension = child(child(element, 'Size') ?? child(base, 'Size') ?? element, 'AbsDimension');
    const anchor = child(child(element, 'Anchors') ?? child(base, 'Anchors') ?? element, 'Anchor');
    const offset = anchor && child(child(anchor, 'Offset') ?? anchor, 'AbsDimension');
    const color = child(base, 'Color');
    const node: UiNode = {
      name, kind: element.localName, parent: parent?.name, root: root ?? name,
      hidden: get('hidden') === 'true', width: num(dimension, 'x'), height: num(dimension, 'y'),
      point: anchor?.getAttribute('point') ?? 'TOP',
      relativePoint: anchor?.getAttribute('relativePoint') ?? anchor?.getAttribute('point') ?? 'TOP',
      relativeTo: anchor?.getAttribute('relativeTo')?.replaceAll('$parent', parent?.name ?? ''),
      offsetX: num(offset, 'x'), offsetY: num(offset, 'y'), layer,
      texture: get('file') ?? child(base, 'BarTexture')?.getAttribute('file') ?? undefined,
      color: color ? ['r', 'g', 'b', 'a'].map(k => num(color, k, 1)) : undefined,
      font: inherited === 'GameFontHighlight' ? inherited : undefined,
      scripts: {}, text: '', minimum: 0, maximum: 1, value: 0, level: parent ? parent.level + 1 : 1,
    };
    nodes.push(node);
    for (const script of Array.from(child(base, 'Scripts')?.children ?? [])) {
      if (!['OnLoad', 'OnEvent', 'OnUpdate'].includes(script.localName)) throw new Error(`Unsupported script ${script.localName}`);
      node.scripts[script.localName] = script.textContent ?? '';
    }
    for (const layers of Array.from(child(base, 'Layers')?.children ?? [])) {
      const rank = layers.getAttribute('level') === 'OVERLAY' ? 3 : 0;
      for (const region of Array.from(layers.children)) instantiate(region, node, node.root, rank);
    }
    for (const frame of Array.from(child(base, 'Frames')?.children ?? [])) instantiate(frame, node, node.root, 1);
    return node;
  };
  for (const element of Array.from(document.documentElement.children)) {
    if (element.localName === 'Script') {
      if (element.getAttribute('file') !== 'MirrorTimer.lua') throw new Error('Unexpected script dependency');
    } else if (element.getAttribute('virtual') === 'true') templates.set(element.getAttribute('name')!, element);
    else instantiate(element, undefined);
  }
  if (nodes.filter(n => !n.parent).length !== 3) throw new Error('Expected three original mirror timer frames');
  return nodes;
}

export type Rect = { x: number; y: number; width: number; height: number };
export function layoutMirrorNodes(nodes: UiNode[], viewport: Rect): Map<string, Rect> {
  const byName = new Map(nodes.map(n => [n.name, n]));
  const resolved = new Map<string, Rect>();
  const visiting = new Set<string>();
  const anchor = (r: Rect, point: string) => {
    if (!['TOP', 'BOTTOM', 'CENTER'].includes(point)) throw new Error(`Unsupported anchor ${point}`);
    return { x: r.x + r.width / 2, y: r.y + (point === 'TOP' ? 0 : point === 'BOTTOM' ? r.height : r.height / 2) };
  };
  const resolve = (node: UiNode): Rect => {
    const old = resolved.get(node.name);
    if (old) return old;
    if (visiting.has(node.name)) throw new Error(`Anchor cycle at ${node.name}`);
    visiting.add(node.name);
    const target = node.relativeTo ?? node.parent;
    if (target && !byName.has(target) && target !== 'UIParent') throw new Error(`Missing anchor ${target}`);
    const relative = target && byName.has(target) ? resolve(byName.get(target)!) : viewport;
    const origin = anchor(relative, node.relativePoint);
    const own = anchor({ x: 0, y: 0, width: node.width, height: node.height }, node.point);
    const rect = { x: origin.x + node.offsetX - own.x, y: origin.y - node.offsetY - own.y, width: node.width, height: node.height };
    resolved.set(node.name, rect);
    visiting.delete(node.name);
    return rect;
  };
  nodes.forEach(resolve);
  return resolved;
}
