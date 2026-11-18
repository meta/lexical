---
'@lexical/markdown': patch
---

[fix] Markdown export no longer escapes an underscore between two ASCII letters or digits, so `snake_case` and bare URLs such as `https://en.wikipedia.org/wiki/Albert_Einstein` export as typed

Such an underscore can neither open nor close emphasis in CommonMark, so the `\_` was not needed, and GFM keeps the backslash inside an autolink literal's target: GitHub, for one, rendered the exported URL above as a link to `…/wiki/Albert%5C_Einstein`. Underscores next to anything else, including another underscore, are still escaped, and the legacy `shouldPreserveNewLines` export is unchanged. Markdown written before this change still imports unchanged.

Verify: Markdown export snapshots of text containing `_` between letters or digits.
