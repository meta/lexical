# Peer Dependencies

Peer Dependencies are used to declare indirect or optional dependencies
between extensions. This can be used to enable some functionality or
configuration only when some other extension is available, or to
avoid a dependency loop. Extensions must form a directed acyclic graph,
there must not be a dependency path from one extension back to itself.

## Use Cases

Generally the intended use case for `peerDependencies` is to provide
functionality only when some other extension is present. For example,
you may have an extension that requires special code to interact with
React, but is also usable without React, so you could have
`ReactProviderExtension` in the `peerDependencies` array.

Another example would be to provide Markdown serialization or import
for an extension that provides some custom node type, but only
if the `MdastExtension` is present in that editor.
