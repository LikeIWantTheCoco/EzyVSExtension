"use strict";
// Ezy extension client: starts the language server (diagnostics, completion,
// hover, symbols, definition, folding, formatting, signature help) and adds the
// Run / Compile terminal commands.

const path = require("path");
const fs = require("fs");
const os = require("os");
const cp = require("child_process");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

let client;
let ezyTerminal = null;

function ezyBinary() {
  const cfg = vscode.workspace.getConfiguration("ezy");
  const custom = cfg.get("path");
  if (custom && custom.trim()) return custom.trim();
  const home = os.homedir();
  for (const c of [path.join(home, ".local", "bin", "ezy"), "/usr/local/bin/ezy"]) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return "ezy";
}

function terminal() {
  if (!ezyTerminal || ezyTerminal.exitStatus !== undefined) ezyTerminal = vscode.window.createTerminal("Ezy");
  return ezyTerminal;
}

async function runCurrentFile(compileOnly) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== "ezy") { vscode.window.showWarningMessage("Ezy: no .ez file is active."); return; }
  if (ed.document.isUntitled) { vscode.window.showWarningMessage("Ezy: save the file before running."); return; }
  await ed.document.save();
  const t = terminal();
  t.show(true);
  t.sendText(`${ezyBinary()} ${compileOnly ? "compile" : "run"} ${JSON.stringify(ed.document.uri.fsPath)}`);
}

// Run `ezy fmt` on a temp copy of the active buffer and replace its contents.
function formatCurrentFile() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== "ezy") {
    vscode.window.showWarningMessage("Ezy: no .ez file is active.");
    return;
  }
  const doc = ed.document;
  const dir = doc.isUntitled ? os.tmpdir() : path.dirname(doc.uri.fsPath);
  const base = doc.isUntitled ? "untitled" : path.basename(doc.uri.fsPath, ".ez");
  const tmp = path.join(dir, `.${base}.ezyfmt-${process.pid}.ez`);
  try { fs.writeFileSync(tmp, doc.getText()); }
  catch (e) { vscode.window.showErrorMessage("Ezy: cannot write temp file for formatting."); return; }
  cp.execFile(ezyBinary(), ["fmt", tmp], { timeout: 10000 }, (err, stdout, stderr) => {
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (err) {
      vscode.window.showWarningMessage("Ezy: format failed — " + (stderr || err.message).split("\n")[0]);
      return;
    }
    if (!stdout) return;
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, full, stdout);
    vscode.workspace.applyEdit(edit);
  });
}

function activate(context) {
  const serverModule = context.asAbsolutePath(path.join("server", "server.js"));
  const serverOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ["--nolazy", "--inspect=6011"] } },
  };
  const clientOptions = {
    documentSelector: [{ scheme: "file", language: "ezy" }, { scheme: "untitled", language: "ezy" }],
    synchronize: { configurationSection: "ezy" },
  };

  client = new LanguageClient("ezy", "Ezy Language Server", serverOptions, clientOptions);
  client.start();

  context.subscriptions.push(
    vscode.commands.registerCommand("ezy.run", () => runCurrentFile(false)),
    vscode.commands.registerCommand("ezy.compile", () => runCurrentFile(true)),
    vscode.commands.registerCommand("ezy.format", () => formatCurrentFile()),
    vscode.window.onDidCloseTerminal((t) => { if (t === ezyTerminal) ezyTerminal = null; })
  );
}

function deactivate() {
  return client ? client.stop() : undefined;
}

module.exports = { activate, deactivate };
