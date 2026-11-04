---
'@lexical/y': patch
---

[docs] The layout policy: after the one-time break to layout 3, layouts are only added. `MIN_LAYOUT` stays 3, the package never removes a reader, writer or published step of a layout from 3 on, and an app that wants a higher floor raises its own (its server stops admitting clients that cannot read the next layout)
