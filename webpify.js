#!/usr/bin/env node
'use strict'
const { readdir, readFile, writeFile, stat, unlink } = require('node:fs/promises')
const { join, relative, basename, dirname, resolve, posix } = require('node:path')

const IMG = /\.(png|jpe?g|gif)$/i
const FORMATS = {
  webp: { ext: 'webp', label: 'WebP' },
  avif: { ext: 'avif', label: 'AVIF' },
  jpeg: { ext: 'jpg', label: 'JPEG' },
  png: { ext: 'png', label: 'PNG' },
}
const CODE = /\.(m?[jt]sx?|vue|svelte|astro|css|s[ac]ss|less|html?|json|md|php|py|rb|xml|ya?ml)$/i
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.output', 'vendor', '.cache', 'coverage'])
// ponytail: regex-scan every text file instead of parsing per-language ASTs.
// Safe because a hit only rewrites when it resolves to an image we actually converted.
// Match the extension first, then scan backwards for the path. A leading `[^...]*` in the
// pattern instead backtracks quadratically on minified bundles: 27.7s -> 87ms on a 172MB tree.
const EXT = /\.(?:png|jpe?g|gif)\b/gi
const STOP = ' \t\r\n"\'`()<>,;:*=[]{}|!?#&'

/** Strip ./ ../ / @/ ~/ prefixes so a code reference can be suffix-matched against a real path. */
const norm = (s) => s.replace(/\\/g, '/').replace(/^(?:[.~@]*\/)+/, '').toLowerCase()

/** rels: image paths relative to the CODE root, '/'-separated — code refs are written
 *  against that root (`/img/a.png` for `public/img/a.png`), not against the image folder.
 *  The returned matcher takes the reference plus the directory of the file it was found
 *  in, so relative references can be resolved instead of guessed at. */
function makeMatcher(rels) {
  const exact = new Set()
  const byBase = new Map()
  // An image outside the code root is keyed by filename alone (see planEdits).
  const looseNames = new Set()
  for (const rel of rels) {
    const low = rel.toLowerCase()
    exact.add(low)
    if (!low.includes('/')) looseNames.add(low)
    const b = basename(low)
    if (!byBase.has(b)) byBase.set(b, [])
    byBase.get(b).push(low)
  }
  return (ref, fromDir = '') => {
    const raw = ref.replace(/\\/g, '/')
    // ./ and ../ resolve against the containing file, so they can be matched exactly.
    // Suffix matching here would wrongly hit a same-named image under a parallel tree:
    // './General/a.png' in src/assets/images/ must not match
    // src/features/X/assets/images/General/a.png.
    if (/^\.{1,2}\//.test(raw)) {
      const abs = posix.normalize(posix.join(fromDir, raw)).toLowerCase()
      return exact.has(abs) || looseNames.has(basename(abs))
    }
    // ponytail: an alias ('@/x'), a web-root path ('/x') or a bare filename cannot be
    // resolved from here, so those still match by suffix.
    const n = norm(raw)
    if (!n) return false
    return (byBase.get(basename(n)) ?? []).some((r) => r === n || r.endsWith('/' + n))
  }
}

function rewrite(text, matches, outExt = 'webp', fromDir = '') {
  const target = '.' + outExt.toLowerCase()
  EXT.lastIndex = 0
  let count = 0, out = '', last = 0, m
  while ((m = EXT.exec(text))) {
    if (m[0].toLowerCase() === target) continue   // already the target format, nothing to rewrite
    let s = m.index
    while (s > last && !STOP.includes(text[s - 1])) s--
    const ref = text.slice(s, EXT.lastIndex)
    if (!matches(ref, fromDir)) continue
    out += text.slice(last, s) + ref.slice(0, -m[0].length) + target
    last = EXT.lastIndex
    count++
  }
  return count ? { out: out + text.slice(last), count } : { out: text, count: 0 }
}

async function* walk(dir) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP.has(e.name)) yield* walk(p) }
    else if (e.isFile()) yield p
  }
}

async function scanImages(imgDir) {
  const images = []
  for await (const p of walk(imgDir)) if (IMG.test(p)) images.push(p)
  return images
}

/** Accepts a mix of folders and image files (what an Explorer multi-select hands over)
 *  and returns the de-duplicated image list — nested selections would otherwise repeat. */
async function collectImages(paths) {
  const seen = new Set()
  for (const p of paths) {
    const st = await stat(p).catch(() => null)
    if (!st) continue
    if (st.isDirectory()) for (const f of await scanImages(p)) seen.add(f)
    else if (IMG.test(p)) seen.add(p)
  }
  return [...seen]
}

/** Code edits implied by converting exactly `images` — the subset the user picked,
 *  which may span several folders, not one. */
