---
'@lexical/link': patch
---

[fix] `$toggleLink` with a URL does nothing for a collapsed selection outside a link, instead of wrapping the whole text node around the caret in a link

Verify: `$toggleLink(url)` and `TOGGLE_LINK_COMMAND` with a collapsed selection outside a link now leave the text unlinked instead of linking the whole text node around the caret. Code that dispatches them at a caret, for example after inserting the URL as text, should select the text to link first. A caret inside a link or an autolink still updates that link's URL.
