"use strict";
// Ezy VS Code extension: diagnostics, formatting, run/compile commands,
// outline symbols, folding, completion, and hover. Plain JS — no build step.

const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let collection;
const timers = new Map(); // uri -> debounce timer
let ezyTerminal = null;

/* ── shared helpers ─────────────────────────────────────────────── */

/** Resolve the ezy compiler binary from settings or common locations. */
function ezyBinary() {
  const cfg = vscode.workspace.getConfiguration("ezy");
  const custom = cfg.get("path");
  if (custom && custom.trim()) return custom.trim();
  const home = os.homedir();
  for (const c of [path.join(home, ".local", "bin", "ezy"), "/usr/local/bin/ezy"]) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return "ezy"; // fall back to PATH
}

/** Run ezy with args against a temp copy of the buffer; calls cb(err, stdout, stderr). */
function runEzyOnBuffer(document, args, cb) {
  const dir = document.isUntitled ? os.tmpdir() : path.dirname(document.uri.fsPath);
  const base = document.isUntitled ? "untitled" : path.basename(document.uri.fsPath, ".ez");
  const tmp = path.join(dir, `.${base}.ezytmp-${process.pid}.ez`);
  try {
    fs.writeFileSync(tmp, document.getText());
  } catch (_) { cb(new Error("write-failed")); return; }
  cp.execFile(
    ezyBinary(),
    args.concat(tmp),
    { timeout: 10000, env: { ...process.env, TERM: "dumb", NO_COLOR: "1" } },
    (err, stdout, stderr) => {
      try { fs.unlinkSync(tmp); } catch (_) {}
      cb(err, stdout, stderr, tmp);
    }
  );
}

/* ── diagnostics ────────────────────────────────────────────────── */

function parseDiagnostics(output, document) {
  const diags = [];
  const headRe = /^(error|warning|fatal)\s*(?:\[[^\]]*\])?\s*:\s*(.*)$/;
  const posRe = /-->\s*.*?:(\d+):(\d+)/;
  let pending = null;
  for (const raw of output.split(/\r?\n/)) {
    const head = raw.match(headRe);
    if (head) {
      if (pending && pending.severity === vscode.DiagnosticSeverity.Error)
        diags.push(makeDiag(document, 1, 1, pending.message, pending.severity));
      pending = {
        message: head[2].trim(),
        severity: head[1] === "warning"
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Error,
      };
      continue;
    }
    const pos = raw.match(posRe);
    if (pos && pending) {
      diags.push(makeDiag(document, parseInt(pos[1], 10), parseInt(pos[2], 10), pending.message, pending.severity));
      pending = null;
    }
  }
  if (pending && pending.severity === vscode.DiagnosticSeverity.Error)
    diags.push(makeDiag(document, 1, 1, pending.message, pending.severity));
  return diags;
}

function makeDiag(document, line1, col1, message, severity) {
  const line = Math.max(0, line1 - 1);
  const col = Math.max(0, col1 - 1);
  const pos = new vscode.Position(line, col);
  let range = document.getWordRangeAtPosition(pos);
  if (!range) {
    const len = line < document.lineCount ? document.lineAt(line).text.length : col + 1;
    range = new vscode.Range(pos, new vscode.Position(line, Math.max(col + 1, len)));
  }
  const d = new vscode.Diagnostic(range, message, severity);
  d.source = "ezy";
  return d;
}

function runCheck(document) {
  if (!document || document.languageId !== "ezy") return;
  runEzyOnBuffer(document, ["doctor"], (err, stdout, stderr) => {
    if (err && err.code === "ENOENT") {
      collection.set(document.uri, [makeDiag(document, 1, 1,
        "ezy compiler not found. Set 'ezy.path' or add ezy to your PATH.",
        vscode.DiagnosticSeverity.Error)]);
      return;
    }
    collection.set(document.uri, parseDiagnostics((stderr || "") + "\n" + (stdout || ""), document));
  });
}

function schedule(document, delay) {
  const key = document.uri.toString();
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => runCheck(document), delay));
}

/* ── formatting (ezy fmt) ───────────────────────────────────────── */

const formatter = {
  provideDocumentFormattingEdits(document) {
    return new Promise((resolve) => {
      runEzyOnBuffer(document, ["fmt"], (err, stdout) => {
        if (err || !stdout) { resolve([]); return; } // syntax error → leave as-is
        const full = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length)
        );
        resolve([vscode.TextEdit.replace(full, stdout)]);
      });
    });
  },
};

