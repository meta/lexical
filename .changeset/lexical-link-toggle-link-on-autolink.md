---
'@lexical/link': patch
---

[fix] `$toggleLink(url)` inside an autolink makes it a link with that URL: it set the autolink's URL in place, and AutoLink set it back from the text on the next edit (or load), losing the URL the user chose

Verify: with `AutoLinkExtension`, select text inside an autolink and set a link URL (`$toggleLink`, the link editor of the playground); edit the link's text or reload: the link keeps the URL you set and is no longer an autolink. Removing a link (`$toggleLink(null)`) and setting a URL on a regular link are unchanged.
