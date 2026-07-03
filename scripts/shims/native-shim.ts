// scripts/shims/native-shim.ts
//
// No-op shims for native addons whose prebuilds are unavailable on 32-bit
// targets (armv7l / armv8l / ia32). The build script's --arch=32 flag routes
// the following imports here:
//
//   - `node-pty`              -> NodePtyShim   (web-server PTY mode disabled)
//   - `image-processor-napi`  -> ImageProcessorShim (image features fall back to sharp)
//
// Both shims intentionally throw late — *only if the feature is actually used*
// — so building and running `claude --version`, the REPL, and most tools still
// works on 32-bit. The error message tells the user what they lost and why.
//
// DO NOT edit `src/` to add these — `src/` is the preserved leaked source.
// The build script's resolver plugin rewrites the import specifier to this
// file at bundle time, so `src/server/web/pty-server.ts` and
// `src/tools/FileReadTool/imageProcessor.ts` load these without being
// modified themselves.

// ───────────────────────────────────────────────────────────────────────────
// node-pty shim
// ───────────────────────────────────────────────────────────────────────────

export type IPty = {
  pid: number
  cols: number
  rows: number
  onData(cb: (data: string) => void): void
  onExit(cb: (ev: { exitCode: number; signal?: number }) => void): void
  resize(cols: number, rows: number): void
  write(data: string): void
  kill(signal?: string): void
}

export function spawn(
  _file: string,
  _args: string[] | undefined,
  _options: {
    name?: string
    cols?: number
    rows?: number
    cwd?: string
    env?: Record<string, string>
  },
): IPty {
  throw new Error(
    'node-pty is not available on this 32-bit platform. ' +
      'The web-server PTY mode (src/server/web/pty-server.ts) requires node-pty ' +
      'prebuilds that do not exist for 32-bit arches. Use the CLI directly ' +
      '(`claude` command) instead of the web server mode, or install node-pty ' +
      "from source after ensuring a build toolchain is present: " +
      "`npm rebuild node-pty`.",
  )
}

// ───────────────────────────────────────────────────────────────────────────
// image-processor-napi shim
// ───────────────────────────────────────────────────────────────────────────
//
// imageProcessor.ts getImageProcessor() only tries this in `isInBundledMode()`
// (Bun standalone binary), which our esbuild bundle is not. So normally this
// shim is never reached at runtime. We provide it so the bundler can resolve
// the dynamic `import('image-processor-napi')` to a real module when the
// native package is absent — the existing try/catch in imageProcessor.ts
// falls through to `sharp`.

export function getNativeModule() {
  return null
}

const imageProcessorShim = {
  sharp: null,
  default: null,
  getNativeModule,
}

export default imageProcessorShim
export const sharp = null
