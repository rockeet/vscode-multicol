import * as vscode from 'vscode';
import { MulticolSession } from './session';
import { yieldToHost } from './layout';

/** Per-document multicol snapshot: key present ⇒ this file should open in two columns again. */
const MULTICOL_PER_DOC_KEY = 'multicol.documents.v1';

/** Legacy single-document workspace keys — migrated into `MULTICOL_PER_DOC_KEY` once. */
const MULTICOL_STATE_KEY_V2 = 'multicol.session.v2';
const MULTICOL_STATE_KEY_V1 = 'multicol.session.v1';

/** Fixed two-column mode on the extension side. */
const COLUMN_COUNT = 2 as const;

interface LegacyStoredPayload {
  enabled?: boolean;
  documentUri?: string;
  columnCount?: number;
  anchorLine?: number;
}

type LegacyRead =
  | { enabled: false }
  | { enabled: true; documentUri: string; columnCount: number; anchorLine: number };

/** Anchor snapshot per URI (multicol implied on for keys present). */
type MulticolDocPersistMap = Record<string, { anchorLine: number }>;

let extensionContext: vscode.ExtensionContext | undefined;
/** Live sessions: one per file that currently has split-in-group multicol. */
const sessions = new Map<string, MulticolSession>();
let statusBar: vscode.StatusBarItem | undefined;
let restoreDebounceTimer: ReturnType<typeof setTimeout> | undefined;
let persistAnchorDebounceTimer: ReturnType<typeof setTimeout> | undefined;

let warnedRestoreFailure = false;

