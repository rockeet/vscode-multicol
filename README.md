# Multicol Reading (vscode-multicol)

Split the current document into **two panes with Split Editor in Group** (one tab), with **synchronized scrolling** and **per-file workspace persistence** (reload restores two-column layout and anchor when possible).

## Features

- **Toggle Two-Column Reading** (`multicol.toggleTwoColumn`): title bar, status bar **2-col**, **Ctrl+Alt+N** / **Cmd+Alt+N**.
- **Turn On** / **Restore Single Column**: command palette.
- **`multicol.overlapLines`**: optional overlap between columns (0–10 document lines).
- **Page Down / Page Up** when multicol is active.
- **Workspace persistence**: `multicol.documents.v1` stores per-URI anchor; reopen / reload tries to restore split for that file.

## About the author

**雷鹏（Lei Peng）** — The founder of Terark Inc, the creator of TerarkDB, and the new [ToplingDB](https://github.com/topling/toplingdb).

## Debug

1. `npm install` → open folder → **F5**.
2. **Multicol Reading: Toggle Two-Column Reading** on a text file.

`npm run package` → install `.vsix` (**Install from VSIX**).

## Layout

| Path | Role |
|------|------|
| `src/extension.ts` | Commands, status bar, persistence |
| `src/session.ts` | Scroll sync |
| `src/layout.ts` | Split / join in group |
| `src/editorMetrics.ts` | Lines per pane from `visibleRanges` |

## Limits

- Scroll sync uses **`revealRange`**, not pixel-perfect tracking.
- Two panes per tab only; restore uses **`joinEditorInGroup`**.

## Publish

Push tag `v*` → [.github/workflows/release.yml](.github/workflows/release.yml) attaches VSIX to a GitHub Release. Marketplace: `npx vsce publish` with PAT.

## License

MIT — see [LICENSE](LICENSE).
