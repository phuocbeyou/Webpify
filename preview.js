'use strict'
// Output picker: original vs encoded, side by side, with format and quality controls.
// Variants are encoded on demand and cached — AVIF is far too slow to pre-render the grid.
const vscode = require('vscode')
const path = require('path')
const { readFile } = require('node:fs/promises')
const { encode, human, FORMATS } = require('./webpify.js')

const LEVELS = [50, 60, 70, 75, 80, 85, 90, 95]
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' }
const OUT_MIME = { webp: 'image/webp', avif: 'image/avif', jpeg: 'image/jpeg', png: 'image/png' }

/** Resolves to {format, quality}, or undefined if the user closed the panel. */
async function pickOutput(sample, imageCount, defaults) {
  const raw = await readFile(sample.p)
  const original = {
    name: path.basename(sample.p),
    ext: path.extname(sample.p).toLowerCase(),
    size: raw.length,
    uri: `data:${MIME[path.extname(sample.p).toLowerCase()] ?? 'image/png'};base64,${raw.toString('base64')}`,
  }

  const panel = vscode.window.createWebviewPanel('webpifyPreview', 'Webpify — output', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
  })
  const startIndex = LEVELS.reduce((best, q, i) =>
    Math.abs(q - defaults.quality) < Math.abs(LEVELS[best] - defaults.quality) ? i : best, 0)
  const formats = Object.entries(FORMATS).map(([id, f]) => ({ id, label: f.label, ext: f.ext }))
  panel.webview.html = render(panel.webview, {
    original, formats, levels: LEVELS, startIndex,
    startFormat: defaults.format, imageCount,
  })

  const cache = new Map()
  return new Promise((resolve) => {
    let settled
    panel.webview.onDidReceiveMessage(async (m) => {
      if (m?.type === 'convert') {
        settled = { format: m.format, quality: m.quality, remember: !!m.remember }
        return panel.dispose()
      }
      if (m?.type !== 'preview') return
      const key = `${m.format}:${m.quality}`
      try {
        if (!cache.has(key)) {
          const buf = await encode(sample.p, m.format, m.quality)
          cache.set(key, { size: buf.length, uri: `data:${OUT_MIME[m.format]};base64,${buf.toString('base64')}` })
        }
        panel.webview.postMessage({ type: 'preview', key, ...cache.get(key) })
      } catch (e) {
        panel.webview.postMessage({ type: 'error', key, message: e.message })
      }
    })
    panel.onDidDispose(() => resolve(settled))
  })
}

