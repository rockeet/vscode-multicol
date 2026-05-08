import * as vscode from 'vscode';
import { getViewportAnchorPosition } from './editorMetrics';

/** Yield to the extension host so VS Code can refresh editors — no fixed sleep. */
export function yieldToHost(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function isSameTextDocument(a: vscode.TextDocument, b: vscode.TextDocument): boolean {
  if (a === b) {
    return true;
  }
  return a.uri.toString() === b.uri.toString();
}

/** Poll until the host reports the same visible editor count several ticks in a row. */
async function waitForStableVisibleEditorCount(
  document: vscode.TextDocument,
  expected: number,
  timeoutMs: number
): Promise<vscode.TextEditor[]> {
  const deadline = Date.now() + timeoutMs;
  let lastCount = -1;
  let stableTicks = 0;
  let last: vscode.TextEditor[] = [];

  while (Date.now() < deadline) {
    last = vscode.window.visibleTextEditors.filter((e) => isSameTextDocument(e.document, document));
    const n = last.length;
    if (n === expected && n === lastCount) {
      stableTicks++;
      if (stableTicks >= 3) {
        return last;
      }
    } else {
      stableTicks = n === expected ? 1 : 0;
      lastCount = n;
    }
    await yieldToHost();
  }
  return last;
}

/** Best-effort undo after a failed `splitEditorInGroup`: join the in-group side-by-side back to one pane. */
async function rollbackSplitInGroup(document: vscode.TextDocument, maxEditorsBefore: number): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const pool = vscode.window.visibleTextEditors.filter((e) => isSameTextDocument(e.document, document));
    if (pool.length <= maxEditorsBefore) {
      return;
    }
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    await yieldToHost();
    await yieldToHost();
    try {
      await vscode.commands.executeCommand('workbench.action.joinEditorInGroup');
    } catch {
      /* command may reject if not in side-by-side layout */
    }
    await yieldToHost();
    await yieldToHost();
  }
}

function sortEditorsByViewColumnThenViewport(editors: vscode.TextEditor[]): vscode.TextEditor[] {
  return [...editors].sort((a, b) => {
    const va = a.viewColumn ?? 0;
    const vb = b.viewColumn ?? 0;
    if (va !== vb) {
      return va - vb;
    }
    const pa = getViewportAnchorPosition(a);
    const pb = getViewportAnchorPosition(b);
    if (pa.line !== pb.line) {
      return pa.line - pb.line;
    }
    return pa.character - pb.character;
  });
}

/**
 * Two-column layout using **Split Editor in Group** (`workbench.action.splitEditorInGroup`): one tab, two panes.
 * VS Code only supports a single primary/secondary split per group, so `columnCount` must be `2`.
 */
export async function splitIntoSameGroupColumns(
  document: vscode.TextDocument,
  columnCount: number
): Promise<vscode.TextEditor[]> {
  if (columnCount < 2) {
    throw new Error('columnCount must be >= 2');
  }
  if (columnCount !== 2) {
    throw new Error('Split Editor in Group supports exactly two columns.');
  }

  const poolBefore = vscode.window.visibleTextEditors.filter((e) => isSameTextDocument(e.document, document));
  const beforeEditorCount = poolBefore.length;

  /** Already two visible editors for this document (e.g. restored split-in-group) — do not run split again. */
  if (beforeEditorCount === columnCount) {
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    await yieldToHost();
    await yieldToHost();
    return sortEditorsByViewColumnThenViewport([...poolBefore]);
  }

  try {
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    await yieldToHost();
    await yieldToHost();

    await vscode.commands.executeCommand('workbench.action.splitEditorInGroup');
    await yieldToHost();
    await yieldToHost();
    await yieldToHost();

    const editors = await waitForStableVisibleEditorCount(document, columnCount, 8000);

    if (editors.length < columnCount) {
      throw new Error(`Could not create enough columns (expected ${columnCount}, got ${editors.length}).`);
    }
    if (editors.length > columnCount) {
      throw new Error(
        `This file is open in ${editors.length} editors. Close extra tabs or previews so only one visible editor remains for this file, then try again.`
      );
    }

    return sortEditorsByViewColumnThenViewport(editors);
  } catch (err) {
    await rollbackSplitInGroup(document, beforeEditorCount);
    throw err;
  }
}

/**
 * Before synced scrolling, both panes may share the same top line; give each editor a distinct reveal target,
 * then sort by viewport start so left/right matches the UI.
 */
export async function orderEditorsLeftToRight(
  document: vscode.TextDocument,
  editors: vscode.TextEditor[]
): Promise<vscode.TextEditor[]> {
  if (editors.length <= 1) {
    return [...editors];
  }

  const n = editors.length;
  const lineCount = document.lineCount;
  if (lineCount === 0) {
    return [...editors];
  }
  const revealType = vscode.TextEditorRevealType.AtTop;

  if (lineCount >= n) {
    for (let j = 0; j < n; j++) {
      const line = j;
      const pos = new vscode.Position(line, 0);
      editors[j].revealRange(new vscode.Range(pos, pos), revealType);
    }
  } else {
    for (let j = 0; j < n; j++) {
      const line = Math.min(lineCount - 1, j);
      const len = document.lineAt(line).text.length;
      const ch = Math.min(len, j * 3);
      const pos = new vscode.Position(line, ch);
      editors[j].revealRange(new vscode.Range(pos, pos), revealType);
    }
  }

  await yieldToHost();
  await yieldToHost();

  const sorted = [...editors].sort((a, b) => {
    const ra = getViewportAnchorPosition(a);
    const rb = getViewportAnchorPosition(b);
    if (ra.line !== rb.line) {
      return ra.line - rb.line;
    }
    if (ra.character !== rb.character) {
      return ra.character - rb.character;
    }
    const va = a.viewColumn ?? 0;
    const vb = b.viewColumn ?? 0;
    return va - vb;
  });

  return sorted;
}

/**
 * Undo in-group split: `workbench.action.joinEditorInGroup` (repeat `columnCount − 1` times).
 */
export async function mergeMulticolEditorGroupsBack(document: vscode.TextDocument, columnCount: number): Promise<void> {
  const times = Math.max(0, columnCount - 1);
  for (let i = 0; i < times; i++) {
    const pool = vscode.window.visibleTextEditors.filter((e) => isSameTextDocument(e.document, document));
    if (pool.length <= 1) {
      break;
    }
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    await yieldToHost();
    await yieldToHost();
    try {
      await vscode.commands.executeCommand('workbench.action.joinEditorInGroup');
    } catch {
      break;
    }
    await yieldToHost();
    await yieldToHost();
  }
}

export function sortEditorsByViewportStart(editors: vscode.TextEditor[]): vscode.TextEditor[] {
  return [...editors].sort((a, b) => {
    const pa = getViewportAnchorPosition(a);
    const pb = getViewportAnchorPosition(b);
    if (pa.line !== pb.line) {
      return pa.line - pb.line;
    }
    return pa.character - pb.character;
  });
}
