#!/usr/bin/env node
'use strict'
// Generates the README screenshots. Mockups of the real UI, drawn as SVG so they stay
// editable and reproducible instead of being opaque binaries in git.
// Run: node docs/make-images.js
const sharp = require('sharp')
const path = require('path')

const C = {
  editor: '#1f1f1f', panel: '#181818', widget: '#202020', border: '#2b2b2b',
  text: '#cccccc', dim: '#9d9d9d', faint: '#6e6e6e', accent: '#0078d4',
  accentHover: '#026ec1', green: '#89d185', red: '#f14c4c', sel: '#04395e',
  input: '#313131', inputBorder: '#3c3c3c',
}
// Unquoted family names only: a quoted one would collide with the attribute's own quotes.
const F = 'Helvetica, Arial, sans-serif'
const MONO = 'Menlo, Courier, monospace'

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const text = (x, y, s, o = {}) =>
  `<text x="${x}" y="${y}" font-family="${o.mono ? MONO : F}" font-size="${o.size ?? 13}"
     fill="${o.fill ?? C.text}" font-weight="${o.weight ?? 400}"
     text-anchor="${o.anchor ?? 'start'}" opacity="${o.opacity ?? 1}">${esc(s)}</text>`
const rect = (x, y, w, h, o = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.r ?? 0}"
     fill="${o.fill ?? 'none'}" stroke="${o.stroke ?? 'none'}" stroke-width="${o.sw ?? 1}"
     opacity="${o.opacity ?? 1}"/>`
const check = (x, y) =>
  `${rect(x, y, 14, 14, { r: 3, fill: C.accent })}
   <path d="M${x + 3.5} ${y + 7.5} l2.5 2.5 l4.5 -5" stroke="#fff" stroke-width="1.8" fill="none"
     stroke-linecap="round" stroke-linejoin="round"/>`

/** A stand-in photo, so the preview panel shows something image-shaped. */
const photo = (x, y, w, h, seed = 0) => {
  const id = 'ph' + seed
  return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a4a6b"/><stop offset="0.55" stop-color="#3d6b8f"/>
      <stop offset="1" stop-color="#d8c9a8"/></linearGradient>
    <clipPath id="c${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4"/></clipPath></defs>
    <g clip-path="url(#c${id})">
      ${rect(x, y, w, h, { fill: `url(#${id})` })}
      <circle cx="${x + w * 0.74}" cy="${y + h * 0.3}" r="${h * 0.11}" fill="#ffd966" opacity="0.95"/>
      <path d="M${x} ${y + h} L${x + w * 0.3} ${y + h * 0.48} L${x + w * 0.52} ${y + h * 0.75}
               L${x + w * 0.72} ${y + h * 0.52} L${x + w} ${y + h} Z" fill="#1e3a52" opacity="0.92"/>
      <path d="M${x} ${y + h} L${x + w * 0.46} ${y + h * 0.66} L${x + w} ${y + h} Z" fill="#16293a" opacity="0.9"/>
    </g>`
}

const svg = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
     ${rect(0, 0, w, h, { fill: C.editor })}${body}</svg>`

// ---------- 1. Explorer multi-select + context menu ----------
function explorer() {
  const w = 1000, h = 520
  const folders = ['BoxProduct', 'Cart', 'CartCheckOut', 'Category', 'General', 'Header']
  let b = rect(0, 0, 330, h, { fill: C.panel }) + rect(330, 0, 1, h, { fill: C.border })
  b += text(20, 34, 'EXPLORER', { size: 11, fill: C.dim, weight: 600 })
  b += text(28, 68, '▾ src / assets / images', { size: 12.5, fill: C.dim })
  folders.forEach((f, i) => {
    const y = 90 + i * 30
    b += rect(12, y, 306, 26, { r: 4, fill: C.sel })
    b += text(46, y + 18, '▸  ' + f, { size: 13 })
  })
  const y2 = 90 + folders.length * 30 + 4
  b += text(46, y2 + 18, '▸  Promotion', { size: 13, fill: C.dim })
  b += text(20, h - 24, '6 folders selected', { size: 11.5, fill: C.faint })

  // context menu
  const mx = 250, my = 150, mw = 330
  b += rect(mx + 3, my + 4, mw, 190, { r: 8, fill: '#000', opacity: 0.45 })
  b += rect(mx, my, mw, 190, { r: 8, fill: C.widget, stroke: C.border })
  const items = ['Open to the Side', 'Reveal in Finder', 'Copy Path', null, 'Convert & Optimize Images', 'Delete']
  let iy = my + 16
  for (const it of items) {
    if (it === null) { b += rect(mx + 10, iy + 6, mw - 20, 1, { fill: C.border }); iy += 14; continue }
    const hot = it.startsWith('Convert')
    if (hot) b += rect(mx + 6, iy, mw - 12, 26, { r: 4, fill: C.accent })
    b += text(mx + 20, iy + 18, it, { size: 13, fill: hot ? '#fff' : C.text, weight: hot ? 600 : 400 })
    iy += 28
  }
  return svg(w, h, b)
}

// ---------- 2. Image checklist ----------
function checklist() {
  const w = 1000, h = 430
  const rows = [
    ['banner_home.png', '1.2MB', 'src/assets/images/Header/banner_home.png'],
    ['hero_bg.jpg', '860KB', 'src/assets/images/General/hero_bg.jpg'],
    ['banner_buy_together.png', '169KB', 'src/assets/images/AttachBuy/banner_buy_together.png'],
    ['ic_cart.png', '42KB', 'src/assets/images/Cart/ic_cart.png'],
    ['ic_category.png', '12KB', 'src/assets/images/Category/ic_category.png'],
  ]
  const bw = 820, bx = (w - bw) / 2, by = 40
  let b = rect(bx + 4, by + 6, bw, 330, { r: 8, fill: '#000', opacity: 0.4 })
  b += rect(bx, by, bw, 330, { r: 8, fill: C.widget, stroke: C.border })
  b += rect(bx, by, bw, 38, { r: 8, fill: '#252526' })
  b += text(bx + bw / 2, by + 24, 'Webpify — select images to convert (258 in "src/assets/images", 14.2MB)',
    { size: 12.5, anchor: 'middle', fill: C.text })

  const iy = by + 50
  b += check(bx + 14, iy + 9)
  b += rect(bx + 38, iy, bw - 150, 32, { r: 3, fill: C.input, stroke: C.accent })
  b += text(bx + 50, iy + 21, 'All selected by default — untick what you want to skip, then press OK',
    { size: 12.5, fill: C.faint })
  b += rect(bx + bw - 200, iy + 5, 78, 22, { r: 3, fill: '#3a3d41' })
  b += text(bx + bw - 161, iy + 20, '258 Selected', { size: 11, anchor: 'middle', fill: C.text })
  b += rect(bx + bw - 108, iy, 94, 32, { r: 3, fill: C.accent })
  b += text(bx + bw - 61, iy + 21, 'OK', { size: 13, anchor: 'middle', fill: '#fff', weight: 600 })

  rows.forEach(([name, size, p], i) => {
    const y = iy + 48 + i * 46
    if (i === 0) b += rect(bx + 6, y - 6, bw - 12, 44, { r: 4, fill: C.sel })
    b += check(bx + 18, y + 8)
    b += text(bx + 46, y + 12, name, { size: 13 })
    b += text(bx + 46 + name.length * 7.4 + 12, y + 12, size, { size: 12, fill: C.dim })
    b += text(bx + 46, y + 30, p, { size: 11.5, fill: C.faint })
  })
  b += text(w / 2, h - 16, 'Sorted biggest first · type to filter · untick anything you want left alone',
    { size: 11.5, anchor: 'middle', fill: C.faint })
  return svg(w, h, b)
}

// ---------- 3. Output preview panel ----------
function preview() {
  const w = 1100, h = 620
  let b = rect(0, 0, w, 36, { fill: C.panel }) + rect(0, 36, w, 1, { fill: C.border })
  b += rect(14, 6, 190, 30, { r: 4, fill: C.editor })
  b += text(30, 26, '☰  Webpify — output', { size: 12.5 })
  b += text(184, 26, '✕', { size: 12, fill: C.dim })

  b += text(32, 78, 'Choose output format and quality', { size: 17, weight: 700 })
  b += text(32, 100, 'banner_home.png — sample from the 258 image(s) you selected', { size: 12, fill: C.dim })

  const fw = 496, fh = 300, ay = 122
  b += rect(32, ay, fw, fh, { r: 6, fill: '#252526', stroke: C.border })
  b += photo(52, ay + 20, fw - 40, fh - 40, 1)
  b += text(32, ay + fh + 22, 'Original (PNG)', { size: 12, fill: C.dim })
  b += text(32 + fw, ay + fh + 22, '1.2MB', { size: 12.5, anchor: 'end', weight: 600, mono: true })

  const bx2 = 572
  b += rect(bx2, ay, fw, fh, { r: 6, fill: '#252526', stroke: C.border })
  b += photo(bx2 + 20, ay + 20, fw - 40, fh - 40, 2)
  b += text(bx2, ay + fh + 22, 'WebP 80%', { size: 12, fill: C.dim })
  b += text(bx2 + fw, ay + fh + 22, '240KB', { size: 12.5, anchor: 'end', weight: 600, mono: true })

  const cy = ay + fh + 58
  b += text(32, cy + 20, 'Format', { size: 12, fill: C.dim })
  b += rect(84, cy + 2, 108, 28, { r: 3, fill: C.input, stroke: C.inputBorder })
  b += text(98, cy + 21, 'WebP', { size: 13 })
  b += text(176, cy + 21, '⌄', { size: 13, fill: C.dim })
  b += text(210, cy + 20, 'Quality', { size: 12, fill: C.dim })
  const sx = 264, sw = 560
  b += rect(sx, cy + 14, sw, 4, { r: 2, fill: C.inputBorder })
  b += rect(sx, cy + 14, sw * 0.62, 4, { r: 2, fill: C.accent })
  b += `<circle cx="${sx + sw * 0.62}" cy="${cy + 16}" r="8" fill="${C.accent}"/>`
  b += text(sx + sw + 24, cy + 21, 'Quality 80% ·', { size: 13 })
  b += text(sx + sw + 112, cy + 21, '−80%', { size: 13, fill: C.green, weight: 700 })

  const by2 = cy + 52
  b += rect(32, by2, 192, 32, { r: 3, fill: C.accent })
  b += text(128, by2 + 21, 'Convert 258 image(s)', { size: 13, anchor: 'middle', fill: '#fff', weight: 600 })
  b += rect(244, by2 + 9, 14, 14, { r: 3, fill: C.input, stroke: C.inputBorder })
  b += text(270, by2 + 21, 'Remember this and skip the preview next time', { size: 12.5 })
  return svg(w, h, b)
}

// ---------- 4. Result dialog ----------
function result() {
  const w = 1000, h = 420
  const bw = 560, bx = (w - bw) / 2, by = 60
  let b = rect(0, 0, w, h, { fill: C.editor, opacity: 1 })
  b += rect(0, 0, w, h, { fill: '#000', opacity: 0.35 })
  b += rect(bx + 4, by + 8, bw, 290, { r: 10, fill: '#000', opacity: 0.45 })
  b += rect(bx, by, bw, 290, { r: 10, fill: '#2a2a2a', stroke: C.border })
  b += text(bx + 32, by + 46, 'Converted 258 images to WebP at 80%', { size: 15, weight: 700 })
  b += text(bx + 32, by + 70, '(−79%, 14.2MB → 3.0MB). Delete the originals?', { size: 15, weight: 700 })
  const lines = [
    'Code references now point to .webp (9 files updated).',
    '',
    '"Delete originals" — remove the 258 source files, keep only .webp.',
    '"Keep both" — keep the originals for comparison or rollback.',
  ]
  lines.forEach((l, i) => { if (l) b += text(bx + 32, by + 108 + i * 22, l, { size: 12.5, fill: C.dim }) })
  const byy = by + 212
  b += rect(bx + 32, byy, 130, 32, { r: 4, fill: '#3a3d41' })
  b += text(bx + 97, byy + 21, 'Cancel', { size: 13, anchor: 'middle' })
  b += rect(bx + 174, byy, 150, 32, { r: 4, fill: '#3a3d41' })
  b += text(bx + 249, byy + 21, 'Keep both', { size: 13, anchor: 'middle' })
  b += rect(bx + 336, byy, 192, 32, { r: 4, fill: C.accent })
  b += text(bx + 432, byy + 21, 'Delete originals', { size: 13, anchor: 'middle', fill: '#fff', weight: 600 })
  return svg(w, h, b)
}

const out = (name, s) =>
  sharp(Buffer.from(s)).png().toFile(path.join(__dirname, name))
    .then((i) => console.log(`${name}  ${i.width}x${i.height}`))

Promise.all([
  out('1-explorer.png', explorer()),
  out('2-checklist.png', checklist()),
  out('3-preview.png', preview()),
  out('4-result.png', result()),
]).catch((e) => { console.error(e); process.exit(1) })