function loadDocMap(ctx: vscode.ExtensionContext): MulticolDocPersistMap {
  const raw = ctx.workspaceState.get<unknown>(MULTICOL_PER_DOC_KEY);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const out: MulticolDocPersistMap = {};
  for (const [uriStr, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!uriStr || typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const anchorLine = (entry as { anchorLine?: unknown }).anchorLine;
    if (typeof anchorLine !== 'number' || !Number.isFinite(anchorLine)) {
      continue;
    }
    out[uriStr] = { anchorLine: Math.trunc(anchorLine) };
  }
  return out;
}

function persistMulticolForDoc(document: vscode.TextDocument, anchorLine: number): void {
  const ctx = extensionContext;
  if (!ctx) {
    return;
  }
  const map = loadDocMap(ctx);
  const maxLine = Math.max(0, document.lineCount - 1);
  const a = Math.min(maxLine, Math.max(0, Math.trunc(anchorLine)));
  map[document.uri.toString()] = { anchorLine: a };
  void ctx.workspaceState.update(MULTICOL_PER_DOC_KEY, map);
}

/** Remove persisted multicol for this URI (default state = single column). */
function clearMulticolForDoc(uriStr: string): void {
  const ctx = extensionContext;
  if (!ctx) {
    return;
  }
  const map = loadDocMap(ctx);
  delete map[uriStr];
  void ctx.workspaceState.update(MULTICOL_PER_DOC_KEY, map);
}

function flushPersistAllOpenSessions(): void {
  const ctx = extensionContext;
  if (!ctx) {
    return;
  }
  const map = loadDocMap(ctx);
  for (const session of sessions.values()) {
    const uriStr = session.document.uri.toString();
    const maxLine = Math.max(0, session.document.lineCount - 1);
    const a = Math.min(maxLine, Math.max(0, Math.trunc(session.getLastAnchorLine())));
    map[uriStr] = { anchorLine: a };
  }
  void ctx.workspaceState.update(MULTICOL_PER_DOC_KEY, map);
}

function readLegacyPersistedState(ctx: vscode.ExtensionContext): LegacyRead | undefined {
  const raw = ctx.workspaceState.get<LegacyStoredPayload>(MULTICOL_STATE_KEY_V2);
  if (raw && raw.enabled === false) {
    return { enabled: false };
  }
  if (raw && typeof raw.documentUri === 'string' && raw.columnCount === COLUMN_COUNT) {
    return {
      enabled: true,
      documentUri: raw.documentUri,
      columnCount: COLUMN_COUNT,
      anchorLine:
        typeof raw.anchorLine === 'number' && Number.isFinite(raw.anchorLine) ? Math.trunc(raw.anchorLine) : 0
    };
  }
  const legacy = ctx.workspaceState.get<{ documentUri: string; columnCount: number }>(MULTICOL_STATE_KEY_V1);
  if (legacy && legacy.columnCount === COLUMN_COUNT && typeof legacy.documentUri === 'string') {
    return {
      enabled: true,
      documentUri: legacy.documentUri,
      columnCount: COLUMN_COUNT,
      anchorLine: 0
    };
  }
  return undefined;
}

/** One-time migration from workspace-wide single URI state to per-document map. */
function migrateLegacyWorkspaceState(ctx: vscode.ExtensionContext): void {
  const existing = loadDocMap(ctx);
  if (Object.keys(existing).length > 0) {
    void ctx.workspaceState.update(MULTICOL_STATE_KEY_V2, undefined);
    void ctx.workspaceState.update(MULTICOL_STATE_KEY_V1, undefined);
    return;
  }

  const legacy = readLegacyPersistedState(ctx);
  if (legacy && legacy.enabled !== false && 'documentUri' in legacy) {
    const map: MulticolDocPersistMap = {
      [legacy.documentUri]: { anchorLine: legacy.anchorLine }
    };
    void ctx.workspaceState.update(MULTICOL_PER_DOC_KEY, map);
  }
  void ctx.workspaceState.update(MULTICOL_STATE_KEY_V2, undefined);
  void ctx.workspaceState.update(MULTICOL_STATE_KEY_V1, undefined);
}

function refreshMulticolUi(): void {
  const ed = vscode.window.activeTextEditor;
  const active = !!(ed && sessions.has(ed.document.uri.toString()));
  void vscode.commands.executeCommand('setContext', 'multicol.active', active);
  refreshStatusBar();
}

function refreshStatusBar(): void {
  if (!statusBar) {
    return;
  }
  const ed = vscode.window.activeTextEditor;
  const on = !!(ed && sessions.has(ed.document.uri.toString()));
  if (on) {
    statusBar.text = '$(check) 2-col';
    statusBar.tooltip = 'Multicol: two-column mode on for this file — click to turn off';
  } else {
    statusBar.text = '$(columns) 2-col';
    statusBar.tooltip = 'Multicol: two-column mode off for this file — click to turn on';
  }
  statusBar.command = 'multicol.toggleTwoColumn';
}

function schedulePersistAllMulticolAnchors(): void {
  if (!extensionContext || sessions.size === 0) {
    return;
  }
  if (persistAnchorDebounceTimer !== undefined) {
    clearTimeout(persistAnchorDebounceTimer);
  }
  persistAnchorDebounceTimer = setTimeout(() => {
    persistAnchorDebounceTimer = undefined;
    flushPersistAllOpenSessions();
  }, 400);
}

async function recreateMulticolSession(doc: vscode.TextDocument, anchor: number): Promise<void> {
  const uriStr = doc.uri.toString();
  try {
    sessions.get(uriStr)?.dispose();
    sessions.delete(uriStr);
    const session = await MulticolSession.start(doc, COLUMN_COUNT, { initialAnchorLine: anchor });
    sessions.set(uriStr, session);
    persistMulticolForDoc(doc, session.getLastAnchorLine());
    refreshMulticolUi();
  } catch (e) {
    if (!warnedRestoreFailure) {
      warnedRestoreFailure = true;
      const detail = e instanceof Error ? e.message : String(e);
      void vscode.window.showWarningMessage(`Multicol: could not restore two-column layout — ${detail}`);
    }
  }
}

async function tryRestorePersistedMulticolForUri(uriStr: string): Promise<void> {
  const ctx = extensionContext;
  if (!ctx || sessions.has(uriStr)) {
    return;
  }

  const map = loadDocMap(ctx);
  const snap = map[uriStr];
  if (!snap) {
    return;
  }

  let doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriStr);
  if (!doc) {
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriStr));
    } catch {
      clearMulticolForDoc(uriStr);
      return;
    }
  }

  const maxLine = Math.max(0, doc.lineCount - 1);
  const anchor = Math.min(maxLine, Math.max(0, snap.anchorLine));

  const pool = (): vscode.TextEditor[] =>
    vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === uriStr);

  let editors = pool();

  if (editors.length === 0) {
    await vscode.window.showTextDocument(doc, { preview: false });
    await yieldToHost();
    await yieldToHost();
    editors = pool();
  }

  if (editors.length > COLUMN_COUNT) {
    await recreateMulticolSession(doc, anchor);
    return;
  }

  if (editors.length === COLUMN_COUNT) {
    const session = await MulticolSession.attachFromRestoredLayout(doc, COLUMN_COUNT, editors, anchor);
    if (!session) {
      await recreateMulticolSession(doc, anchor);
      return;
    }
    sessions.set(uriStr, session);
    persistMulticolForDoc(doc, session.getLastAnchorLine());
    refreshMulticolUi();
    return;
  }

  await recreateMulticolSession(doc, anchor);
}

