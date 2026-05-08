# Multicol Reading (vscode-multicol)

Split the current document into **two panes with Split Editor in Group** (one tab), with **synchronized scrolling** (`visibleRanges` on the pane you scroll → `revealRange` on the other).

## Features

- **Toggle Two-Column Reading** (`multicol.toggleTwoColumn`): editor title bar icon or **Ctrl+Alt+N** / **Cmd+Alt+N**.
- **Page Down / Page Up** when multicol is active (`multicol.active`): step by one column height.

State is **not** saved across window reloads; toggle again after restart if needed.

## About the author

**雷鹏（Lei Peng）** — The founder of Terark Inc, the creator of TerarkDB, and the new [ToplingDB](https://github.com/topling/toplingdb).

## Debug

1. Run `npm install` in the repo root.
2. Open this folder in VS Code.
3. Press **F5** (Run Extension).
4. Open a text file and run **Multicol Reading: Toggle Two-Column Reading**.

Package: `npm run package`, then install the `.vsix` from VS Code (**Install from VSIX**).

## Layout

| Path | Role |
|------|------|
| `package.json` | Manifest |
| `src/extension.ts` | Commands, session map |
| `src/session.ts` | Scroll sync |
| `src/layout.ts` | `splitEditorInGroup` / `joinEditorInGroup` |
| `src/editorMetrics.ts` | Line count from `visibleRanges` |

## Limits (VS Code API)

- Scrolling uses **`revealRange`**, not pixel-perfect wheel matching.
- Only **two panes in one group**; closing uses **`joinEditorInGroup`**.

## Publish (maintainer)

Push a tag `v*` to trigger [.github/workflows/release.yml](.github/workflows/release.yml) (builds and attaches the VSIX to a GitHub Release).

Marketplace: `npm run package` then `npx vsce publish` with your PAT ([docs](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)).

## License

MIT — see [LICENSE](LICENSE).
