---
'lexical': patch
---

[fix] `getTextDirection` returns the direction that the browser gives `dir="auto"`

It now skips emoji, variation selectors, U+3000, U+FEFF and other characters with no strong direction, reads LRM, RLM and ALM as strong, and treats Arabic-Indic digits as neutral. Letters of all right-to-left scripts count as RTL, including Samaritan, Mandaic, Adlam and Hanifi Rohingya. Text that starts with an emoji followed by Hebrew or Arabic was `'ltr'` and is now `'rtl'`.

Verify: output that uses `getTextDirection` for text that starts with an emoji, RLM or a digit, and RTL code lines in `@lexical/code` that start with an emoji (`$getCodeLineDirection`, the line start and end keys).
