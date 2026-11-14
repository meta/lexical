---
'@lexical/react': patch
---

[fix] Announce typeahead menu options and result count to screen readers

The default typeahead menu now exposes a named listbox that holds its options directly, a custom `menuRenderFn` menu keeps a listbox on its container, and menus announce how many suggestions there are, "Loading" while a lookup runs, and "No results" when it finishes empty. `LexicalTypeaheadMenuPlugin` takes `loading` and `getStatusMessage` props, `LexicalNodeMenuPlugin` takes `getStatusMessage`, and `MenuOption` takes `ariaLabel`. `getStatusMessage` replaces the spoken line for translation and returns `null` to stay silent.

Verify: open a typeahead menu with a screen reader. The listbox role is on the inner list (`ul`) and no longer on `#typeahead-menu`. Options that are not highlighted no longer carry `aria-selected="false"`. The editor's `aria-controls` is still `typeahead-menu`. The menu says "N suggestions available" once typing settles. A menu that is empty and not loading says "No results".
