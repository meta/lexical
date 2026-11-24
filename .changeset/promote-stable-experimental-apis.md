---
'lexical': patch
'@lexical/clipboard': patch
'@lexical/code-core': patch
'@lexical/extension': patch
'@lexical/html': patch
'@lexical/link': patch
'@lexical/list': patch
'@lexical/rich-text': patch
'@lexical/table': patch
---

[docs] Drop `@experimental` from APIs that have shipped unchanged for several releases: the DOM import pipeline (`DOMImportExtension`, `defineImportRule`, `CoreImportExtension`, the node packages' import rules and schemas, `ClipboardImportExtension` and `ClipboardDOMImportExtension`), `DOMRenderExtension` and its render context, the shadow DOM helpers (`getActiveElement`, `getComposedEventTarget`, `getDOMSelectionRange` and the rest), `setDOMUnmanaged`/`isDOMUnmanaged`, keyboard shortcuts (`KeyboardShortcutsExtension`, `compileKeyboardShortcuts`), `NodeSelectionDataSelectedExtension`, compact JSON export (`$withCompactExport`, `$isCompactExport`, `$exportNodeJSON`) and the `$config` serialization schema
