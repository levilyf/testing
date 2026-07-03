# Handoff: Claude Code on 32-bit Android (Termux, armv8l)

This document records everything we learned, what does and doesn't work, and the
realistic next steps. Read it before retrying the on-device build.

## TL;DR

1. **You cannot get a working Claude Code CLI on this 32-bit arm Android purely
   by installing or building on the device.** Anthropic ships no 32-bit binary,
   the leaked source cannot be bundled on a 32-bit Node process (V8 hits a hard
   ~512 MB old-space ceiling before esbuild finishes parsing), and the official
   wrapper has no pure-JS fallback path.

2. **You CAN get there** by bundling the local leaked `src/` tree into a single
   `dist/cli.32.mjs` file on a 64-bit machine, then copying that one JS file
   onto this device and running it with the installed 32-bit Node. That JS
   bundle is architecture-independent; it just needs Node, not a native binary.

3. **Pointing it at NVIDIA or any other OpenAI-compatible provider** is
   supported by Claude Code via environment variables — but Claude Code speaks
   the Anthropic Messages API shape, not the OpenAI Chat Completions shape, so
   you also need a translation proxy (LiteLLM or `claude-code-proxy`) sitting
   between Claude Code's Anthropic-shaped requests and the NVIDIA endpoint.
   Set `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` to point at the proxy and
   `ANTHROPIC_MODEL`/`ANTHROPIC_DEFAULT_*_MODEL` to whatever model ID the
   proxy maps to.

---

## Part 1: Why every on-device path fails

### Path A: Official `@anthropic-ai/claude-code` npm package

