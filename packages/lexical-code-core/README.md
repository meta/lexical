# `@lexical/code-core`

[![See API Documentation](https://lexical.dev/img/see-api-documentation.svg)](https://lexical.dev/docs/api/modules/lexical_code-core)

This package contains the base functionality for the code blocks and code highlighting for Lexical. This package
is considered an implementation detail and is being used transitionally while the deprecated highlighting
functionality is still available in `@lexical/code`.

## Line numbers

`@lexical/code-prism` and `@lexical/code-shiki` write the line numbers of each code block to its `data-gutter`
attribute (`"1\n2\n3"`), which a theme can show with `content: attr(data-gutter)`. That gutter is a single block of
text, so it can't follow a line that wraps.

`CodeLineNumbersExtension`, which `@lexical/code` also exports, is an opt-in alternative that marks where each logical
line starts, so a theme can hang a number on it:

- the DOM of every `CodeNode` gets `data-lexical-code-line-numbers`
- the `<br>` of each `LineBreakNode` in a code block is wrapped in `<span data-lexical-code-line-break>`

A theme can then number the lines with a CSS counter. Line 1 comes from the code element's `::before` and every other
line from the `::after` of the span that ends the line before it, so empty lines get a number too:

```css
code[data-lexical-code-line-numbers] {
  counter-reset: code-line;
}
code[data-lexical-code-line-numbers]::before,
code[data-lexical-code-line-numbers] [data-lexical-code-line-break]::after {
  counter-increment: code-line;
  content: counter(code-line);
  /* empty alternative text, so screen readers don't read the numbers */
  content: counter(code-line) / '';
  /* size and place the number in a gutter */
}
```

The numbers are generated content, so they never end up in the editor's text, the clipboard or exported HTML. Neither do
the wrappers: the default `exportDOM` of a `LineBreakNode` goes through the same `$createDOM` overrides, so the
extension leaves the `<br>` unwrapped while `RenderContextExport` is set. Exported and copied HTML is the same as without
the extension, including what other `$createDOM` overrides do to the `<br>`. The highlighters keep writing `data-gutter`
while the extension is enabled. If a theme draws an `attr(data-gutter)` gutter with the code element's `::before`, which
now draws line 1's number, override that gutter's `content` and placement (such as a float or full height) under
`[data-lexical-code-line-numbers]` rather than hiding the pseudo element. The playground theme
(`PlaygroundEditorTheme.css`) has a complete example.

WebKit does not draw line 1's number, the code element's `::before`, while a right to left block is scrolled sideways.
The numbers drawn by the wrappers stay. The playground theme has this limitation too.

The extension can be switched off at runtime through its `disabled` signal, which puts back exactly the DOM a code
block has without it.

Set `onlyWordWrapped` to give the line number markup only to code blocks with word wrap on (see below). The other blocks
render exactly as they do without the extension, so a theme can keep numbering them with `data-gutter`. It can also be
switched at runtime through the `onlyWordWrapped` signal.

## Word wrap

`CodeNode.setWordWrap(true)` makes a code block soft wrap lines that are wider than it, instead of scrolling sideways,
and `getWordWrap()` reads it back. Wrapping is visual only: no `LineBreakNode` is added and the text is unchanged.

While it is on:

- the node's JSON has `"wordWrap": true`. The key is left out while it is off, so the JSON of other code blocks doesn't
  change.
- the code element and the exported `<pre>` get `data-lexical-code-word-wrap="true"`. HTML import reads the attribute
  back, and a value of `"false"` counts as off.

The package adds no CSS for it. A theme wraps the lines under the attribute:

```css
code[data-lexical-code-word-wrap] {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
```

`data-gutter` has one row per logical line, so it can't follow wrapped rows. Number wrapped blocks with
`CodeLineNumbersExtension` instead, and take the numbers out of the line box, because an inline number can be left
alone on a row before a long token:

```css
code[data-lexical-code-word-wrap][data-lexical-code-line-numbers]::before,
code[data-lexical-code-word-wrap][data-lexical-code-line-numbers] [data-lexical-code-line-break]::after {
  position: absolute;
  inset-inline-start: 0;
  margin-inline: 0;
}
```

Keep `top: auto` and an inline `display` such as `inline-block`, so each number stays on the first row of its line, and
give the code element `position: relative` and a `padding-inline-start` as wide as the numbers, so the text starts after
them. `margin-inline: 0` drops any margin that placed the number in the line, which would now move it out of the
gutter. Keep `overflow-x: auto` rather than `visible` on the code element, because
`visible` would change the scroll container the numbers are placed against.

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
`scroll-padding-left` for it. A sticky gutter at the inline start, like the playground theme's per line numbers, is on
the right in a right to left block, so use `scroll-padding-inline-start` for it.

At the end of the longest line the block is scrolled as far as it goes, and a browser can draw the caret a fraction of a
pixel past that edge. A few pixels of `padding-inline-end` on the code element leave room for it. The playground theme
(`PlaygroundEditorTheme.css`) does all of this.
