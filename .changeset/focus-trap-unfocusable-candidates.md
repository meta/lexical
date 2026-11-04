---
'@lexical/a11y': patch
---

[fix] `FocusTrapExtension` passes over descendants that can't take focus (hidden, `inert`, in a disabled `<fieldset>`, or a link inside an editor), so Tab no longer gets stuck

Verify: Tab, Shift+Tab and the initial focus in trapped dialogs that contain hidden or disabled controls, or an editor with links.