/* ── run / compile commands ─────────────────────────────────────── */

function terminal() {
  if (!ezyTerminal || ezyTerminal.exitStatus !== undefined) {
    ezyTerminal = vscode.window.createTerminal("Ezy");
  }
  return ezyTerminal;
}

async function runCurrentFile(compileOnly) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== "ezy") {
    vscode.window.showWarningMessage("Ezy: no .ez file is active.");
    return;
  }
  if (ed.document.isUntitled) {
    vscode.window.showWarningMessage("Ezy: save the file before running.");
    return;
  }
  await ed.document.save();
  const file = ed.document.uri.fsPath;
  const bin = ezyBinary();
  const t = terminal();
  t.show(true);
  const cmd = compileOnly ? "compile" : "run";
  t.sendText(`${bin} ${cmd} ${JSON.stringify(file)}`);
}

/* ── outline / document symbols ─────────────────────────────────── */

const symbolProvider = {
  provideDocumentSymbols(document) {
    const out = [];
    const rules = [
      [/^\s*(?:pub\s+|priv\s+)?fn\s+([A-Za-z_]\w*)/, vscode.SymbolKind.Function],
      [/^\s*class\s+([A-Za-z_]\w*)/, vscode.SymbolKind.Class],
      [/^\s*struct\s+([A-Za-z_]\w*)/, vscode.SymbolKind.Struct],
      [/^\s*enum\s+([A-Za-z_]\w*)/, vscode.SymbolKind.Enum],
      [/^\s*interface\s+([A-Za-z_]\w*)/, vscode.SymbolKind.Interface],
      [/^\s*const\s+([A-Za-z_]\w*)/, vscode.SymbolKind.Constant],
    ];
    for (let i = 0; i < document.lineCount; i++) {
      const text = document.lineAt(i).text;
      for (const [re, kind] of rules) {
        const m = text.match(re);
        if (m) {
          const indented = /^\s/.test(text);
          let k = kind;
          if (kind === vscode.SymbolKind.Function && indented) k = vscode.SymbolKind.Method;
          const start = text.indexOf(m[1]);
          const range = new vscode.Range(i, 0, i, text.length);
          const sel = new vscode.Range(i, start, i, start + m[1].length);
          out.push(new vscode.DocumentSymbol(m[1], "", k, range, sel));
          break;
        }
      }
    }
    return out;
  },
};

/* ── folding (braces + #region markers) ─────────────────────────── */

