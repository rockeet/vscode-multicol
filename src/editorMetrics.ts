import * as vscode from 'vscode';

/**
 * Distinct document lines intersecting the vertical viewport (`visibleRanges` union).
 * Sticky scroll can yield multiple ranges; union counts cover them all.
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
  return Math.max(1, lineSet.size);
}

/**
 * Top of the viewport in document order (`visibleRanges[0].start`).
 */
export function getViewportAnchorPosition(editor: vscode.TextEditor): vscode.Position {
  const ranges = editor.visibleRanges;
  if (!ranges.length) {
    return new vscode.Position(0, 0);
  }
  return ranges[0]!.start;
}
