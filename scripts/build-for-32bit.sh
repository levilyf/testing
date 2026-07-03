#!/usr/bin/env bash
# Cross-compile the 32-bit Claude Code bundle.
# Run this on a 64-bit machine (Codespaces, Linux, Mac, or 64-bit Android Termux).
# Output: dist/cli.32.mjs — copy that file to your 32-bit Android device.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Install deps (skipped if node_modules present)"
if [ ! -d node_modules ]; then
  npm install --no-optional
fi

echo "==> Build the 32-bit bundle"
if command -v bun >/dev/null 2>&1; then
  bun scripts/build-bundle.ts --arch=32 --no-sourcemap
elif node --version | grep -qE 'v(2[2-9]|3[0-9])'; then
  node --experimental-strip-types scripts/build-bundle.ts --arch=32 --no-sourcemap
else
  echo "Need Node >= 22 or Bun. Got: $(node --version 2>/dev/null || echo 'no node')"
  exit 1
fi

OUT=dist/cli.32.mjs
if [ ! -f "$OUT" ]; then
  echo "Build finished but $OUT not found — esbuild probably failed."
  exit 1
fi

SIZE=$(du -h "$OUT" | cut -f1)
echo
echo "==> Built $OUT ($SIZE)"
echo "==> Copy this file to your 32-bit Android device at ~/claude-32/dist/cli.32.mjs"
echo "    Then on the device: chmod +x ~/claude-32/dist/cli.32.mjs && ~/claude-32/dist/cli.32.mjs --version"
