---
'@lexical/code-core': patch
---

[fix] Enter in a code block keeps the indentation of a line made of plain text nodes, as a code block holds without a highlighter, instead of starting the new line at column 0

Verify: in a code block with no syntax highlighting, type `    run();` and press Enter; the new line starts with the same four spaces. Only the indentation before the caret is copied, so Enter at the start of an indented line no longer doubles the indentation of the line it moves down, on highlighted lines too. Pasted code keeps each line as written, including a paste at the end of an indented highlighted line, which used to add that line's indentation to the first pasted line. As on highlighted lines, the new line after an indented line starts with its indentation, so pressing Enter twice more does not leave the code block until that indentation is deleted.
