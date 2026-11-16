---
'@lexical/html': patch
---

[fix] `$generateNodesFromDOM` keeps the bold, italic, underline and strikethrough of a `<span>` around another `<span>`, as Word for the web writes every run

Verify: import `<span style="font-weight: bold"><span>x</span></span>` with `$generateNodesFromDOM`; `x` is bold. An inner element still adds formats without removing the outer ones, as across different tags: `<span style="font-weight: bold"><span style="font-weight: normal">x</span></span>` now gives a bold `x`, like `<b><span style="font-weight: normal">x</span></b>` already did. Every tag's `forChild` now runs for the children of a nested element with the same tag, outermost first, as the legacy import docs describe, so check an application's own `importDOM` conversions whose `forChild` is not idempotent, such as one that toggles bold without checking `hasFormat`.
