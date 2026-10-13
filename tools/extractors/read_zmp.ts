import { openClientArchive } from '@vanillagl/assets';
import * as fs from 'fs';

async function main() {
  const CACHE = '.client-cache';
  const archive = await openClientArchive(CACHE, 'interface.MPQ');
  
  const zmpPath = 'Interface\\WorldMap\\Azeroth.zmp';
  if (archive.has(zmpPath)) {
    const bytes = archive.extract(zmpPath);
    console.log(`Successfully extracted ${zmpPath}. Size: ${bytes.length} bytes`);
    
    // Print first 256 bytes in hex and ASCII
    console.log("Header hex dump:");
    const hex = [];
    const ascii = [];
    const limit = Math.min(bytes.length, 256);
    
    for (let i = 0; i < limit; i++) {
      hex.push(bytes[i].toString(16).padStart(2, '0'));
      ascii.push(bytes[i] >= 32 && bytes[i] <= 126 ? String.fromCharCode(bytes[i]) : '.');
      
      if ((i + 1) % 16 === 0 || i === limit - 1) {
        console.log(`${(i - 15).toString(16).padStart(4, '0')}: ${hex.join(' ')}  |${ascii.join('')}|`);
        hex.length = 0;
        ascii.length = 0;
      }
    }
  } else {
    console.log(`${zmpPath} not found in interface.MPQ`);
  }
  
  archive.close();
}

main().catch(console.error);
