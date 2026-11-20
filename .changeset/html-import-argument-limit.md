---
'@lexical/html': patch
'lexical': patch
---

[fix] `$generateNodesFromDOM` no longer throws `RangeError: Maximum call stack size exceeded` when one block or link of the HTML holds more nodes than a call can take as arguments, such as a `<pre>` of 70,000 lines of plain text or a paragraph or link of that many `<br>`-separated lines. Pasting such HTML into a rich-text editor keeps its formatting instead of falling back to plain text with a console error

Verify: import a `<pre>` of 70,000 lines of plain text, and a `<p><a href>` of 70,000 `<br>`-separated lines, with `$generateNodesFromDOM`; each imports every line (inside the link for the second) with no error.
