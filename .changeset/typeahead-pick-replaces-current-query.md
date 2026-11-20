---
'@lexical/react': patch
---

[fix] `LexicalTypeaheadMenuPlugin` replaces the query as it is typed when an option is picked before the menu re-renders, instead of leaving the start of the query in front of the inserted node, or cutting the text before it after a Backspace

Verify: with a typeahead menu open, type one more letter (or press Backspace) and pick an option before the menu re-renders, for example while the page is busy: the whole query is replaced and the text before it stays. The `textNodeContainingQuery` and `matchingString` that `onSelectOption` receives now describe that query, not the one the menu last rendered.
