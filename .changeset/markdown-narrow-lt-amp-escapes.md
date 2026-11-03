---
'@lexical/markdown': patch
---

[fix] Markdown export escapes a literal `<` or `&` only where it would start markup or a character reference

A literal `<` is written as `&#60;` only where a CommonMark reader would otherwise start a tag, a closing tag, a comment, a declaration, a processing instruction, CDATA or an autolink (a letter, `/`, `!` or `?` after it, or an email address up to `>`), and a literal `&` as `&#38;` only where it would start a numeric character reference (or, at the end of a text node, a named one). Text such as `<3`, `1<2`, `x <- y`, `a <= b` and `Tom &` now exports as typed instead of as `&#60;3` or `Tom &#38;`. Both rules still read on into the text exported after a text node.

Verify: Markdown export snapshots of text containing `<` or `&`, and any caller that shows or sends the export as plain text rather than through a Markdown reader.
