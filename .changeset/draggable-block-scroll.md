---
'@lexical/react': patch
---

[fix] `DraggableBlockPlugin` places a dropped block, and its drop indicator line, from the pointer's position in the viewport (`clientY`) instead of in the page (`pageY`), so a block dropped above the first block lands there when the window is scrolled

Verify: scroll the window, then drag a block above the first block; it lands first, and the indicator line shows above it.
