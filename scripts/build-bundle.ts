// scripts/build-bundle.ts
// Usage: bun scripts/build-bundle.ts [--watch] [--minify] [--no-sourcemap] [--arch=32|64]
//
// Production build: bun scripts/build-bundle.ts --minify
// Dev build:        bun scripts/build-bundle.ts
// Watch mode:       bun scripts/build-bundle.ts --watch
// 32-bit target:    bun scripts/build-bundle.ts --arch=32
//                    (resolves native modules node-pty / image-processor-napi
//                     to no-op shims so the bundle runs on 32-bit arches where
//                     prebuilds are unavailable)

import * as esbuild from 'esbuild'
import { resolve, dirname } from 'path'
import { chmodSync, readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'

// Bun: import.meta.dir — Node 21+: import.meta.dirname — fallback
const __dir: string =
  (import.meta as any).dir ??
  (import.meta as any).dirname ??
  dirname(fileURLToPath(import.meta.url))

const ROOT = resolve(__dir, '..')
const watch = process.argv.includes('--watch')
const minify = process.argv.includes('--minify')
const noSourcemap = process.argv.includes('--no-sourcemap')

// --lean : aggressive memory reduction for low-RAM 32-bit hosts.
//   - Disables metafile analysis output
//   - Disables minification budget tracking
//   - Disables tree shaking (esbuild frees AST nodes earlier)
//   - Skips writing dist/meta.json
// Use when standard build OOMs; bundle is larger and unminified but functionally identical.
const lean = process.argv.includes('--lean')

// --jobs=N : cap esbuild's parallelism. The 1,900-file src/ tree can OOM on a
// 32-bit device if esbuild parses too many files concurrently. Default is
// unchecked (esbuild picks # of CPU cores). Try --jobs=1 if the build crashes
// with "The service was stopped" mid-bundle.
const jobsArg = process.argv.find((a) => a.startsWith('--jobs'))
const jobs = jobsArg ? parseInt(jobsArg.split('=')[1], 10) : undefined

// --arch=32 : build for 32-bit targets where native prebuilds are unavailable.
//   - Routes `node-pty` and `image-processor-napi` imports to no-op shims.
//   - sharp stays external (already dynamic-imported with try/catch fallback).
//   - Web-server PTY mode (`src/server/web/pty-server.ts`) will throw a clear
//     runtime error if invoked on a 32-bit build without node-pty installed.
const archArg = process.argv.find((a) => a.startsWith('--arch'))
const arch = archArg ? archArg.split('=')[1] : '64'
const is32Bit = arch === '32'

// Read version from package.json for MACRO injection
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'))
const version = pkg.version || '0.0.0-dev'

// ── Plugin: resolve bare 'src/' imports (tsconfig baseUrl: ".") ──
// The codebase uses `import ... from 'src/foo/bar.js'` which relies on
// TypeScript's baseUrl resolution. This plugin maps those to real TS files.
const srcResolverPlugin: esbuild.Plugin = {
  name: 'src-resolver',
  setup(build) {
    build.onResolve({ filter: /^src\// }, (args) => {
      const basePath = resolve(ROOT, args.path)

      // Already exists as-is
      if (existsSync(basePath)) {
        return { path: basePath }
      }

      // Strip .js/.jsx and try TypeScript extensions
      const withoutExt = basePath.replace(/\.(js|jsx)$/, '')
      for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
        const candidate = withoutExt + ext
        if (existsSync(candidate)) {
          return { path: candidate }
        }
      }

      // Try as directory with index file
      const dirPath = basePath.replace(/\.(js|jsx)$/, '')
      for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
        const candidate = resolve(dirPath, 'index' + ext)
        if (existsSync(candidate)) {
          return { path: candidate }
        }
      }

      // Let esbuild handle it (will error if truly missing)
      return undefined
    })
  },
}

// ── Plugin: resolve relative imports/requires with context ──
// Handles relative paths like '../services/compact/snipCompact.js' by resolving
// them relative to the importing file's directory, with .js → .ts fallback.
// Matches both ESM imports and CommonJS requires (esbuild normalizes both).
const relativeResolverPlugin: esbuild.Plugin = {
  name: 'relative-resolver',
  setup(build) {
    // Match relative paths: '../foo', './bar', '../../baz'
    build.onResolve({ filter: /^\.\.?\// }, (args) => {
      const importer = args.importer
      if (!importer) {
        // No importer context; let esbuild handle it
        return undefined
      }

      const importerDir = dirname(importer)
      const basePath = resolve(importerDir, args.path)

      // Already exists as-is
      if (existsSync(basePath)) {
        return { path: basePath }
      }

      // Strip .js/.jsx and try TypeScript extensions
      const withoutExt = basePath.replace(/\.(js|jsx)$/, '')
      for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
        const candidate = withoutExt + ext
        if (existsSync(candidate)) {
          return { path: candidate }
        }
      }

      // Try as directory with index file
      for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
        const candidate = resolve(withoutExt, 'index' + ext)
        if (existsSync(candidate)) {
          return { path: candidate }
        }
      }

      // Let esbuild handle it (will error if truly missing)
      return undefined
    })
  },
}

// ── Plugin (32-bit only): route native imports to no-op shims ──
// When --arch=32 is passed, node-pty and image-processor-napi prebuilds are
// typically unavailable. Redirect their imports to scripts/shims/native-shim.ts
// so the bundle builds and runs without those packages installed. The shim
// throws a clear error *only if* the feature is actually used at runtime.
const nativeShimPlugin: esbuild.Plugin = {
  name: 'native-shim-32bit',
  setup(build) {
    if (!is32Bit) return
    const shim = resolve(__dir, 'shims/native-shim.ts')
    // Static + dynamic `import('node-pty')` and `require('node-pty')`
    build.onResolve({ filter: /^node-pty$/ }, () => ({ path: shim }))
    // image-processor-napi — only ever dynamically imported
    build.onResolve({ filter: /^image-processor-napi$/ }, () => ({ path: shim }))
  },
}

