import * as vscode from 'vscode';
import { getLinesPerView, getViewportAnchorPosition } from './editorMetrics';
import { mergeMulticolEditorGroupsBack, orderEditorsLeftToRight, splitIntoSameGroupColumns } from './layout';

const revealType = vscode.TextEditorRevealType.AtTop;

/**
 * Scroll sync: whichever column fires `visibleRanges` is the source; `revealRange` only on the other column(s).
 */
export class MulticolSession {
  readonly document: vscode.TextDocument;
  readonly columnCount: number;
  private editors: vscode.TextEditor[];
  private disposables: vscode.Disposable[] = [];
  private applying = false;
  private linesPerView: number;
  private lastAnchorLine = -1;

  private pendingFlushSource: vscode.TextEditor | undefined;
  private flushChainScheduled = false;

  private ignoreNextVisibleRangeFor = new Set<vscode.TextEditor>();
  private ignoreReleaseTimers = new Map<vscode.TextEditor, ReturnType<typeof setTimeout>>();

  private constructor(document: vscode.TextDocument, columnCount: number, editors: vscode.TextEditor[], linesPerView: number) {
    this.document = document;
    this.columnCount = columnCount;
    this.editors = editors;
    this.linesPerView = Math.max(1, linesPerView);
  }

  static async start(document: vscode.TextDocument, columnCount: number): Promise<MulticolSession> {
    const seed = vscode.window.activeTextEditor;
    const sameUri = seed && seed.document.uri.toString() === document.uri.toString();
    if (!seed || !sameUri) {
      await vscode.window.showTextDocument(document, { preview: false });
    }
    if (!vscode.window.activeTextEditor) {
      throw new Error('Could not determine the active text editor.');
    }

    let editors = await splitIntoSameGroupColumns(document, columnCount);
    editors = await orderEditorsLeftToRight(document, editors);
    const left = editors[0];
    if (!left) {
      throw new Error('No editor after split.');
    }
    const linesPerView = Math.max(1, getLinesPerView(left));

    const maxLine = Math.max(0, document.lineCount - 1);
    const initial = Math.min(maxLine, Math.max(0, getViewportAnchorPosition(left).line));

    const session = new MulticolSession(document, columnCount, editors, linesPerView);
    session.layoutEveryColumnFromAnchor(initial);
    session.wire();
    return session;
  }

  dispose(): void {
    this.pendingFlushSource = undefined;
    this.flushChainScheduled = false;
    this.ignoreNextVisibleRangeFor.clear();
    for (const t of this.ignoreReleaseTimers.values()) {
      clearTimeout(t);
    }
    this.ignoreReleaseTimers.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  getLastAnchorLine(): number {
    if (this.lastAnchorLine >= 0) {
      return this.lastAnchorLine;
    }
    const left = this.editors[0];
    return left && left.visibleRanges.length ? getViewportAnchorPosition(left).line : 0;
  }

  pageBy(deltaPages: 1 | -1): void {
    this.editors = this.editors.filter((ed) => this.isEditorAlive(ed));
    if (this.editors.length !== this.columnCount) {
      if (!this.rebuildEditorsFromUriPool()) {
        return;
      }
    }
    const left = this.editors[0];
    if (left) {
      this.lastAnchorLine = getViewportAnchorPosition(left).line;
    } else if (this.lastAnchorLine < 0) {
      this.lastAnchorLine = 0;
    }

    const step = this.linesPerView;
    const maxLine = Math.max(0, this.document.lineCount - 1);
    let next = this.lastAnchorLine + deltaPages * step;
    next = Math.max(0, Math.min(maxLine, next));
    if (next === this.lastAnchorLine) {
      return;
    }
    this.layoutEveryColumnFromAnchor(next);
  }

  async restoreKeepingActive(): Promise<void> {
    const active = vscode.window.activeTextEditor;
    const anchor =
      active && active.document.uri.toString() === this.document.uri.toString()
        ? getViewportAnchorPosition(active)
        : new vscode.Position(0, 0);

    await mergeMulticolEditorGroupsBack(this.document, this.columnCount);

    const restored = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === this.document.uri.toString());
    if (restored) {
      this.applying = true;
      try {
        restored.revealRange(new vscode.Range(anchor, anchor), revealType);
      } finally {
        this.applying = false;
      }
    }
  }

