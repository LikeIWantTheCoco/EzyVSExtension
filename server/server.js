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
  SemanticTokensBuilder,
  CodeActionKind,
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

const SEM_TYPES = ["namespace", "type", "class", "enum", "struct", "interface",
  "parameter", "variable", "property", "function", "method"];
const SEM_MODS = ["declaration", "readonly", "defaultLibrary"];
const semTypeIndex = Object.fromEntries(SEM_TYPES.map((t, i) => [t, i]));
const semModBit = Object.fromEntries(SEM_MODS.map((m, i) => [m, 1 << i]));

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
  const lines = doc.getText().split(/\r?\n/);
  return lines[line] !== undefined ? lines[line] : "";
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

/* ── undefined-name analysis (yellow warnings) ──────────────────── */

// Replace string/comment contents with spaces, preserving length & newlines,
// so identifier scanning never matches inside text.
function maskCode(text) {
  const out = text.split("");
  const n = text.length;
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "; };
  let i = 0;
  while (i < n) {
    if (text.startsWith('"""', i)) {
      let j = text.indexOf('"""', i + 3); j = j < 0 ? n : j + 3; blank(i, j); i = j; continue;
    }
    const c = text[i];
    if (c === "#") { let j = text.indexOf("\n", i); if (j < 0) j = n; blank(i, j); i = j; continue; }
    // prefixed string like f"..." (or f'...'): blank the prefix letter too
    if (/[A-Za-z]/.test(c) && (text[i + 1] === '"' || text[i + 1] === "'")) {
      const q = text[i + 1]; let j = i + 2;
      while (j < n) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === q || text[j] === "\n") { if (text[j] === q) j++; break; }
        j++;
      }
      blank(i, j); i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === c || text[j] === "\n") { if (text[j] === c) j++; break; }
        j++;
      }
      blank(i, j); i = j; continue;
    }
    i++;
  }
  return out.join("");
}

const headerCache = new Map(); // path -> { mtime, fns:[], names:[] }

function addNamesFromFile(p, fns, names) {
  let stat;
  try { stat = fs.statSync(p); } catch (_) { return; }
  const cached = headerCache.get(p);
  if (cached && cached.mtime === stat.mtimeMs) {
    cached.fns.forEach((x) => { fns.add(x); names.add(x); });
    cached.names.forEach((x) => names.add(x));
    return;
  }
  let text;
  try { text = fs.readFileSync(p, "utf8"); } catch (_) { return; }
  const masked = maskCode(text);
  const f = [], nm = [];
  let m;
  const fnRe = /\b(?:extern\s+)?fn\s+([A-Za-z_]\w*)/g;
  while ((m = fnRe.exec(masked))) { f.push(m[1]); }
  const tyRe = /\b(?:class|struct|enum|interface|type|const|global)\s+([A-Za-z_]\w*)/g;
  while ((m = tyRe.exec(masked))) { nm.push(m[1]); }
  headerCache.set(p, { mtime: stat.mtimeMs, fns: f, names: nm });
  f.forEach((x) => { fns.add(x); names.add(x); });
  nm.forEach((x) => names.add(x));
}

