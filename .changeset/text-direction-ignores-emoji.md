---
'lexical': patch
---

[fix] `getTextDirection` no longer reads an emoji or another character outside the Basic Multilingual Plane as left-to-right, so a line that starts with an emoji followed by right-to-left text is right-to-left
