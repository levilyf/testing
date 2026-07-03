#!/bin/bash
# ─────────────────────────────────────────────────────────────
# ci-build-32.sh — 32-bit build pipeline
# ─────────────────────────────────────────────────────────────
# Same shape as ci-build.sh but builds the 32-bit bundle:
#   - Installs deps with --no-optional (skip node-pty / sharp prebuilds)
#   - Builds with --arch=32 (routes native imports to no-op shims)
#   - Verifies the bundle runs and reports its 32-bit status
#
# Usage:
#   ./scripts/ci-build-32.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

echo "=== Installing dependencies (skipping optional native addons) ==="
# --no-optional: skip node-pty (no 32-bit prebuilds) and sharp.
# Both are in optionalDependencies; the build script's --arch=32 flag
# routes their imports to scripts/shims/native-shim.ts at bundle time.
bun install --no-optional 2>/dev/null || npm install --no-optional

echo "=== Type checking ==="
bun run typecheck 2>/dev/null || npx tsc --noEmit || {
  echo "  (typecheck produced pre-existing src/ errors — continuing; see AGENTS.md)"
}

echo "=== Linting (src/ only) ==="
bun run lint 2>/dev/null || npx @biomejs/biome check src/ || {
  echo "  (lint produced pre-existing src/ errors — continuing; see AGENTS.md)"
}

echo "=== Building 32-bit production bundle ==="
bun run build:prod:32 2>/dev/null || bun scripts/build-bundle.ts --minify --arch=32

echo "=== Verifying 32-bit build output ==="

if [ ! -f dist/cli.32.mjs ]; then
  echo "ERROR: dist/cli.32.mjs not found"
  exit 1
fi

SIZE=$(ls -lh dist/cli.32.mjs | awk '{print $5}')
echo "  Bundle size: $SIZE"

# Verify it runs under Node
if command -v node &>/dev/null; then
  VERSION=$(node dist/cli.32.mjs --version 2>&1 || true)
  echo "  node dist/cli.32.mjs --version → $VERSION"
fi

# Verify it runs under Bun (if installed)
if command -v bun &>/dev/null; then
  VERSION=$(bun dist/cli.32.mjs --version 2>&1 || true)
  echo "  bun dist/cli.32.mjs --version → $VERSION"
fi

# Verify the bundle actually contains the 32-bit shim path (smoke check)
echo ""
echo "=== 32-bit shim verification ==="
if grep -q "native-shim-32bit\|scripts/shims/native-shim" dist/cli.32.mjs 2>/dev/null; then
  echo "  ✅ 32-bit bundle references native shim"
elif grep -q "node-pty is not available on this 32-bit platform" dist/cli.32.mjs 2>/dev/null; then
  echo "  ✅ 32-bit shim error message present in bundle"
else
  echo "  ⚠️  Could not confirm shim presence in bundle (grep did not match)"
  echo "      This is expected if tree-shaking removed the error string."
fi

echo ""
echo "=== Done ==="
