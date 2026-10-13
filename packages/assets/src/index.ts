/** Asset conversion utility. */
// stormjs has no type declarations; treated as any via the client's shims.d.ts.
import { FS, MPQ as StormMPQ } from '@wowserhq/stormjs';

export * from './m2-vanilla.ts';
export * from './m2-emitters.ts';
export * from './wmo-liquid.ts';
export * from './ground-effect-5875.ts';

// ---------------------------------------------------------------------------
// MPQ archive
// ---------------------------------------------------------------------------

export class MpqArchive {
  #handle: any;

  private constructor(handle: any) {
    this.#handle = handle;
  }

  /** Open an archive at a path inside the stormjs FS (already mounted/written). */
  static async open(fsPath: string): Promise<MpqArchive> {
    const handle = await StormMPQ.open(fsPath, 'r');
    return new MpqArchive(handle);
  }

  /** True if the archive (or its patch chain) contains the file. */
  has(name: string): boolean {
    return this.#handle.hasFile(name);
  }

  /** List file names via the archive's internal (listfile); [] if absent. */
  list(mask = '*'): string[] {
    try {
      return this.#handle.search(mask).map((r: any) => r.fileName);
    } catch {
      return [];
    }
  }

  /** Extract a file's bytes. Copies out of the WASM heap before the handle is freed. */
  extract(name: string): Uint8Array {
    const file = this.#handle.openFile(name);
    try {
      return new Uint8Array(file.read());
    } finally {
      file.close();
    }
  }

  /**
   * Apply a patch archive on top of this one (StormLib patch-chaining; files in
   * later patches override earlier ones). Vanilla loads base MPQs then patch-N.
   */
  patch(fsPath: string, prefix = ''): void {
    this.#handle.patch(fsPath, prefix);
  }

  close(): void {
    this.#handle.close();
  }
}

// ---------------------------------------------------------------------------
// Node: mount a real directory of MPQs into the stormjs FS
// ---------------------------------------------------------------------------

const mountedRoots = new Set<string>();

/** (Node) Mount an OS directory into the stormjs FS once. Returns the FS mount point. */
export function mountDir(osPath: string, mountPoint = '/client'): string {
  if (!mountedRoots.has(mountPoint)) {
    try {
      FS.mkdir(mountPoint);
    } catch {
      /* already exists */
    }
    FS.mount(FS.filesystems.NODEFS, { root: osPath }, mountPoint);
    mountedRoots.add(mountPoint);
  }
  return mountPoint;
}

/** (Node) Mount `osDir` and open `mpqName` from it. */
export async function openClientArchive(osDir: string, mpqName: string): Promise<MpqArchive> {
  const mount = mountDir(osDir);
  return MpqArchive.open(`${mount}/${mpqName}`);
}

/**
 * Patch archives, highest priority first.
 *
 * The client resolves a path by consulting patches before the base archives, and a higher-numbered
 * patch before a lower one — `patch-2.MPQ` shadows `patch.MPQ`, which shadows `model.MPQ`. Measured
 * against this client: patch.MPQ carries 26,352 files of which 11,470 shadow a base archive (5,889
 * textures, 2,325 WMOs, 2,090 terrain ADTs, 668 models, 384 interface, 114 DBCs), patch-2 shadows a
 * further 50 (30 of them DBCs), and patch-4 shadows 29. A bake that opens only the base archives is
 * reading superseded assets — that is how our character bake ended up on HumanMale.m2's 142-sequence
 * base copy while the client renders patch.MPQ's 143-sequence one.
 */
export const PATCH_ARCHIVES = ['patch-4.MPQ', 'patch-3.MPQ', 'patch-2.MPQ', 'patch.MPQ'] as const;

/**
 * (Node) Open the client's archives in resolution order: every patch present, highest first, then
 * the requested base archives in the order given. Archives that are absent are skipped rather than
 * throwing, so this works against both a full client `Data` directory and a partial `.client-cache`.
 *
 * Pass the result straight to any loop that takes the first archive containing a path — that loop
 * now honours patch overrides for free.
 */
export async function openClientArchives(osDir: string, baseNames: string[]): Promise<MpqArchive[]> {
  const out: MpqArchive[] = [];
  for (const name of [...PATCH_ARCHIVES, ...baseNames]) {
    try {
      out.push(await openClientArchive(osDir, name));
    } catch {
      // Absent archive: a stock client has no patch-3, and .client-cache may hold only a subset.
    }
  }
  return out;
}

/**
 * A set of archives searched in priority order, quacking like a single `MpqArchive`.
 *
 * Lets a bake that holds one archive handle adopt patch precedence with a one-line change instead of
 * threading an array through every call site.
 */
export class ClientArchiveSet {
  // Explicit field, not a constructor parameter property: the bake tools run as .ts directly under
  // node's strip-only TypeScript mode, which rejects parameter properties outright.
  private readonly archives: MpqArchive[];

