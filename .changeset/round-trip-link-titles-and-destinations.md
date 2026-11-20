---
'@lexical/markdown': patch
---

[fix] Round-trip link titles and destinations through Markdown export and import, so the link and the text after it read back intact

Verify: Markdown export of links whose title contains a line ending (now `&#10;` or `&#13;`), whose title or URL contains a backtick (now `` \` ``), or whose URL contains an ASCII control character (now written between `<` and `>`). Markdown import of links whose title ends in a backslash: as in CommonMark, a title whose closing delimiter is itself escaped, such as `"C:\"`, no longer closes, so that link now imports as plain text, and an unescaped carriage return in a `<...>` destination no longer reads as a link. A backslash before U+2028 or U+2029 no longer stops a parenthesized title or a `<...>` destination from matching.
