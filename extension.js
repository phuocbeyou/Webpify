'use strict'
const vscode = require('vscode')
const path = require('path')
const { stat } = require('node:fs/promises')
const { collectImages, planEdits, convert, applyEdits, removeOriginals, human, saved, FORMATS } = require('./webpify.js')
const { pickOutput } = require('./preview.js')

const DELETE = 'Delete originals'
const KEEP = 'Keep both'
const PREVIEW_MAX = 4 * 1024 * 1024   // don't inline a huge original as a data URI

function activate(context) {
  const out = vscode.window.createOutputChannel('Webpify')
  context.subscriptions.push(
    out,
    // Explorer passes (clicked, allSelected) — the second arg is how multi-select arrives.
    vscode.commands.registerCommand('webpify.convertFolder', (uri, uris) =>
      run(uris?.length ? uris : uri ? [uri] : [], out).catch((e) => {
        out.appendLine(`ERROR: ${e.stack}`)
        vscode.window.showErrorMessage(`Webpify: ${e.message}`, 'Show log').then((a) => a && out.show())
      })
    )
  )
}

async function run(uris, out) {
  // Palette invocation has no uri — ask for folders or images.
  if (!uris.length) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: true, canSelectMany: true, openLabel: 'Convert',
      filters: { Images: ['png', 'jpg', 'jpeg', 'gif'] },
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    })
    if (!picked?.length) return
    uris = picked
  }
  const targets = uris.map((u) => u.fsPath)
  const ws = vscode.workspace.getWorkspaceFolder(uris[0])
  const codeDir = ws ? ws.uri.fsPath : path.dirname(targets[0])
  const rel = (p) => path.relative(codeDir, p) || path.basename(p)
  const where = targets.length === 1 ? `"${rel(targets[0])}"` : `${targets.length} items`

  const found = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Webpify: finding images…' },
    () => collectImages(targets)
  )
  if (!found.length) {
    return vscode.window.showInformationMessage(`Webpify: no png/jpg/gif images in ${where}.`)
  }

  const cfg = vscode.workspace.getConfiguration('webpify')
  const defaults = {
    format: FORMATS[cfg.get('format', 'webp')] ? cfg.get('format', 'webp') : 'webp',
    quality: cfg.get('quality', 80),
  }
  const skipPreview = cfg.get('skipPreview', false)

  // Checklist, everything ticked by default — untick what you don't want converted.
  const sized = await Promise.all(found.map(async (p) => ({ p, size: (await stat(p)).size })))
  sized.sort((a, b) => b.size - a.size)
  const total = human(sized.reduce((n, x) => n + x.size, 0))
  const chosen = await pickImages({
    items: sized.map(({ p, size }) => ({ label: path.basename(p), description: human(size), detail: rel(p), p })),
    title: skipPreview
      ? `Webpify — ${found.length} images in ${where} (${total}) → ${FORMATS[defaults.format].label} ${defaults.quality}%`
      : `Webpify — select images to convert (${found.length} in ${where}, ${total})`,
    placeholder: skipPreview
      ? 'Press OK to convert — gear to change format/quality, sliders to preview just this once'
      : 'All selected by default — untick what you want to skip, then press OK',
    skipPreview,
  })
  if (!chosen) return
  if (!chosen.items.length) return vscode.window.showInformationMessage('Webpify: no images selected.')
  const images = chosen.items.map((c) => c.p)

  // Output picker: preview on the largest image small enough to inline as a data URI.
  let out_ = skipPreview && !chosen.forcePreview ? defaults : undefined
  if (!out_) {
    const picked = sized.filter((x) => images.includes(x.p))
    const sample = picked.find((x) => x.size <= PREVIEW_MAX) ?? picked[picked.length - 1]
    out_ = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Webpify: rendering preview…' },
      () => pickOutput(sample, images.length, defaults)
    )
    if (!out_) return   // panel closed without choosing
    if (out_.remember) {
      await cfg.update('format', out_.format, vscode.ConfigurationTarget.Global)
      await cfg.update('quality', out_.quality, vscode.ConfigurationTarget.Global)
      await cfg.update('skipPreview', true, vscode.ConfigurationTarget.Global)
    }
  }
  const { format, quality } = out_
  const ext = FORMATS[format].ext

  // Convert first: references may only be rewritten for images that actually got written,
  // otherwise a failed or skipped encode leaves the code pointing at a file that isn't there.
  const { done, skipped, before, after } = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Webpify: converting to ${FORMATS[format].label} at ${quality}%`, cancellable: true },
    (p, token) => {
      let i = 0
      return convert(images, { format, quality }, (src, err, wasSkipped) => {
        p.report({ increment: 100 / images.length, message: `${++i}/${images.length}  ${path.basename(src)}` })
        if (err) out.appendLine(`x ${rel(src)}: ${err.message}`)
        else if (wasSkipped) out.appendLine(`• skipped ${rel(src)} — ${ext} came out larger`)
      }, token)
    }
  )

  out.appendLine(`— ${where} → ${FORMATS[format].label} q${quality}: ${done.length} written, ${skipped.length} left as-is, of ${images.length} selected —`)

  if (!done.length) {
    const msg = skipped.length
      ? `Webpify: nothing written — ${FORMATS[format].label} at ${quality}% came out larger than all ${skipped.length} source images. Try a lower quality or a different format.`
      : 'Webpify: could not convert any image.'
    return vscode.window.showWarningMessage(msg, 'Show log').then((a) => a && out.show())
  }

  let cancelled = false
  const edits = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Webpify: scanning code…', cancellable: true },
    async (p, token) => {
      const r = await planEdits(done.map((d) => d.src), codeDir, ext, {
        token,
        onProgress: (i, n) => p.report({ message: `${i}/${n} files` }),
      })
      cancelled = token.isCancellationRequested
      return r
    }
  )
  if (cancelled) {
    out.appendLine('• Code scan cancelled — images were converted but references were left alone.')
    return vscode.window.showWarningMessage(
      `Webpify: ${done.length} images converted, but the code scan was cancelled so no references were updated.`,
      'Show log').then((a) => a && out.show())
  }

  await applyEdits(edits)
  out.appendLine(`✓ ${done.length}/${images.length} images → ${ext} (${human(before)} → ${human(after)}, -${saved(before, after)}%)`)
  for (const e of edits) out.appendLine(`✓ ${rel(e.f)} — ${e.count} refs`)

  // An in-place re-encode (png -> png) leaves no separate original to remove.
  const replaced = done.filter((d) => d.src !== d.dst).map((d) => d.src)
  const delta = `−${saved(before, after)}%, ${human(before)} → ${human(after)}`
  const note = skipped.length ? ` ${skipped.length} left as-is (output was larger).` : ''
  if (!replaced.length) {
    out.appendLine(`• ${done.length} images re-encoded in place.`)
    return vscode.window.showInformationMessage(`Webpify: done — ${done.length} images re-encoded in place (${delta}).${note}`)
  }

  const answer = await vscode.window.showWarningMessage(
    `Converted ${done.length} images to ${FORMATS[format].label} at ${quality}% (${delta}).${note} Delete the originals?`,
    { modal: true, detail: `Code references now point to .${ext} (${edits.length} files updated).\n\n"${DELETE}" — remove the ${replaced.length} source files, keep only .${ext}.\n"${KEEP}" — keep the originals for comparison or rollback.` },
    DELETE, KEEP
  )
  if (answer === DELETE) {
    await removeOriginals(replaced)
    out.appendLine(`✓ Deleted ${replaced.length} originals.`)
    vscode.window.showInformationMessage(`Webpify: done — ${done.length} images converted, ${edits.length} code files updated.`)
  } else {
    out.appendLine(`• Kept ${replaced.length} originals.`)
    vscode.window.showInformationMessage(`Webpify: done — kept ${replaced.length} originals, ${edits.length} code files updated.`)
  }
}

/** Checklist with title-bar buttons — showQuickPick cannot carry those, createQuickPick can.
 *  Resolves to {items, forcePreview} or undefined when dismissed. */
function pickImages({ items, title, placeholder, skipPreview }) {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick()
    const gear = { iconPath: new vscode.ThemeIcon('gear'), tooltip: 'Webpify settings' }
    const tune = { iconPath: new vscode.ThemeIcon('settings'), tooltip: 'Preview format/quality this once' }
    qp.title = title
    qp.placeholder = placeholder
    qp.canSelectMany = true
    qp.matchOnDetail = true
    qp.items = items
    qp.selectedItems = items        // must come after items, or the ticks are dropped
    qp.buttons = skipPreview ? [tune, gear] : [gear]
    let result
    qp.onDidTriggerButton((b) => {
      if (b === gear) return vscode.commands.executeCommand('workbench.action.openSettings', 'webpify')
      result = { items: qp.selectedItems.slice(), forcePreview: true }
      qp.hide()
    })
    qp.onDidAccept(() => { result = { items: qp.selectedItems.slice(), forcePreview: false }; qp.hide() })
    qp.onDidHide(() => { qp.dispose(); resolve(result) })
    qp.show()
  })
}

module.exports = { activate, deactivate() {} }
