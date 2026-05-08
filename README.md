# Multicol Reading (vscode-multicol)

Split the current document into **two panes with Split Editor in Group** (one tab, primary/secondary), with **continuous newspaper-style columns** and **synchronized scrolling** (document-line based `visibleRanges` + `revealRange`).

## Features

- **`Multicol Reading: Toggle Two-Column Reading`** (`multicol.toggleTwoColumn`): switch between single pane and two panes (editor title bar button, status bar, **Ctrl+Alt+N** / **Cmd+Alt+N**).
- **`Turn On Two-Column Reading`** / **`Restore Single Column`**: explicit commands in the Command Palette.
- **`multicol.overlapLines`**: optional vertical overlap between columns (0–10 document lines).
- **Page Down / Page Up** when multicol is active: step by one column height.
- **Per-file editor state (persisted in the workspace)**: each document URI can independently be “two-column on” or off; missing entry means single column. Reload restores split **per URI** that was left on, including scroll **anchor** (best-effort).

## About the author

**雷鹏（Lei Peng）** — The founder of Terark Inc, the creator of TerarkDB, and the new [ToplingDB](https://github.com/topling/toplingdb).

## Debug

1. Run `npm install` in the repo root.
2. Open this folder in VS Code.
3. Press **F5** (Run Extension) to launch an Extension Development Host.
4. Open a text file and run **Multicol Reading: Toggle Two-Column Reading**.

Package: `npm install -g @vscode/vsce` then `vsce package`, install the VSIX from VS Code.

## Layout

| Path | Role |
|------|------|
| `package.json` | Manifest: commands, keybindings, configuration |
| `src/extension.ts` | Activation: commands, status bar, per-document persistence (`multicol.documents.v1` map) |
| `src/session.ts` | `MulticolSession`: scroll sync via `revealRange(AtTop)` |
| `src/layout.ts` | `workbench.action.splitEditorInGroup` / `joinEditorInGroup` |
| `src/editorMetrics.ts` | Lines-per-column heuristic from `visibleRanges` |

## Limits (VS Code API)

- No public pixel scroll API on `TextEditor`; scrolling uses **`revealRange`** — not pixel-identical to native wheel/trackpad in all themes.
- Layout uses **Split Editor in Group** only (two panes per tab); there is no supported third column in the same group.
- **Restore single column** runs **`joinEditorInGroup`** (not `joinTwoGroups`).
- If **split** fails mid-flight, the extension **best-effort rolls back** with **`joinEditorInGroup`** until visible editor count for that document is back to what it was before the attempt.
- Some editor types cannot split in group (non-text editors); split may fail with a clear error.

## Publish (maintainer)

1. **GitHub Release + VSIX**  
   Push a version tag `v*` (e.g. `v0.1.1`). The [Release workflow](.github/workflows/release.yml) compiles, runs `vsce package`, and attaches the `.vsix` to a GitHub Release.

2. **Visual Studio Marketplace**  
   - Create a [publisher](https://marketplace.visualstudio.com/manage) (ID must match `package.json` → `publisher`, here `rockeet`).  
   - Create a Personal Access Token: [Azure DevOps](https://dev.azure.com) → User settings → Personal access tokens → **Custom defined** → scope **Marketplace (Manage)**.  
   - In PowerShell:  
     `$env:VSCE_PAT = 'your_token_here'`  
     `npm run package`  
     `npx vsce publish`  
   Or: `npx vsce publish -p $env:VSCE_PAT`

## License

MIT — see [LICENSE](LICENSE).