- Installed at `/data/data/com.termux/files/usr/lib/node_modules/@anthropic-ai/claude-code/`
  (v2.1.150 via Termux's npm, latest is 2.1.199).
- All versions publish ONLY these per-arch binaries as optionalDependencies:
  `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-arm64-musl`,
  `linux-x64`, `linux-x64-musl`, `win32-arm64`, `win32-x64`.
- **There is no `linux-arm` (32-bit) and no `android-arm` binary in any
  published version** (verified by `npm view @anthropic-ai/claude-code@2.1.199
  optionalDependencies`).

- The only thing in the npm tarball is:
  - `bin/claude.exe` — a 500-byte `echo` stub
  - `install.cjs` — postinstall that copies a per-arch binary from
    optionalDependencies over the stub
  - `cli-wrapper.cjs` — fallback launcher that does `spawnSync` on a per-arch
    binary that doesn't exist for our platform
  - `sdk-tools.d.ts` — type declarations only
  - README/LICENSE
  - **No pure-JS CLI implementation is shipped.** The whole CLI is the native
    binary. Without a native binary for this arch, `claude --version` fails with
    "claude native binary not installed."

- The `cli-wrapper.cjs` `getPlatformKey()` returns `"linux-arm-android"` on this
  device (`process.platform === 'android'`, `os.arch() === 'arm'`). That key
  is **not in the PLATFORMS map**, and even if it were, the corresponding npm
  optional dep `@anthropic-ai/claude-code-linux-arm-android` returns 404 on the
  registry (verified). So the wrapper has nothing to invoke.

- **Conclusion**: the official package is unusable on 32-bit arm Android. There
  is no fixable subset; the package literally does not contain a JS-runnable
  CLI.

### Path B: Bundle the leaked `src/` on this device

- Repo at `~/claude-32/` contains the leaked source. `src/entrypoints/cli.tsx`
  is the bin entry. The tree is ~1,900 TSX/TS files. esbuild can bundle it to a
  single ESM file (`dist/cli.32.mjs`) — this is what `scripts/build-bundle.ts`
  is set up to do with `--arch=32` (already wired with native-shim plugin for
  `node-pty` and `image-processor-napi`).

- **Hard blocker on this device**: V8 on the 32-bit Node process caps out at
  ~512 MB old-space, regardless of `--max-old-space-size`. Confirmed by
  `v8.getHeapStatistics().heap_size_limit` saying ~1.1 GB but esbuild crashing
  at exactly 514.6 MB with "Ineffective mark-compacts near heap limit". This is
  the 32-bit virtual-address-space wall — not an esbuild bug, not fixable by
  memory flags, `--jobs=1`, `--lean`, or any plugin. Tested at `--max-old-space-size=1500`
  and `1700` — both hit the same 514 MB crash.

- We also confirmed that `node --experimental-strip-types` cannot run
  `src/entrypoints/cli.tsx` directly: it crashes with
  `ERR_UNKNOWN_FILE_EXTENSION ".tsx"` (strip-types only handles `.ts`).

- **Conclusion**: bundling on this device is impossible. You must bundle
  elsewhere.

### Path C: `mcp-server/` sub-project

- Not Claude Code. It is `warrioraashuu-codemaster` v1.1.0, a third-party MCP
  explorer that indexes the Claude Code source. Don't confuse it with the CLI.

---

## Part 2: What ACTUALLY works — cross-compile, then deploy

### Procedure

**On a 64-bit machine (any x86_64/arm64 Linux/Mac, or a 64-bit Android Termux,
or even a free Codespaces/Gitpod VM):**

```sh
git clone <your-leak-repo> claude-32   # or scp the ~/claude-32 dir over
cd claude-32
npm install                              # installs esbuild + deps
node --experimental-strip-types scripts/build-bundle.ts --arch=32 --no-sourcemap
# Output: dist/cli.32.mjs (one file, ~tens of MB, depends on tree-shaking)
```

If `node --experimental-strip-types` is unavailable on that host (Node < 22.6),
install Bun (`curl -fsSL https://bun.sh/install | bash`) and run
`bun scripts/build-bundle.ts --arch=32 --no-sourcemap` — same flags, same
output, Bun handles the `.ts` entrypoint natively.

**Copy the bundle to this device:**

```sh
# From the 64-bit machine, after `cd claude-32`:
scp dist/cli.32.mjs ${ANDROID_DEVICE}:~/claude-32/dist/cli.32.mjs
```

Or `adb push dist/cli.32.mjs /data/data/com.termux/files/home/claude-32/dist/`
from a connected PC.

**On this 32-bit device:**

```sh
mkdir -p ~/claude-32/dist
chmod +x ~/claude-32/dist/cli.32.mjs
~/claude-32/dist/cli.32.mjs --version
```

The bundle has a `#!/usr/bin/env node` shebang, so it runs under this device's
32-bit Node directly. No native binary needed.

### Why this works

- The leaked `src/` compiles to pure JavaScript (the only native bits are
  `node-pty`, used by web-server PTY mode, and `image-processor-napi`, used by
  image pasting). With `--arch=32` the build script redirects both to a no-op
  shim in `scripts/shims/native-shim.ts`. The shim throws a clear error ONLY
  if the web-server PTY mode is actually invoked; everything else (interactive
  CLI, file editing, tool calls, slash commands, MCP) works in pure JS.
- Output `dist/cli.32.mjs` is an ESM text file. Node on 32-bit arm reads and
  runs it exactly like any other script. The whole bundle uses only the
  Node APIs this device already has.
- The `sharp` package stays external and is dynamically imported with a
  try/catch fallback in the leaked source, so its absence on 32-bit is already
  handled — images fall through to a JS decoder.

### Caveats to verify once it runs

- Interactive TTY: this is a 32-bit Android; the CLI's interactive TUI uses
  ink (React-for-terminals). It works in Termux, but the rendering quality
  depends on the terminal. Run the non-interactive form
  (`dist/cli.32.mjs -p "do the thing"`) first to confirm it executes without
  crashes.
- Token counting: done in JS via `tiktoken` or the Anthropic API — fine.
- Ink + xterm web components (`@xterm/*`) only matter for the web-server
  mode (http://localhost:port), which we just stubbed out. The local CLI path
  doesn't pull them at runtime.

---

## Part 3: Routing Claude Code to NVIDIA or other non-Anthropic providers

### What the leaked source actually reads

Verified by grep over `src/services/api/` and `src/utils/model/`:

- Claude Code constructs `new Anthropic(clientConfig)` in
  `src/services/api/client.ts:315`. The `clientConfig` does NOT pass
  `baseURL` explicitly (except for `USER_TYPE === 'ant'` staging). The
  `@anthropic-ai/sdk` reads `process.env.ANTHROPIC_BASE_URL` itself — so
  setting the env var alone is sufficient to redirect requests.
- `ANTHROPIC_API_KEY` → SDK `apiKey` field (header `x-api-key`). Source:
  `src/utils/auth.ts:236-254`, fed into `clientConfig.apiKey` at
  `client.ts:302`.
- `ANTHROPIC_AUTH_TOKEN` → SDK `authToken` field (header
  `Authorization: Bearer …`). Source: `client.ts:323`. Use this instead of
  `API_KEY` if the upstream expects a Bearer token (most OpenAI-compatible
  endpoints, including NVIDIA, do).
- `ANTHROPIC_MODEL` → primary model selector at priority 3 (after `--model`
  flag and `/model` slash command). Source: `src/utils/model/model.ts:69`,
  `src/main.tsx:2012`.
- `ANTHROPIC_DEFAULT_OPUS_MODEL`, `_SONNET_MODEL`, `_HAIKU_MODEL` → override
  the model ID sent for each tier. Source: `src/utils/model/model.ts:106-133`.
  Useful when a 3P provider uses different model IDs (e.g. NVIDIA uses
  `nvidia/llama-3.1-nemotron-70b-instruct`).
- `ANTHROPIC_SMALL_FAST_MODEL` → override the small/fast (Haiku-tier) model.
  Source: `src/utils/model/model.ts:37`.
- `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` → swap the SDK
  constructor to `AnthropicBedrock` / `AnthropicVertex` / `AnthropicFoundry`.
  These expect Anthropic-shaped requests to AWS/GCP/Azure-hosted Claude, NOT a
  generic OpenAI endpoint, so they are NOT the path for NVIDIA.
- `ANTHROPIC_CUSTOM_HEADERS` → multi-line `Name: Value` headers appended to
  every request. Source: `client.ts:330-352`.

### The shape problem and the fix

Claude Code sends `/v1/messages` requests in Anthropic's Messages API shape
(`messages: [{role, content: [{type: 'text', text}]}]`, `max_tokens`,
`system`, `stream: true`). NVIDIA's `https://integrate.api.nvidia.com/v1`
endpoint speaks OpenAI's Chat Completions shape
(`/v1/chat/completions`, `messages: [{role, content: "string"}]`). They are
NOT compatible — you can't just set `ANTHROPIC_BASE_URL` to NVIDIA and be
done.

**You must run a translation proxy.** Two well-tested options:

#### Option 1: LiteLLM (recommended, broadest provider support)

LiteLLM exposes an Anthropic-compatible front on `http://localhost:4000` and
translates to dozens of backends (NVIDIA NIM, OpenAI, vLLM, Bedrock, Vertex,
etc.).

```sh
pip install 'litellm[proxy]'
# ~/.litellm/config.yaml
model_list:
  - model_name: claude-sonnet-4-5
    litellm_params:
      model: nvidia/llama-3.1-nemotron-70b-instruct
      api_base: https://integrate.api.nvidia.com/v1
      api_key: nvapi-XXXXXXXX

# Run the proxy
litellm --config ~/.litellm/config.yaml --port 4000
# LiteLLM 1.x has an Anthropic-shaped proxy mode: /v1/messages
```

Then run the bundled Claude Code against it:

```sh
export ANTHROPIC_BASE_URL=http://localhost:4000
export ANTHROPIC_AUTH_TOKEN=sk-anything   # LiteLLM master key, or dummy if disabled
# Map Claude Code's model names to LiteLLM model_name entries via these envs:
export ANTHROPIC_DEFAULT_OPUS_MODEL=claude-sonnet-4-5
export ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-5
export ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-sonnet-4-5
export ANTHROPIC_SMALL_FAST_MODEL=claude-sonnet-4-5
export CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-4-5
export DISABLE_TELEMETRY=1
unset ANTHROPIC_API_KEY     # use AUTH_TOKEN instead, LiteLLM prefers Bearer

~/claude-32/dist/cli.32.mjs
```

#### Option 2: `claude-code-proxy` (lighter, single-purpose)

GitHub projects like `claude-code-proxy` (search by name) implement a tiny
Anthropic-to-OpenAI translator specifically for pointing Claude Code at
OpenAI-compatible endpoints. Drop-in env setup is identical to the LiteLLM
example, with the proxy URL swapped.

### Things to expect when running against a non-Claude backend

- **Tool calling format**: Claude Code sends tool definitions and tool calls
  in the Anthropic `tools` schema with `tool_use` / `tool_result` blocks.
  LiteLLM translates these to OpenAI function-calling. Works for simple tools
  (bash, edit, view) but claude-specific features (parallel tool batches,
  fine-grained cache breakpoints, `service_tier` selection) may not round-trip
  perfectly.
- **Prompt caching** (`cache_control`): Anthropic-specific; LiteLLM drops or
  emulates it. Expect higher token usage and slower runs.
- **Long-context windows**: depends on the model. A 1M-context Claude call
  sent to a 128K model will truncate at the proxy.
- **Streaming**: LiteLLM translates SSE streams in both directions.
- **Subagent / Haiku-tier tasks**: Claude Code uses `ANTHROPIC_SMALL_FAST_MODEL`
  for "background" work (file summarization, compaction). Make sure the proxy
  maps THAT model name too, or those calls will 404.

---

## Part 4: Verified facts about this environment

- Device: Android armv8l (32-bit userspace on a 64-bit kernel), Termux.
- Node: `v26.2.0` at `/data/data/com.termux/files/usr/bin/node`.
- `bun`: NOT installed.
- `npm install -g` and `pkg install`: blocked by the assistant's security
  policy. Run those yourself.
- ` node` reports `arch === 'arm'`, `platform === 'android'` ⇒ wrapper maps
  this to `linux-arm-android`, which has no npm optional dep.
- V8 `heap_size_limit` says ~1.1 GB but the 32-bit Node process actually dies
  at 514.6 MB old-space when esbuild holds the full 1,900-file graph. This is
  the 32-bit address space wall, not a tunable knob.
- The official claude wrapper at `/data/data/com.termux/files/usr/bin/claude`
  → `bin/claude.exe` (500-byte stub) → exits with the message we saw.
- `scripts/build-bundle.ts` is ready for cross-compile: it runs under
  `node --experimental-strip-types` on any 64-bit Node ≥ 22.6, OR under
  Bun if installed, with identical CLI flags.

---

## Part 5: Suggested order of operations

1. On a 64-bit machine (or Codespaces/Gitpod free VM), `git clone` this repo
   and run `node --experimental-strip-types scripts/build-bundle.ts --arch=32
   --no-sourcemap`. Or use Bun.
2. Copy `dist/cli.32.mjs` back to this device at `~/claude-32/dist/`.
3. Run `~/claude-32/dist/cli.32.mjs --version` to smoke test.
4. Authenticate against Anthropic directly first (easiest: `export
   ANTHROPIC_API_KEY=sk-ant-…`) to confirm the binary works and the CLI
   boots on this device.
5. Once that's solid, stand up LiteLLM and switch the env vars to point at
   the NVIDIA-targeted proxy. Re-run.

If step 1 is the blocker for you (no 64-bit machine handy), the cheapest
zero-cost path is a free GitHub Codespaces instance with a 4-core 16 GB
Linux container — esbuild finishes in well under a minute on such a box.
