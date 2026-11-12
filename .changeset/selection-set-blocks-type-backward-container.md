---
'@lexical/selection': patch
---

[fix] `$setBlocksType` puts its new block in an empty declared block container whichever end of the selection is in it, so a backward range ending in the container no longer leaves it empty

Verify: with `NodeStructureExtension`, select backward from a following paragraph into an empty `children: 'block'` container and convert to a heading: the container holds an empty heading, and the selection still spans from the paragraph into it.
