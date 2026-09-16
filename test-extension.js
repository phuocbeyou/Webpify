'use strict'
// Smoke-test the VSCode UI layer against a real fixture, with the `vscode` module stubbed.
// Run: node test-extension.js
const Module = require('node:module')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert')

const DELETE = 'Delete originals'
const KEEP = 'Keep both'

let answers = []              // queued replies for each modal, in order
const asked = []              // what the extension actually asked
let pick = (items) => items   // how the checklist is answered; default = keep everything ticked
let previewOut = { format: 'webp', quality: 80 }   // what the preview panel sends back; null = closed
let settings = {}                                  // stands in for the workspace configuration
let openedSettings = 0                             // times the gear button was pressed
let quickPickButton = null                         // a title-bar button the "user" presses

const stub = {
  ProgressLocation: { Notification: 15, Window: 10 },
  Uri: { file: (p) => ({ fsPath: p }) },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    withProgress: (_opts, task) => task({ report() {} }, { isCancellationRequested: false }),
    showInformationMessage: (m) => (asked.push(m), Promise.resolve(answers.shift())),
    showWarningMessage: (m) => (asked.push(m), Promise.resolve(answers.shift())),
    showErrorMessage: (m) => { throw new Error('extension reported: ' + m) },
    showOpenDialog: () => Promise.resolve(undefined),
    createWebviewPanel: () => {
      let onMsg, onDispose
      const panel = {
        webview: {
          cspSource: 'vscode-webview:',
          set html(v) { lastHtml = v },
          get html() { return lastHtml },
          onDidReceiveMessage: (fn) => ((onMsg = fn), { dispose() {} }),
        },
        onDidDispose: (fn) => ((onDispose = fn), { dispose() {} }),
        dispose: () => onDispose?.(),
      }
      // Stand in for the user: move the slider and press Convert, or just close the panel.
      setImmediate(() =>
        previewOut === null ? panel.dispose() : onMsg?.({ type: 'convert', ...previewOut }))
      return panel
    },
    createQuickPick: () => {
      const qp = { title: '', placeholder: '', canSelectMany: false, matchOnDetail: false,
                   items: [], selectedItems: [], buttons: [] }
      let onAccept, onHide, onButton
      qp.onDidAccept = (fn) => ((onAccept = fn), { dispose() {} })
      qp.onDidHide = (fn) => ((onHide = fn), { dispose() {} })
      qp.onDidTriggerButton = (fn) => ((onButton = fn), { dispose() {} })
      qp.hide = () => onHide?.()
      qp.dispose = () => {}
      qp.show = () => setImmediate(() => {
        assert(qp.canSelectMany, 'checklist must allow multiple picks')
        assert(qp.selectedItems.length === qp.items.length, 'every image must be ticked by default')
        lastQuickPick = qp
        if (quickPickButton !== null) {
          const b = qp.buttons[quickPickButton]
          assert(b, `checklist has no button at index ${quickPickButton}`)
          onButton?.(b)
          // The gear leaves the checklist open (settings opened alongside it) — stand in
          // for the user dismissing it afterwards, or this never settles.
          return setImmediate(() => onHide?.())
        }
        const kept = pick(qp.items)
        if (!kept) return onHide?.()
        qp.selectedItems = kept
        onAccept?.()
      })
      return qp
    },
  },
  workspace: {
    workspaceFolders: [],
    getWorkspaceFolder: () => ({ uri: { fsPath: fixtureRoot } }),
    getConfiguration: () => ({
      get: (k, d) => (k in settings ? settings[k] : d),
      update: async (k, v) => { settings[k] = v },
    }),
  },
  commands: {
    registerCommand: (id, fn) => ((handlers[id] = fn), { dispose() {} }),
    executeCommand: (id) => { if (id === 'workbench.action.openSettings') openedSettings++ },
  },
  ThemeIcon: class { constructor(id) { this.id = id } },
  ConfigurationTarget: { Global: 1 },
  ViewColumn: { One: 1 },
  window_createWebviewPanel: null,
}
const handlers = {}
let fixtureRoot
let lastHtml = ''
let lastQuickPick = null
const origLoad = Module._load
Module._load = (req, ...a) => (req === 'vscode' ? stub : origLoad.call(Module, req, ...a))

