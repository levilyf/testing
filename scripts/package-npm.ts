// scripts/package-npm.ts
// Generate a publishable npm package in dist/npm/
//
// Usage: bun scripts/package-npm.ts [--arch=32|64]
//
// Prerequisites: run `bun run build:prod` (or `bun run build:prod:32`) first
// to generate dist/cli.mjs (or dist/cli.32.mjs)

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, chmodSync } from 'fs'
import { resolve } from 'path'

// Bun: import.meta.dir — Node 21+: import.meta.dirname — fallback
const __dir: string =
  (import.meta as ImportMeta & { dir?: string; dirname?: string }).dir ??
  (import.meta as ImportMeta & { dir?: string; dirname?: string }).dirname ??
  new URL('.', import.meta.url).pathname

const ROOT = resolve(__dir, '..')
const DIST = resolve(ROOT, 'dist')
const NPM_DIR = resolve(DIST, 'npm')

// --arch=32 packages the 32-bit bundle (dist/cli.32.mjs) and adds a 32-bit
// variant of the npm package metadata (subdirectory dist/npm-32/).
const archArg = process.argv.find((a) => a.startsWith('--arch'))
const arch = archArg ? archArg.split('=')[1] : '64'
const is32Bit = arch === '32'
const CLI_BUNDLE = resolve(DIST, is32Bit ? 'cli.32.mjs' : 'cli.mjs')
const OUT_DIR = is32Bit ? resolve(DIST, 'npm-32') : NPM_DIR
const OUT_CLI_NAME = 'cli.mjs'

function main() {
  // Verify the bundle exists
  if (!existsSync(CLI_BUNDLE)) {
    console.error(
      `Error: ${CLI_BUNDLE} not found. Run \`bun run build:prod${is32Bit ? ':32' : ''}\` first.`,
    )
    process.exit(1)
  }

  // Read source package.json
  const srcPkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'))

  // Create npm output directory
  mkdirSync(OUT_DIR, { recursive: true })

  // Copy the bundled CLI
  const outCliPath = resolve(OUT_DIR, OUT_CLI_NAME)
  copyFileSync(CLI_BUNDLE, outCliPath)
  chmodSync(outCliPath, 0o755)

  // Copy source map if it exists
  const sourceMap = resolve(DIST, is32Bit ? 'cli.32.mjs.map' : 'cli.mjs.map')
  if (existsSync(sourceMap)) {
    copyFileSync(sourceMap, resolve(OUT_DIR, 'cli.mjs.map'))
  }

  // Generate a publishable package.json
  const npmPkg = {
    name: is32Bit ? `${srcPkg.name || '@anthropic-ai/claude-code'}-32` : srcPkg.name || '@anthropic-ai/claude-code',
    version: srcPkg.version || '0.0.0',
    description: is32Bit
      ? `${srcPkg.description || 'Anthropic Claude Code CLI'} (32-bit build; native modules replaced with no-op shims)`
      : srcPkg.description || 'Anthropic Claude Code CLI',
    license: 'MIT',
    type: 'module',
    main: './cli.mjs',
    bin: {
      claude: './cli.mjs',
    },
    engines: {
      node: '>=20.0.0',
    },
    os: ['darwin', 'linux', 'win32', 'android'],
    cpu: is32Bit ? ['arm', 'armv7l', 'armv8l', 'ia32', 'x32'] : ['x64', 'arm64', 'arm', 'ia32', 'armv7l', 'armv8l'],
    files: [
      'cli.mjs',
      'cli.mjs.map',
      'README.md',
    ],
  }

  writeFileSync(
    resolve(OUT_DIR, 'package.json'),
    JSON.stringify(npmPkg, null, 2) + '\n',
  )

  // Copy README if it exists
  const readme = resolve(ROOT, 'README.md')
  if (existsSync(readme)) {
    copyFileSync(readme, resolve(OUT_DIR, 'README.md'))
  }

  // Summary
  const bundleSize = readFileSync(CLI_BUNDLE).byteLength
  const sizeMB = (bundleSize / 1024 / 1024).toFixed(2)

  console.log(`npm package generated in ${is32Bit ? 'dist/npm-32/' : 'dist/npm/'}`)
  console.log(`  package:  ${npmPkg.name}@${npmPkg.version}`)
  console.log(`  bundle:   ${CLI_BUNDLE} (${sizeMB} MB)`)
  console.log(`  bin:      claude → ./cli.mjs`)
  if (is32Bit) {
    console.log(`  note:     32-bit build — node-pty and image-processor-napi are no-op shims`)
  }
  console.log('')
  console.log('To publish:')
  console.log(`  cd ${is32Bit ? 'dist/npm-32' : 'dist/npm'} && npm publish`)
}

main()
