---
'@lexical/y': patch
---

[fix] Text typed right next to a format that an undo removed takes the format's leftmost edge when a redo brings the format back: typed right after its last character it joins the format, typed right before its first character it stays outside, as in Word, Google Docs and ProseMirror (before, the reverse). Where the typing and the redo are concurrent, which edge it takes depends on the client ids.

Verify: with two clients, A bolds `abc` in `xxabcyy` and undoes; B types X right after `c`; A redoes. Every client shows X bold (before, plain); typed right before `a` instead, X stays plain (before, bold).