const { activate } = require('./extension.js')
activate({ subscriptions: [] })
assert(handlers['webpify.convertFolder'], 'command not registered')

async function fixture() {
  const sharp = require('sharp')
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webpify-'))
  fs.mkdirSync(path.join(fixtureRoot, 'public/img/icons'), { recursive: true })
  fs.mkdirSync(path.join(fixtureRoot, 'src'), { recursive: true })
  const png = (w, c, f) => sharp({ create: { width: w, height: w, channels: 3, background: c } }).png().toFile(path.join(fixtureRoot, f))
  await png(400, '#c33', 'public/img/hero.png')
  await png(60, '#3c3', 'public/img/icons/hero.png')
  await png(120, '#39c', 'public/img/logo.png')
  // Photographic noise: any lossless PNG of it is far bigger than the JPEG.
  const noise = Buffer.alloc(200 * 200 * 3)
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) % 256
  await sharp(noise, { raw: { width: 200, height: 200, channels: 3 } }).jpeg({ quality: 40 })
    .toFile(path.join(fixtureRoot, 'public/img/noise.jpg'))
  fs.writeFileSync(path.join(fixtureRoot, 'src/App.jsx'),
    `import h from '@/img/hero.png'\n<img src="/img/icons/hero.png" />\n<img src="/assets/hero.png" />\n<img src="/img/logo.png" />\n<img src="/img/noise.jpg" />\n`)
  return { imgDir: stub.Uri.file(path.join(fixtureRoot, 'public/img')) }
}
const read = (f) => fs.readFileSync(path.join(fixtureRoot, f), 'utf8')
const exists = (f) => fs.existsSync(path.join(fixtureRoot, f))

