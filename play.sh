#!/usr/bin/env bash
# Starts VanillaGL (realm bridge + game) on macOS and Linux. Run: ./play.sh  (or: bash play.sh)
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Run ./setup.sh first."
  exit 1
fi

exec node tools/play.mjs "$@"
