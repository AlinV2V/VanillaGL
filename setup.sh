#!/usr/bin/env bash
# VanillaGL one-step setup for macOS and Linux. Run: ./setup.sh  (or: bash setup.sh)
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "VanillaGL needs Node.js (version 20.19 or newer), which is not installed."
  echo "Install the LTS version from https://nodejs.org (or your package manager), then run ./setup.sh again."
  echo
  exit 1
fi

exec node tools/setup-wizard.mjs
