---
'@lexical/mdast': patch
---

[fix] With `exportPunctuation: 'cjk-friendly'` and the GFM extensions, export writes a character beside formatting as typed beside a link's `[` and beside `-`, `.` and `+`, where it wrote a character reference

Verify: CJK-friendly export snapshots of GFM Markdown with formatting beside a link's `[` or beside `-`, `.` or `+`, such as `**"다르게"**다.` (formerly `**"다르게"**&#xB2E4;.`), `[世**。**](u)` (formerly `[&#x4E16;**。**](u)`) or `-世**!**` (formerly `-&#x4E16;**!**`). Readers that follow the CJK-friendly amendment read both forms alike.
