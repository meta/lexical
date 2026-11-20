---
'@lexical/yjs': patch
---

[fix] Mark the `yjs` peer dependency of `@lexical/yjs` optional, as `@lexical/react` already does, so apps that use `@lexical/react` without `LexicalCollaborationPlugin` no longer get an unmet required `yjs` peer (or an auto-installed `yjs`) through `@lexical/react`'s dependency on `@lexical/yjs`

Verify: in a pnpm app with `autoInstallPeers: false` that depends on `@lexical/react` and not on `yjs`, `pnpm install` reports no missing `yjs` peer; with the default `autoInstallPeers: true`, `yjs` is no longer installed. Apps that use `@lexical/yjs` or `LexicalCollaborationPlugin` still need `yjs` installed, as before.
