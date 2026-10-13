/** Bounded district pilot; reads existing WMO bake, writes separate experiment assets. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import { prepareWmoRenderBatches } from '../../apps/client/src/rendering/wmo-render-batches';
import { compactWmoBatchGeometry } from '../../apps/client/src/rendering/wmo-batched-experiment';
import { worldPagePartKey, worldPageSourceChecksum, type PageRange, type WorldPageCatalog, type PagePart } from '../../apps/client/src/rendering/world-page-format';
import { compileWorldVisibility } from '../../apps/client/src/rendering/world-visibility-compiler';

const tile=process.argv[2]??'Azeroth_30_48';
if(!/^[A-Za-z]+_\d+_\d+$/.test(tile))throw new Error('Expected one tile key');
const live=process.argv.includes('--live'),prefix=live?'terrain/world-pages':'__experiments/world-pages';
const input=resolve('apps/client/public/terrain/tiles',tile), output=resolve('apps/client/public',prefix,tile);
const metaBytes=readFileSync(join(input,'wmos.meta.json')), raw=readFileSync(join(input,'wmos.bin'));
const buffer=raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength);
const meta=JSON.parse(metaBytes.toString());
if(meta.format!=='wow-browser-wmo-bin-v1')throw new Error('Unsupported source bake');
const catalog: WorldPageCatalog={format:'vgl-world-pages-v1',sourceHash:createHash('sha256').update(metaBytes).update(raw).digest('hex'),pages:[]};
mkdirSync(output,{recursive:true});await MeshoptSimplifier.ready;
let originalTriangles=0, middleTriangles=0, farTriangles=0;
const read=(ref:any):any=>!ref?[]:ref.$bin==='f32'?new Float32Array(buffer,ref.offset,ref.count):ref.$bin==='u32'?new Uint32Array(buffer,ref.offset,ref.count):new Uint8Array(buffer,ref.offset,ref.count);
for(const [modelIndex,model] of meta.models.entries())for(const [groupIndex,g] of model.groups.entries()) {
  const source=new THREE.BufferGeometry();
  source.setAttribute('position',new THREE.BufferAttribute(read(g.positions),3));
  source.setAttribute('normal',new THREE.BufferAttribute(read(g.normals),3));
  source.setAttribute('uv',new THREE.BufferAttribute(read(g.uvs),2));
  const colors=read(g.colors);source.setAttribute('wmoColor',new THREE.BufferAttribute(colors.length?Float32Array.from(colors,(v:number)=>v/255):new Float32Array(source.getAttribute('position').count*4),4));
  const sourceIndices=read(g.indices), chunks:Buffer[]=[], parts:PagePart[]=[];let offset=0;
  const store=(data:Float32Array|Uint32Array,itemSize:number):PageRange=>{const bytes=Buffer.from(data.buffer,data.byteOffset,data.byteLength);const range:PageRange={offset,count:data.length,itemSize,type:data instanceof Float32Array?'f32':'u32'};chunks.push(bytes);offset+=bytes.length;return range;};
  for(const batch of prepareWmoRenderBatches(sourceIndices,g.batches??[])) {
    const index=batch.mergedIndices??sourceIndices;
    source.setIndex(new THREE.BufferAttribute(index,1));source.setDrawRange(batch.indexStart,batch.indexCount);
    const geometry=compactWmoBatchGeometry(source), positions=geometry.getAttribute('position').array as Float32Array;
    const indices=Uint32Array.from(geometry.index!.array), attributes:Record<string,PageRange>={};
    for(const [name,attribute] of Object.entries(geometry.attributes))attributes[name]=store((attribute as THREE.BufferAttribute).array as Float32Array,attribute.itemSize);
    const lods=[indices], errors=[0];
    const attrs=new Float32Array(positions.length/3*9);
    for(let i=0;i<positions.length/3;i++){let cursor=i*9;for(const name of ['normal','uv','wmoColor']){const a=geometry.getAttribute(name) as THREE.BufferAttribute;for(let c=0;c<a.itemSize;c++)attrs[cursor++]=a.array[i*a.itemSize+c];}}
    for(const [ratio,error] of live||process.argv.includes('--exact-only')?[]:[[.5,.002],[.2,.008]]) {
      const result=batch.blendMode<=1 && indices.length>=96?MeshoptSimplifier.simplifyWithAttributes(indices,positions,3,attrs,9,[.5,.5,.5,1,1,.5,.5,.5,.5],null,Math.floor(indices.length*ratio/3)*3,error,['LockBorder']):[indices,0] as const;
      lods.push(result[0]);errors.push(result[1]*MeshoptSimplifier.getScale(positions,3));
    }
    originalTriangles+=indices.length/3;middleTriangles+=(lods[1]??indices).length/3;farTriangles+=(lods[2]??indices).length/3;
    const visibility=process.argv.includes('--visibility')?compileWorldVisibility(geometry).map(p=>store(p,3)):undefined;
    parts.push({key:worldPagePartKey(index,batch.indexStart,batch.indexCount,batch.tex,batch.blendMode),attributes,indices:lods.map(lod=>store(lod,1)),errors,visibility});
    geometry.dispose();
  }
  source.dispose();const id=`${modelIndex}-${groupIndex}`;writeFileSync(join(output,`${id}.bin`),Buffer.concat(chunks));
  catalog.pages.push({id,model:model.name,group:groupIndex,url:`/${prefix}/${tile}/${id}.bin`,bytes:offset,bounds:g.bbox,parts,sourceChecksum:worldPageSourceChecksum({positions:read(g.positions),normals:read(g.normals),uvs:read(g.uvs),colors:read(g.colors),indices:read(g.indices)})});
}
writeFileSync(join(output,'catalog.json'),JSON.stringify(catalog));
console.log(JSON.stringify({tile,pages:catalog.pages.length,bytes:catalog.pages.reduce((s,p)=>s+p.bytes,0),triangles:[originalTriangles,middleTriangles,farTriangles],sourceHash:catalog.sourceHash}));
