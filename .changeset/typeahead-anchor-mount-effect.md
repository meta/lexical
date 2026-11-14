---
'@lexical/react': patch
---

[fix] `useMenuAnchorRef` no longer leaks an empty `role="listbox"` div when React discards a render of a typeahead menu (for example when a nearby `Suspense` boundary suspends on first render): the anchor element is appended in an effect instead of during render, so only a committed render attaches it, and unmounting still removes it

Verify: render an editor with a typeahead plugin inside a `Suspense` boundary next to a component that suspends on its first render: while suspended no "Typeahead menu" element is in the page, after the boundary resolves exactly one is attached, and unmounting removes it.
