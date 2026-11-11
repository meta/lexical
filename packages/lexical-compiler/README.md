# `@lexical/compiler`

Lexical's build-time compiler: source-to-source passes over Lexical code,
delivered as a Vite/Rollup plugin and as plain transform functions for
builds with no plugin API of their own.

The **tree-shaking** pass inserts `/* @__PURE__ */`
annotations before module-scope calls to the side-effect-free factories
(`defineExtension`, `createCommand`, `createState`, `safeCast`,
`defineImportRule`, …) so bundlers can drop the extension, command, and rule
definitions an application never uses; it replaces calls to the trivial ones
with the value they would have returned; and with `strict` it refuses to let
an unannotated call hide inside a definition, where it would pin the whole
thing into the bundle.

Lexical's published `dist` bundles already carry the annotations — this
package is for builds that compile Lexical from its TypeScript source:

- consumers that opt into the `source` export condition
  (`resolve.conditions: ['source', ...]`),
- a vendored copy or a git checkout of the monorepo,
- and your own application code, whose `defineExtension`/`createCommand`
  definitions get annotated the same way.

## Why the annotations are needed

The factories are annotated with `@__NO_SIDE_EFFECTS__` where they are
defined, but esbuild only honors that for calls in the same file as the
definition, and webpack/terser do not honor it at all. Bundlers do honor a
`/* @__PURE__ */` annotation at the call site, and that is what this
transform adds.

Argument-position calls matter too: a pure call is only removable when its
arguments are also side-effect-free, so an unannotated nested `safeCast(...)`
inside a `defineExtension({...})` config pins the whole definition. The
transform annotates every module-scope call, nested ones included.

Calls inside function bodies, class fields, and static blocks are left alone —
they are not evaluated when the module is initialized, so an annotation there
has no effect on tree-shaking.

Factory calls are not the only module-scope statements a bundler has to keep.
esbuild and webpack keep, as a side effect, any property read
(`navigator.userAgent`, `Date.now`, `SomeExtension.name`), any call or `new`
they were not told is pure (`new RegExp(...)`, `Object.freeze(...)`,
`[...].join(',')`), an array or object spread, an `in` test, a `try`
statement, a mutation (`table.push(...)`, `Klass.static = ...`), and a class
with a computed member — and everything such a statement references, which is
how one `LexicalEditor.version = ...` after the class kept nearly all of
`lexical` in a bundle that imported only `createCommand`. The fix is the same
mechanism: move the work into a function declared `@__NO_SIDE_EFFECTS__` and
call it at module scope, so that this transform annotates the call and a
bundler can drop it when its result is unused. A call to a builtin or to a
third-party function that cannot be declared is annotated by hand at the call
site.

## Guaranteeing a definition can be dropped

An annotated definition is only droppable when everything it is built from is
too, so a single unannotated call in its arguments quietly pins it into every
bundle that imports the module. With `strict: true` that is a build error
naming the call rather than something you find later in a bundle analyzer:

```
@lexical/compiler: 1 call(s) evaluated inside a definition in
src/MdastFootnoteExtension.ts are not known to be side-effect free, so the
definition cannot be tree-shaken:
  1145:25 gfmFootnoteFromMarkdown(...) inside defineExtension(...)
Make the call lazy, or declare the function side-effect free
(@__NO_SIDE_EFFECTS__ plus the transform's `functions`/`namespaces` options)
so that its calls are annotated too.
```

Calls that only run later (a `nodes: () => [...]` callback, a `register`
method body) are not counted, and neither are the built-ins every bundler
already knows are pure (`new Map(...)`, `new Set(...)`, `Object`, `Symbol`,
…). Modules under `node_modules` are annotated as usual but never
checked: a definition a dependency shipped is not yours to fix. Lexical's own
build runs with `strict` on.

## Usage

Each pass is its own entry point, so a build that wants one of them does not
load the rest: `@lexical/compiler/PureAnnotations` is the tree-shaking pass,
and `@lexical/compiler` re-exports every pass for convenience.

### Vite

