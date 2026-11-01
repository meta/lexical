# Node Replacement Example

A rich text editor built with extensions (`RichTextExtension`, `HistoryExtension`, and `AutoFocusExtension`) that uses node replacement to swap every `ParagraphNode` for a `CustomParagraphNode`. The replacement is declared in the `nodes` of `CustomParagraphExtension`.

**Run it locally:** `pnpm i && pnpm run dev`

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/meta/lexical/tree/main/examples/node-replacement?file=src/main.tsx)
