import * as vscode from 'vscode';
import { MulticolSession } from './session';

const COLUMN_COUNT = 2 as const;

const sessions = new Map<string, MulticolSession>();

function refreshMulticolActiveContext(): void {
  const ed = vscode.window.activeTextEditor;
  const active = !!(ed && sessions.has(ed.document.uri.toString()));
  void vscode.commands.executeCommand('setContext', 'multicol.active', active);
}

export function activate(context: vscode.ExtensionContext): void {
  refreshMulticolActiveContext();

  const onDocClosed = vscode.workspace.onDidCloseTextDocument((closedDoc) => {
    const uriStr = closedDoc.uri.toString();
    if (!sessions.has(uriStr)) {
      return;
    }
    const stillOpen = vscode.workspace.textDocuments.some((d) => d.uri.toString() === uriStr);
    if (!stillOpen) {
      sessions.get(uriStr)?.dispose();
      sessions.delete(uriStr);
      refreshMulticolActiveContext();
    }
  });

  const onActiveEditorChange = vscode.window.onDidChangeActiveTextEditor(() => {
    refreshMulticolActiveContext();
  });

  context.subscriptions.push(
    onDocClosed,
    onActiveEditorChange,
    vscode.commands.registerCommand('multicol.toggleTwoColumn', () => runToggleTwoColumn()),
    vscode.commands.registerCommand('multicol.pageDown', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) {
        return;
      }
      sessions.get(ed.document.uri.toString())?.pageBy(1);
    }),
    vscode.commands.registerCommand('multicol.pageUp', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) {
        return;
      }
      sessions.get(ed.document.uri.toString())?.pageBy(-1);
    })
  );
}

export function deactivate(): void {
  void vscode.commands.executeCommand('setContext', 'multicol.active', false);
  for (const s of sessions.values()) {
    s.dispose();
  }
  sessions.clear();
}

async function runToggleTwoColumn(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    void vscode.window.showWarningMessage('Open a text editor first.');
    return;
  }
  const uriStr = ed.document.uri.toString();
  if (sessions.has(uriStr)) {
    await runRestore(ed);
  } else {
    await runStart(ed);
  }
}

async function runStart(editor: vscode.TextEditor): Promise<void> {
  const uriStr = editor.document.uri.toString();
  try {
    const session = await MulticolSession.start(editor.document, COLUMN_COUNT);
    sessions.set(uriStr, session);
    refreshMulticolActiveContext();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void vscode.window.showErrorMessage(`Multicol: failed to split — ${msg}`);
  }
}

async function runRestore(ed: vscode.TextEditor): Promise<void> {
  const uriStr = ed.document.uri.toString();
  const session = sessions.get(uriStr);
  if (!session) {
    return;
  }
  try {
    await session.restoreKeepingActive();
  } finally {
    session.dispose();
    sessions.delete(uriStr);
    refreshMulticolActiveContext();
  }
}