```js
// vite.config.js
import {pureAnnotations} from '@lexical/compiler/PureAnnotations';
import {defineConfig} from 'vite';

export default defineConfig({
  plugins: [pureAnnotations()],
  resolve: {conditions: ['source']},
});
```

The plugin defaults to `enforce: 'post'` so it runs after Vite has compiled
TypeScript and JSX away.

### Rollup

```js
// rollup.config.js
import {pureAnnotations} from '@lexical/compiler/PureAnnotations';

export default {
  plugins: [
    // ... any TypeScript/JSX plugin first
    pureAnnotations(),
  ],
};
```

### Any other bundler

`transformPureAnnotations` is the transform itself, with no bundler
integration, so it can be wrapped in a webpack loader or run as a codemod:

```js
import {transformPureAnnotations} from '@lexical/compiler/PureAnnotations';

const result = transformPureAnnotations(code, {filename});
// `null` when the module needs no annotations
const annotated = result === null ? code : result.code;
```

## Which calls get annotated

A call is annotated only when the transform can establish that the function
being called really is side-effect free. It resolves the callee to its binding
in the module and annotates the call when that binding is:

- **imported from a Lexical package** — a specifier matching `lexical` or
  `@lexical/*` (configurable with `sources`). Every factory in
  `PURE_FACTORY_FUNCTIONS` is declared `@__NO_SIDE_EFFECTS__` in those
  packages, so the import is evidence enough. Aliased imports
  (`import {defineExtension as define}`) are resolved too, and so is a
  default import from a Lexical module named for its export
  (`import warnOnlyOnce from '@lexical/internal/warnOnlyOnce'`);
- **declared in the same module with `@__NO_SIDE_EFFECTS__`**, or **imported
  from a relative module that declares it that way** — the imported file is
  read and parsed to check (turn this off with `relativeImports: false`).
  Such a declaration is evidence on its own, so a factory of your own does
  not have to be named in `functions`: mark it and its module-scope calls are
  annotated; or
- **a method of a pure namespace** — an object whose methods build values and
  touch nothing else, like `@lexical/html`'s `sel`, so that
  `sel.tag('span').attr('data-x', true)` is annotated the way a factory call
  is. The names are `PURE_NAMESPACES` (configurable with `namespaces`) when
  imported from a Lexical package, and any object marked
  `@lexical-pure-namespace` where it is declared, including through a
  relative import or a local alias. Only the outermost call of a chain is
  annotated — rollup, terser and esbuild all drop the whole chain from that
  one.

Anything else is left alone. Your own `safeCast` from `./utils`, or a
`createCommand` from some other library, will not be annotated just because it
shares a name with a Lexical factory — annotating a call that does have side
effects would let a bundler drop it. Mark your own factories
`@__NO_SIDE_EFFECTS__` (and add them to `functions`) to opt them in.

## Eliding the trivial factories

Some of the factories are pure type-level helpers whose implementation is a
trivial expression over their own arguments:

| Factory | Returns | Form |
| --- | --- | --- |
| `safeCast(value)` | `value` | `identity` |
| `defineExtension(extension)` | `extension` | `identity` |
| `defineImportRule(rule)` | `rule` | `identity` |
| `configExtension(...args)` | `args` | `args` |
| `declarePeerDependency(...args)` | `args` | `args` |

With `inline: true` the call is replaced by that expression instead of being
annotated:

```js
export const MarkExtension = defineExtension({name: '@lexical/mark', ...});
// becomes
export const MarkExtension = {name: '@lexical/mark', ...};
```

which is better than an annotation in every way that matters: a literal is
inert for every bundler with nothing to preserve through minification, there
is no nested call left to pin the definition, and the factory itself can be
dropped from the bundle once nothing calls it (the import it came from is
removed along with the last call to it).

A call that does not fit its form is annotated as usual: a spread argument
where a single parameter is expected, or a call whose result is discarded.
The replacement is parenthesized wherever bare syntax would not bind the way
the call did — `safeCast(1 + 2) * 3` is not `1 + 2 * 3`, an object literal at
the start of an expression statement would read as a block, and an `args`
array is always wrapped, since a leading `[` is a member access on whatever
the previous line ended with. Minifiers drop the parentheses again.

