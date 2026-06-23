"use strict";
// Ezy language server. Provides diagnostics (via `ezy doctor`), completion,
// hover, document symbols, workspace go-to-definition, signature help, folding,
// and formatting (via `ezy fmt`). Communicates with VS Code over stdio.

const {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  DiagnosticSeverity,
  CompletionItemKind,
  SymbolKind,
  TextEdit,
  Range,
  Position,
  Location,
  FoldingRangeKind,
  MarkupKind,
} = require("vscode-languageserver/node");
const { TextDocument } = require("vscode-languageserver-textdocument");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const url = require("url");

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let settings = { path: "", diagnostics: { run: "onType" } };

/* ── shared data ────────────────────────────────────────────────── */

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
  "make","mutex","js","js_int","js_str"];

const BUILTIN_SIG = {
  print: "print(...values) — variadic, space-separated output",
  range: "range(stop) | range(start, stop[, step]) -> iterator",
  len: "len(x) -> int",
  input: "input(prompt: string) -> string",
  format: "format(fmt: string, ...args) -> string",
  assert: "assert(cond[, message])",
  push: "push(value) — append to an array",
  get: "get(key[, default]) — dict lookup",
};

const HOVERS = {
  fn: "Declare a function: `fn name(args) -> Type:`",
  const: "Immutable binding. Reassignment is a compile-time error.",
  match: "Pattern matching (no fall-through). Supports `case x if guard:` and `case _:`.",
  region: "Memory region — arena allocations inside are reclaimed at the closing brace.",
  defer: "Run a statement when the enclosing function returns (skipped on panic-unwind).",
  panic: "panic(msg): unwind to the nearest enclosing `try`.",
  spawn: "Spawn a goroutine (pthread).",
  chan: "Channel type. `make(chan, cap)`; send `ch <- v`, recv `<-ch`.",
};

/* ── ezy binary resolution ──────────────────────────────────────── */

function ezyBinary() {
  if (settings.path && settings.path.trim()) return settings.path.trim();
  const home = os.homedir();
  for (const c of [path.join(home, ".local", "bin", "ezy"), "/usr/local/bin/ezy"]) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return "ezy";
}

function uriToPath(uri) {
  try { return url.fileURLToPath(uri); } catch (_) { return null; }
}

/* ── diagnostics (ezy doctor) ───────────────────────────────────── */

function runEzy(doc, args, cb) {
  const fsPath = uriToPath(doc.uri);
  const dir = fsPath ? path.dirname(fsPath) : os.tmpdir();
  const base = fsPath ? path.basename(fsPath, ".ez") : "untitled";
  const tmp = path.join(dir, `.${base}.ezylsp-${process.pid}.ez`);
  try { fs.writeFileSync(tmp, doc.getText()); }
  catch (_) { cb(new Error("write-failed")); return; }
  cp.execFile(
    ezyBinary(), args.concat(tmp),
    { timeout: 10000, env: { ...process.env, TERM: "dumb", NO_COLOR: "1" } },
    (err, stdout, stderr) => {
      try { fs.unlinkSync(tmp); } catch (_) {}
      cb(err, stdout, stderr);
    }
  );
}

function wordRangeAt(doc, line, col) {
  const text = lineText(doc, line);
  let s = col, e = col;
  while (s > 0 && /[A-Za-z0-9_]/.test(text[s - 1])) s--;
  while (e < text.length && /[A-Za-z0-9_]/.test(text[e])) e++;
  if (e === s) e = Math.min(text.length, s + 1);
  return Range.create(line, s, line, e);
}

function lineText(doc, line) {
  return doc.getText(Range.create(line, 0, line, Number.MAX_SAFE_INTEGER)).replace(/\r?\n$/, "");
}

function parseDiagnostics(output, doc) {
  const diags = [];
  const headRe = /^(error|warning|fatal)\s*(?:\[[^\]]*\])?\s*:\s*(.*)$/;
  const posRe = /-->\s*.*?:(\d+):(\d+)/;
  let pending = null;
  const push = (line, col, p) => {
    const range = line > 0 ? wordRangeAt(doc, line - 1, Math.max(0, col - 1)) : Range.create(0, 0, 0, 1);
    diags.push({ severity: p.severity, range, message: p.message, source: "ezy" });
  };
  for (const raw of output.split(/\r?\n/)) {
    const head = raw.match(headRe);
    if (head) {
      if (pending && pending.severity === DiagnosticSeverity.Error) push(1, 1, pending);
      pending = {
        message: head[2].trim(),
        severity: head[1] === "warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
      };
      continue;
    }
    const pos = raw.match(posRe);
    if (pos && pending) { push(parseInt(pos[1], 10), parseInt(pos[2], 10), pending); pending = null; }
  }
  if (pending && pending.severity === DiagnosticSeverity.Error) push(1, 1, pending);
  return diags;
}

