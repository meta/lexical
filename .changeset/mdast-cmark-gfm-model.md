---
'@lexical/mdast': patch
---

[perf] Strict Markdown export is much faster on long paragraphs where the cmark-gfm pass rejects many of the character references it tries, as it judges most attempts without parsing the document again