async function planEdits(images, codeDir, outExt = 'webp', { onProgress, token } = {}) {
  const rels = images.map((p) => {
    const fromCode = relative(codeDir, p).split('\\').join('/')
    // Image outside the code root: match on filename alone, the only thing left to go on.
    return fromCode.startsWith('..') ? basename(p) : fromCode
  })
  const matches = makeMatcher(rels)

  const files = []
  for await (const f of walk(codeDir)) if (CODE.test(f)) files.push(f)

  const edits = []
  for (let i = 0; i < files.length; i++) {
    if (token?.isCancellationRequested) break
    if (i % 200 === 0) onProgress?.(i, files.length)
    const f = files[i]
    if ((await stat(f)).size > 2_000_000) continue
    const dir = dirname(relative(codeDir, f)).split('\\').join('/')
    const { out, count } = rewrite(await readFile(f, 'utf8'), matches, outExt, dir === '.' ? '' : dir)
    if (count) edits.push({ f, out, count })
  }
  return edits
}

/** Whole-folder convenience used by the CLI. */
async function plan(imgDir, codeDir, outExt = 'webp', opts) {
  const images = await scanImages(imgDir)
  return { images, edits: images.length ? await planEdits(images, codeDir, outExt, opts) : [] }
}

/** Plain require, never a dynamic import expression: the VSCode extension host runs
 *  CommonJS with no dynamic-import callback, so that throws at runtime there while
 *  working fine under plain node. sharp is CommonJS anyway. */
function encode(src, format, quality) {
  const sharp = require('sharp')
  // Only webp and avif can carry the extra frames; the others take frame one.
  const animated = /\.gif$/i.test(src) && (format === 'webp' || format === 'avif')
  const img = sharp(src, animated ? { animated: true } : undefined)
  if (format === 'png') return img.png({ quality, compressionLevel: 9, palette: true }).toBuffer()
  if (format === 'jpeg') return img.jpeg({ quality, mozjpeg: true }).toBuffer()
  if (format === 'avif') return img.avif({ quality }).toBuffer()
  return img.webp({ quality }).toBuffer()
}

/** onStep(src, err, skipped) is called once per image; token.isCancellationRequested stops early.
 *  Returns done as {src, dst} pairs — dst equals src when re-encoding in place.
 *  An image whose encode comes out no smaller is skipped and left alone: a flat GIF or an
 *  already-optimised PNG can grow, and writing that would make the site heavier, not lighter. */
async function convert(images, { format = 'webp', quality = 80 } = {}, onStep, token) {
  const ext = FORMATS[format].ext
  const done = []
  const skipped = []
  let before = 0, after = 0
  for (const src of images) {
    if (token?.isCancellationRequested) break
    const dst = src.replace(IMG, '.' + ext)
    let err = null
    try {
      const buf = await encode(src, format, quality)
      // Size the source before writing: an in-place re-encode overwrites it.
      const srcSize = await stat(src).then((st) => st.size)
      if (buf.length >= srcSize) {
        skipped.push({ src, size: srcSize, would: buf.length })
        onStep?.(src, null, true)
        continue
      }
      await writeFile(dst, buf)
      before += srcSize
      after += buf.length
      done.push({ src, dst })
    } catch (e) { err = e }
    onStep?.(src, err, false)
  }
  return { done, skipped, before, after }
}

const applyEdits = (edits) => Promise.all(edits.map((e) => writeFile(e.f, e.out)))
const removeOriginals = (paths) => Promise.all(paths.map((p) => unlink(p)))
const human = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : (n / 1024).toFixed(0) + 'KB')
const saved = (before, after) => (before ? Math.round((1 - after / before) * 100) : 0)

module.exports = { plan, scanImages, collectImages, planEdits, convert, encode, applyEdits, removeOriginals, makeMatcher, rewrite, human, saved, FORMATS }

// ---------- CLI ----------

