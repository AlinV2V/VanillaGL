# Portable asset tools

`asset-tools.json` pins the release URL and SHA-256 digest for `toktx`, `cwebp`, and `ffmpeg` on the supported Windows, macOS, and Linux targets.

Run `npm run tools:install` to install the current platform under this directory. Downloads are held in memory, hashed, and rejected before they are written, extracted, installed, or executed. Installed binaries and their verification markers are local generated prerequisites and are ignored by Git.