  constructor(archives: MpqArchive[]) {
    this.archives = archives;
  }

  static async open(osDir: string, baseNames: string[]): Promise<ClientArchiveSet> {
    return new ClientArchiveSet(await openClientArchives(osDir, baseNames));
  }

  /** The underlying archives, highest priority first. */
  get all(): MpqArchive[] {
    return this.archives;
  }

  has(path: string): boolean {
    return this.archives.some((a) => a.has(path));
  }

  /** First archive holding `path`, or null. */
  owner(path: string): MpqArchive | null {
    return this.archives.find((a) => a.has(path)) ?? null;
  }

  extract(path: string): Uint8Array {
    const owner = this.owner(path);
    if (!owner) throw new Error(`not found in any client archive: ${path}`);
    return owner.extract(path);
  }

  /** Union of every archive's listing, de-duplicated case-insensitively (first listing wins). */
  list(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const a of this.archives) {
      let names: string[] = [];
      try {
        names = a.list();
      } catch {
        continue;
      }
      for (const n of names) {
        const key = n.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(n);
      }
    }
    return out;
  }

  close(): void {
    for (const a of this.archives) {
      try {
        a.close();
      } catch {
        /* already closed */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Browser: fetch an MPQ into the in-memory FS, then open
// ---------------------------------------------------------------------------

/** (Browser) Fetch an MPQ over HTTP into the WASM FS and return its file list. */
export async function openMpq(url: string): Promise<string[]> {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const fsPath = '/' + (url.split('/').pop() || 'archive.mpq');
  FS.writeFile(fsPath, bytes);
  const archive = await MpqArchive.open(fsPath);
  try {
    return archive.list();
  } finally {
    archive.close();
  }
}

// ---------------------------------------------------------------------------
// DBC — generic, version-agnostic WDBC reader
// 1.12 specification handling.
// on vanilla 1.12.1 (different field counts). This reader is layout-agnostic: it
// exposes raw fields (int/uint/float) + string-block strings, so callers decode the
// columns they need per the 1.12.1 schema. Fields are the standard 4 bytes wide.
// ---------------------------------------------------------------------------

export class DbcFile {
  readonly recordCount: number;
  readonly fieldCount: number;
  readonly recordSize: number;
  readonly stringBlockSize: number;

  #view: DataView;
  #recordsOffset: number;
  #strings: Uint8Array;

  constructor(data: Uint8Array) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
    if (magic !== 'WDBC') {
      throw new Error(`Not a WDBC file (magic="${magic}")`);
    }

    this.recordCount = view.getUint32(4, true);
    this.fieldCount = view.getUint32(8, true);
    this.recordSize = view.getUint32(12, true);
    this.stringBlockSize = view.getUint32(16, true);

    this.#recordsOffset = 20;
    const stringsOffset = this.#recordsOffset + this.recordCount * this.recordSize;

    this.#view = view;
    this.#strings = new Uint8Array(data.buffer, data.byteOffset + stringsOffset, this.stringBlockSize);
  }

  #fieldOffset(record: number, field: number): number {
    return this.#recordsOffset + record * this.recordSize + field * 4;
  }

  getInt(record: number, field: number): number {
    return this.#view.getInt32(this.#fieldOffset(record, field), true);
  }

  getUint(record: number, field: number): number {
    return this.#view.getUint32(this.#fieldOffset(record, field), true);
  }

  getFloat(record: number, field: number): number {
    return this.#view.getFloat32(this.#fieldOffset(record, field), true);
  }

  /** A string field stores a byte offset into the string block. Reads a C-string there. */
  getString(record: number, field: number): string {
    const offset = this.getUint(record, field);
    if (offset === 0 || offset >= this.#strings.length) return '';
    let end = offset;
    while (end < this.#strings.length && this.#strings[end] !== 0) end++;
    // WoW string blocks are UTF-8; latin1 is a safe superset for ASCII-y identifiers.
    return new TextDecoder('utf-8').decode(this.#strings.subarray(offset, end));
  }
}

// ---------------------------------------------------------------------------
// OPFS cache (browser) — stash streamed assets so we don't refetch GBs.
// ---------------------------------------------------------------------------

const safeKey = (key: string) => key.replace(/[^\w.-]+/g, '_');

export async function cachePut(key: string, data: ArrayBuffer): Promise<void> {
  const root = await (navigator as any).storage.getDirectory();
  const handle = await root.getFileHandle(safeKey(key), { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

export async function cacheGet(key: string): Promise<ArrayBuffer | null> {
  try {
    const root = await (navigator as any).storage.getDirectory();
    const handle = await root.getFileHandle(safeKey(key));
    return await (await handle.getFile()).arrayBuffer();
  } catch {
    return null;
  }
}
