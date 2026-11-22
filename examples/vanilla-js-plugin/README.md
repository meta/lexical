# Basic Vanilla JS Extension example

An `EmojiExtension` that replaces smiles (`:)`, `:P`, etc...) with actual emojis (using [Node Transforms](https://lexical.dev/docs/concepts/transforms)) and uses own graphics for emojis rendering by creating our own custom node that extends [TextNode](https://lexical.dev/docs/concepts/nodes#textnode).

[Getting started guide](https://lexical.dev/docs/getting-started/creating-plugin)

**Run it locally:** `pnpm i && pnpm run dev`

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/meta/lexical/tree/main/examples/vanilla-js-plugin?file=src/emoji-plugin/EmojiExtension.ts)
