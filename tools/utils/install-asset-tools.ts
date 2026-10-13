/** Install checksum-pinned toktx, cwebp, and ffmpeg binaries for the current platform. */
import { ensureAssetTools } from './asset-tools.ts';

const resolved = await ensureAssetTools({ installMissing: true, preferPortable: true });
for (const [name, tool] of Object.entries(resolved)) {
  console.log(`${name}=${tool.path} | ${tool.source} | ${tool.version}`);
}
