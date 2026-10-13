export type PageRange = { offset: number; count: number; itemSize: number; type: 'f32'|'u32' };
export type PagePart = { key: string; attributes: Record<string,PageRange>; indices: PageRange[]; errors: number[]; visibility?:PageRange[] };
export type WorldPage = { id: string; model: string; group: number; url: string; bytes: number; bounds: unknown; parts: PagePart[]; sourceChecksum?:number };
export type WorldPageCatalog = { format: 'vgl-world-pages-v1'; sourceHash: string; pages: WorldPage[] };
export function worldPagePartKey(indices: ArrayLike<number>, start: number, count: number, tex: number, blend: number): string {
  let hash=2166136261;
  for(let i=start;i<start+count;i++)hash=Math.imul(hash ^ indices[i],16777619);
  return `${tex}:${blend}:${count}:${hash>>>0}`;
}
export function pageView(range: PageRange, buffer: ArrayBuffer): Float32Array|Uint32Array {
  if(!['f32','u32'].includes(range.type)||!Number.isInteger(range.itemSize)||range.itemSize<1||range.count%range.itemSize)throw new Error('Invalid world page element layout');
  if(!Number.isInteger(range.offset)||!Number.isInteger(range.count)||range.offset<0||range.count<0||range.offset%4||range.offset+range.count*4>buffer.byteLength)throw new Error('World page range outside buffer');
  return range.type==='f32'?new Float32Array(buffer,range.offset,range.count):new Uint32Array(buffer,range.offset,range.count);
}
export function worldPageSourceChecksum(source:{positions:ArrayLike<number>;normals?:ArrayLike<number>;uvs?:ArrayLike<number>;colors?:ArrayLike<number>;indices:ArrayLike<number>}):number {
  let hash=2166136261;
  for(const array of [Float32Array.from(source.positions),Float32Array.from(source.normals??[]),Float32Array.from(source.uvs??[]),Uint8Array.from(source.colors??[]),Uint32Array.from(source.indices)]){
    hash=Math.imul(hash^array.byteLength,16777619);
    for(const byte of new Uint8Array(array.buffer))hash=Math.imul(hash^byte,16777619);
  }
  return hash>>>0;
}