function validate(doc) {
  if (!doc) return;
  runEzy(doc, ["doctor"], (err, stdout, stderr) => {
    if (err && err.code === "ENOENT") {
      connection.sendDiagnostics({
        uri: doc.uri,
        diagnostics: [{
          severity: DiagnosticSeverity.Error,
          range: Range.create(0, 0, 0, 1),
          message: "ezy compiler not found. Set 'ezy.path' or add ezy to your PATH.",
          source: "ezy",
        }],
      });
      return;
    }
    connection.sendDiagnostics({
      uri: doc.uri,
      diagnostics: parseDiagnostics((stderr || "") + "\n" + (stdout || ""), doc),
    });
  });
}

const timers = new Map();
function scheduleValidate(doc, delay) {
  clearTimeout(timers.get(doc.uri));
  timers.set(doc.uri, setTimeout(() => validate(doc), delay));
}

/* ── symbol scanning (for outline, completion, definition) ──────── */

const SYM_RULES = [
  [/^\s*(?:pub\s+|priv\s+)?fn\s+([A-Za-z_]\w*)/, SymbolKind.Function],
  [/^\s*class\s+([A-Za-z_]\w*)/, SymbolKind.Class],
  [/^\s*struct\s+([A-Za-z_]\w*)/, SymbolKind.Struct],
  [/^\s*enum\s+([A-Za-z_]\w*)/, SymbolKind.Enum],
  [/^\s*interface\s+([A-Za-z_]\w*)/, SymbolKind.Interface],
  [/^\s*const\s+([A-Za-z_]\w*)/, SymbolKind.Constant],
];

function scanSymbols(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    for (const [re, kind] of SYM_RULES) {
      const m = t.match(re);
      if (m) {
        const indented = /^\s/.test(t);
        let k = kind;
        if (kind === SymbolKind.Function && indented) k = SymbolKind.Method;
        const start = t.indexOf(m[1]);
        out.push({ name: m[1], kind: k, line: i, start, end: start + m[1].length, lineLen: t.length });
        break;
      }
    }
  }
  return out;
}

function documentSymbols(doc) {
  return scanSymbols(doc.getText()).map((s) => ({
    name: s.name,
    kind: s.kind,
    range: Range.create(s.line, 0, s.line, s.lineLen),
    selectionRange: Range.create(s.line, s.start, s.line, s.end),
  }));
}

/* ── workspace definition index ─────────────────────────────────── */

function listEzFiles(dir, acc, depth) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listEzFiles(full, acc, depth + 1);
    else if (e.name.endsWith(".ez")) acc.push(full);
  }
}

let workspaceRoots = [];

function findDefinition(name) {
  const locs = [];
  const files = [];
  for (const root of workspaceRoots) listEzFiles(root, files, 0);
  // include open docs (may have unsaved defs)
  const openByPath = new Map();
  for (const d of documents.all()) { const p = uriToPath(d.uri); if (p) openByPath.set(p, d.getText()); }
  const seen = new Set();
  for (const f of files) {
    if (seen.has(f)) continue; seen.add(f);
    let text = openByPath.get(f);
    if (text === undefined) { try { text = fs.readFileSync(f, "utf8"); } catch (_) { continue; } }
    for (const s of scanSymbols(text)) {
      if (s.name === name) {
        locs.push(Location.create(url.pathToFileURL(f).href,
          Range.create(s.line, s.start, s.line, s.end)));
      }
    }
  }
  return locs;
}

function wordAt(doc, pos) {
  const r = wordRangeAt(doc, pos.line, pos.character);
  return doc.getText(r);
}

/* ── server lifecycle ───────────────────────────────────────────── */

connection.onInitialize((params) => {
  if (params.workspaceFolders) workspaceRoots = params.workspaceFolders.map((f) => uriToPath(f.uri)).filter(Boolean);
  else if (params.rootUri) { const p = uriToPath(params.rootUri); if (p) workspaceRoots = [p]; }
  return {
    capabilities: {
      textDocumentSync: 1, // full
      completionProvider: { triggerCharacters: ["."] },
      hoverProvider: true,
      documentSymbolProvider: true,
      definitionProvider: true,
      foldingRangeProvider: true,
      documentFormattingProvider: true,
      signatureHelpProvider: { triggerCharacters: ["(", ","] },
    },
  };
});

connection.onInitialized(() => {
  connection.workspace.getConfiguration("ezy").then((c) => { if (c) settings = c; }).catch(() => {});
});

connection.onDidChangeConfiguration((change) => {
  if (change.settings && change.settings.ezy) settings = change.settings.ezy;
  documents.all().forEach(validate);
});

documents.onDidOpen((e) => validate(e.document));
documents.onDidSave((e) => validate(e.document));
documents.onDidChangeContent((e) => {
  if ((settings.diagnostics && settings.diagnostics.run) !== "onSave") scheduleValidate(e.document, 500);
});
documents.onDidClose((e) => connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] }));

