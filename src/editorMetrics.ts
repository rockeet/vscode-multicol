import * as vscode from 'vscode';

export function isWordWrapEnabled(): boolean {
  const w = vscode.workspace.getConfiguration('editor').get<string>('wordWrap', 'off');
  return w !== 'off';
}

/**
 * Estimate how many document lines fit in the pane from `visibleRanges`.
 * Sticky scroll can yield multiple ranges; union line counts so column step is not underestimated.
 */
export function getLinesPerView(editor: vscode.TextEditor): number {
  const ranges = editor.visibleRanges;
  if (!ranges.length) {
    return 1;
  }
  const lineSet = new Set<number>();
  for (const vr of ranges) {
    for (let ln = vr.start.line; ln <= vr.end.line; ln++) {
      lineSet.add(ln);
    }
  }
  let docLines = Math.max(1, lineSet.size);
  const firstVr = ranges[0]!;

  if (docLines === 1 && isWordWrapEnabled()) {
    const line = editor.document.lineAt(firstVr.start.line);
    const conf = vscode.workspace.getConfiguration('editor');
    const tabSize = conf.get<number>('tabSize', 4);
    const fontSize = conf.get<number>('fontSize', 14);
    const estimatedCharWidth = Math.max(5, fontSize * 0.55);
    const assumedContentWidthPx = 880;
    const charsPerVisualRow = Math.max(24, Math.floor(assumedContentWidthPx / estimatedCharWidth));
    const effectiveLen = line.text.replace(/\t/g, ' '.repeat(tabSize)).length;
    const wrappedRows = Math.max(1, Math.ceil(effectiveLen / charsPerVisualRow));
    if (wrappedRows > 1) {
      return Math.max(docLines, wrappedRows);
    }
  }

  return docLines;
}

/**
 * Top-left of the visible viewport in document order. VS Code sorts `visibleRanges` by range start;
 * using `[0].start` matches the line used for layout/scroll math. Taking max(start.line) across ranges
 * breaks sync when sticky scroll / multiple pockets produce a higher segment that is not this column’s top.
 */
export function getViewportAnchorPosition(editor: vscode.TextEditor): vscode.Position {
  const ranges = editor.visibleRanges;
  if (!ranges.length) {
    return new vscode.Position(0, 0);
  }
  return ranges[0]!.start;
}
