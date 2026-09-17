#!/usr/bin/env node
'use strict'
// Finds code references to .webp/.avif files that do not exist, where the original
// image is still on disk, and points them back. Pass --apply to write.
const { readdir, readFile, writeFile, stat } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { join, dirname, relative, posix } = require('node:path')

const CODE = /\.(m?[jt]sx?|vue|svelte|astro|css|s[ac]ss|less|html?|json|md|php|py|rb|xml|ya?ml)$/i
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.output', 'vendor', '.cache', 'coverage'])
const EXT = /\.(?:webp|avif)\b/gi
const STOP = ' \t\r\n"\'`()<>,;:*=[]{}|!?#&'
const ORIGINALS = ['.png', '.jpg', '.jpeg', '.gif']

async function* walk(dir) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP.has(e.name)) yield* walk(p) }
    else if (e.isFile()) yield p
  }
}

const root = process.argv[2]
const apply = process.argv.includes('--apply')
if (!root) { console.error('usage: fix-refs.js <project-root> [--apply]'); process.exit(1) }

;(async () => {
  let files = 0, broken = 0, fixed = 0
  for await (const f of walk(root)) {
    if (!CODE.test(f)) continue
    if ((await stat(f)).size > 2_000_000) continue
    const text = await readFile(f, 'utf8')
    if (!/\.(webp|avif)/i.test(text)) continue

    const fdir = dirname(f)
    EXT.lastIndex = 0
    let out = '', last = 0, m, hits = 0
    while ((m = EXT.exec(text))) {
      let s = m.index
      while (s > last && !STOP.includes(text[s - 1])) s--
      const ref = text.slice(s, EXT.lastIndex)
      // Only relative references can be resolved with certainty — and those are
      // exactly the ones the suffix-matching bug mangled.
      if (!/^\.{1,2}\//.test(ref)) continue
      const abs = posix.normalize(posix.join(fdir.split('\\').join('/'), ref))
      if (existsSync(abs)) continue                 // reference is fine
      const orig = ORIGINALS.find((e) => existsSync(abs.replace(/\.(webp|avif)$/i, e)))
      broken++
      if (!orig) {
        console.log(`  ?  ${relative(root, f)}: ${ref} — missing, and no original found either`)
        continue
      }
      out += text.slice(last, s) + ref.replace(/\.(webp|avif)$/i, orig)
      last = EXT.lastIndex
      hits++
      console.log(`  ${apply ? '✓' : '·'}  ${relative(root, f)}: ${ref} -> ${ref.replace(/\.(webp|avif)$/i, orig)}`)
    }
    if (hits) {
      files++; fixed += hits
      if (apply) await writeFile(f, out + text.slice(last))
    }
  }
  console.log(`\n${broken} broken reference(s); ${fixed} can be pointed back, across ${files} file(s).`)
  if (!apply && fixed) console.log('Nothing written. Re-run with --apply to fix.')
})()
