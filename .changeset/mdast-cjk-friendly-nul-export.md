---
'@lexical/mdast': patch
---

[fix] With `exportPunctuation: 'cjk-friendly'`, a CJK character beside a run with U+0000 at its edge goes out as typed where it would beside a run with other punctuation at its edge, not as a character reference (`**\0**世` and `世**\0**`, formerly `**\0**&#x4E16;` and `&#x4E16;**\0**`)

Verify: CJK-friendly export snapshots of formatting with U+0000 at its edge beside a CJK character, which may no longer hold that character's reference.
