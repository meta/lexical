---
'@lexical/list': patch
---

[feature] New `TouchIndentationExtension` lets you change the indentation of list items by swiping

Add the extension to your editor's `dependencies` and swipe on a touch device: swiping right on a list item indents it, and swiping left outdents it. You can swipe both items inside the selection and items outside of it. Changing the indentation keeps the selection where it was, and an editor that is not focused does not take the focus back.

Swipes are ignored when the editor is read-only, when more than one finger is touching the screen, and when the gesture is mostly vertical, so scrolling and text selection are not affected.

The extension has two options, which you can set with `configExtension(TouchIndentationExtension, {...})`:

- `disabled` turns swipe-to-indent off (default `false`). It can be changed at runtime.
- `swipeThreshold` is the horizontal distance in pixels a swipe needs to count (default `50`).
