---
'@lexical/y': patch
---

[feature] Refuse a Yjs that lacks the internals `@lexical/y` uses, or a document from a second copy of Yjs, with a typed `YUnsupportedYjsError` before anything is written

`@lexical/y` supports exactly one `@y/y` version, its exact peer dependency,
now also exported as `SUPPORTED_YJS_VERSION`. The exact version is enforced
by that peer dependency: `@y/y` exposes no version at run time. Package
managers only warn about an unmet peer dependency (pnpm by default, npm
with `--legacy-peer-deps`), so an app could still run another `@y/y` and
misbehave without an error. `createYDoc`, `YBinding` (and so
`YCollabExtension`) and the headless helpers now check, once per app, that
the `@y/y` they loaded provides the exports, fields and events the binding
uses, and that the document comes from that same copy. Otherwise they throw a
`YUnsupportedYjsError` (`code: UNSUPPORTED_YJS_ERROR`) with
`data: {supported, found, reason}`, where `reason` is `'changed-internals'`
or `'other-copy'`. A `@y/y` older than `14.0.0-rc.25` fails earlier, at
build or load, with a missing `Node` export; `rc.25` to `rc.28` provide
everything the binding uses and pass the check, so pin the named version.

Verify: with `@y/y@14.0.0-rc.29` installed once (`npm ls @y/y`), nothing
changes.
