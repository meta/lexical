---
'@lexical/y': patch
---

[fix] Keep a read-only bound editor showing the document: what a local update changes while the binding is read only is read again, with an `UNSUPPORTED_EDIT_WARNING`

Code that edited a read-only bound editor (the binding writes nothing then)
left it showing content the document does not hold, and a remote change read
into it later could misplace blocks or hang the tab. A binding read only for
good (node types it cannot build, an unsupported configuration, a change it
cannot store) also made the editor editable for a moment whenever the
layout record changed, and warned again; it now stays read only.

Verify: code that calls `editor.update()` while the binding's `status` is
`'readonly'` sees its change undone after the update (the editor reads what
it changed again, or, once the document cannot be read, shows what it showed
before), and `onWarn` receives
`UNSUPPORTED_EDIT_WARNING` (`reason: 'read-only'`) once, unless the binding went
read only to keep showing a change it cannot store
(`UNSUPPORTED_SLOTS_WARNING`). Code that handles every `YWarningCode`
handles the new one.
