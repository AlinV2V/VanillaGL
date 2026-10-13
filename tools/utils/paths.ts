import path from 'node:path';

// Automatically resolves the repository root from process.cwd() or module location
export const REPO_ROOT = path.resolve(process.cwd());
export const PUBLIC_DIR = path.join(REPO_ROOT, 'apps/client/public');
export const RUNTIME_TERRAIN_DIR = process.env.RUNTIME_TERRAIN_DIR || path.join(PUBLIC_DIR, 'terrain');
export const CACHE_DIR = process.env.WOW_DBC_ROOT || path.join(REPO_ROOT, '.client-cache');
export const DATA_DIR = process.env.DATA_SOURCE_DIR || path.join(REPO_ROOT, 'data');
export const DBC_DIR = process.env.DBC_SOURCE_DIR || path.join(DATA_DIR, 'dbcs');
export const EXTRACTED_DIR = process.env.EXTRACTED_SOURCE_DIR || path.join(DATA_DIR, 'extracted');
