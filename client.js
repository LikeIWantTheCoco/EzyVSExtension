"use strict";
// Ezy extension client: starts the language server (diagnostics, completion,
// hover, symbols, definition, folding, formatting, signature help) and adds the
// Run / Compile terminal commands.

const path = require("path");
const fs = require("fs");
const os = require("os");
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
    vscode.window.onDidCloseTerminal((t) => { if (t === ezyTerminal) ezyTerminal = null; })
  );
}

function deactivate() {
  return client ? client.stop() : undefined;
}

module.exports = { activate, deactivate };
