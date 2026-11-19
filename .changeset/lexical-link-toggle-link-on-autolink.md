---
'@lexical/link': patch
---

[fix] `$toggleLink(url)` inside an autolink makes it a link with that URL: it set the autolink's URL in place, and AutoLink set it back from the text on the next edit (or load), losing the URL the user chose

Verify: with `AutoLinkExtension`, select text inside an autolink and call `$toggleLink(url)` (or dispatch `TOGGLE_LINK_COMMAND`) directly; edit the link's text or reload: the link keeps the URL you set and is no longer an autolink, and a screen reader hears no "Link removed". Removing a link (`$toggleLink(null)`) and setting a URL on a regular link are unchanged. (The playground's link editor already replaced the autolink itself, so it shows no difference.)