function render(webview, data) {
  const nonce = Math.random().toString(36).slice(2)
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); margin: 0; padding: 16px 16px 24px; }
  h2 { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 16px; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
  @media (max-width: 720px) { .pair { grid-template-columns: 1fr; } }
  figure { margin: 0; }
  .frame { background: var(--vscode-editorWidget-background);
           border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35));
           border-radius: 6px; display: flex; align-items: center; justify-content: center;
           min-height: 200px; overflow: hidden; position: relative; }
  .frame img { max-width: 100%; max-height: 50vh; display: block; }
  .frame.busy::after { content: 'encoding…'; position: absolute; font-size: 12px;
           color: var(--vscode-descriptionForeground); background: var(--vscode-editorWidget-background);
           padding: 4px 10px; border-radius: 4px; }
  figcaption { font-size: 12px; margin-top: 6px; display: flex; justify-content: space-between; gap: 8px; }
  figcaption b { font-weight: 600; font-variant-numeric: tabular-nums; }
  .win { color: var(--vscode-charts-green, #89d185); }
  .warn { color: var(--vscode-charts-red, #f14c4c); }
  .row { margin-top: 18px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  label { font-size: 12px; color: var(--vscode-descriptionForeground); }
  select { font-family: inherit; font-size: 13px; padding: 4px 8px; border-radius: 3px;
           background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
           border: 1px solid var(--vscode-dropdown-border, transparent); }
  input[type=range] { flex: 1; min-width: 200px; accent-color: var(--vscode-button-background); }
  .q { font-variant-numeric: tabular-nums; font-size: 13px; min-width: 150px; }
  button { font-family: inherit; font-size: 13px; padding: 6px 16px; border: none; border-radius: 3px;
           cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .hint { color: var(--vscode-descriptionForeground); font-size: 11.5px; margin-top: 12px; line-height: 1.5; }
  .remember { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer;
              color: var(--vscode-foreground); }
  .remember input { accent-color: var(--vscode-button-background); cursor: pointer; }
</style></head>
<body>
  <h2>Choose output format and quality</h2>
  <div class="sub" id="sub"></div>
  <div class="pair">
    <figure>
      <div class="frame"><img id="before"></div>
      <figcaption><span id="beforeLabel">Original</span><b id="beforeSize"></b></figcaption>
    </figure>
    <figure>
      <div class="frame" id="afterFrame"><img id="after"></div>
      <figcaption><span id="afterLabel"></span><b id="afterSize"></b></figcaption>
    </figure>
  </div>
  <div class="row">
    <label for="format">Format</label>
    <select id="format"></select>
    <label for="slider">Quality</label>
    <input type="range" id="slider" min="0" step="1">
    <span class="q" id="qLabel"></span>
  </div>
  <div class="row">
    <button id="go"></button>
    <label class="remember"><input type="checkbox" id="remember"> Remember this and skip the preview next time</label>
  </div>
  <div class="row"><span class="hint" id="note"></span></div>
  <div class="hint">Lower quality means smaller files and more artefacts. Writing the same format
  the source already uses re-encodes it in place and leaves your code references untouched.<br>
  Remembering your choice skips straight from the checklist to converting — reopen it any time
  from the gear button on the checklist.</div>
<script nonce="${nonce}">
  const D = ${json};
  const api = acquireVsCodeApi();
  const kb = n => n >= 1048576 ? (n/1048576).toFixed(1)+'MB' : (n/1024).toFixed(0)+'KB';
  const $ = id => document.getElementById(id);
  let pending = null;

  $('before').src = D.original.uri;
  $('beforeSize').textContent = kb(D.original.size);
  $('beforeLabel').textContent = 'Original (' + D.original.ext.replace('.', '').toUpperCase() + ')';
  $('sub').textContent = D.original.name + ' — sample from the ' + D.imageCount + ' image(s) you selected';
  $('go').textContent = 'Convert ' + D.imageCount + ' image(s)';

  const fmt = $('format');
  for (const f of D.formats) {
    const o = document.createElement('option');
    o.value = f.id; o.textContent = f.label;
    if (f.id === D.startFormat) o.selected = true;
    fmt.appendChild(o);
  }
  const slider = $('slider');
  slider.max = D.levels.length - 1;
  slider.value = D.startIndex;

  function current() { return { format: fmt.value, quality: D.levels[slider.value] }; }

  function request() {
    const c = current();
    pending = c.format + ':' + c.quality;
    $('afterFrame').classList.add('busy');
    $('afterLabel').textContent = D.formats.find(f => f.id === c.format).label + ' ' + c.quality + '%';
    $('afterSize').textContent = '';
    $('qLabel').textContent = 'Quality ' + c.quality + '%';
    const inPlace = '.' + D.formats.find(f => f.id === c.format).ext === D.original.ext;
    $('note').textContent = inPlace ? 'Same format as the source — re-encoded in place, code untouched.'
      : (c.format === 'avif' ? 'AVIF encodes slowly; a large batch will take a while.' : '');
    api.postMessage({ type: 'preview', format: c.format, quality: c.quality });
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.key !== pending) return;      // a stale reply from a level we already left
    $('afterFrame').classList.remove('busy');
    if (m.type === 'error') { $('afterSize').textContent = m.message; return; }
    $('after').src = m.uri;
    $('afterSize').textContent = kb(m.size);
    const cut = Math.round((1 - m.size / D.original.size) * 100);
    $('qLabel').innerHTML = 'Quality <b>' + current().quality + '%</b> · <span class="' +
      (cut > 0 ? 'win' : 'warn') + '">' + (cut > 0 ? '−' + cut + '%' : '+' + Math.abs(cut) + '%') + '</span>';
    if (m.size >= D.original.size) {
      $('note').innerHTML = '<span class="warn">Larger than the source — this image would be ' +
        'left as-is. Flat GIFs and already-optimised PNGs often grow at high quality; try a lower one.</span>';
    }
  });

  let timer;
  const debounced = () => { clearTimeout(timer); timer = setTimeout(request, 120); };
  slider.addEventListener('input', debounced);
  fmt.addEventListener('change', request);
  $('go').addEventListener('click', () =>
    api.postMessage({ type: 'convert', ...current(), remember: $('remember').checked }));
  request();
</script>
</body></html>`
}

module.exports = { pickOutput, LEVELS }
