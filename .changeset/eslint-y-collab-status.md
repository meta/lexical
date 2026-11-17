---
'@lexical/eslint-plugin': patch
---

[feature] Add `@lexical/y-collab-status`, in the recommended config: it reports `configExtension(YCollabExtension, {doc, ...})` without `onYStatus`, which TypeScript accepts (an extension's config is partial) and which throws when the editor is built

It suggests `onYStatus: null`. A config without `doc` (an override of a `yCollab(...)` or `createYCollabConfig(...)` dependency), one with a spread, and one that is not an object literal are not reported.

Verify: an app on `@lexical/y` that lints with the recommended config gets an error at each `configExtension(YCollabExtension, {doc, ...})` that lacks `onYStatus`, and none elsewhere.
