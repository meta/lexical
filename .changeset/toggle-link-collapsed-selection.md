---
'@lexical/link': minor
---

[breaking] `$toggleLink` and `TOGGLE_LINK_COMMAND` with a URL no longer link at a collapsed selection outside a link

They used to wrap the whole text node around the caret in a link, so how much text got linked depended on text node boundaries the user cannot see. A caret inside a link or an autolink still updates that link's URL, and removing a link (`null`) from a caret is unchanged.

Migration: select the text or node to link before dispatching, for example `textNode.select(0, textNode.getTextContentSize())` after inserting the text, or a `NodeSelection` of an inserted decorator.

Detect: `$toggleLink(url)` calls, or `TOGGLE_LINK_COMMAND` dispatched with a URL, while the `RangeSelection` is collapsed.

Verify: Insert link and Ctrl/Cmd+K with a collapsed caret outside a link do nothing; with text selected, or inside an existing link, they work as before.