async function main() {
  settings = {}
  // 0. The extension host runs CommonJS with no dynamic-import callback, so `import()`
  //    throws at runtime there but works fine under plain node — a green test would lie.
  for (const f of ['extension.js', 'webpify.js', 'preview.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8')
    assert(!/(^|[^.\w])import\s*\(/.test(src), `${f}: dynamic import() breaks in the extension host, use require()`)
  }

  // 1. Escape the checklist -> nothing touched (it is the only confirmation step).
  let { imgDir } = await fixture()
  pick = () => undefined
  await handlers['webpify.convertFolder'](imgDir, [imgDir])
  assert(!exists('public/img/hero.webp'), 'escaping the checklist still converted')
  pick = (items) => items

  // 2. Convert, then keep originals.
  ;({ imgDir } = await fixture())
  answers = [KEEP, undefined]
  await handlers['webpify.convertFolder'](imgDir, [imgDir])
  assert(exists('public/img/hero.webp'), 'webp not created')
  assert(exists('public/img/hero.png'), `original deleted despite "${KEEP}"`)
  const code = read('src/App.jsx')
  assert(code.includes("'@/img/hero.webp'"), 'alias ref not rewritten')
  assert(code.includes('/img/icons/hero.webp'), 'nested ref not rewritten')
  assert(code.includes('/assets/hero.png'), 'unrelated same-name image was rewritten')

  // 3. Convert, then delete originals.
  ;({ imgDir } = await fixture())
  answers = [DELETE, undefined]
  await handlers['webpify.convertFolder'](imgDir, [imgDir])
  assert(exists('public/img/hero.webp'), 'webp not created')
  assert(!exists('public/img/hero.png'), `original kept despite "${DELETE}"`)
  assert(!exists('public/img/icons/hero.png'), 'nested original kept')

  // 4. Untick one image -> it is neither converted nor rewritten, the rest still are.
  ;({ imgDir } = await fixture())
  pick = (items) => items.filter((i) => i.label !== 'logo.png')
  answers = [DELETE, undefined]
  await handlers['webpify.convertFolder'](imgDir, [imgDir])
  pick = (items) => items
  assert(exists('public/img/logo.png'), 'unticked image was deleted')
  assert(!exists('public/img/logo.webp'), 'unticked image was converted')
  assert(exists('public/img/hero.webp'), 'ticked image not converted')
  const c4 = read('src/App.jsx')
  assert(c4.includes('/img/logo.png'), 'unticked image ref was rewritten')
  assert(c4.includes('@/img/hero.webp'), 'ticked image ref not rewritten')

  // 5. Close the preview panel without choosing -> nothing converted.
  ;({ imgDir } = await fixture())
  previewOut = null
  await handlers['webpify.convertFolder'](imgDir, [imgDir])
  previewOut = { format: 'webp', quality: 80 }
  assert(!exists('public/img/hero.webp'), 'closing the preview still converted')
  assert(read('src/App.jsx').includes('hero.png'), 'closing the preview still rewrote code')

  // 6. Multi-select: two folders at once, both converted, one checklist covering both.
  ;({ imgDir } = await fixture())
  answers = [KEEP, undefined]
  await handlers['webpify.convertFolder'](null, [
    stub.Uri.file(path.join(fixtureRoot, 'public/img/icons')),
    stub.Uri.file(path.join(fixtureRoot, 'src')),
  ])
  assert(exists('public/img/icons/hero.webp'), 'multi-select missed the image folder')
  assert(!exists('public/img/hero.webp'), 'multi-select converted a folder that was not selected')

  // 6b. Overlapping selections must not offer the same image twice.
  ;({ imgDir } = await fixture())
  let offered = 0
  pick = (items) => { offered = items.length; return items }
  answers = [KEEP, undefined]
  await handlers['webpify.convertFolder'](null, [imgDir, stub.Uri.file(path.join(fixtureRoot, 'public/img/icons'))])
  pick = (items) => items
  assert(offered === 4, `nested folders double-counted images: got ${offered}, want 4`)

  // 7. A single image file, not a folder, is converted too.
  ;({ imgDir } = await fixture())
  answers = [KEEP, undefined]
  await handlers['webpify.convertFolder'](null, [stub.Uri.file(path.join(fixtureRoot, 'public/img/hero.png'))])
  assert(exists('public/img/hero.webp'), 'single image file was not converted')
  assert(!exists('public/img/logo.webp'), 'single-file pick converted its siblings')
  assert(read('src/App.jsx').includes('@/img/hero.webp'), 'single-file pick did not rewrite its ref')

  // 8. AVIF output writes .avif and rewrites refs to match.
  ;({ imgDir } = await fixture())
  previewOut = { format: 'avif', quality: 50 }
  answers = [KEEP, undefined]
  await handlers['webpify.convertFolder'](imgDir, [imgDir])
  previewOut = { format: 'webp', quality: 80 }
  assert(exists('public/img/hero.avif'), 'avif output not written')
  assert(read('src/App.jsx').includes('@/img/hero.avif'), 'avif ref not rewritten')

  // 9. PNG output on a PNG source re-encodes in place: no new file, no ref change, no delete prompt.
  ;({ imgDir } = await fixture())
  const sizeBefore = fs.statSync(path.join(fixtureRoot, 'public/img/hero.png')).size
  previewOut = { format: 'png', quality: 50 }
  pick = (items) => items.filter((i) => i.label.endsWith('.png'))
  asked.length = 0
  answers = [undefined]
  await handlers['webpify.convertFolder'](imgDir, [imgDir])
  pick = (items) => items
  previewOut = { format: 'webp', quality: 80 }
  assert(exists('public/img/hero.png'), 'in-place re-encode removed the source')
  assert(read('src/App.jsx').includes('@/img/hero.png'), 'in-place re-encode rewrote refs')
  assert(!asked.some((m) => /Delete the originals/.test(m)), 'in-place re-encode still asked to delete originals')
  assert(fs.statSync(path.join(fixtureRoot, 'public/img/hero.png')).size !== sizeBefore, 'in-place re-encode did not rewrite the file')

  // 10. Preview panel renders the format choices and quality levels.
  assert(lastHtml.includes('acquireVsCodeApi'), 'preview panel never rendered')
  assert(/"levels":\[50/.test(lastHtml) && /95\]/.test(lastHtml), 'preview is missing quality levels')
  assert(/"id":"avif"/.test(lastHtml) && /"id":"webp"/.test(lastHtml), 'preview is missing format choices')

  // 11. "Remember" writes the choice to settings and turns the preview off for next time.
  ;({ imgDir } = await fixture())
  settings = {}
  previewOut = { format: 'avif', quality: 60, remember: true }
  answers = [KEEP, undefined]
  await handlers['webpify.convertFolder'](imgDir, [imgDir])
  previewOut = { format: 'webp', quality: 80 }
  assert(settings['skipPreview'] === true, 'remember did not set skipPreview')
  assert(settings['format'] === 'avif' && settings['quality'] === 60, `remember stored ${JSON.stringify(settings)}`)

  // 12. With skipPreview on, the checklist alone converts — the panel never opens.
  ;({ imgDir } = await fixture())
  settings = { skipPreview: true, format: 'avif', quality: 60 }
  lastHtml = ''
  answers = [KEEP, undefined]
  await handlers['webpify.convertFolder'](imgDir, [imgDir])
  assert(exists('public/img/hero.avif'), 'skipPreview did not convert with the stored format')
  assert(lastHtml === '', 'skipPreview still opened the preview panel')
  assert(lastQuickPick.buttons.length === 2, 'skipPreview checklist should offer both buttons')

  // 13. The sliders button reopens the preview for one run without changing settings.
  ;({ imgDir } = await fixture())
  settings = { skipPreview: true, format: 'avif', quality: 60 }
  quickPickButton = 0                       // the "preview this once" button
  previewOut = { format: 'webp', quality: 90 }
  answers = [KEEP, undefined]
  await handlers['webpify.convertFolder'](imgDir, [imgDir])
  quickPickButton = null
  previewOut = { format: 'webp', quality: 80 }
  assert(exists('public/img/hero.webp'), 'one-off preview did not use the format chosen in the panel')
  assert(settings['skipPreview'] === true, 'one-off preview changed the stored settings')

  // 14. The gear button opens settings and converts nothing.
  ;({ imgDir } = await fixture())
  settings = {}
  openedSettings = 0
  quickPickButton = 0                       // with skipPreview off, index 0 is the gear
  await handlers['webpify.convertFolder'](imgDir, [imgDir])
  quickPickButton = null
  assert(openedSettings === 1, 'gear button did not open settings')
  assert(!exists('public/img/hero.webp'), 'gear button converted anyway')

  // 15. An image that would grow is left alone, and its reference is NOT rewritten —
  //     otherwise the code would point at a file that was never written.
  ;({ imgDir } = await fixture())
  settings = {}
  previewOut = { format: 'webp', quality: 95 }
  answers = [KEEP, undefined]
  await handlers['webpify.convertFolder'](imgDir, [imgDir])
  previewOut = { format: 'webp', quality: 80 }
  assert(exists('public/img/noise.jpg'), 'skipped source was removed')
  assert(!exists('public/img/noise.webp'), 'a larger WebP was written anyway')
  const c15 = read('src/App.jsx')
  assert(c15.includes('/img/noise.jpg'), 'reference rewritten for an image never written')
  assert(c15.includes('@/img/hero.webp'), 'a skipped image stopped the healthy ones from converting')

  // 16. A failed encode must not leave its reference rewritten either.
  ;({ imgDir } = await fixture())
  fs.writeFileSync(path.join(fixtureRoot, 'public/img/broken.png'), 'not an image at all')
  fs.appendFileSync(path.join(fixtureRoot, 'src/App.jsx'), `<img src="/img/broken.png" />\n`)
  settings = {}
  answers = [KEEP, undefined]
  await handlers['webpify.convertFolder'](imgDir, [imgDir])
  const c16 = read('src/App.jsx')
  assert(!exists('public/img/broken.webp'), 'broken image produced output')
  assert(c16.includes('/img/broken.png'), 'reference rewritten for an image that failed to encode')
  assert(c16.includes('@/img/hero.webp'), 'a failed image stopped the healthy ones from being rewritten')

  // 17. Folder with no images -> one info message, no crash.
  ;({ imgDir } = await fixture())
  asked.length = 0
  answers = [undefined]
  await handlers['webpify.convertFolder'](null, [stub.Uri.file(path.join(fixtureRoot, 'src'))])
  assert(asked.length === 1 && asked[0].includes('no png/jpg/gif'), `unexpected: ${asked[0]}`)

  console.log('extension smoke-test ok (19 flows + import guard)')
}
main()
