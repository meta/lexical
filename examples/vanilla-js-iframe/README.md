# Vanilla JS example in an iframe

A minimal Lexical editor built with `buildEditorFromExtensions` and no framework, using `RichTextExtension`, `HistoryExtension`, and `DragonExtension` (accessibility). The contentEditable lives inside an iframe, so the editor reads selection and focus from the iframe's window rather than the page's.

**Run it locally:** `pnpm i && pnpm run dev`

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/meta/lexical/tree/main/examples/vanilla-js-iframe?file=src/main.ts)
