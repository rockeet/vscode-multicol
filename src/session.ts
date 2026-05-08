import * as vscode from 'vscode';
import { getLinesPerView, getViewportAnchorPosition } from './editorMetrics';
import { mergeMulticolEditorGroupsBack, orderEditorsLeftToRight, splitIntoSameGroupColumns } from './layout';

const revealType = vscode.TextEditorRevealType.AtTop;

/**
 * Scroll sync model:
 * - Whichever column fires `visibleRanges` is treated as the column the user scrolled in;
 *   VS Code already applied native scrolling there — we never call `revealRange` on it for that event.
 * - Read that column’s top document line, derive the shared anchor for the contiguous layout,
 *   and call `revealRange` only on the other column(s) so their first visible line matches.
 */
export class MulticolSession {
  readonly document: vscode.TextDocument;
  readonly columnCount: number;
  private editors: vscode.TextEditor[];
  private disposables: vscode.Disposable[] = [];
  private applying = false;
  private linesPerView: number;
  private lastAnchorLine = -1;

  /** Coalesce multiple `visibleRanges` updates in one frame; flush uses the last source editor only. */
  private pendingFlushSource: vscode.TextEditor | undefined;
  private flushChainScheduled = false;

  /**
   * After `revealRange`, the host often fires `visibleRanges` once with a stale top line; honoring it would
   * snap the user-scrolled column back. Ignore exactly one such event per editor we programmatically moved.
   */
  private ignoreNextVisibleRangeFor = new Set<vscode.TextEditor>();
  private ignoreReleaseTimers = new Map<vscode.TextEditor, ReturnType<typeof setTimeout>>();

  private constructor(document: vscode.TextDocument, columnCount: number, editors: vscode.TextEditor[], linesPerView: number) {
    this.document = document;
    this.columnCount = columnCount;
    this.editors = editors;
    this.linesPerView = Math.max(1, linesPerView);
  }

  static async start(
    document: vscode.TextDocument,
    columnCount: number,
    options?: { initialAnchorLine?: number }
  ): Promise<MulticolSession> {
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
    /** Measure after panes exist — pre-split full-width would overestimate lines-per-column and skew the first layout. */
    const linesPerView = Math.max(1, getLinesPerView(left));

    const maxLine = Math.max(0, document.lineCount - 1);
    const initial =
      options?.initialAnchorLine !== undefined
        ? Math.min(maxLine, Math.max(0, Math.trunc(options.initialAnchorLine)))
        : 0;

    const session = new MulticolSession(document, columnCount, editors, linesPerView);
    session.layoutEveryColumnFromAnchor(initial);
    session.wire();
    return session;
  }

  /**
   * Reattach after reload when both panes already exist. Uses `orderEditorsLeftToRight` (same as `start()`),
   * not viewport-only sort — after restore both columns often share the same top line, so sorting only by
   * `visibleRanges` cannot distinguish primary vs secondary and breaks scroll-sync geometry.
   */
  static async attachFromRestoredLayout(
    document: vscode.TextDocument,
    columnCount: number,
    editors: vscode.TextEditor[],
    persistedAnchorLine: number
  ): Promise<MulticolSession | undefined> {
    const alive = editors.filter((e) => vscode.window.visibleTextEditors.includes(e));
    if (alive.length !== columnCount) {
      return undefined;
    }
    const ordered = await orderEditorsLeftToRight(document, [...alive]);
    const left = ordered[0]!;
    const linesPer = Math.max(1, getLinesPerView(left));
    const session = new MulticolSession(document, columnCount, ordered, linesPer);
    session.linesPerView = linesPer;
    /** Layout before `wire()` so the first programmatic reveals do not run through sync handlers. */
    session.applyPersistedAnchorLine(persistedAnchorLine);
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

  getEditors(): readonly vscode.TextEditor[] {
    return this.editors;
  }

  /** Contiguous-layout anchor: document line shown at the top of column 0. */
  getLastAnchorLine(): number {
    if (this.lastAnchorLine >= 0) {
      return this.lastAnchorLine;
    }
    const left = this.editors[0];
    return left && left.visibleRanges.length ? getViewportAnchorPosition(left).line : 0;
  }

  /** After restoring editors from workspace state, force both columns to the saved anchor. */
  applyPersistedAnchorLine(line: number): void {
    const maxLine = Math.max(0, this.document.lineCount - 1);
    const a = Math.min(maxLine, Math.max(0, Math.trunc(line)));
    this.layoutEveryColumnFromAnchor(a);
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

    const step = this.getColumnStep();
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
    const subCfg = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('multicol.overlapLines', this.document.uri)) {
        return;
      }
      const ed0 = this.editors[0];
      const anchor = ed0
        ? getViewportAnchorPosition(ed0).line
        : this.lastAnchorLine >= 0
          ? this.lastAnchorLine
          : 0;
      this.layoutEveryColumnFromAnchor(anchor);
    });
    this.disposables.push(subCfg);

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

  /**
   * Order columns left-to-right. Split-in-group panes often share the same `viewColumn`; tie-break by viewport
   * top so primary/secondary order matches contiguous layout (left column shows the earlier chunk).
   */
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

  /** When visible editor count matches `columnCount`, rebuild `this.editors` from the URI pool. */
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

  /**
   * `source` just changed viewport natively; align every other column’s top line to the same anchor layout.
   */
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

    const step = this.getColumnStep();
    const maxLine = Math.max(0, this.document.lineCount - 1);
    const topLine = getViewportAnchorPosition(source).line;
    const anchorLine = Math.min(maxLine, Math.max(0, topLine - idx * step));

    if (anchorLine !== this.lastAnchorLine) {
      this.lastAnchorLine = anchorLine;
      this.revealOtherColumnsForAnchor(anchorLine, source);
    }
  }

  private getOverlapLines(): number {
    const v = vscode.workspace.getConfiguration('multicol', this.document.uri).get<number>('overlapLines', 0);
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
    return Math.max(0, n);
  }

  private getColumnStep(): number {
    return Math.max(1, this.linesPerView - this.getOverlapLines());
  }

  /** Full relayout (startup, page commands, overlap setting): reveal every column. */
  private layoutEveryColumnFromAnchor(anchorLine: number): void {
    const maxLine = Math.max(0, this.document.lineCount - 1);
    this.lastAnchorLine = Math.min(maxLine, Math.max(0, Math.trunc(anchorLine)));
    this.applyAnchorLayout(this.lastAnchorLine, { forceReveal: true });
  }

  /**
   * After native scroll on `nativeEditor`, only move other editors so column *j* shows `anchorLine + j×step` at top.
   */
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
      const step = this.getColumnStep();
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

  /** Drop the next `visibleRanges` event for `ed`; release after timeout if the host never sends one. */
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
