---
'lexical': patch
---

[fix] `getStyleObjectFromCSS` closes a string or parentheses left open at the end of a style, as CSS does, so `$patchStyleText` on a style such as `font-family: "Arial` no longer writes the patch inside the open string

Verify: code that reads parsed styles with an unterminated string or parentheses at the end, which now come back closed (`"Arial` is now `"Arial"`). Such styles also render as the closed value now: `color: rgb(0,0,0 !important` rendered as `rgb(0, 0, 0) !important` and is now not applied, since `!important` is inside the closed `rgb()`. A comment between `/` and `*` now leaves a space (`x//**/*y` is now `x/ *y`).
