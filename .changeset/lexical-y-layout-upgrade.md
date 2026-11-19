---
'@lexical/y': patch
---

[feature] `createYCollabConfig(input)`, the way to configure `YCollabExtension`: its input requires `layoutUpgrade`, how documents below `MIN_LAYOUT` are upgraded, either `createYServerLayoutUpgrade()` (it takes no options; the document's server migrates them on load; the handle, with `kind` and `handshake({generation, material})`, builds the complete session handshake) or `null` (they stay read only). The editor opens such a document read only either way, and `UNSUPPORTED_LAYOUT_WARNING` `'older'` carries `upgrade` (`'server'` or `'read-only'`); a config without the option also reports `UNSUPPORTED_CONFIG_WARNING` `'missing-layout-upgrade'`