/* ── completion ─────────────────────────────────────────────────── */

connection.onCompletion((params) => {
  const doc = documents.get(params.textDocument.uri);
  const items = [];
  const seen = new Set();
  const add = (label, kind, detail) => {
    if (seen.has(label)) return; seen.add(label);
    items.push({ label, kind, detail });
  };
  KEYWORDS.forEach((k) => add(k, CompletionItemKind.Keyword));
  TYPES.forEach((t) => add(t, CompletionItemKind.TypeParameter, "type"));
  CONSTS.forEach((c) => add(c, CompletionItemKind.Constant));
  BUILTINS.forEach((b) => add(b, CompletionItemKind.Function, BUILTIN_SIG[b] || "builtin"));
  if (doc) {
    for (const s of scanSymbols(doc.getText())) {
      const kind = s.kind === SymbolKind.Function || s.kind === SymbolKind.Method
        ? CompletionItemKind.Function
        : s.kind === SymbolKind.Constant ? CompletionItemKind.Constant : CompletionItemKind.Class;
      add(s.name, kind, "defined in this file");
    }
  }
  return items;
});

connection.onCompletionResolve((item) => item);

/* ── hover ──────────────────────────────────────────────────────── */

connection.onHover((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const word = wordAt(doc, params.position);
  let md = null;
  if (HOVERS[word]) md = HOVERS[word];
  else if (BUILTIN_SIG[word]) md = "```ezy\n" + BUILTIN_SIG[word] + "\n```";
  else if (BUILTINS.includes(word)) md = "**" + word + "** — Ezy builtin";
  else if (TYPES.includes(word)) md = "**" + word + "** — primitive type";
  else {
    const sym = scanSymbols(doc.getText()).find((s) => s.name === word);
    if (sym) md = "**" + word + "** — defined in this file";
  }
  if (!md) return null;
  return { contents: { kind: MarkupKind.Markdown, value: md } };
});

/* ── document symbols / definition / folding / formatting ───────── */

connection.onDocumentSymbol((params) => {
  const doc = documents.get(params.textDocument.uri);
  return doc ? documentSymbols(doc) : [];
});

connection.onDefinition((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const word = wordAt(doc, params.position);
  if (!word) return null;
  const locs = findDefinition(word);
  return locs.length ? locs : null;
});

connection.onFoldingRanges((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const lines = doc.getText().split(/\r?\n/);
  const ranges = [];
  const stack = [];
  const regions = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^#\s*region\b/.test(t)) regions.push(i);
    else if (/^#\s*endregion\b/.test(t) && regions.length)
      ranges.push({ startLine: regions.pop(), endLine: i, kind: FoldingRangeKind.Region });
    const code = lines[i].replace(/#.*$/, "").replace(/"(\\.|[^"])*"/g, "");
    for (const ch of code) {
      if (ch === "{") stack.push(i);
      else if (ch === "}" && stack.length) { const s = stack.pop(); if (i > s) ranges.push({ startLine: s, endLine: i }); }
    }
  }
  return ranges;
});

connection.onDocumentFormatting((params) => {
  return new Promise((resolve) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) { resolve([]); return; }
    runEzy(doc, ["fmt"], (err, stdout) => {
      if (err || !stdout) { resolve([]); return; }
      const text = doc.getText();
      const end = doc.positionAt(text.length);
      resolve([TextEdit.replace(Range.create(Position.create(0, 0), end), stdout)]);
    });
  });
});

/* ── signature help ─────────────────────────────────────────────── */

connection.onSignatureHelp((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const line = lineText(doc, params.position.line).slice(0, params.position.character);
  const m = line.match(/([A-Za-z_]\w*)\s*\([^()]*$/);
  if (!m) return null;
  const name = m[1];
  let label = null;
  if (BUILTIN_SIG[name]) label = BUILTIN_SIG[name];
  else {
    // find user fn signature from source
    const reg = new RegExp("\\bfn\\s+" + name + "\\s*\\(([^)]*)\\)\\s*(->\\s*[A-Za-z_*\\[\\]]+)?");
    const all = doc.getText();
    const fm = all.match(reg);
    if (fm) label = "fn " + name + "(" + fm[1].trim() + ")" + (fm[2] ? " " + fm[2].trim() : "");
  }
  if (!label) return null;
  const active = (line.match(/,/g) || []).length;
  const params2 = label.replace(/^[^(]*\(/, "").replace(/\).*$/, "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    signatures: [{ label, parameters: params2.map((p) => ({ label: p })) }],
    activeSignature: 0,
    activeParameter: Math.min(active, Math.max(0, params2.length - 1)),
  };
});

documents.listen(connection);
connection.listen();
