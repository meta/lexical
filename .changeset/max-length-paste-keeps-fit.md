---
'@lexical/selection': patch
---

[fix] `$trimTextContentFromAnchor` keeps the part of a paste that fits under the limit and no longer cuts an emoji or other grapheme in half

Verify: with a max-length transform that calls `$trimTextContentFromAnchor`, paste text that crosses the limit after existing text: the start of the paste is kept up to the limit and the caret ends after it. An emoji or other grapheme that crosses the limit is dropped whole, so the text can end a few characters short of the limit. Text that is already over the limit is cut to it by the next edit instead of the edit being ignored.
