# Webpify

[![CI](https://github.com/phuocbeyou/Webpify/actions/workflows/ci.yml/badge.svg)](https://github.com/phuocbeyou/Webpify/actions/workflows/ci.yml)

Convert images to **WebP, AVIF, JPEG or PNG** and **rewrite the path references in your code**
to match. Ships as both a VSCode extension (with UI) and a CLI.

## VSCode extension

Install from the VS Code Marketplace, or from a `.vsix` built locally:
`code --install-extension webpify-darwin-arm64.vsix`

Use: **right-click a folder or an image** in the Explorer → **Convert & Optimize Images**.
Multi-select works: cmd/ctrl-click any mix of folders and image files and it takes them in one
pass, de-duplicating nested selections. The Command Palette opens a picker that accepts both too.

1. **Image checklist** — everything ticked by default, sorted by file size descending,
   with each image's path so you can tell same-named files apart. Untick what to skip, press OK.
2. **Output preview** — original and result side by side, with a **format dropdown**
   (WebP / AVIF / JPEG / PNG) and a **quality slider** from 50% to 95%. Each combination is
   encoded on demand and cached, and the caption shows the resulting file size and the saving,
   so you can see exactly what a given % costs. Press **Convert** to run, or close to cancel.
3. Scans your code, converts, and rewrites the references (progress shown, cancellable).
4. Final dialog: **Delete originals** / **Keep both**.

Tick **Remember this and skip the preview next time** in the panel and step 2 disappears:
the checklist alone converts, using the format and quality you settled on. The checklist's
title bar then carries two buttons — ⚙ opens the settings, and the sliders button reopens
the preview for a single run without changing them.

Writing the format a source file already uses (PNG → PNG) re-encodes it **in place**: no second
file, no reference change, and no delete prompt for it.

**An image whose output comes out no smaller is left untouched** — no file written, no reference
rewritten. Flat GIFs and already-optimised PNGs routinely grow at high quality: a 3.5MB animated
GIF becomes a 4.4MB WebP at 95%, because GIF's palette + LZW beats full-colour lossy on flat art.
The preview flags this, and the Output channel lists every image left as-is.

References are rewritten **after** the encode, from the list of files actually written, so a
skipped or failed image never leaves your code pointing at a file that does not exist.

An unticked image is neither converted nor rewritten, so the code still points at the file
that is actually there.

Per-file details go to Output → channel **Webpify**.
| Setting | Default | |
|---|---|---|
| `webpify.format` | `webp` | Where the preview's format dropdown starts, and what `skipPreview` uses |
| `webpify.quality` | `80` | Where the preview's slider starts, and what `skipPreview` uses |
| `webpify.skipPreview` | `false` | Skip the panel and convert straight to the two settings above |

## CLI

```bash
npm install
node webpify.js <image-folder> [--code <code-root>]
```

| Flag | Default | |
|---|---|---|
| `--code <dir>` | cwd | Where to rewrite references |
| `-f, --format <fmt>` | `webp` | `webp`, `avif`, `jpeg` or `png` |
| `--quality <n>` | `80` | Output quality |
| `-y, --yes` | | Don't prompt: convert + rewrite, **keep** originals |
| `-d, --delete` | | Delete originals without prompting |

## How references are matched

A path is matched by **suffix relative to the code root**, so `public/img/hero.png` matches
`/img/hero.png`, `@/img/hero.png`, `./public/img/hero.png` and `url(img/hero.png?v=3)` —
but leaves `/assets/hero.png` (same filename, different folder) and any image you did not
convert untouched.

Scanned: `js jsx ts tsx mjs mts vue svelte astro css scss sass less html json md php py rb xml yaml`.
Skipped: `node_modules .git dist build out .next .nuxt .output vendor .cache coverage`, files over 2MB.

## Tests

```bash
node webpify.js --self-test   # reference-rewriting logic (14 cases)
node test-extension.js        # 19 UI flows + dynamic-import guard
```

## Notes

- The packaged `.vsix` embeds a `sharp` native binary for the platform it was built on.
  To share it across platforms, reinstall with `npm i --os=... --cpu=...` and repackage.
- Matching the extension first and scanning backwards for the path is deliberate: a leading
  `[^...]*` in the pattern backtracks quadratically on minified bundles (27.7s → 87ms on a
  172MB tree).

## Releasing

CI builds a platform-specific `.vsix` for `darwin-arm64`, `darwin-x64`, `linux-x64`,
`linux-arm64` and `win32-x64` — sharp ships a native binary per platform, so one universal
package is not possible. Every push runs the tests and builds all five; pushing a `v*` tag
also publishes them and attaches them to a GitHub release.

```bash
npm version patch        # or minor / major — updates package.json
git push --follow-tags   # tag v1.8.1 -> CI publishes
```

The publish job refuses to run if the tag and `package.json` version disagree.

### One-time setup

1. Create the `phuocbeyou` publisher at <https://marketplace.visualstudio.com/manage>.
2. Create a Personal Access Token at <https://dev.azure.com> — **All accessible organizations**,
   scope **Marketplace → Manage**.
3. Add it to the repository as the secret **`VSCE_PAT`**
   (Settings → Secrets and variables → Actions).
