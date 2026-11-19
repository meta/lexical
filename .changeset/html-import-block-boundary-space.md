---
'lexical': patch
'@lexical/html': patch
---

[fix] Trim a space at a block boundary next to an inline tag on HTML import

Verify: `<div><p>a </p><font>b</font></div>` and `<div><font>a</font><p> b</p></div>` import as `a` and `b` without the stray space, and `<div>a <span><div>b</div></span> c</div>` no longer keeps the spaces around `b`.