async function cli() {
  const { parseArgs } = require('node:util')
  const { createInterface } = require('node:readline/promises')
  const { values, positionals } = parseArgs({
    options: {
      code: { type: 'string' },
      format: { type: 'string', short: 'f', default: 'webp' },
      quality: { type: 'string', default: '80' },
      delete: { type: 'boolean', short: 'd', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      'self-test': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  })
  if (values['self-test']) return selfTest()

  const ask = async (q, def) => {
    if (values.yes || !process.stdin.isTTY) return def
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const a = (await rl.question(q)).trim().toLowerCase()
    rl.close()
    return a === '' ? def : a[0] === 'y'
  }

  const format = values.format.toLowerCase()
  if (!FORMATS[format]) return console.error(`Unknown format "${format}". Use one of: ${Object.keys(FORMATS).join(', ')}`)
  const ext = FORMATS[format].ext

  const imgDir = resolve(positionals[0] ?? '.')
  const codeDir = resolve(values.code ?? process.cwd())
  const images = await scanImages(imgDir)
  if (!images.length) return console.log(`No png/jpg/gif images found in ${imgDir}`)

  console.log(`\n${images.length} images in ${imgDir}`)
  if (!(await ask(`Convert to ${FORMATS[format].label} at ${values.quality}% and update code? [Y/n] `, true))) {
    return console.log('Cancelled.')
  }

  const { done, skipped, before, after } = await convert(images, { format, quality: Number(values.quality) }, (src, err) => {
    if (err) console.error(`  x ${relative(imgDir, src)}: ${err.message}`)
  })
  console.log(`\n✓ ${done.length}/${images.length} images → ${ext}  (${human(before)} → ${human(after)}, -${saved(before, after)}%)`)
  for (const sk of skipped.slice(0, 10)) {
    console.log(`  • skipped ${relative(imgDir, sk.src)} — ${ext} would be ${human(sk.would)} vs ${human(sk.size)}`)
  }
  if (skipped.length > 10) console.log(`  • ... +${skipped.length - 10} more left as-is`)
  if (!done.length) return console.log('Nothing was written, so no code references changed.')

  // Rewrite references only for images that actually got written.
  const edits = await planEdits(done.map((d) => d.src), codeDir, ext)
  await applyEdits(edits)
  console.log(`✓ ${edits.length} code files updated`)

  // An in-place re-encode (png -> png) has no separate original left to remove.
  const replaced = done.filter((d) => d.src !== d.dst).map((d) => d.src)
  if (!replaced.length) return console.log(`• ${done.length} images re-encoded in place.`)

  if (values.delete || (await ask(`\nDelete ${replaced.length} original images (.${ext} already written)? [y/N] `, false))) {
    await removeOriginals(replaced)
    console.log(`✓ Deleted ${replaced.length} originals.`)
  } else {
    console.log(`• Kept ${replaced.length} originals.`)
  }
}

function selfTest() {
  const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m) }
  const m = makeMatcher(['public/img/hero.png', 'public/img/sub/hero.png', 'logo.JPG'])
  const cases = [
    [`<img src="./img/hero.png">`, `<img src="./img/hero.webp">`, 1, 'relative path'],
    [`url(/img/sub/hero.png)`, `url(/img/sub/hero.webp)`, 1, 'web-root path (public/ stripped by server)'],
    [`import a from '@/img/hero.png'`, `import a from '@/img/hero.webp'`, 1, 'alias prefix'],
    [`src="../../logo.JPG"`, `src="../../logo.webp"`, 1, 'case-insensitive ext'],
    [`src="hero.png"`, `src="hero.webp"`, 1, 'bare basename'],
    [`src="other/hero.png"`, `src="other/hero.png"`, 0, 'same name, different folder -> untouched'],
    [`src="nope.png"`, `src="nope.png"`, 0, 'not converted -> untouched'],
    [`"img/hero.png?v=2"`, `"img/hero.webp?v=2"`, 1, 'query string preserved'],
    [`a.png b.png img/hero.png`, `a.png b.png img/hero.webp`, 1, 'multiple, only real hit'],
    [`<img src=img/hero.png>`, `<img src=img/hero.webp>`, 1, 'unquoted html attribute'],
    [`url(img/hero.png) url(img/sub/hero.png)`, `url(img/hero.webp) url(img/sub/hero.webp)`, 2, 'two hits in one line'],
    [`"` + 'a'.repeat(200) + `.png"`, `"` + 'a'.repeat(200) + `.png"`, 0, 'long unmatched token, no backtracking'],
  ]
  for (const [input, want, n, name] of cases) {
    const r = rewrite(input, m, 'webp', 'public')
    assert(r.out === want, `${name}: got ${r.out}`)
    assert(r.count === n, `${name}: count ${r.count} != ${n}`)
  }
  // Output format decides the extension written, and a ref already in that format is left alone.
  const fm = makeMatcher(['public/img/hero.png', 'public/img/photo.jpg'])
  const avif = rewrite(`"/img/hero.png"`, fm, 'avif')
  assert(avif.out === `"/img/hero.webp"`.replace('webp', 'avif'), `avif: got ${avif.out}`)
  const toPng = rewrite(`"/img/photo.jpg" "/img/hero.png"`, fm, 'png')
  assert(toPng.out === `"/img/photo.png" "/img/hero.png"`, `png: got ${toPng.out}`)
  assert(toPng.count === 1, `png: only the jpg ref changes, got ${toPng.count}`)

  // Parallel trees: './General/a.png' means a different file depending on which
  // index.ts it sits in, so a converted image under one tree must not rewrite the
  // reference in the other. This shipped broken in 1.8.4.
  const par = makeMatcher(['src/features/orderstracking/assets/images/general/mascot_empty.png'])
  const wrongTree = rewrite(`require("./General/mascot_empty.png")`, par, 'webp', 'src/assets/images')
  assert(wrongTree.count === 0, `parallel tree: rewrote a reference it should not have: ${wrongTree.out}`)
  const rightTree = rewrite(`require("./General/mascot_empty.png")`, par, 'webp',
    'src/features/OrdersTracking/assets/images')
  assert(rightTree.count === 1, 'parallel tree: failed to rewrite the reference that does point at it')
  assert(rightTree.out === `require("./General/mascot_empty.webp")`, `got ${rightTree.out}`)
  // '../' has to resolve too.
  const up = rewrite(`require("../images/General/mascot_empty.png")`, par, 'webp',
    'src/features/OrdersTracking/assets/styles')
  assert(up.count === 1, 'parallel tree: ../ reference not resolved')

  console.log(`self-test ok (${cases.length + 5} cases)`)
}

if (require.main === module) cli()
