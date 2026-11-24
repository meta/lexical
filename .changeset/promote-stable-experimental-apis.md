---
'lexical': patch
'@lexical/clipboard': patch
'@lexical/code-core': patch
'@lexical/extension': patch
'@lexical/html': patch
'@lexical/link': patch
'@lexical/list': patch
'@lexical/react': patch
'@lexical/rich-text': patch
'@lexical/table': patch
'@lexical/utils': patch
---

[docs] Drop `@experimental` from APIs that have shipped for several releases with no API change queued: the DOM import pipeline (`DOMImportExtension`, `defineImportRule`, `CoreImportExtension`, the node packages' import rules and schemas, `ClipboardImportExtension` and `ClipboardDOMImportExtension`), `DOMRenderExtension` and its render context, the shadow DOM helpers (`getActiveElement`, `getComposedEventTarget`, `getDOMSelectionRange` and the rest), `setDOMUnmanaged`/`isDOMUnmanaged`, keyboard shortcuts (`KeyboardShortcutsExtension`, `compileKeyboardShortcuts`), `NodeSelectionDataSelectedExtension` and `getRegisteredSubtypeMap`, named slots (`$setSlot`, `$getSlot`, `$removeSlot`, `mountSlotContainer`, `useLexicalSlotRef`, `$dfsWithSlots` and the rest) and `DOMSlot`/`$getDOMSlot`, compact JSON export (`$withCompactExport`, `$isCompactExport`, `$exportNodeJSON`) and the `$config` serialization schema
