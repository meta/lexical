---
'@lexical/link': patch
---

[feature] Add a `disabled` option to AutoLinkExtension

Setting `disabled: true` in the AutoLinkExtension config stops the extension from registering its transform or command, so typed text is never turned into a link. The option is reactive: flipping the `disabled` signal on and off enables and disables auto-linking without rebuilding the editor.