const foldingProvider = {
  provideFoldingRanges(document) {
    const ranges = [];
    const stack = [];
    const regionStack = [];
    for (let i = 0; i < document.lineCount; i++) {
      const text = document.lineAt(i).text;
      const trimmed = text.trim();
      if (/^#\s*region\b/.test(trimmed)) regionStack.push(i);
      else if (/^#\s*endregion\b/.test(trimmed) && regionStack.length)
        ranges.push(new vscode.FoldingRange(regionStack.pop(), i, vscode.FoldingRangeKind.Region));
      // brace folding (ignore braces inside strings/comments approximately)
      const code = text.replace(/#.*$/, "").replace(/"(\\.|[^"])*"/g, "");
      for (const ch of code) {
        if (ch === "{") stack.push(i);
        else if (ch === "}" && stack.length) {
          const start = stack.pop();
          if (i > start) ranges.push(new vscode.FoldingRange(start, i));
        }
      }
    }
    return ranges;
  },
};

/* ── completion ─────────────────────────────────────────────────── */

const KEYWORDS = ["if","elif","else","for","while","do","switch","case","default","match",
  "break","continue","return","try","except","defer","pass","in","go","select","region",
  "fn","class","struct","enum","interface","impl","type","const","let","var","global",
  "extern","import","pub","priv","and","or","not","as","spawn","chan","close"];
const TYPES = ["int","float","bool","string","char","void","dict","set","chan"];
const CONSTS = ["true","false","null","nil","iota","self","Ok","Err","Some","None"];
const BUILTINS = ["print","input","len","range","str","chr","ord","hex","bin","format","type",
  "abs","max","min","sqrt","pow","floor","ceil","round","sin","cos","tan","atan2","log","log2",
  "log10","exp","fmod","hypot","clamp","sign","random","randint","randfloat","choice","seed",
  "time","now","clock","date","datetime","strftime","sleep","assert","assert_eq","assert_ne",
  "panic","exit","flush","enumerate","zip","getcwd","path_join","readfile","writefile",
  "appendfile","copyfile","listdir","getenv","argc","argv","cpu_count","maketrans","translate",
  "make","close","mutex","js","js_int","js_str"];

const completionProvider = {
  provideCompletionItems(document) {
    const items = [];
    const add = (label, kind, detail) => {
      const it = new vscode.CompletionItem(label, kind);
      if (detail) it.detail = detail;
      items.push(it);
    };
    KEYWORDS.forEach((k) => add(k, vscode.CompletionItemKind.Keyword));
    TYPES.forEach((t) => add(t, vscode.CompletionItemKind.TypeParameter, "type"));
    CONSTS.forEach((c) => add(c, vscode.CompletionItemKind.Constant));
    BUILTINS.forEach((b) => add(b, vscode.CompletionItemKind.Function, "builtin"));
    // user symbols in this file
    const text = document.getText();
    const seen = new Set();
    const symRe = /\b(?:fn|class|struct|enum|const)\s+([A-Za-z_]\w*)/g;
    let m;
    while ((m = symRe.exec(text))) {
      if (!seen.has(m[1])) { seen.add(m[1]); add(m[1], vscode.CompletionItemKind.Reference, "defined here"); }
    }
    return items;
  },
};

/* ── hover ──────────────────────────────────────────────────────── */

const HOVERS = {
  fn: "Declare a function: `fn name(args) -> Type:`",
  const: "Immutable binding. Reassignment is a compile-time error.",
  match: "Pattern matching (no fall-through). Supports `case x if guard:` and `case _:`.",
  region: "Memory region — arena allocations inside are reclaimed at the closing brace.",
  defer: "Run a statement when the enclosing function returns (skipped on panic-unwind).",
  panic: "panic(msg): unwind to the nearest enclosing `try`.",
  print: "print(...): variadic, space-separated output.",
  range: "range(stop) / range(start, stop[, step]): integer iterator.",
  spawn: "Spawn a goroutine (pthread).",
  chan: "Channel type. Create with `make(chan, capacity)`; send `ch <- v`, recv `<-ch`.",
};

const hoverProvider = {
  provideHover(document, position) {
    const range = document.getWordRangeAtPosition(position);
    if (!range) return;
    const word = document.getText(range);
    if (HOVERS[word]) return new vscode.Hover(new vscode.MarkdownString(HOVERS[word]), range);
    if (BUILTINS.includes(word))
      return new vscode.Hover(new vscode.MarkdownString("**" + word + "** — Ezy builtin"), range);
    if (TYPES.includes(word))
      return new vscode.Hover(new vscode.MarkdownString("**" + word + "** — primitive type"), range);
    return undefined;
  },
};

/* ── activation ─────────────────────────────────────────────────── */

function activate(context) {
  collection = vscode.languages.createDiagnosticCollection("ezy");
  context.subscriptions.push(collection);

  vscode.workspace.textDocuments.forEach((d) => runCheck(d));

  const sel = { language: "ezy" };
  context.subscriptions.push(
    collection,
    vscode.workspace.onDidOpenTextDocument((d) => runCheck(d)),
    vscode.workspace.onDidSaveTextDocument((d) => runCheck(d)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (vscode.workspace.getConfiguration("ezy").get("diagnostics.run", "onType") === "onType")
        schedule(e.document, 500);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => collection.delete(d.uri)),
    vscode.languages.registerDocumentFormattingEditProvider(sel, formatter),
    vscode.languages.registerDocumentSymbolProvider(sel, symbolProvider),
    vscode.languages.registerFoldingRangeProvider(sel, foldingProvider),
    vscode.languages.registerCompletionItemProvider(sel, completionProvider),
    vscode.languages.registerHoverProvider(sel, hoverProvider),
    vscode.commands.registerCommand("ezy.run", () => runCurrentFile(false)),
    vscode.commands.registerCommand("ezy.compile", () => runCurrentFile(true)),
    vscode.window.onDidCloseTerminal((t) => { if (t === ezyTerminal) ezyTerminal = null; })
  );
}

function deactivate() {
  if (collection) collection.dispose();
}

module.exports = { activate, deactivate };
