---
'@lexical/mdast': patch
---

[fix] Preserve edits to imported autolink literals when exporting Markdown

Verify: Import a bare URL with `MdastAutolinkLiteralExtension`, change its destination, label or text formatting, then export and reimport it. The edits should survive. Unchanged bare URLs and email addresses should keep their original syntax.
