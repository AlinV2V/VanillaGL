# Runtime data boundary

TypeScript in this directory contains schemas, protocol/layout helpers, and loaders only.
Generated game-data payloads belong in `apps/client/public/data/`, which is ignored by Git.
A clean source checkout therefore typechecks and builds without bundling third-party data;
runtime features are populated after local data preparation supplies the matching JSON files.
