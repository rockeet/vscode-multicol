import * as vscode from 'vscode';

/**
 * How many distinct document lines intersect the vertical viewport (`visibleRanges` union).
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
