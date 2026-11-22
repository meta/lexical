---
'@lexical/mdast': patch
---

[fix] A block shortcut no longer strips the lines after its marker when the text before the caret holds a newline

A text node can hold a newline when app code inserts text that contains one (for example `selection.insertText('---\nnotes')`). A space or Enter typed at the end of such a node scanned its whole text as one line: a marker on the first line (`---`, `***`, `___`, `#`, `-`, `1.`, `>` or an empty code fence) was taken as the marker of all of it, so the paragraph became a horizontal rule, an empty heading, list item or quote, and the lines after the marker were deleted. A block marker is now recognized only within one line, so such text stays as it is. Typing a marker on its own line (also after blank lines in the same text node), and Enter with content in a later text node, are unchanged.

Verify: in an editor with `MdastShortcutsExtension`, insert `---\nnotes` with `selection.insertText`, press Enter, and check that the paragraph still holds `notes`.
