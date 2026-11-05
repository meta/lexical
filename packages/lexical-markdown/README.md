# `@lexical/markdown`

[![See API Documentation](https://lexical.dev/img/see-api-documentation.svg)](https://lexical.dev/docs/api/modules/lexical_markdown)

This package contains markdown helpers for Lexical: import, export and shortcuts.

## Import and export
```js
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  TRANSFORMERS,
} from '@lexical/markdown';

editor.update(() => {
  const markdown = $convertToMarkdownString(TRANSFORMERS);
  ...
});

editor.update(() => {
  $convertFromMarkdownString(markdown, TRANSFORMERS);
});
```

It can also be used for initializing editor's state from markdown string. Here's an example with react `<RichTextPlugin>`
```jsx
<LexicalComposer initialConfig={{
  editorState: () => $convertFromMarkdownString(markdown, TRANSFORMERS)
}}>
  <RichTextPlugin />
</LexicalComposer>
```

## Shortcuts
Can use `<MarkdownShortcutPlugin>` if using React
```jsx
import { TRANSFORMERS } from '@lexical/markdown';
import {MarkdownShortcutPlugin} from '@lexical/react/LexicalMarkdownShortcutPlugin';

<LexicalComposer>
  <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
</LexicalComposer>
```

Or `registerMarkdownShortcuts` to register it manually:
```js
import {
  registerMarkdownShortcuts,
  TRANSFORMERS,
} from '@lexical/markdown';

const editor = createEditor(...);
registerMarkdownShortcuts(editor, TRANSFORMERS);
```

## Transformers
Markdown functionality relies on transformers configuration. It's an array of objects that define how certain text or nodes
are processed during import, export or while typing. `@lexical/markdown` package provides set of built-in transformers:
```js
// Element transformers
UNORDERED_LIST
CODE
HEADING
ORDERED_LIST
QUOTE

// Text format transformers
BOLD_ITALIC_STAR
BOLD_ITALIC_UNDERSCORE
BOLD_STAR
BOLD_UNDERSCORE
INLINE_CODE
ITALIC_STAR
ITALIC_UNDERSCORE
STRIKETHROUGH

// Text match transformers
LINK
```

And bundles of commonly used transformers:
- `TRANSFORMERS` - all built-in transformers
- `ELEMENT_TRANSFORMERS` - all built-in element transformers
- `MULTILINE_ELEMENT_TRANSFORMERS` - all built-in multiline element transformers
- `TEXT_FORMAT_TRANSFORMERS` - all built-in text format transformers
- `TEXT_MATCH_TRANSFORMERS` - all built-in text match transformers

Transformers are explicitly passed to markdown API allowing application-specific subset of markdown or custom transformers.

Default export protects numeric-reference, HTML and link syntax in text,
including constructs split across text nodes. A literal `<` is escaped only where
it would start a tag, a comment, a declaration, a processing instruction or an
autolink, and a literal `&` only where it would start a numeric reference, so
`AT&T`, `a < b`, `<3`, `1<2` and `Tom &` export as typed; named references keep
their legacy import and export behavior. Code and strings
returned by custom transformers retain their existing serialization rules, as
does the legacy source escaping of `shouldPreserveNewLines`. Import reads
backslash escapes and decimal or hexadecimal references in one pass. A literal
bracket is escaped only where it would otherwise start a link, an image, a link
reference definition or a check list item, so text such as `[1]` and `array[0]`
exports as typed. Escaped brackets and guarded `<`/`&` use numeric references so
escaping does not change adjacent emphasis flanking.

Import follows CommonMark's Unicode punctuation and whitespace when deciding
whether `*`, `_`, `~~` and `==` open or close formatting. When formatted text
starts or ends with punctuation right beside a letter, export writes that
letter as a numeric reference (`fo&#111;**“bar”**`) so that the markers still
open and close, for micromark-based readers such as `@lexical/mdast` too. This
holds with `shouldPreserveNewLines` as well, where a raw backslash right before
such a marker or reference goes out as `&#92;`. Where a bare URL, `www.` host
or email that GFM readers would link holds such a reference, or would take in
the markers or code span after it, export writes a character of its prefix as
a reference too (`www&#46;x.co*a*b`), so that no reader links it and the
formatting comes through.

Import and export also take an options object in the position of the
`shouldPreserveNewLines` argument, which still takes a boolean. Its
`punctuation` option (`'cjk-friendly'` or `'strict-commonmark'`) chooses
how markers beside punctuation are read and written. CommonMark doesn't let
`**` open or close between a letter and punctuation, so `**你好。**世界` reads
with literal asterisks. Import defaults to `'cjk-friendly'`, which follows the
[CommonMark CJK-friendly amendment](https://github.com/tats-u/markdown-cjk-friendly):
it reads Markdown as CommonMark does except beside Chinese, Japanese and Korean
characters and punctuation, where markers open and close as their writer
meant, and a variation selector before a marker reads as the character it
follows, but after whitespace as itself, as `micromark-extension-cjk-friendly`
reads it, and after a U+0000 as the U+FFFD that readers put in its place, as
`markdown-it-cjk-friendly` reads it. Export defaults to `'strict-commonmark'`,
whose references every CommonMark, GFM and CJK-friendly reader reads the same
way (`**你好。**&#19990;界`), with three exceptions. A run of three or more
markers that a pair uses only part of (`***a*b*c***` or `***x****y*`, as on
earlier versions, or `**“***!。**」!a***`) is read differently by micromark and by commonmark.js
and markdown-it, which apply the rule of 3 to the whole run.
A selector after a tab, a line ending, a vertical tab or a form feed that ends
a run (`**。\v︎**`) reads as that whitespace in `markdown-it-cjk-friendly`,
which leaves those markers literal.
A vertical tab beside a marker (`p\v**.**\vq`) reads as whitespace in
commonmark.js, markdown-it and micromark, but not in cmark and cmark-gfm
(GitHub's renderer), which follow CommonMark's definition of whitespace, and
no reference can stand for it.
`'cjk-friendly'` writes such CJK text as typed
(`**你好。**世界`) for readers that follow the amendment.

```ts
$convertFromMarkdownString(markdown, TRANSFORMERS, undefined, {
  punctuation: 'strict-commonmark',
  shouldPreserveNewLines: false,
});
$convertToMarkdownString(TRANSFORMERS, undefined, {punctuation: 'cjk-friendly'});
```

There're three types of transformers:

- **Element transformer** handles top level elements (lists, headings, quotes, tables or code blocks)
- **Text format transformer** applies text range formats defined in `TextFormatType` (bold, italic, underline, strikethrough, code, subscript and superscript)
- **Text match transformer** relies on matching leaf text node content

See `MarkdownTransformers.js` for transformer implementation examples
