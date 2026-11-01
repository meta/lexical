# `@lexical/code-core`

[![See API Documentation](https://lexical.dev/img/see-api-documentation.svg)](https://lexical.dev/docs/api/modules/lexical_code-core)

This package contains the base functionality for the code blocks and code highlighting for Lexical. This package
is considered an implementation detail and is being used transitionally while the deprecated highlighting
functionality is still available in `@lexical/code`.

## Caret scrolling

When Lexical moves the caret itself, it scrolls the code block sideways to show the caret. That happens on the line
start and end keys in a code block (Home and End, or Cmd+Left and Cmd+Right on macOS), on Enter, on paste and on undo.
It also happens while you type in a highlighted code block, because the highlighter retokenizes the line and Lexical
puts the caret back. Plain arrow keys and clicks move the caret natively, and the browser scrolls for them. Extending a
selection with Shift does not scroll sideways.

When the block scrolls back toward the start of the line and the caret would also fit with it scrolled all the way back,
it goes all the way back. That shows the whole indentation, which Home and Enter leave the caret after. Otherwise it
scrolls just far enough, and keeps the caret out of the code element's `scroll-padding`. A gutter that stays in place
while the code scrolls should set that padding to its width, so the caret isn't left under it. A `float: left` gutter,
like the one the playground theme draws from `data-gutter`, is on the left in both directions, so use
`scroll-padding-left` for it.

At the end of the longest line the block is scrolled as far as it goes, and a browser can draw the caret a fraction of a
pixel past that edge. A few pixels of `padding-inline-end` on the code element leave room for it. The playground theme
(`PlaygroundEditorTheme.css`) does both.
