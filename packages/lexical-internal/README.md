# `@lexical/internal`

> [!WARNING]
> This package contains **internal** utilities shared across the Lexical
> packages: `invariant`/`devInvariant`, `createError`, dev/prod error- and warning-message
> formatting, `warnOnlyOnce`, and the `LEXICAL_VERSION` constant. These are
> bound to the build's transforms and are inlined into every other package
> rather than shipped as a runtime dependency, so it is published only so the
> modules resolve through normal package resolution — including the `source`
> export condition used when developing against a linked checkout.
>
> It is **not** a public API. Import from `lexical` and the `@lexical/*`
> feature packages instead. Nothing here follows semver and any export may
> change or disappear without notice.

`createError('Message with %s', value)` constructs an `Error` without throwing
it, for example to pass to an editor's `onWarn` handler. It shares invariant's
literal-message and `%s` argument convention, including production error-code
extraction, and can be used inside expressions.

The transform recognizes the default import from
`@lexical/internal/createError` (or its `.js` alias), including renamed imports.
Unrelated or shadowed functions with the same name are left alone. Generated
calls use separate `createDevError` and `createProdError` runtime helpers so
bundled output can pass through the transform again.

Warnings routed through `createError`, including the update-cascade warning,
use the minified error message in production builds with extracted error codes.
Arguments such as the editor namespace are encoded as `v` parameters in the
decoder URL instead of appearing directly in the message text. Telemetry that
matches the full development warning text must account for that production form.
