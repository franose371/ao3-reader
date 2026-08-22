# AGENTS.md

No build system, test suite, linter, or CI. All code is hand-written vanilla JS — no bundler or transpiler.

## Deliverables

Two independent shipping targets that must stay in sync:

- **`chrome-extension/`** — Manifest V3 extension. Storage via `chrome.storage.sync`; CSS via `content.css` file.
- **`userscript/ao3-reader.user.js`** — Single-file Tampermonkey script. Storage via `GM_setValue`/`GM_getValue`; CSS via `GM_addStyle` inline.

Both implement the same reading-mode logic. When changing behavior, mirror the change in both files — there is no shared module.

## Version sync

Bump the version in all three places together:

1. `chrome-extension/manifest.json` (`"version"`)
2. `userscript/ao3-reader.user.js` (`// @version`)
3. `CHANGELOG.md` (new section under `## [X.Y.Z]`)

Git commit messages follow the format `v1.2.1: <description>` (see `git log`).

## Settings defaults

The `DEFAULTS` object (keys: `swapLR`, `fontSize`, `theme`, `lineHeight`, `customColor`, `customTextColor`, `marginTop/Bottom/Left/Right`, `pageScroll`, `autoEnterReader`) is duplicated in three files — keep them aligned:

- `chrome-extension/content.js` (the `DEFAULTS` const)
- `chrome-extension/background.js` (inline in `onInstalled` listener)
- `chrome-extension/popup.js` (the `defaults` const)

`background.js` is missing `customColor` and `customTextColor` — intentional, since it only seeds initial install state.

## Testing

Manual testing only. Load the extension unpacked from `chrome-extension/` via `chrome://extensions/`, or install the userscript in Tampermonkey, then open any `https://archiveofourown.org/works/*` page.
