# Defining Extensions

An extension is an plain JavaScript object that complies with the
[LexicalExtension](/docs/api/modules/lexical#lexicalextension) interface.
The [defineExtension](/docs/api/modules/lexical#defineextension) function
is merely an identity function to make TypeScript inference convenient.
It will be compiled down to the following, and likely optimized out by your
bundler or minifier:

```js
function defineExtension(extension) {
  return extension;
}
```

Extensions *must* be stable references. It is most useful to define them at
module scope, but if for some reason you have to define it inside of a
React component you'll need some way to make it stable such as with
`useState`, `useMemo`, or `useRef` as appropriate.

## Required Properties

### name

The only required property for an extension is `name`. The name is a string
that should be unique to that extension your editor. It is best practice to
use a scope for your project or organization to ensure that reusable
extensions don't conflict with each other.

The general practice in the lexical repository is to use the name of the
package as the extension name when it only makes sense to export a single
extension, (e.g. `DragonExtension` has the name `@lexical/dragon`), or
with an additional path if multiple extensions are exported (e.g.
`AutoFocusExtension` has the name `@lexical/extension/AutoFocus`).

## InitialEditorConfig

Extensions can specify configuration overrides for the editor, these are
defined by the
[InitialEditorConfig](/docs/api/modules/lexical#initialeditorconfig)
interface. See the API docs for the full list of properties. Every property
here has some default.

### Merged properties

For an extension designed to be used as a dependency, it can also be useful
to specify properties that are merged such as
`html` (override HTML import/export),
`nodes` (register new nodes or node overrides with the editor),
or `theme` (specify classes to be used for nodes provided by lexical).

```ts
export const CodeExtension = defineExtension({
  name: '@lexical/code',
  nodes: () => [CodeNode, CodeHighlightNode],
});
```

### Root properties

There are other properties that are more useful for the "root" extension
that you provide to
[buildEditorFromExtensions](/docs/api/modules/lexical_extension#buildeditorfromextensions)
or the `extension` prop of
[LexicalExtensionComposer](/docs/api/modules/lexical_react_LexicalExtensionComposer#lexicalextensioncomposer)
where you would specify properties that can only be meaningfully set
once such as `$initialEditorState`, `editable`, `onError`, `namespace` or `parentEditor`.

There is no requirement that these properties be set from any specific level
of the extension hierarchy, or at all, but it is only meaningful to set them
once per editor.

```ts
const editor = buildEditorFromExtensions(
  defineExtension({
    name: "@example/basic-rich-text-editor",
    namespace: "basic-rich-text-editor",
    dependencies: [RichTextExtension],
    register: (editor: LexicalEditor) => {
      console.log("Editor Created");
      return () => console.log("Editor Disposed");
    },
  }),
);
```

### Errors and warnings

`onError` and `onWarn` are root properties too. `onError` receives errors
an update could not recover from; it throws by default. `onWarn` receives
recoverable, warn-level conditions the editor or a package has already
handled (an update listener that keeps scheduling updates, a selection
listener that keeps changing the selection); by default it throws in
development, so the
condition is hard to miss, and calls `console.warn` in production.

A package that reports a condition with a stable code passes a
`LexicalWarning` to `onWarn`. It is an `Error` with a `code` namespaced by
the package (such as `'@example/importer/skipped-element'`) and optional `data` for
programs, documented with each code; the message is for people and may
change.

```ts
import {defineExtension, LexicalWarning} from 'lexical';

const AppExtension = defineExtension({
  name: '@example/app',
  onWarn(error, editor) {
    if (error instanceof LexicalWarning) {
      switch (error.code) {
        case '@example/importer/skipped-element':
          showImportNotice(editor, error.data);
          break;
        default:
          break;
      }
      reportWarning(error.code, error.message, error.data);
      return;
    }
    console.warn(error);
  },
});
```

Each package documents the codes it reports. Treat them as public API: a
code is never renamed or reused for another condition, and new codes may be
added in any release, so keep a `default` branch in a `switch` over codes.

## Extension Dependencies

Lexical Extensions have two ways for extensions to depend on and specify
configuration for each other:

- [dependencies](#dependencies) are direct (by reference)
- [peerDependencies](#peerdependencies) are indirect (by name) and optional

The exception to this rule is with `peerDependencies`. These are optional
dependencies

### dependencies

The `dependencies` property is an array of extensions by reference that your
extension depends on. For example, if your extension uses React then it should
depend on the `ReactExtension`.

Dependencies form a directed acyclic graph. This means that there must not
be any circular dependencies. If extension A depends on extension B then
there must not be any dependency path from B to A
(or from A to A).

This array can contain either direct references to extensions, or calls to
[configExtension](/docs/api/modules/lexical#configextension).

```ts
export const ExampleExtension = defineExtension({
  name: "@example/extension",
  dependencies: [
    SomeExtension,
    configExtension(ReactExtension, {
      decorators: [<ExampleDecorator />]
    }),
  ],
});
```

### peerDependencies

The `peerDependencies` property is an array of optional extensions by name.
They are not requirements, but specifying them here allows your extension
to find them at runtime and override configuration for them if they are
built with the editor. You can use
[declarePeerDependency](/docs/api/modules/lexical#declarepeerdependency) to
build this array with type inference.

Since these are optional and by name, an extension may declare a peer it does
not import. The graph must still be acyclic: peer edges take part in the same
topological sort as `dependencies`, so two extensions that peer-depend on each
other and are both present will fail to build.

This is rarely needed in practice and is considered an advanced use case,
typically to avoid a direct import or dependency loop. See
[Peer Dependencies](/docs/extensions/peer-dependencies) for more detail.

### conflictsWith

The `conflictsWith` property is an array of extensions by name that are
known to conflict with this extension. For example, it does not make
sense to have
[RichTextExtension](/docs/api/modules/lexical_rich-text#richtextextension) and
[PlainTextExtension](/docs/api/modules/lexical_plain-text#plaintextextension)
in the same editor.

```ts
export const PlainTextExtension = defineExtension({
  conflictsWith: ['@lexical/rich-text'],
  dependencies: [
    DragonExtension,
    NormalizeInlineElementsExtension,
    NormalizeTripleClickSelectionExtension,
  ],
  name: '@lexical/plain-text',
  register: registerPlainText,
});
```

This is rarely needed in practice and is considered an advanced use case,
but it can provide helpful early errors when it is needed.

## Phases

The construction of an editor using extensions is done in sequential phases,
and the following properties are useful ways to hook into that process at
specific points.

### config

`config` is an object that is the default configuration for your extension,
properties of this object can be overridden by other extensions using
[configExtension](/docs/api/modules/lexical#configextension) or
[declarePeerDependency](/docs/api/modules/lexical#declarepeerdependency).

This object is used in later phases to build the init and/or output.

The config phase happens before the editor is constructed.

### mergeConfig

`mergeConfig` is a function that can be used to merge configuration
with its overrides if you need something more fine-grained than a
shallow object merge, such as concatenating arrays. For example:

```ts
interface StringArrayConfig {
  array: string[];
}
const StringArrayExtension = defineExtension({
  config: safeCast<StringArrayConfig>({array: []}),
  name: "@example/StringArray",
  mergeConfig(a, b) {
    const config = shallowMergeConfig(a, b);
    if (b.array) {
      config.array =
        b.array.length > 0
          ? [...a.array, ...b.array]
          : a.array;
    }
    return config;
  },
});
```

The default implementation is
[shallowMergeConfig](/docs/api/modules/lexical#shallowmergeconfig),
most extensions will not need to override this.

### init

The init phase happens before the editor is constructed, but after
the merged editor configuration is available and all extensions are
configured. It can be used to reference configuration
from peers, compute data that should be available during
[build](#build), and is generally a last resort for making mutations
to any extension or editor configuration before the editor is
created.

The result of this function is available in later phases.

This is rarely needed in practice and is considered an advanced use case.

### build

The build phase happens after the editor is constructed — it receives the
`LexicalEditor` — but before [register](#register), and after
[config](#config) and [init](#init). The return value of the `build`
phase is `output` and is available for later phases.

`output` is generally how extensions provide functionality to each
other and to the nodes in your application. A very common use case is
to build signals from configuration with `namedSignals` so that the
behavior of your extension can be modified at runtime (e.g. `disabled`
is a very common use case).

Other use cases for build's `output` are to provide
shared data structures, typed theme configuration, references to the
commands that the extension implements, etc.

```ts
export interface TabIndentationConfig {
  disabled: boolean;
  maxIndent: null | number;
  /**
   * By default, indents are set on all elements for which the
   * {@link ElementNode.canIndent} returns true. This option allows you to set
   * indents for specific nodes without overriding the method for others.
   */
  $canIndent: CanIndentPredicate;
}
export const TabIndentationExtension = defineExtension({
  build(editor, config, state) {
    return namedSignals(config);
  },
  config: safeCast<TabIndentationConfig>({
    $canIndent: $defaultCanIndent,
    disabled: false,
    maxIndent: null,
  }),
  name: '@lexical/extension/TabIndentation',
  register(editor, config, state) {
    const {disabled, maxIndent, $canIndent} = state.getOutput();
    return effect(() => {
      if (!disabled.value) {
        return registerTabIndentation(editor, maxIndent, $canIndent);
      }
    });
  },
});
```

### register

This happens after the editor has been constructed. This is where you will
register any commands, listeners, etc. that your extension needs. It can use
the result of `init` or `build` via `state.getInitResult()` and
`state.getOutput()` respectively.

The return value is a dispose function, typically the result of `mergeRegister`.

### afterRegistration

This happens after [register](#register) for every extension has been called,
so all commands should be registered. This is the phase when the
`$initialEditorState` is applied to the editor by `InitialStateExtension`,
so `editor.setRootElement` should be called no sooner than this phase (it may
of course be called after the editor is built, outside of extensions).

The return value is a dispose function, typically the result of
`mergeRegister`.
