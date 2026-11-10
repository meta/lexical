---
'@lexical/y': patch
---

[docs] The layout policy while `@lexical/y` is experimental: a release may stop reading an older layout (raise `MIN_LAYOUT`), as layout 3's release does for layouts 1 and 2, and rooms stored in it then open read only until their server migrates them with the published steps (`@lexical/y/migrate`), so apps that store rooms plan a server-side migration for such an upgrade (its release notes say when one is needed). What stays: every published step and revision (1to2 and 2to3 included) stays available and its default revision never changes what it writes; a layout above `MIN_LAYOUT` is reached only with an explicit target; and an app that wants a higher floor raises its own (its server stops admitting clients that cannot read the next layout)
