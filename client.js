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

async function runCurrentFile(subcommand) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== "ezy") { vscode.window.showWarningMessage("Ezy: no .ez file is active."); return; }
  if (ed.document.isUntitled) { vscode.window.showWarningMessage("Ezy: save the file first."); return; }
  await ed.document.save();
  const t = terminal();
  t.show(true);
  t.sendText(`${ezyBinary()} ${subcommand} ${JSON.stringify(ed.document.uri.fsPath)}`);
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

// Toggle `#` line comments over the selected lines (whole lines that the
// selection touches). If every non-blank line is already commented, uncomment;
// otherwise comment all of them, aligned to the least-indented line.
function toggleComment() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== "ezy") {
    vscode.window.showWarningMessage("Ezy: no .ez file is active.");
    return;
  }
  const doc = ed.document;
  return ed.edit((builder) => {
    for (const sel of ed.selections) {
      let last = sel.end.line;
      // a selection that ends at column 0 doesn't really include that last line
      if (last > sel.start.line && sel.end.character === 0) last--;
      const lines = [];
      for (let ln = sel.start.line; ln <= last; ln++) lines.push(ln);

      const nonBlank = lines.filter((ln) => doc.lineAt(ln).text.trim() !== "");
      const target = nonBlank.length ? nonBlank : lines;
      const allCommented = target.every((ln) => /^\s*#/.test(doc.lineAt(ln).text));

      if (allCommented) {
        for (const ln of target) {
          const text = doc.lineAt(ln).text;
          const m = /^(\s*)#[ ]?/.exec(text); // drop `#` and one optional space
          if (!m) continue;
          builder.delete(new vscode.Range(ln, m[1].length, ln, m[0].length));
        }
      } else {
        // align inserted `#` to the shallowest indentation among target lines
        let indent = Infinity;
        for (const ln of target) {
          const t = doc.lineAt(ln).text;
          indent = Math.min(indent, /^\s*/.exec(t)[0].length);
        }
        if (!isFinite(indent)) indent = 0;
        for (const ln of target) {
          if (nonBlank.length && doc.lineAt(ln).text.trim() === "") continue;
          builder.insert(new vscode.Position(ln, indent), "# ");
        }
      }
    }
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
    vscode.commands.registerCommand("ezy.run", () => runCurrentFile("run")),
    vscode.commands.registerCommand("ezy.compile", () => runCurrentFile("compile")),
    vscode.commands.registerCommand("ezy.doctor", () => runCurrentFile("doctor")),
    vscode.commands.registerCommand("ezy.format", () => formatCurrentFile()),
    vscode.commands.registerCommand("ezy.comment", () => toggleComment()),
    vscode.window.onDidCloseTerminal((t) => { if (t === ezyTerminal) ezyTerminal = null; })
  );
}

function deactivate() {
  return client ? client.stop() : undefined;
}

module.exports = { activate, deactivate };
