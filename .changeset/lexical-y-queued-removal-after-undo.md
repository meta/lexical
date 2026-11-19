---
'@lexical/y': patch
---

[fix] Keep a format change that commits after a collaborator's undo of that format arrived from spreading the format past the run in `@lexical/y`

Verify: on `abcdef`, B bolds `bcde`; at a caret after `c`, A turns bold off and types `X` in a normal `editor.update`, and B's undo of the bold arrives before that update commits. After syncing, no client shows bold on `f`, and every client shows what they show when A's update commits first. (Removing part of a comment the same way shows it too; removing bold with the toolbar does not reproduce it.)
