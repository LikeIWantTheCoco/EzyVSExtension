"use strict";
// Ezy diagnostics: run `ezy doctor` on the buffer and surface errors/warnings
// as squiggles. TextMate grammars can't produce diagnostics, so this is done
// here in extension code.

const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let collection;
const timers = new Map(); // uri -> debounce timer

/** Resolve the ezy compiler binary from settings or common locations. */
function ezyBinary() {
  const cfg = vscode.workspace.getConfiguration("ezy");
  const custom = cfg.get("path");
  if (custom && custom.trim()) return custom.trim();
  const home = os.homedir();
  const candidates = [path.join(home, ".local", "bin", "ezy"), "/usr/local/bin/ezy"];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return "ezy"; // fall back to PATH
}

/**
 * Parse `ezy doctor` stderr+stdout into diagnostics.
 * Blocks look like:
 *   error: <message>
 *    --> <file>:<line>:<col>
 */
function parseDiagnostics(output, document) {
  const diags = [];
  const lines = output.split(/\r?\n/);
  const headRe = /^(error|warning|fatal)\s*(?:\[[^\]]*\])?\s*:\s*(.*)$/;
  const posRe = /-->\s*.*?:(\d+):(\d+)/;
  let pending = null;

  for (const raw of lines) {
    const head = raw.match(headRe);
    if (head) {
      // flush a previous header that never found a position (e.g. fatal)
      if (pending && pending.severity === vscode.DiagnosticSeverity.Error) {
        diags.push(makeDiag(document, 1, 1, pending.message, pending.severity));
      }
      const kind = head[1];
      pending = {
        message: head[2].trim(),
        severity:
          kind === "warning"
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Error,
      };
      continue;
    }
    const pos = raw.match(posRe);
    if (pos && pending) {
      diags.push(
        makeDiag(document, parseInt(pos[1], 10), parseInt(pos[2], 10), pending.message, pending.severity)
      );
      pending = null;
    }
  }
  // trailing fatal with no position
  if (pending && pending.severity === vscode.DiagnosticSeverity.Error) {
    diags.push(makeDiag(document, 1, 1, pending.message, pending.severity));
  }
  return diags;
}

/** Build a Diagnostic, widening the range to the token at (line,col). */
function makeDiag(document, line1, col1, message, severity) {
  const line = Math.max(0, line1 - 1);
  const col = Math.max(0, col1 - 1);
  const pos = new vscode.Position(line, col);
  let range = document.getWordRangeAtPosition(pos);
  if (!range) {
    const lineLen = line < document.lineCount ? document.lineAt(line).text.length : col + 1;
    range = new vscode.Range(pos, new vscode.Position(line, Math.max(col + 1, Math.min(col + 1, lineLen))));
  }
  const d = new vscode.Diagnostic(range, message, severity);
  d.source = "ezy";
  return d;
}

/** Run the checker against the current buffer contents (handles unsaved edits). */
function runCheck(document) {
  if (!document || document.languageId !== "ezy") return;

  // Write current buffer to a temp file in the same dir so relative imports
  // resolve the same way they would for the real file.
  const dir = document.isUntitled ? os.tmpdir() : path.dirname(document.uri.fsPath);
  const base = document.isUntitled ? "untitled" : path.basename(document.uri.fsPath, ".ez");
  const tmp = path.join(dir, `.${base}.ezycheck-${process.pid}.ez`);

  try {
    fs.writeFileSync(tmp, document.getText());
  } catch (e) {
    return; // can't write (read-only dir): silently skip
  }

  cp.execFile(
    ezyBinary(),
    ["doctor", tmp],
    { timeout: 8000, env: { ...process.env, TERM: "dumb", NO_COLOR: "1" } },
    (err, stdout, stderr) => {
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (err && err.code === "ENOENT") {
        collection.set(
          document.uri,
          [makeDiag(document, 1, 1,
            "ezy compiler not found. Set 'ezy.path' or add ezy to your PATH.",
            vscode.DiagnosticSeverity.Error)]
        );
        return;
      }
      const out = (stderr || "") + "\n" + (stdout || "");
      collection.set(document.uri, parseDiagnostics(out, document));
    }
  );
}

/** Debounced trigger so typing doesn't spawn a compiler on every keystroke. */
function schedule(document, delay) {
  const key = document.uri.toString();
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => runCheck(document), delay));
}

function activate(context) {
  collection = vscode.languages.createDiagnosticCollection("ezy");
  context.subscriptions.push(collection);

  // initial pass for any already-open ezy docs
  vscode.workspace.textDocuments.forEach((d) => runCheck(d));

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((d) => runCheck(d)),
    vscode.workspace.onDidSaveTextDocument((d) => runCheck(d)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const cfg = vscode.workspace.getConfiguration("ezy");
      if (cfg.get("diagnostics.run", "onType") === "onType") {
        schedule(e.document, 500);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((d) => collection.delete(d.uri))
  );
}

function deactivate() {
  if (collection) collection.dispose();
}

module.exports = { activate, deactivate };