const buildOptions: esbuild.BuildOptions = {
  entryPoints: [resolve(ROOT, 'src/entrypoints/cli.tsx')],
  bundle: true,
  platform: 'node',
  target: ['node20', 'es2022'],
  format: 'esm',
  outdir: resolve(ROOT, 'dist'),
  outExtension: { '.js': is32Bit ? '.32.mjs' : '.mjs' },

  // Single-file output — no code splitting for CLI tools
  splitting: false,

  plugins: [srcResolverPlugin, relativeResolverPlugin, nativeShimPlugin],

  // Use tsconfig for baseUrl / paths resolution (complements plugin above)
  tsconfig: resolve(ROOT, 'tsconfig.json'),

  // Alias bun:bundle to our runtime shim
  alias: {
    'bun:bundle': resolve(ROOT, 'src/shims/bun-bundle.ts'),
  },

  // Don't bundle node built-ins or problematic native packages
  external: [
    // Node built-ins (with and without node: prefix)
    'fs', 'path', 'os', 'crypto', 'child_process', 'http', 'https',
    'net', 'tls', 'url', 'util', 'stream', 'events', 'buffer',
    'querystring', 'readline', 'zlib', 'assert', 'tty', 'worker_threads',
    'perf_hooks', 'async_hooks', 'dns', 'dgram', 'cluster',
    'string_decoder', 'module', 'vm', 'constants', 'domain',
    'console', 'process', 'v8', 'inspector',
    'node:*',
    // Native addons that can't be bundled
    'fsevents',
    'sharp',
    // node-pty: external on 64-bit (resolved at runtime from node_modules);
    //            routed to scripts/shims/native-shim.ts on 32-bit by the
    //            nativeShimPlugin above.
    ...(is32Bit ? [] : ['node-pty']),
    'image-processor-napi',
    // Anthropic-internal packages (not published externally)
    '@anthropic-ai/sandbox-runtime',
    '@anthropic-ai/claude-agent-sdk',
    // Anthropic-internal (@ant/) packages — gated behind USER_TYPE === 'ant'
    '@ant/*',
  ],

  jsx: 'automatic',

  // Source maps for production debugging (external .map files)
  sourcemap: noSourcemap ? false : 'external',

  // Minification for production
  minify,

  // Tree shaking (on by default, explicit for clarity)
  // --lean disables it so esbuild can free file ASTs earlier in the pipeline.
  treeShaking: !lean,

  // Define replacements — inline constants at build time
  // MACRO.* — originally inlined by Bun's bundler at compile time
  // process.env.USER_TYPE — eliminates 'ant' (Anthropic-internal) code branches
  define: {
    'MACRO.VERSION': JSON.stringify(version),
    'MACRO.PACKAGE_URL': JSON.stringify('@anthropic-ai/claude-code'),
    'MACRO.ISSUES_EXPLAINER': JSON.stringify(
      'report issues at https://github.com/anthropics/claude-code/issues'
    ),
    'process.env.USER_TYPE': '"external"',
    'process.env.NODE_ENV': minify ? '"production"' : '"development"',
  },

  // Banner: shebang for direct CLI execution
  banner: {
    js: '#!/usr/bin/env node\n',
  },

  // Handle the .js → .ts resolution that the codebase uses
  resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.json'],

  logLevel: 'info',

  // Metafile for bundle analysis
  // --lean disables it to save memory (metafile retains per-file size data).
  metafile: !lean,
}

async function main() {
  if (is32Bit) {
    console.log('Building 32-bit bundle: node-pty → no-op shim, image-processor-napi → no-op shim')
    console.log('Native features unavailable on this build: web-server PTY mode, native image processing')
    console.log('Use `claude` CLI directly. See AGENTS.md > 32-bit compatibility for details.\n')
  }
  if (jobs !== undefined) {
    process.env.ESBUILD_MAX_WORKERS = String(jobs) // esbuild honors this env var on the worker pool
    console.log(`Capping esbuild parallelism to ${jobs} worker(s) via ESBUILD_MAX_WORKERS`)
  }
  if (watch) {
    const ctx = await esbuild.context(buildOptions)
    await ctx.watch()
    console.log('Watching for changes...')
  } else {
    const startTime = Date.now()
    const result = await esbuild.build(buildOptions)

    if (result.errors.length > 0) {
      console.error('Build failed')
      process.exit(1)
    }

    // Make the output executable (output is dist/cli.mjs or dist/cli.32.mjs)
    const outPath = resolve(ROOT, is32Bit ? 'dist/cli.32.mjs' : 'dist/cli.mjs')
    try {
      chmodSync(outPath, 0o755)
    } catch {
      // chmod may fail on some platforms, non-fatal
    }

    const elapsed = Date.now() - startTime

    // Print bundle size info
    if (result.metafile) {
      const text = await esbuild.analyzeMetafile(result.metafile, { verbose: false })
      const outFiles = Object.entries(result.metafile.outputs)
      for (const [file, info] of outFiles) {
        if (file.endsWith('.mjs')) {
          const sizeMB = ((info as { bytes: number }).bytes / 1024 / 1024).toFixed(2)
          console.log(`\n  ${file}: ${sizeMB} MB`)
        }
      }
      console.log(`\nBuild complete in ${elapsed}ms → dist/`)

      // Write metafile for further analysis
      const { writeFileSync } = await import('fs')
      writeFileSync(
        resolve(ROOT, 'dist/meta.json'),
        JSON.stringify(result.metafile),
      )
      console.log('  Metafile written to dist/meta.json')
    }
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
