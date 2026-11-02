---
'@lexical/markdown': patch
---

[feature] Export option `escapeAmbiguousHtml` to keep `<` and `&` as the author typed them

Since v0.53.0 the exporter writes a literal `<` or `&` that could read as raw
HTML or as a character reference (`<u>under</u>`, `&#0036;5`) as numeric
character references, so re-importing the Markdown gives back the text the
editor held. An app whose renderer is meant to read inline HTML written in the
editor wants the characters instead, which is how the exporter behaved before
that release.

`$convertToMarkdownString` and `$convertSelectionToMarkdownString` take an
options object as their last argument:

```ts
$convertToMarkdownString(TRANSFORMERS, undefined, false, {
  escapeAmbiguousHtml: false,
});
```

The default stays `true`. Brackets that would start a link, an image, a link
reference definition or a check list item are escaped either way, and the
format characters (`*`, `_`, `` ` ``, `~`, `\`) keep their backslash escapes.
