# Ezy Language — VS Code Extension

Language support for **[Ezy](https://github.com/LikeIWantTheCoco/EzyLang)** —
*"The clarity of Python, the speed of C."* Adds syntax highlighting, a file/tab
icon, snippets, and editor smarts for `.ez` files.

## Features

- **Syntax highlighting** — keywords, types, builtins, f-strings (with `{...}`
  interpolation and format specs), `#` line comments and `"""…"""` doc blocks,
  numbers (int/float/hex/bin), operators (`->`, `<-`, `**`, `//`, …), function
  and type definitions, enum `Type.Variant`, and `Ok`/`Err`/`Some`/`None`.
- **File icon** — `.ez` files get the Ezy icon in editor tabs and breadcrumbs.
- **Snippets / completion** — `main`, `fn`, `if`, `for`, `while`, `class`,
  `struct`, `enum`, `match`, `switch`, `try`, `region`, … plus buffer-word and
  builtin-function completion.
- **Language server** — a dedicated LSP process powers the intelligence below;
  open the *Output → Ezy Language Server* channel to see its logs.
- **Diagnostics** — runs `ezy doctor` on the buffer and shows error/warning
  squiggles inline (debounced on type, or on save).
- **Go-to-definition** — jump to a `fn`/`class`/`struct`/`enum`/`const`
  definition anywhere in the workspace (F12).
- **Signature help** — parameter hints for builtins and your own functions.
- **Formatting** — `ezy fmt` as the document formatter (supports format-on-save).
- **Run / Compile** — *Ezy: Run File* (`Ctrl+F5`) and *Ezy: Compile File* run in
  an integrated terminal; a run button is added to the editor title bar.
- **Outline & folding** — symbols for functions, classes, structs, enums, and
  constants in the breadcrumb/outline; folding for `{ }` blocks and
  `# region` / `# endregion`.
- **Hover** — short docs for builtins, types, and key constructs.
- **Editor behavior** — bracket matching, auto-closing pairs, comment toggling
  (`#`), and block indentation after `:`.

## Settings

- `ezy.path` — path to the `ezy` compiler (empty = search `~/.local/bin` then PATH).
- `ezy.diagnostics.run` — `onType` (default) or `onSave`.

## About the icon

VS Code does **not** read the operating system's MIME database, so the desktop
`.ez` icon (registered by `ezy install`) does not carry into the editor. This
extension supplies the icon through VS Code's own **language icon** mechanism, so
it shows on editor tabs and in the breadcrumb bar.

To also see it in the **File Explorer**, use a file icon theme that renders
language icons (e.g. *Minimal (Visual Studio Code)* via
`Preferences: File Icon Theme`). The default *Seti* theme draws its own icons by
extension and will show a generic icon for unknown types like `.ez`.

## Publishing to the Marketplace

The `publisher` field is `LikeIWantTheCoco`. To publish you must own that
publisher on the VS Code Marketplace and have a Personal Access Token:

```bash
npm i -g @vscode/vsce
vsce login LikeIWantTheCoco     # paste the Azure DevOps PAT
vsce publish                    # or: vsce publish minor
```

(For Open VSX / VSCodium's registry, use `npx ovsx publish ezy-lang-*.vsix -p <token>`.)

## Install (local / from source)

```bash
# from this folder
npm i -g @vscode/vsce      # one-time: the VS Code extension packager
vsce package               # produces ezy-lang-0.1.0.vsix
code --install-extension ezy-lang-0.1.0.vsix
```

Or for quick local testing, copy/symlink this folder into your extensions dir and
reload VS Code:

```bash
ln -s "$PWD" ~/.vscode/extensions/ezy-lang-0.1.0
```

## License

GPL-2.0 — same as EzyLang.