function collectDefined(masked, docDir, raw) {
  const fns = new Set(), names = new Set();
  let m;
  const fnRe = /\b(?:extern\s+)?fn\s+([A-Za-z_]\w*)/g;
  while ((m = fnRe.exec(masked))) { fns.add(m[1]); names.add(m[1]); }
  const tyRe = /\b(?:class|struct|enum|interface|type)\s+([A-Za-z_]\w*)/g;
  while ((m = tyRe.exec(masked))) names.add(m[1]);
  const declRe = /\b(?:const|global|let|var)\s+([A-Za-z_]\w*)/g;
  while ((m = declRe.exec(masked))) names.add(m[1]);
  // generic type parameters: fn name<T, U>(...) / class Name<T>
  const genRe = /\b(?:fn|class|struct|interface)\s+[A-Za-z_]\w*\s*<([^>]*)>/g;
  while ((m = genRe.exec(masked)))
    for (const g of m[1].split(",")) { const nm = g.trim(); if (/^[A-Za-z_]\w*$/.test(nm)) names.add(nm); }
  const paramRe = /\bfn\b\s*(?:[A-Za-z_]\w*)?\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g;
  while ((m = paramRe.exec(masked)))
    for (const p of m[1].split(",")) { const nm = p.trim().split(/[:\s]/)[0]; if (/^[A-Za-z_]\w*$/.test(nm)) names.add(nm); }
  const asgRe = /^[ \t]*([A-Za-z_]\w*)\s*(?::[^=\n]+)?(?:[-+*/%&|^]|\*\*|\/\/|<<|>>)?=(?!=)/gm;
  while ((m = asgRe.exec(masked))) names.add(m[1]);
  const forRe = /\bfor\s+([A-Za-z_]\w*)(?:\s*,\s*([A-Za-z_]\w*))?\s+in\b/g;
  while ((m = forRe.exec(masked))) { names.add(m[1]); if (m[2]) names.add(m[2]); }
  const exRe = /\bexcept\s+([A-Za-z_]\w*)/g;
  while ((m = exRe.exec(masked))) names.add(m[1]);
  // bindings: case Pat(x), if let Ok(x)
  const bindRe = /\b(?:case|let)\b[^\n=]*?\(([A-Za-z_]\w*)\)/g;
  while ((m = bindRe.exec(masked))) names.add(m[1]);
  // imports — scan the RAW text: `#include` lines start with `#`, which maskCode
  // blanks as a comment, so the masked copy hides them.
  const impSrc = raw !== undefined ? raw : masked;
  const impRe = /^[ \t]*(?:import|#include)\s+(?:"([^"]+)"|([A-Za-z_][\w./-]*))(?:\s+as\s+([A-Za-z_]\w*))?/gm;
  while ((m = impRe.exec(impSrc))) {
    const spec = m[1] || m[2]; const alias = m[3];
    if (alias) names.add(alias);
    if (!spec) continue;
    if (spec.endsWith(".ez")) {
      const p = path.isAbsolute(spec) ? spec : path.join(docDir, spec);
      addNamesFromFile(p, fns, names);
      names.add(path.basename(spec, ".ez"));
    } else {
      const lib = spec.split("/").pop();
      names.add(lib);
      addNamesFromFile(path.join(os.homedir(), ".ezy", "libs", lib, lib + ".ez"), fns, names);
    }
  }
  return { fns, names };
}

const ALWAYS_KNOWN = new Set([...KEYWORDS, ...TYPES, ...CONSTS, ...BUILTINS, "self", "main", "iota"]);

function analyzeUndefined(doc) {
  const fsPath = uriToPath(doc.uri);
  const docDir = fsPath ? path.dirname(fsPath) : os.tmpdir();
  const raw = doc.getText();
  const masked = maskCode(raw);
  const { names } = collectDefined(masked, docDir, raw);
  const diags = [];
  const lines = masked.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (/^\s*case\b/.test(line) || /\bif\s+let\b/.test(line)) continue;
    const tokRe = /[A-Za-z_]\w*/g;
    let m;
    while ((m = tokRe.exec(line))) {
      const word = m[0], start = m.index, end = start + word.length;
      if (ALWAYS_KNOWN.has(word) || names.has(word)) continue;
      let p = start - 1; while (p >= 0 && line[p] === " ") p--;
      const prev = p >= 0 ? line[p] : "";
      if (prev === "." || prev === ":" || prev === ">") continue; // member / type / return
      let q = end; while (q < line.length && line[q] === " ") q++;
      const next = q < line.length ? line[q] : "";
      const next2 = q + 1 < line.length ? line[q + 1] : "";
      if (next === ":") continue;                       // declaration / label / annotation
      if (next === "=" && next2 !== "=") continue;        // assignment / struct field
      const isCall = next === "(";
      diags.push({
        severity: DiagnosticSeverity.Error,
        range: Range.create(li, start, li, end),
        message: isCall ? `call to undefined function '${word}'` : `use of undefined name '${word}'`,
        source: "ezy",
      });
    }
  }
  return diags;
}

function validate(doc) {
  if (!doc) return;
  const undef = (settings.diagnostics && settings.diagnostics.undefinedNames === false)
    ? [] : safeAnalyze(doc);
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
    const doctor = parseDiagnostics((stderr || "") + "\n" + (stdout || ""), doc);
    // drop our warning if doctor already reports something on the same token
    const taken = new Set(doctor.map((d) => d.range.start.line + ":" + d.range.start.character));
    const merged = doctor.concat(
      undef.filter((d) => !taken.has(d.range.start.line + ":" + d.range.start.character))
    );
    connection.sendDiagnostics({ uri: doc.uri, diagnostics: merged });
  });
}

