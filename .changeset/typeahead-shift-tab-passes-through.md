---
'@lexical/react': patch
---

[fix] An open typeahead or node menu lets Shift+Tab through instead of picking the highlighted option, as it already does for Shift+Enter

Verify: press Shift+Tab with a menu open. The menu no longer picks. The key goes to the editor's own Tab handling instead (with `TabIndentationExtension`, an outdent at the start of a block, otherwise a tab character), or, with no Tab handler, the browser moves focus to the previous element. Tab still picks.
