# Contributing to VanillaGL

Thank you for your interest in contributing to **VanillaGL**!

This project is a high-performance, browser-native 3D MMORPG client engine built with TypeScript, Three.js, WebGL2, and WebSockets.

---

## 🛠️ Development Workflow

### 1. Prerequisites
- **Node.js** v20.x or higher
- **npm** or **pnpm**

### 2. Local Setup
```bash
# Clone your fork
git clone https://github.com/AlinV2V/VanillaGL.git
cd VanillaGL

# Install dependencies
npm install

# Start development server
npm run dev
```

To run the game you also need your own 1.12.1 client and a baked asset set; see the [README](README.md).

### 3. Verification Before Submitting a PR
Before submitting a Pull Request, please ensure both checks pass:
```bash
# 1. Typecheck TypeScript across the workspace
npm run typecheck

# 2. Build production distribution
npm run build
```

---

## 📐 Architecture & Engineering Guidelines

1. **Strict IP & Clean-Room Standard:**
   - **Never commit proprietary, copyrighted, or extracted binary game assets** (`.mpq`, `.blp`, `.m2`, `.wmo`, `.dbc`, `.adt`, `.wav`, etc.).
   - All runtime assets must be original or generated via the open-source bakers in `tools/bakers/`.

2. **Modularity & Single Responsibility:**
   - Keep domain systems isolated under `apps/client/src/world/<domain>.ts`, `combat/<domain>.ts`, and `ui/<domain>-frame.ts`.
   - Avoid monolithic accumulation in `world.ts` or `main.ts`.

3. **Cross-Platform Compatibility:**
   - Always use `path.join()`, `path.resolve()`, or `import.meta.url` for path resolutions.
   - Never hardcode OS-specific paths or drive letters.

---

## 🤝 Pull Request Process

1. Fork the repo and create your branch from `main`:
   ```bash
   git checkout -b feature/my-new-feature
   ```
2. Commit your changes with clear, descriptive commit messages.
3. Push to your branch and open a Pull Request against `main`.

---

## 📄 License
By contributing, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
