# Design Doc

See also the initial PR [#7706](https://github.com/meta/lexical/pull/7706)

## Guiding principles

### Minimize boilerplate

Wherever possible, sensible defaults should be provided and it must be
possible to override them. This is why a `Extension` has the `config` property
which specifies the initial configuration.

### Full backwards compatibility

Almost anything that you do with the editor or a legacy React plug-in should
just work. Upgrading to use a `Extension` should be a simple change.

### Minimize change required to add an Extension

Ideally, adding an extension should be two or three lines of code:

- Import it
- Add it as a dependency (with config if necessary)
- Add UI related code (only if needed, e.g. has to be rendered in a specific place in the DOM)

### Avoid invalid states

TypeScript goes a long way here, but it's only as good as the API design.
For example, splitting up the workflow for an Extension to have separate `Config`,
`Init` and `Output` types was something that evolved over time. In earlier
prototypes, `Config` was overloaded to maintain all of that state, but it
required a lot more runtime support and type assertions to check that
the state was properly initialized for that phase.

### Try to avoid undecipherable type errors

There's only so much that can be done to make readable error messages
out of complex type expressions, so the API is designed to avoid them
when possible. See also [microsoft/TypeScript#23689](https://github.com/microsoft/TypeScript/issues/23689).

## Inspiration

### [ESLint Flat Plugins](https://eslint.org/docs/latest/extend/plugin-migration-flat-config)

These have many of the same constraints as this project, although of course
are used for a very different purpose

### [MDXEditor](https://mdxeditor.dev/)

This editor is based on Lexical, but provides its own mechanism for plugins
based on a third party state management library. These plugins don't
really expose any type-safe configuration.

### [@payloadcms/richtext-lexical](https://www.npmjs.com/package/@payloadcms/richtext-lexical)

Another Lexical based editor framework for use inside the
[Payload](https://payloadcms.com/) CMS. It also doesn't really expose type-safe
configuration, but it does seem to have quite a lot of features and seems
well-designed for laziness and SSR. Features are conceptually similar to Extensions.

### [Effect](https://effect.website/)

This library is pretty much state of the art for type safety with a focus on
composition and usability.

### Tighter integration with LexicalEditor

This package was originally prototyped as an entirely optional feature,
as adoption increases it's expected that more of Lexical will directly
depend on it.

## Intentional trade-offs

### No compile-time support for dependency resolution

The current theory is that it would require too much TypeScript
in order to carry around the list of all dependency names that
exist in the graph, and would likely add another type argument
to `LexicalExtension`.

The features that this blocks are:

- Compile-time support for detecting Extension conflicts. Detecting that two
  extensions defined with the same name (but are not identical object
  references, because a dependency can be shared!) would also be quite the
  undertaking in TypeScript. This is automatically detected at runtime by
  the builder.
- Compile-time support for required configuration without defaults.
  An extension can implement this at runtime in `init` or `register`.
- Compile-time support for required peer dependencies. A use case for this
  would be the requirement of a `ReactProviderExtension` provided by either
  `LexicalExtensionComposer` or `ReactPluginHostExtension`. An extension can implement this
  at runtime in `init` or `register`.

Generally speaking, all of these are already surfaced as runtime errors
while building the editor with sufficient information to quickly track
down the root cause.

## Known Missing Features

### Direct support for devtools

This is a TODO, the infrastructure was designed with this in mind.

### Documented patterns for RSC/SSR/Headless

Having a known peer dependency that is used to declare SSR may help
guide future Extension development. In many cases there are decorator nodes
that have React dependencies that you do not want to (or can not) render
in an SSR context. For example, RSC can not be supported anywhere that
`React.Context` is used which is everywhere that React is currently used
in Lexical.

Another option would be to build separate entrypoints for the SSR use case,
which is more of an RSC specific strategy, but we could encourage people
to use those import conditions even in a Vanilla JS or some other bespoke
SSR use case. That strategy may make it hard to support including both
"headless" and "non-headless" in the same module.
