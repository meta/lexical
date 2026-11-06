---
'@lexical/y': patch
---

[docs] The layout policy, from the one-time break to layout 3 on: layouts are only added. With layout 3, `MIN_LAYOUT` becomes 3 and stays 3; the package never removes a reader or writer of a layout from 3 on, nor any published step or revision (1to2 and 2to3 included); a later layout is reached only with an explicit target; and an app that wants a higher floor raises its own (its server stops admitting clients that cannot read the next layout)
