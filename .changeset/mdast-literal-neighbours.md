---
'@lexical/mdast': patch
---

[fix] Export an imported autolink literal in resource or autolink form when what is written beside it would change how it reads back

Verify: Import `www.example.com` with `MdastAutolinkLiteralExtension`, add bold `y` right after it, and export: it should be `[www.example.com](http://www.example.com)**y**`, which reimports as the same link followed by bold `y` (before, `www.example.com**y**` reimported as a link to `http://www.example.com**y`). The same applies to a letter, code or punctuation the link would run into, and to a letter right before it. Unedited `www.example.com_` should export as `[www.example.com](http://www.example.com)\_` and reimport without a backslash in the link. Literals that read back unchanged, such as `see www.example.com, then` or `(www.example.com)`, should keep their bare form.

Only the literals from the first one that would read back differently are written in another form; the ones before it keep their bare form. If the paragraph, heading or table cell still would not read back as written, every literal in it is. To check them, a paragraph, heading or table cell with such a literal is written again, once or twice, so contributed `toMarkdownExtensions` handlers for its inline content run again each time, and a contributed `root` handler runs inside the package's own, with the state as `this`.