function safeAnalyze(doc) {
  try { return analyzeUndefined(doc); } catch (_) { return []; }
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
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      foldingRangeProvider: true,
      signatureHelpProvider: { triggerCharacters: ["(", ","] },
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
      semanticTokensProvider: {
        legend: { tokenTypes: SEM_TYPES, tokenModifiers: SEM_MODS },
        full: true,
      },
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
  if (doc) {
    const member = memberCompletion(doc, params.position);
    if (member) return member;
  }
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

/* ── semantic tokens ────────────────────────────────────────────── */

const KEYWORD_SET = new Set(KEYWORDS);

connection.languages.semanticTokens.on((params) => {
  const doc = documents.get(params.textDocument.uri);
  const builder = new SemanticTokensBuilder();
  if (!doc) return builder.build();
  const fsPath = uriToPath(doc.uri);
  const docDir = fsPath ? path.dirname(fsPath) : os.tmpdir();
  const raw = doc.getText();
  const masked = maskCode(raw);
  const { fns, names } = collectDefined(masked, docDir, raw);
  const typeNames = new Set();
  let m;
  const tyRe = /\b(?:class|struct|enum|interface|type)\s+([A-Za-z_]\w*)/g;
  while ((m = tyRe.exec(masked))) typeNames.add(m[1]);
  const paramNames = new Set();
  const paramRe = /\bfn\b\s*(?:[A-Za-z_]\w*)?\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g;
  while ((m = paramRe.exec(masked)))
    for (const p of m[1].split(",")) { const nm = p.trim().split(/[:\s]/)[0]; if (/^[A-Za-z_]\w*$/.test(nm)) paramNames.add(nm); }

  const lines = masked.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const tokRe = /[A-Za-z_]\w*/g;
    while ((m = tokRe.exec(line))) {
      const word = m[0], start = m.index, end = start + word.length;
      if (KEYWORD_SET.has(word) || CONSTS.includes(word)) continue; // TextMate handles
      let p = start - 1; while (p >= 0 && line[p] === " ") p--;
      const prev = p >= 0 ? line[p] : "";
      let q = end; while (q < line.length && line[q] === " ") q++;
      const next = q < line.length ? line[q] : "";
      // declaration context: token right after a declaring keyword
      const before = line.slice(0, start);
      const declKw = /\b(fn|class|struct|enum|interface|type)\s+$/.exec(before);
      let tt = null, mods = 0;
      if (declKw) {
        tt = declKw[1] === "fn" ? "function" : (declKw[1] === "class" ? "class" : declKw[1] === "enum" ? "enum" : declKw[1] === "struct" ? "struct" : declKw[1] === "interface" ? "interface" : "type");
        mods |= semModBit.declaration;
      } else if (prev === ".") {
        tt = next === "(" ? "method" : "property";
      } else if (TYPES.includes(word) || typeNames.has(word)) {
        tt = typeNames.has(word) ? "class" : "type";
      } else if (BUILTINS.includes(word)) {
        tt = "function"; mods |= semModBit.defaultLibrary;
      } else if (next === "(" && (fns.has(word) || !names.has(word))) {
        tt = "function";
      } else if (paramNames.has(word)) {
        tt = "parameter";
      } else if (names.has(word)) {
        tt = "variable";
      } else {
        continue; // unknown — let other layers handle / error diagnostic covers it
      }
      const idx = semTypeIndex[tt];
      if (idx === undefined) continue;
      builder.push(li, start, word.length, idx, mods);
    }
  }
  return builder.build();
});

/* ── references & rename ────────────────────────────────────────── */

function allWorkspaceFiles() {
  const files = [];
  for (const root of workspaceRoots) listEzFiles(root, files, 0);
  return [...new Set(files)];
}

function findOccurrences(name) {
  const result = []; // { uri, line, char }
  const open = new Map();
  for (const d of documents.all()) { const p = uriToPath(d.uri); if (p) open.set(p, d.getText()); }
  const files = allWorkspaceFiles();
  // include open docs that may be outside the scanned roots
  for (const [p] of open) if (!files.includes(p)) files.push(p);
  const re = new RegExp("(?<![A-Za-z0-9_.])" + name + "(?![A-Za-z0-9_])", "g");
  for (const f of files) {
    let text = open.get(f);
    if (text === undefined) { try { text = fs.readFileSync(f, "utf8"); } catch (_) { continue; } }
    const masked = maskCode(text);
    const lines = masked.split(/\r?\n/);
    for (let li = 0; li < lines.length; li++) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(lines[li]))) result.push({ uri: url.pathToFileURL(f).href, line: li, char: m.index });
    }
  }
  return result;
}

connection.onReferences((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const word = wordAt(doc, params.position);
  if (!word || /^\d/.test(word)) return null;
  return findOccurrences(word).map((o) =>
    Location.create(o.uri, Range.create(o.line, o.char, o.line, o.char + word.length)));
});

connection.onPrepareRename((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const r = wordRangeAt(doc, params.position.line, params.position.character);
  const word = doc.getText(r);
  if (!word || /^\d/.test(word) || KEYWORD_SET.has(word)) return null;
  return r;
});

connection.onRenameRequest((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const word = wordAt(doc, params.position);
  if (!word) return null;
  const changes = {};
  for (const o of findOccurrences(word)) {
    (changes[o.uri] = changes[o.uri] || []).push(
      TextEdit.replace(Range.create(o.line, o.char, o.line, o.char + word.length), params.newName));
  }
  return { changes };
});

