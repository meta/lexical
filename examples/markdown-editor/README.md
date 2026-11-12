# Markdown Editor example

This example demonstrates a split-view markdown editor: a WYSIWYG editor on
the left synchronized with a live markdown preview on the right. It is built
entirely on the Lexical [Extension](https://lexical.dev/docs/concepts/extensions)
system — every piece of state and behavior the React UI relies on is provided
by an extension as a command, an output signal, or both.

## Layout

- **`src/extensions/MarkdownExtension.ts`** — pulls in `RichTextExtension`,
  `HistoryExtension`, `ListExtension`, `CheckListExtension`,
  `TabIndentationExtension` and `EditorStateExtension`; registers
  `registerMarkdownShortcuts` with the curated `MARKDOWN_TRANSFORMERS`
  array (headings, ordered/unordered/check lists, inline code, bold,
  italics, bold-italic) so that typing `# `, `**bold**`, `` `code` ``,
  `- item`, `1. item`, `[ ] todo` etc. transforms inline. The
  transformer list keeps `CHECK_LIST` ahead of `UNORDERED_LIST` so that
  `- [ ] foo` matches the checklist regex first on import. A custom
  `CHECK_LIST_ITEM` `TextMatchTransformer` (trigger `' '`) handles the
  typing-time case where the user has already typed `- ` (turning the
  line into a bullet list item) and then types `[ ] ` — the standard
  element transformer can't fire there because its parent is no longer
  a paragraph at root, but the text-match transformer has no such
  restriction. The extension also registers `FORMAT_PARAGRAPH_COMMAND`
  and `FORMAT_HEADING_COMMAND<HeadingTagType>`, and exposes the
  current document as a `markdown` `computed` signal derived off
  `EditorStateExtension`.
- **`src/extensions/MarkdownPersistenceExtension.ts`** — owns the
  localStorage ↔ editor sync. It provides the editor's
  `$initialEditorState` so the document is seeded from
  `localStorage[storageKey]` (falling back to the configured
  `defaultMarkdown`). An effect on `MarkdownExtension`'s `markdown`
  signal writes back on every change, and `RESET_MARKDOWN_COMMAND`
  clears the storage entry and re-imports the default in place — no
  page reload.
- **`src/extensions/ToolbarStateExtension.ts`** — exposes everything
  the toolbar reads as output signals: `canUndo` / `canRedo` are
  `computed` off `HistoryExtension`'s `historyState`, while
  `blockType`, `isBold`, `isItalic`, and `isCode` are `computed` off
  the editor-state signal. The React component calls
  `useExtensionSignalValue` for each signal and dispatches commands —
  no local `useState` / `useEffect` and no second update listener.
- **`src/plugins/ToolbarPlugin.tsx`** — block-type select (paragraph,
  heading 1-3, bullet/numbered/check list), undo / redo, and bold /
  italic / inline-code buttons. Pure UI: dispatches commands, reads
  signals.
- **`src/plugins/MarkdownPreviewPlugin.tsx`** — one-liner that reads
  the markdown signal via `useExtensionSignalValue` and renders it.
- **`src/Editor.tsx`** — composes the extensions through
  `LexicalExtensionComposer`, passing the storage key and demo
  document as `MarkdownPersistenceExtension` config.

## Tests

`pnpm run test` runs vitest. The suite covers:

- Round-tripping every supported feature through the markdown
  transformers (`$convertFromMarkdownString` →
  `$convertToMarkdownString`).
- That `CHECK_LIST` matches `- [x] foo` ahead of `UNORDERED_LIST` on
  import, and that the new `CHECK_LIST_ITEM` text-match transformer
  flips a bullet list into a checklist when the user types `[ ] ` /
  `[x] ` inside an existing list item (simulated character-by-character
  via `selection.insertText`).
- That `MarkdownExtension`'s `markdown` output signal updates as the
  editor state changes, and that `ToolbarStateExtension`'s `canUndo` /
  `canRedo` / `blockType` / `isBold` / `isItalic` / `isCode` signals
  follow real edits, real `UNDO_COMMAND` / `REDO_COMMAND` /
  `FORMAT_TEXT_COMMAND` dispatches, and selection changes.

## Running

```bash
pnpm install
pnpm run dev        # vite dev server
pnpm run build      # production build
pnpm run typecheck  # tsc --noEmit
pnpm run test       # vitest run
```

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/meta/lexical/tree/main/examples/markdown-editor?file=src/main.tsx)
