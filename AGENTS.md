# AGENTS.md

Guide for AI agents working in this repository. Read this before making changes.

## What this repo is

This is an **archive of the leaked Claude Code CLI source** (`src/`, ~1,900 files, ~512K lines of TypeScript) plus a build/tooling layer and a sub-project MCP server that the repo author added on top. Treat these as **two distinct surfaces**:

1. **`src/`** — the original leaked source, preserved unmodified.
2. **Everything else** (`scripts/`, `mcp-server/`, `web/`, `docker/`, `docs/`, `prompts/`, root configs) — community-added build, packaging, exploration, and docs tooling.

### CRITICAL: Do not modify `src/`

Per `CONTRIBUTING.md` and `agent.md`, the `src/` directory is the original leaked source and **must not be modified**. The unmodified original is preserved on the `backup` branch. Changes go into `scripts/`, `mcp-server/`, `web/`, `docs/`, or other supporting directories only. If a task seems to require editing `src/`, stop and confirm — you're likely misreading the task.

The one exception: `src/shims/` (`bun-bundle.ts`, `macro.ts`, `preload.ts`) — these are runtime shims the build layer needs and reference from `bunfig.toml` and the build scripts. Verify against the latest state before editing.

## Sub-projects at a glance

| Sub-project | Location | Build | Notes |
|---|---|---|---|
| CLI bundle | root (`package.json`) | `bun run build` | Bundles `src/entrypoints/cli.tsx` → `dist/cli.mjs` via esbuild |
| MCP explorer server | `mcp-server/` | `npm run build` (tsc) | Separate npm package: `warrioraashuu-codemaster`. Has its own `package.json`, `tsconfig.json`. Published to npm. |
| Web UI | `web/` | `npm run build` (next) | Next.js 14 + Radix UI + Tailwind. Independent of the CLI bundle. |
| Docker runtime | `Dockerfile` (root) + `docker/` | `docker build -t claude-code .` | Multi-stage: builds bundle, runs under `oven/bun:1-alpine` with `git` and `ripgrep` installed. |
| Vercel HTTP MCP | `vercel.json` | routes `/mcp`, `/sse`, `/messages` → `mcp-server/api/index.ts` | Hosts the MCP server with HTTP/SSE transports. |

Each sub-project has **its own `package.json` and `tsconfig.json`** and uses a different toolchain. Do not assume root-level commands work inside sub-projects — `cd` into them first.

## Essential commands

All commands assume root directory unless noted. Runtime is **Bun >=1.1.0** (`engines` in `package.json`); the bundled output also runs under Node 20+.

### Install

```bash
bun install                      # root: install CLI deps
cd mcp-server && npm install     # mcp-server deps (npm, not bun)
cd web && npm install            # web deps (npm)
```

`scripts/build.sh install` also autoselects `bun` or `npm` based on what's on PATH.

### Build the CLI bundle

```bash
bun run build            # esbuild → dist/cli.mjs (+ dist/cli.mjs.map, dist/meta.json)
bun run build:watch      # watch mode
bun run build:prod       # minified production bundle
bun run build:32         # 32-bit dev bundle → dist/cli.32.mjs (native shims; see "32-bit compatibility")
bun run build:prod:32   # 32-bit minified production bundle
bun run build:web        # build the web UI (separate Next.js app in web/)
```

