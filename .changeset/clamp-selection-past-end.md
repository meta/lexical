---
'lexical': patch
---

[fix] Clamp text selection points to node bounds on update commit

Verify: after shrinking a text node under the selection with spliceText (without moveSelection) or setTextContent, the committed selection sits at the node's new end.
