# Changelog

## 0.6.1

- f-strings (`f"..."`) are no longer mis-analyzed: the `f` prefix and the string
  body are masked, so the prefix is not flagged as an undefined name.
- Generic functions/types are understood: type parameters (`fn f<T>(...)`) are
  treated as defined, and parameters of generic functions and of functions whose
  name contains digits (e.g. `color256`) are collected correctly (fixes spurious
  "undefined name" errors on their parameters).
- Formatting no longer registers a document formatter, so the generic
  "Format Document" entry is gone — use **Ezy: Format** (runs `ezy fmt`).
  Requires the matching compiler fix so `ezy fmt` formats your file only and
  does not inline imported modules/library headers.

## 0.6.0

- **Semantic tokens**: real var/type/function/method/parameter/property coloring
  driven by the document's symbol tables (so a capitalized variable is no longer
  mis-colored as a type).
- **Find references** and **workspace rename** for identifiers across all `.ez`
  files in the workspace (string/comment occurrences excluded).
- **Member completion**: `obj.` lists methods and fields when the receiver's type
  can be inferred (`x = Type_new(...)`, `x = Type{...}`, `x: Type`); string / dict
  / set get their builtin method sets.
- **Quick fixes**: "Create function 'X'" for an undefined call (arity inferred
  from the call site) and "Remove unused variable" for the doctor warning.
- Undefined functions/names are now reported as **errors (red)**, not warnings.
- Publisher set to `LikeIWantTheCoco`.

## 0.5.0

- Undefined-name warnings (yellow): the server flags calls to functions and uses
  of names that have no definition in the file, its imports, or the builtins.
  Resolves imported library symbols from `~/.ezy/libs/<name>/<name>.ez` and local
  `import`/`#include` files, so e.g. `import cli` keeps `cli_*` calls clean.
  Toggle with `ezy.diagnostics.undefinedNames`. Heuristic — skips members,
  type annotations, struct fields, and match/`if let` bindings to avoid noise.

## 0.4.2

- Richer syntax highlighting: bare `import name` (no quotes), type annotations
  (`: Type`, `-> Type`), function parameters, struct literals (`Point{...}`),
  inheritance types (`class Dog: Animal`), method calls (`.foo()`), property
  access (`.field`), UPPER_CASE constants, and CamelCase user types.
- New command **Ezy: Format File** (also in the editor context menu and command
  palette) that runs the `ezy fmt` formatter on the active file.

## 0.4.1

- Fix: the language server crashed while building diagnostic ranges
  (`Range#create` rejected an out-of-bounds column), so no error/warning
  squiggles appeared. Diagnostics work again.

## 0.4.0

- **Language server** (`vscode-languageserver`) — all language intelligence now
  runs in a dedicated server process via the Language Server Protocol:
  - Diagnostics from `ezy doctor` (debounced on type, or on save).
  - Completion: keywords, types, constants, builtins (with signatures), and
    symbols from the current file.
  - Hover docs for builtins, types, and constructs.
  - **Go-to-definition** across the whole workspace (fn/class/struct/enum/const).
  - **Signature help** for builtins and user functions.
  - Outline/breadcrumb symbols and folding (braces + `# region`).
  - Formatting via `ezy fmt`.
- Run / Compile terminal commands remain on the client.
- Requires VS Code ^1.75.

## 0.3.0

- Formatting via `ezy fmt` (format document / format on save).
- Commands: **Ezy: Run File** (Ctrl+F5) and **Ezy: Compile File** — run in an
  integrated terminal; also in the editor title-bar run button and context menu.
- Outline / breadcrumbs: document symbols for fn, class, struct, enum,
  interface, const (methods detected by indentation).
- Folding: brace blocks and `# region` / `# endregion` markers.
- Completion: keywords, primitive types, constants, builtins, and symbols
  defined in the current file.
- Hover docs for builtins, types, and key constructs.
- Blue logo.

## 0.2.0

- Error/warning diagnostics: runs `ezy doctor` on the buffer and shows squiggles
  inline (debounced on type, or on save). Settings: `ezy.path`,
  `ezy.diagnostics.run`.

## 0.1.0

- Initial release.
- Syntax highlighting for `.ez` (TextMate grammar `source.ezy`).
- Language icon for editor tabs and breadcrumbs.
- Snippets for common constructs and builtin-function completion.
- Language configuration: comments, brackets, auto-closing, block indentation.