The bundler is **esbuild** (not Bun's bundler), defined in `scripts/build-bundle.ts`. Key behavior:
- Entry: `src/entrypoints/cli.tsx`
- Output: `dist/cli.mjs` (ESM, with `#!/usr/bin/env node` shebang banner, made executable via `chmod 0o755`)
- `bun:bundle` is aliased to `src/shims/bun-bundle.ts` (runtime feature-flag shim — returns `false` for unknown flags)
- `MACRO.VERSION`, `MACRO.PACKAGE_URL`, `MACRO.ISSUES_EXPLAINER` are inlined at build time via `define`
- `process.env.USER_TYPE` is defined to `"external"` — **strips all Anthropic-internal (`'ant'`) code branches** at build time
- Anthropic-internal packages (`@anthropic-ai/sandbox-runtime`, `@anthropic-ai/claude-agent-sdk`, `@antropic-ai/*`, `@ant/*`) are marked `external` and **expected to be absent** — code paths using them are gated behind `USER_TYPE === 'ant'` and should never execute for external users
- A custom `src-resolver` esbuild plugin resolves bare `src/...` imports ( relying on tsconfig `baseUrl: "."`)

### Lint / typecheck

```bash
bun run typecheck     # tsc --noEmit (root tsconfig, src/ only)
bun run lint          # biome check src/
bun run lint:fix      # biome check --write src/
bun run format        # biome format --write src/
bun run check         # biome check + tsc --noEmit (combined)
./scripts/build.sh check    # same thing via shell script
```

**Important:** `tsc` and `biome` are scoped to `src/` — they do **not** check `scripts/`, `mcp-server/`, `web/`, or `docs/`. Each sub-project has its own config; run lint/typecheck inside the sub-project if you change it.

### Run

```bash
bun run dev                  # dev launcher: scripts/dev.ts → loads MACRO shim, then imports cli.tsx
bun scripts/dev.ts [args]    # same, with explicit args
bun dist/cli.mjs --version   # run the production bundle (after build)
node dist/cli.mjs --version  # also works — bundle targets node20+es2022
```

`scripts/dev.ts` runs the CLI **directly via Bun's TS runtime** (no bundle step). The `bun:bundle` shim is auto-loaded via `bunfig.toml` `preload = ["./scripts/bun-plugin-shims.ts"]`. Bun auto-reads `.env` from the repo root.

### Test

There is **no test runner configured**. `package.json` has no `test` script, no `vitest.config.ts`, and no `tests/` directory. The `scripts/test-*.ts` files are **manual smoke scripts** you run via Bun:

```bash
bun scripts/test-commands.ts   # load all commands, assert essential ones present, exit 1 on missing
bun scripts/test-services.ts    # import services, verify they init without crashing (uses src/shims/preload.js)
bun scripts/test-mcp.ts         # spawn mcp-server/dist/index.js, MCP client roundtrip (needs `cd mcp-server && npm run build` first)
bun scripts/test-auth.ts       # real API call to verify ANTHROPIC_API_KEY works (uses @anthropic-ai/sdk)
```

`test-services.ts` sets `NODE_ENV=test` defensively and loads `src/shims/preload.js` first — **follow that pattern** for any new test script that imports `src/` code, otherwise the MACRO/bun:bundle globals won't be defined and imports will fail.

`prompts/16-testing.md` describes the intended but **not-yet-implemented** Vitest setup. Don't claim tests exist — they don't.

### CI pipeline

`scripts/ci-build.sh` runs the full pipeline: `bun install` → `typecheck` → `lint` → `build:prod` → verify `dist/cli.mjs` exists and prints a version via both `node` and `bun`. There is **no `.github/workflows/`** — `.github/` contains only `FUNDING.yml`. CI is presumably wired externally.

### Docker

```bash
docker build -t claude-code .
docker run --rm -e ANTHROPIC_API_KEY=sk-... claude-code -p "hello"
```

`docker/docker-compose.yml` and `docker/entrypoint.sh` exist for a richer runtime setup.

### MCP server (sub-project)

```bash
cd mcp-server
npm install
npm run dev          # tsx src/index.ts (no build)
npm run build        # tsc → dist/
npm start            # node dist/index.js (STDIO transport)
npm run start:http   # HTTP + SSE transports on :3000 (/mcp, /sse, /health)
```

Published to npm as `warrioraashuu-codemaster`. Set `CLAUDE_CODE_SRC_ROOT=/path/to/src` to point it at a non-default source tree (defaults to sibling `../src`).

### Build the npm package

```bash
bun run build:prod                 # produces dist/cli.mjs
bun scripts/package-npm.ts         # assembles dist/npm/ with cli.mjs + package.json
```

`package-npm.ts` requires `dist/cli.mjs` to exist first; it generates a publishable `dist/npm/` with `engines.node: >=20.0.0`, `os: [darwin, linux, win32]`.

## 32-bit compatibility

The CLI also needs to run on 32-bit platforms (Android `armv7l`/`armv8l`, Raspberry Pi `armv6`/`armv7`, older `i386`/`i686`). The blockers are native addons (`.node` prebuilds) whose prebuilt binaries don't exist for 32-bit arches:

| Native dep | Used by | 32-bit strategy |
|---|---|---|
| **`node-pty`** | `src/server/web/pty-server.ts` (web-server PTY mode only) | Optional dep + esbuild routes import to no-op shim |
| **`image-processor-napi`** | `src/tools/FileReadTool/imageProcessor.ts` (only in `isInBundledMode()` — not our build path) | Routes to no-op shim; existing try/catch falls back to `sharp` |
| **`sharp`** | `imageProcessor.ts`, `FileReadTool.ts`, `imageResizer.ts`, `imagePaste.ts` | Already external + dynamic-imported with try/catch fallback. Optional dep. |
| **`audio-capture-napi`** | `src/services/voice.ts` (voice input) | macOS-only (CoreAudio). Skipped on non-macOS; no action needed. |
| **`fsevents`** | (none in runtime code) | macOS-only, build-external. No action. |
| **`@anthropic-ai/sandbox-runtime`**, **`@ant/*`** | sandbox-adapter | Gated behind `USER_TYPE === 'ant'`, which the build `define`s to `"external"` — fully stripped. No action. |

The xterm addons (`@xterm/addon-*`) are **browser-side JS**, not native Node addons — they ship in the web UI bundle and don't need 32-bit fixes.

### Building for 32-bit

```bash
bun run build:32          # dev bundle → dist/cli.32.mjs (uses native-shim plugin)
bun run build:prod:32     # minified → dist/cli.32.mjs
bun run package:32        # assembles dist/npm-32/ (separate publishable package)
./scripts/ci-build-32.sh  # full CI pipeline with --no-optional install + 32-bit build + verification
```

The `--arch=32` flag (`scripts/build-bundle.ts`) does three things:

1. Registers the `native-shim-32bit` esbuild plugin that rewrites `import('node-pty')` and `import('image-processor-napi')` to `scripts/shims/native-shim.ts`.
2. Removes `node-pty` from the `external` array (so the shim resolution is the only one).
3. Renames the output to `dist/cli.32.mjs` so 32-bit and 64-bit bundles can coexist.

`package-npm.ts --arch=32` produces `dist/npm-32/` as a separate publishable package named `@anthropic-ai/claude-code-32` with `cpu: ['arm','armv7l','armv8l','ia32','x32']` so npm refuses to install it on 64-bit hosts.

### Installing on 32-bit

```bash
bun install --no-optional      # skips node-pty and sharp prebuilds
# or
npm install --no-optional
```

`package.json` lists `node-pty` and `sharp` in `optionalDependencies`; `--no-optional` means install never fails on a 32-bit host even when prebuilds are unavailable.

### What you lose on a 32-bit build

- **Web-server PTY mode** (`node . --web` server that spawns `claude` in a PTY) — `pty-server.ts` will throw a clear runtime error if invoked. Use the `claude` CLI directly.
- **Native image processing** — `imageProcessor.ts` falls back to `sharp`, and if `sharp` is also missing the existing try/catch returns null and image-dependent tools (FileRead of images, image paste, image resize) gracefully degrade or skip.
- **Voice input** — `audio-capture-napi` is macOS-only and not affected on Android/Linux 32-bit platforms (it was never loadable there).

### What still works on a 32-bit build

Everything else: the REPL, all ~40 tools except image ones, all ~50 slash commands, MCP client/server, the IDE bridge, skills, plugins, git workflows, file editing, search.

### Adding a new native dep

If a new native addon gets introduced to `src/`: add it to `optionalDependencies` in `package.json`, add an `onResolve` filter in `scripts/build-bundle.ts`'s `nativeShimPlugin`, and provide a no-op stub in `scripts/shims/native-shim.ts` matching the API surface used in `src/`. **Do not add the dep to `dependencies`** — that would break `bun install --no-optional` on 32-bit.

## Code organization

### `src/` layout (do not edit — reference only)

Read `docs/architecture.md`, `docs/exploration-guide.md`, `docs/subsystems.md`, `docs/tools.md`, `docs/commands.md` for the deep dives. A condensed map:

- `src/main.tsx` — Commander.js CLI parser + Ink renderer entry
- `src/QueryEngine.ts` (~46K lines) — core LLM API loop: streaming, tool-call loop, retries, token counting
- `src/Tool.ts` (~29K lines) — `buildTool()` factory + tool type defs
- `src/commands.ts` (~25K lines) — command registry with conditional per-environment imports
- `src/tools.ts` — tool registry
- `src/context.ts` — system/user context collection
- `src/cost-tracker.ts` — token cost tracking
- `src/entrypoints/` — `init.ts`, `cli.tsx`, `mcp.ts`, `sdk/` (programmatic API)
- `src/tools/{ToolName}/` — each tool: `{ToolName}.tsx` (impl), `UI.tsx` (render), `prompt.ts` (system prompt), index.ts (re-export)
- `src/commands/` — slash commands (PromptCommand / LocalCommand / LocalJSXCommand)
- `src/services/` — `api/`, `mcp/`, `oauth/`, `lsp/`, `analytics/`, `plugins/`, `compact/`, `policyLimits/`, etc.
- `src/bridge/` — IDE bridge (VS Code, JetBrains), JWT auth
- `src/hooks/toolPermission/` — permission checks on every tool call
- `src/schemas/`, `src/migrations/` — Zod config schemas + version migrations
- `src/state/` — `AppStateStore.ts`, `onChangeAppState.ts`
- `src/coordinator/`, `src/tasks/`, `src/memdir/`, `src/skills/`, `src/plugins/` — subsystems
- `src/shims/` — **the one directory in `src/` that the build layer depends on** (`bun-bundle.ts`, `macro.ts`, `preload.ts`)

### Patterns to recognize when reading `src/`

- **`buildTool({ name, inputSchema, call, checkPermissions, isConcurrencySafe, isReadOnly, prompt, renderToolUseMessage, renderToolResultMessage })`** — every tool uses this factory.
- **`satisfies Command`** — every command uses this pattern; three types: `prompt` | `local` | `local-jsx`.
- **`import { feature } from 'bun:bundle'`** — feature-flag gate. In our build, the shim (`src/shims/bun-bundle.ts`) returns `false` for unknown flags, so gated code never runs. At bundle time the code is still included but the `if (feature(...))` branch is dead.
- **`process.env.USER_TYPE === 'ant'`** — Anthropic-internal gate. Our `define` sets this to `"external"`, so these branches are **completely stripped** from the bundle.
- **ESM with `.js` extensions for `.ts` files** — `import './foo.js'` actually resolves to `./foo.ts`. The esbuild resolver follows `['.tsx', '.ts', '.jsx', '.js', '.json']`.
- **Lazy dynamic imports** for heavy modules (OpenTelemetry ~400KB, gRPC ~700KB): `const mod = await import('./heavy.js')`.
- **Barrel `index.ts` re-exports** in most directories.
- **`MACRO.VERSION`**, `MACRO.PACKAGE_URL`, `MACRO.ISSUES_EXPLAINER` — compile-time globals; in dev (`scripts/dev.ts`) they're seeded by `src/shims/macro.js`, in bundle by `define`.

### Supporting directories (editable)

- `scripts/` — Bun-runnable build/test/dev/package scripts. `bunfig.toml` preloads `./scripts/bun-plugin-shims.ts` for dev runs.
- `mcp-server/` — standalone TypeScript MCP server. Published as `warrioraashuu-codemaster`. See `mcp-server/README.md`.
- `web/` — Next.js 14 + Radix + Tailwind, independent toolchain.
- `docker/` — runtime containerization (root `Dockerfile` is the canonical build; `docker/` has compose + entrypoint for a richer setup).
- `docs/` — architecture, tools, commands, subsystems, exploration-guide markdown. The authoritative reference for `src/`.
- `prompts/` — numbered build-out prompts (`00-overview.md` → `16-testing.md`) that were used to construct the supporting tooling. Useful as historical context for *why* the build layer is shaped the way it is.
- `server.json` (root) — appears to be an MCP server manifest snapshot (the live one is `mcp-server/server.json`).

## Conventions & style

### Biome (root, `src/` only)

From `biome.json`:
- **Indent:** tab, width 2 (effective 2-wide tabs)
- **Line width:** 100
- **Quotes:** single
- **Semicolons:** asNeeded (no trailing semicolons unless required by ASI hazards)
- **Trailing comma:** Biome default (es5)
- **Linter:** recommended rules + `noExcessiveCognitiveComplexity` warn, `noUnusedImports`/`noUnusedVariables` warn, `useImportType` warn, `noNonNullAssertion` off, `noExplicitAny` off
- **Ignore:** `node_modules`, `dist`, `*.d.ts`
- **JSON:** 2-space indent (different from JS/TS tabs)

### TypeScript (`tsconfig.json`)

- `target`/`module`: ESNext, `moduleResolution: bundler`
- `jsx: react-jsx`
- `strict: true`, `skipLibCheck: true`, `isolatedModules: true`, `noEmit: true`, `declaration: false`, `verbatimModuleSyntax: false`
- `allowImportingTsExtensions: true`
- `paths`: `bun:bundle` → `./src/types/bun-bundle.d.ts`
- `include: src/**/*.ts, src/**/*.tsx` — **only `src/` is type-checked at root**
- `exclude: node_modules, dist`

### File naming (observed in `src/`)

- **Components/tools:** PascalCase (`BashTool.tsx`, `App.tsx`, `PromptInput.tsx`)
- **Commands:** kebab-case files (`commit-push-pr.ts`)
- **Hooks:** `use` prefix (`useCanUseTool`, `useSettings`)
- **Types:** PascalCase with suffix (`ToolUseContext`, `*Props`, `*State`, `*Context`)
- **Constants:** SCREAMING_SNAKE_CASE (`MAX_TOKENS`, `DEFAULT_TIMEOUT_MS`)

### Indentation gotcha

`CONTRIBUTING.md` says "2-space indentation (tabs for `src/` to match Biome config)" — that's accurate. **`src/` uses tabs; new code in `scripts/`, `mcp-server/`, `web/` may use spaces** — match the file you're editing. `biome.json` only applies to `src/`.

## Gotchas an agent will hit

1. **`bun:bundle` does not exist as a real module.** It's a Bun-bundler compile-time primitive. In this repo it's aliased to `src/shims/bun-bundle.ts` at build time and preloaded via `bunfig.toml` at dev time. If you see `import { feature } from 'bun:bundle'`, do not try to install a package — the shim handles it.
2. **`MACRO` is a global, not an import.** Seeded by `src/shims/macro.ts` (dev) or inlined via esbuild `define` (bundle). Anywhere you see `MACRO.VERSION` etc. without an import, this is why.
3. **`process.env.USER_TYPE === 'ant'` branches are dead** in external builds. Don't try to wire up `@anthropic-ai/sandbox-runtime`, `@anthropic-ai/claude-agent-sdk`, or `@ant/*` — they're marked external and intentionally unreachable.
4. **Type-check / lint scope is `src/` only.** If you edit `scripts/foo.ts`, `tsc --noEmit` and `biome check src/` won't catch your mistakes. Run `tsc` directly on the file or use the file's sub-project config. `scripts/tsconfig.json` exists for the `scripts/` directory.
5. **No test runner.** `bun run test` does nothing (no script). Smoke scripts in `scripts/test-*.ts` are the closest thing — run them manually via Bun, and follow the `src/shims/preload.js` import pattern if you add more.
6. **Sub-projects have separate toolchains.** `mcp-server/` uses npm + tsc + express; `web/` uses npm + Next.js + Radix + Tailwind. Don't cross-import between them and the root.
7. **`prompts/16-testing.md` is a plan, not a fact.** It describes the *intended* Vitest setup, which was never landed. Don't reference vitest as if it's configured.
8. **LSP/Pyright diagnostics in this environment are noisy and often wrong** (the `tvm_ffi_navigator Pyright` server reports spurious errors on `.md`, `.json`, `.sh`, `.ts` files — e.g. "Expected expression" in `README.md`). Trust the actual `tsc`/`biome`/`esbuild` output, not these diagnostics.
9. **`agent.md` vs `Skill.md`** — both exist with overlapping content but slightly different framing. `agent.md` is the short agent operating guide (the basis for this file). `Skill.md` is a longer "Repository Skill" doc with more `src/` reference tables. When they disagree, prefer `agent.md` + `CONTRIBUTING.md` for *behavior* and `Skill.md` + `docs/` for *reference*.
10. **The repo is `private: true` and `license: UNLICENSED`** (`package.json`). The MCP server `mcp-server/package.json` is separately published under MIT. Don't add license headers to `src/`.
11. **32-bit builds route native modules to no-op shims.** `bun run build:32` passes `--arch=32`, which registers the `native-shim-32bit` esbuild plugin in `scripts/build-bundle.ts`. That plugin rewrites `import('node-pty')` and `import('image-processor-napi')` to `scripts/shims/native-shim.ts`. If a build is failing on 32-bit, check whether the failing import is a native addon the shim doesn't cover yet; if so, add it to `nativeShimPlugin.onResolve`, add a stub to `scripts/shims/native-shim.ts`, and add it to `optionalDependencies` in `package.json`. Native deps must NEVER go in `dependencies` — that breaks `--no-optional` installs on 32-bit.

## Existing rule files

- `agent.md` — short agent operating guide (this file's predecessor; preserved).
- `Skill.md` — longer architecture/naming reference for the Claude Code source.
- `CONTRIBUTING.md` — what's in/out of scope for contributions (the `src/` rule lives here).
- `docs/` — full architecture/tools/commands/subsystems/exploration guides, authoritative for `src/`.
- No `.cursor/rules/`, `.cursorrules`, `.github/copilot-instructions.md`, or `claude.md` files exist.

When in doubt about whether a change is allowed: **`src/` is off-limits; everything else is fair game**, and the MCP server + build scripts are the most actively maintained parts.