  private wire(): void {
    const sub = vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      if (e.textEditor.document.uri.toString() !== this.document.uri.toString()) {
        return;
      }
      if (this.ignoreNextVisibleRangeFor.delete(e.textEditor)) {
        const tid = this.ignoreReleaseTimers.get(e.textEditor);
        if (tid !== undefined) {
          clearTimeout(tid);
          this.ignoreReleaseTimers.delete(e.textEditor);
        }
        return;
      }
      if (this.applying) {
        return;
      }
      if (!this.editors.includes(e.textEditor)) {
        if (!this.rebindEditorsFromVisiblePool(e.textEditor)) {
          return;
        }
      }
      this.enqueueFlushVisibleRangeSync(e.textEditor);
    });
    this.disposables.push(sub);
  }

  private assignEditorsFromPool(pool: vscode.TextEditor[]): void {
    const tagged = pool.map((t, i) => ({ t, i }));
    tagged.sort((a, b) => {
      const va = a.t.viewColumn ?? 0;
      const vb = b.t.viewColumn ?? 0;
      if (va !== vb) {
        return va - vb;
      }
      const pa = getViewportAnchorPosition(a.t);
      const pb = getViewportAnchorPosition(b.t);
      if (pa.line !== pb.line) {
        return pa.line - pb.line;
      }
      if (pa.character !== pb.character) {
        return pa.character - pb.character;
      }
      return a.i - b.i;
    });
    this.editors = tagged.map((x) => x.t);
  }

  private rebuildEditorsFromUriPool(): boolean {
    const key = this.document.uri.toString();
    const pool = vscode.window.visibleTextEditors.filter((t) => t.document.uri.toString() === key);
    if (pool.length !== this.columnCount) {
      return false;
    }
    this.assignEditorsFromPool(pool);
    return true;
  }

  private rebindEditorsFromVisiblePool(trigger: vscode.TextEditor): boolean {
    const key = this.document.uri.toString();
    const pool = vscode.window.visibleTextEditors.filter((t) => t.document.uri.toString() === key);
    if (pool.length !== this.columnCount || !pool.includes(trigger)) {
      return false;
    }
    this.assignEditorsFromPool(pool);
    return true;
  }

  private enqueueFlushVisibleRangeSync(source: vscode.TextEditor): void {
    this.pendingFlushSource = source;
    if (this.flushChainScheduled) {
      return;
    }
    this.flushChainScheduled = true;
    const tick = (): void => {
      if (this.applying) {
        queueMicrotask(tick);
        return;
      }
      const src = this.pendingFlushSource;
      if (!src) {
        this.flushChainScheduled = false;
        return;
      }
      this.pendingFlushSource = undefined;
      this.syncOtherColumnsAfterNativeScrollOn(src);
      queueMicrotask(tick);
    };
    queueMicrotask(tick);
  }

  private syncOtherColumnsAfterNativeScrollOn(source: vscode.TextEditor): void {
    this.editors = this.editors.filter((ed) => this.isEditorAlive(ed));
    if (this.editors.length !== this.columnCount) {
      if (!this.rebuildEditorsFromUriPool()) {
        return;
      }
    }
    if (!this.editors.includes(source)) {
      if (!this.rebindEditorsFromVisiblePool(source)) {
        return;
      }
    }
    const idx = this.editors.indexOf(source);
    if (idx < 0) {
      return;
    }

    if (!source.visibleRanges.length) {
      return;
    }

    const step = this.linesPerView;
    const maxLine = Math.max(0, this.document.lineCount - 1);
    const topLine = getViewportAnchorPosition(source).line;
    const anchorLine = Math.min(maxLine, Math.max(0, topLine - idx * step));

    if (anchorLine !== this.lastAnchorLine) {
      this.lastAnchorLine = anchorLine;
      this.revealOtherColumnsForAnchor(anchorLine, source);
    }
  }

  private layoutEveryColumnFromAnchor(anchorLine: number): void {
    const maxLine = Math.max(0, this.document.lineCount - 1);
    this.lastAnchorLine = Math.min(maxLine, Math.max(0, Math.trunc(anchorLine)));
    this.applyAnchorLayout(this.lastAnchorLine, { forceReveal: true });
  }

  private revealOtherColumnsForAnchor(anchorLine: number, nativeEditor: vscode.TextEditor): void {
    this.applyAnchorLayout(anchorLine, { forceReveal: false, skipEditor: nativeEditor });
  }

  private applyAnchorLayout(
    anchorLine: number,
    opts: { forceReveal: boolean; skipEditor?: vscode.TextEditor }
  ): void {
    this.applying = true;
    try {
      const maxLine = Math.max(0, this.document.lineCount - 1);
      const step = this.linesPerView;
      const skip = opts.skipEditor;
      for (let j = 0; j < this.editors.length; j++) {
        const ed = this.editors[j];
        if (!this.isEditorAlive(ed)) {
          continue;
        }
        if (skip !== undefined && ed === skip) {
          continue;
        }
        const line = Math.min(maxLine, anchorLine + j * step);
        const pos = new vscode.Position(line, 0);
        const cur = ed.visibleRanges.length ? getViewportAnchorPosition(ed).line : undefined;
        if (!opts.forceReveal && cur === line) {
          continue;
        }
        this.scheduleIgnoreNextVisibleRange(ed);
        ed.revealRange(new vscode.Range(pos, pos), revealType);
      }
    } finally {
      this.applying = false;
    }
  }

  private scheduleIgnoreNextVisibleRange(ed: vscode.TextEditor): void {
    const prev = this.ignoreReleaseTimers.get(ed);
    if (prev !== undefined) {
      clearTimeout(prev);
    }
    this.ignoreNextVisibleRangeFor.add(ed);
    const tid = setTimeout(() => {
      this.ignoreReleaseTimers.delete(ed);
      this.ignoreNextVisibleRangeFor.delete(ed);
    }, 200);
    this.ignoreReleaseTimers.set(ed, tid);
  }

  private isEditorAlive(editor: vscode.TextEditor): boolean {
    return vscode.window.visibleTextEditors.includes(editor);
  }
}
