---
'@lexical/mdast': patch
---

[fix] Preserve edits to imported autolink literals when exporting Markdown

Verify: Import a bare URL with `MdastAutolinkLiteralExtension`, change its destination, label or text formatting, then export and reimport it. The edits should survive. Unchanged bare URLs and email addresses should keep their original syntax. Also check that `**https://a.example**` exports as `[**https://a.example**](https://a.example)`, literal-styled links loaded from JSON without `MdastAutolinkLiteralExtension` export as `<https://a.example>`, and copying `https://one.ex` from `https://one.example` exports as `[https://one.ex](https://one.example)`.