async function tryRestoreAllPersistedDocs(): Promise<void> {
  const ctx = extensionContext;
  if (!ctx) {
    return;
  }
  const map = loadDocMap(ctx);
  for (const uriStr of Object.keys(map)) {
    await tryRestorePersistedMulticolForUri(uriStr);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  warnedRestoreFailure = false;

  extensionContext = context;
  migrateLegacyWorkspaceState(context);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.show();
  refreshMulticolUi();

  const onDocClosed = vscode.workspace.onDidCloseTextDocument((closedDoc) => {
    const uriStr = closedDoc.uri.toString();
    if (!sessions.has(uriStr)) {
      return;
    }
    const stillOpen = vscode.workspace.textDocuments.some((d) => d.uri.toString() === uriStr);
    if (!stillOpen) {
      sessions.get(uriStr)?.dispose();
      sessions.delete(uriStr);
      refreshMulticolUi();
    }
  });

  const onVisibleEditorsChange = vscode.window.onDidChangeVisibleTextEditors(() => {
    const map = loadDocMap(context);
    if (Object.keys(map).length === 0) {
      return;
    }
    if (restoreDebounceTimer !== undefined) {
      clearTimeout(restoreDebounceTimer);
    }
    restoreDebounceTimer = setTimeout(() => {
      restoreDebounceTimer = undefined;
      void tryRestoreAllPersistedDocs();
    }, 400);
  });

  const onVisibleRangesScrollPersist = vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
    const uriStr = e.textEditor.document.uri.toString();
    if (!sessions.has(uriStr)) {
      return;
    }
    schedulePersistAllMulticolAnchors();
  });

  const onDocOpened = vscode.workspace.onDidOpenTextDocument((doc) => {
    const map = loadDocMap(context);
    if (map[doc.uri.toString()] !== undefined && !sessions.has(doc.uri.toString())) {
      void tryRestorePersistedMulticolForUri(doc.uri.toString());
    }
  });

  const onActiveEditorChange = vscode.window.onDidChangeActiveTextEditor(() => {
    refreshMulticolUi();
  });

  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (restoreDebounceTimer !== undefined) {
        clearTimeout(restoreDebounceTimer);
        restoreDebounceTimer = undefined;
      }
      if (persistAnchorDebounceTimer !== undefined) {
        clearTimeout(persistAnchorDebounceTimer);
        persistAnchorDebounceTimer = undefined;
      }
    }),
    statusBar,
    onDocClosed,
    onVisibleEditorsChange,
    onVisibleRangesScrollPersist,
    onDocOpened,
    onActiveEditorChange,
    vscode.commands.registerCommand('multicol.toggleTwoColumn', async () => {
      await runToggleTwoColumn();
    }),
    vscode.commands.registerCommand('multicol.activateTwoColumn', async () => {
      await runActivateTwoColumn();
    }),
    vscode.commands.registerCommand('multicol.restoreSingleColumn', async () => {
      await runRestore();
    }),
    vscode.commands.registerCommand('multicol.pageDown', () => {
      const ed = vscode.window.activeTextEditor;
      const s = ed ? sessions.get(ed.document.uri.toString()) : undefined;
      s?.pageBy(1);
      if (s) {
        schedulePersistAllMulticolAnchors();
      }
    }),
    vscode.commands.registerCommand('multicol.pageUp', () => {
      const ed = vscode.window.activeTextEditor;
      const s = ed ? sessions.get(ed.document.uri.toString()) : undefined;
      s?.pageBy(-1);
      if (s) {
        schedulePersistAllMulticolAnchors();
      }
    })
  );

  void tryRestoreAllPersistedDocs();
}

export function deactivate(): void {
  if (extensionContext) {
    flushPersistAllOpenSessions();
  }

  void vscode.commands.executeCommand('setContext', 'multicol.active', false);
  for (const s of sessions.values()) {
    s.dispose();
  }
  sessions.clear();
  extensionContext = undefined;
  refreshStatusBar();
  if (restoreDebounceTimer !== undefined) {
    clearTimeout(restoreDebounceTimer);
    restoreDebounceTimer = undefined;
  }
  if (persistAnchorDebounceTimer !== undefined) {
    clearTimeout(persistAnchorDebounceTimer);
    persistAnchorDebounceTimer = undefined;
  }
  statusBar?.dispose();
  statusBar = undefined;
}

async function runToggleTwoColumn(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    void vscode.window.showWarningMessage('Open a text editor first.');
    return;
  }
  if (sessions.has(ed.document.uri.toString())) {
    await runRestore({ silent: true });
  } else {
    await runActivateTwoColumn({ silent: true });
  }
}

async function runActivateTwoColumn(options?: { silent?: boolean }): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage('Open a text editor first.');
    return;
  }

  const uriStr = editor.document.uri.toString();
  if (sessions.has(uriStr)) {
    if (!options?.silent) {
      void vscode.window.showInformationMessage('Two-column reading is already on for this file.');
    }
    return;
  }

  try {
    const session = await MulticolSession.start(editor.document, COLUMN_COUNT);
    sessions.set(uriStr, session);
    persistMulticolForDoc(editor.document, session.getLastAnchorLine());
    refreshMulticolUi();
    if (!options?.silent) {
      void vscode.window.showInformationMessage(
        'Two-column reading is on for this file. Toggle again or use Restore Single Column to turn it off.'
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void vscode.window.showErrorMessage(`Multicol: failed to split — ${msg}`);
  }
}

async function runRestore(options?: { silent?: boolean }): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    void vscode.window.showWarningMessage('Open a text editor first.');
    return;
  }
  const uriStr = ed.document.uri.toString();
  const session = sessions.get(uriStr);
  if (!session) {
    clearMulticolForDoc(uriStr);
    if (!options?.silent) {
      void vscode.window.showInformationMessage('Two-column reading is off for this file.');
    }
    refreshMulticolUi();
    return;
  }

  try {
    await session.restoreKeepingActive();
  } finally {
    session.dispose();
    sessions.delete(uriStr);
    clearMulticolForDoc(uriStr);
    refreshMulticolUi();
  }
  if (!options?.silent) {
    void vscode.window.showInformationMessage('Restored this file to a single column.');
  }
}