/* ── member completion (obj. -> methods/fields) ─────────────────── */

function classBody(masked, typeName) {
  const re = new RegExp("\\b(?:class|struct)\\s+" + typeName + "\\b[^\\n]*\\n");
  const m = re.exec(masked);
  if (!m) return null;
  // capture until the matching closing brace of the first '{'
  let i = masked.indexOf("{", m.index);
  if (i < 0) return null;
  let depth = 0, start = i;
  for (; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}") { depth--; if (depth === 0) return masked.slice(start + 1, i); }
  }
  return masked.slice(start + 1);
}

function inferType(masked, receiver) {
  let m;
  let re = new RegExp("\\b" + receiver + "\\s*=\\s*([A-Z]\\w*)_new\\b");
  if ((m = re.exec(masked))) return m[1];
  re = new RegExp("\\b" + receiver + "\\s*=\\s*([A-Z]\\w*)\\s*\\{");
  if ((m = re.exec(masked))) return m[1];
  re = new RegExp("\\b" + receiver + "\\s*:\\s*\\*?\\[?\\s*([A-Za-z_]\\w*)");
  if ((m = re.exec(masked))) return m[1];
  return null;
}

const STRING_METHODS = ["upper","lower","strip","lstrip","rstrip","title","find","index","rfind",
  "replace","startswith","endswith","contains","split","splitlines","count","reverse","len",
  "padl","padr","center","to_int","translate"];
const ARRAY_METHODS = ["push","pop","len","contains","sort","sorted","reverse","slice","remove",
  "extend","join","map","filter","any","all","sum","reduce","unique","flatten"];
const DICT_METHODS = ["get","set","has","remove","keys","values","len","clear"];
const SET_METHODS = ["add","contains","len","union","intersection","difference"];

function memberCompletion(doc, position) {
  const lineText0 = doc.getText(Range.create(position.line, 0, position.line, position.character));
  const mm = /([A-Za-z_]\w*)\s*\.\s*$/.exec(lineText0);
  if (!mm) return null;
  const receiver = mm[1];
  const masked = maskCode(doc.getText());
  const items = [];
  const addAll = (arr, kind) => arr.forEach((n) => items.push({ label: n, kind }));
  const type = inferType(masked, receiver);
  if (type) {
    if (["string", "char"].includes(type)) addAll(STRING_METHODS, CompletionItemKind.Method);
    else if (type === "dict") addAll(DICT_METHODS, CompletionItemKind.Method);
    else if (type === "set") addAll(SET_METHODS, CompletionItemKind.Method);
    else {
      const body = classBody(masked, type);
      if (body) {
        let m; const re = /\bfn\s+([A-Za-z_]\w*)/g;
        while ((m = re.exec(body))) if (m[1] !== "constructor") items.push({ label: m[1], kind: CompletionItemKind.Method, detail: type + " method" });
        const fre = /^\s*([A-Za-z_]\w*)\s*:/gm;
        while ((m = fre.exec(body))) items.push({ label: m[1], kind: CompletionItemKind.Field, detail: type + " field" });
      }
    }
  }
  // arrays/strings created by literals are hard to type; offer common array methods as fallback
  if (!items.length) addAll(ARRAY_METHODS, CompletionItemKind.Method);
  return items;
}

/* ── code actions / quick fixes ─────────────────────────────────── */

connection.onCodeAction((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const actions = [];
  for (const d of params.context.diagnostics || []) {
    let m;
    if ((m = /call to undefined function '([A-Za-z_]\w*)'/.exec(d.message))) {
      const name = m[1];
      // count args at the call site to shape the stub
      const callLine = lineText(doc, d.range.start.line);
      const after = callLine.slice(d.range.end.character);
      const am = /^\s*\(([^)]*)\)/.exec(after);
      const argc = am && am[1].trim() ? am[1].split(",").length : 0;
      const ps = Array.from({ length: argc }, (_, i) => `arg${i}: int`).join(", ");
      const stub = `\nfn ${name}(${ps}) -> int:\n{\n    return 0\n}\n`;
      const endLine = doc.lineCount;
      actions.push({
        title: `Create function '${name}'`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [d],
        edit: { changes: { [doc.uri]: [TextEdit.insert(Position.create(endLine, 0), stub)] } },
      });
    } else if (/declared but never used/.test(d.message)) {
      const ln = d.range.start.line;
      actions.push({
        title: "Remove unused variable",
        kind: CodeActionKind.QuickFix,
        diagnostics: [d],
        edit: { changes: { [doc.uri]: [TextEdit.del(Range.create(ln, 0, ln + 1, 0))] } },
      });
    }
  }
  return actions;
});

documents.listen(connection);
connection.listen();