`createCommand` is deliberately not inlined: `{type: x}` is more bytes than a
call to a minified one-character name.

Each inlined factory is marked `@lexical-inline <form>` where it is defined.
For an import from a Lexical package the marker is documentation — the table
is trusted, because this package ships alongside that Lexical. Everywhere
else (a factory of your own, declared in the module or imported relatively)
the marker is what makes inlining possible at all: `@__NO_SIDE_EFFECTS__`
says a call is safe to *drop*, but only the marker says what the call can be
*replaced with*, so a same-named look-alike is annotated instead. Add your
factory's name to `functions`, mark it with the form its body takes, and its
calls are inlined like Lexical's own.

A marker that names a form the transform does not implement (a typo, or a
form from an older version) throws, naming the file and the forms it accepts.
Failing is the point: a marker that silently did nothing would leave the
factory un-inlined with no sign of it.

This is **off by default** because it reproduces those function bodies, so it
assumes the Lexical you are building matches this package's version — they
are released together with the same version number. Lexical's own build turns
it on for the bundles it publishes. The package's tests check that the
markers in the tree and the table agree, and that the real functions still
return what the table claims.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `inline` | `false` | Replace calls to the trivial factories with the literal they would have returned (see above). |
| `functions` | `PURE_FACTORY_FUNCTIONS` | Names of the factories whose module-scope calls are annotated. Pass your own list (or `[...PURE_FACTORY_FUNCTIONS, 'myFactory']`) to cover factories of your own. |
| `namespaces` | `PURE_NAMESPACES` | Names of objects whose method calls are annotated (see above). |
| `sources` | `[/^lexical$/, /^@lexical\//]` | `RegExp` (or array) of module specifiers whose exports are trusted to be the factories without reading them. |
| `strict` | `false` | Throw when a call evaluated inside one of the definitions is not known to be side-effect free (see above). |
| `relativeImports` | `true` | Whether to read relatively imported modules to look for a `@__NO_SIDE_EFFECTS__` declaration. |
| `include` | every `.js`/`.jsx`/`.ts`/`.tsx`/`.mjs`/`.cjs`/`.mts`/`.cts` module | `RegExp` (or array) matched against the module id with any query string removed. |
| `exclude` | none | `RegExp` (or array) of module ids to skip. |
| `enforce` | `'post'` | Vite plugin ordering. |
| `parserPlugins` | none | Extra [`@babel/parser`](https://babeljs.io/docs/babel-parser#plugins) plugins, for syntax the defaults do not cover. |
| `sourceMap` | `true` | Set to `false` to skip source map generation. |

Modules that fail to parse are passed through unchanged with a warning rather
than failing the build.

The transform is idempotent: a call that already has a `/* @__PURE__ */` (or
terser's `/* #__PURE__ */`) annotation immediately before it is left alone.

## Subpath imports without tree-shaking

`subpathImports` redirects named imports and re-exports from
`@lexical/extension` to their public subpaths. For example,
`import {namedSignals, defineExtension} from '@lexical/extension'` becomes
imports from `@lexical/extension/namedSignals` and `lexical`. It reads the
installed version's barrel, including aliases, rather than using a fixed
list of symbols.

```ts
import {subpathImports} from '@lexical/compiler/SubpathImports';

export default {
  plugins: [subpathImports()],
};
```

Use this Rollup/Vite plugin before dependency resolution. It accepts
TypeScript, TSX and JavaScript, including CommonJS dependencies, standard
decorators and legacy TypeScript parameter decorators, so it can run before
or after TypeScript transpilation. Unlike `pureAnnotations`, it also helps
builds that do not tree-shake: unused extension modules never become
dependencies in the first place. It does not make an individual subpath
smaller than that subpath's own dependency graph.

Options:

- `packages`: package names, or paths to their `package.json` files. Defaults
  to `['@lexical/extension']`. Each package must publish its source files via
  the `source` export condition and declare `sideEffects: false`. Only packages
  with multiple public entries and transparent re-export barrels are narrowed;
  executable root entries are left intact.
- `root`: directory from which package names are resolved. Defaults to
  `process.cwd()`. Use absolute package.json paths for an unbuilt checkout.
- `parserPlugins`: extra `@babel/parser` plugins, appended to the defaults
  for each filename. Accepts plugin names and `[name, options]` tuples, just
  like `pureAnnotations`. Applies to consumers and package source files read
  to derive the export mapping. For example, `parserPlugins: ['doExpressions']`
  enables parsing that syntax; your downstream compiler must still transform it.
  `flow` and `flowComments` are omitted for TypeScript filenames, so Flow
  consumers can import TypeScript packages without enabling both languages
  for the same file. This also applies to `pureAnnotations`.
- `strict`: defaults to `false`. Set to `true` to reject unmappable default
  imports, namespace imports, side-effect imports, star re-exports, dynamic
  imports, TypeScript import assignments and `require` calls
  targeting a barrel. These forms load the whole namespace and cannot be
  narrowed safely. With the default setting they keep their original
  behavior. An explicitly re-exported default is narrowed like a named export.
  Checks include access inside exported declarations. Type-only imports are
  preserved and erased by TypeScript. String literals and template literals
  without substitutions are checked; computed module names cannot be narrowed.

In Rollup watch builds and Vite development servers, changes to the package export
map or barrel bindings refresh the mapping and invalidate cached consumer
transforms. Vite also includes those consumers in the hot update even when
rewriting removed the barrel from their dependency graph.

Relative imports between public entry points are also converted to package
subpaths. Lexical's package build keeps those subpaths external, so a shared
module such as `signals` has one instance across entries. The plugin does
not change a bundler's external configuration: a downstream application can
bundle the subpaths together normally.

Lexical runs this pass in strict mode for all its published package builds,
including www. Consumers can continue to import the complete barrel API
without using any compiler plugin. Barrel and subpath exports reference the
same functions, classes, extensions and signals runtime.

In this repository, source code imports from the `@lexical/extension` barrel
across package boundaries and uses relative imports within that package,
including the barrel's own re-exports. ESLint enforces this convention;
the compiler handles the published subpath layout. Direct subpath imports
remain supported for downstream consumers, including applications that need
small bundles without tree-shaking or the compiler plugin.

## SchemaJsonCodegen

The package's second entry point, `@lexical/compiler/SchemaJsonCodegen`, is
not part of the plugin pipeline: it is the library a code generator uses to
turn a node's declarative serialization schema (the `json` property of
`$config`) into straight-line JavaScript. Lexical's own
`scripts/generate-node-json.mjs` uses it to generate the specialized
`exportJSON`/`updateFromJSON` implementations the built-in nodes ship with.

- `compileParse(meta, defaultValue, tableBaseName)` compiles a schema's
  introspectable `meta` into a JavaScript expression over `v` that parses
  exactly as the schema does, plus any lookup tables the expression refers
  to. Only the kinds whose meta fully determines the parse are compiled
  (strings, numbers, booleans, enums, and `aliasedValue` tables); the rest
  throw `NotCompilable` rather than emit a guess.
- Compiling is not trusting: `verifyCompiledParse` runs the compiled
  expression against the real schema over `verificationCorpus(meta)` — every
  value the schema names plus a fixed set of hostile inputs,
  `Object.prototype` member names included — and throws naming the first
  value they disagree on. `verifyTableCoversDomain` proves an emitted lookup
  table total over a schema's domain, so its miss-fallback is dead code.
- The compact form's comparisons are compiled the same way.
  `compileDiffersFromDefault(schema, name)` states the test that a value is
  not the schema's default — a literal for a primitive default, and the
  length test `arrayValue`'s equality reduces to for an empty-array default —
  and `verifyDiffersFromDefault` runs it against the schema's own `isEqual`
  over the corpus.
- `NUM_HELPER_SOURCE` and `JSON_NUMBER_SOURCE` are the number-parsing helper
  as source text, so an emitted module and the verification share one
  definition rather than two copies that could drift; `NUM_RANGE_HELPER_SOURCE`
  is the constrained-domain variant.

The corpus is fixed rather than sampled, so a generator built on this
produces byte-reproducible output — which is what lets generated files be
checked in and drift-tested against regeneration.
