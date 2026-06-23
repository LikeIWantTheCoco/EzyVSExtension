# Changelog

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
