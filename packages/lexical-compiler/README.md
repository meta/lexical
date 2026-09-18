# `@lexical/compiler`

Lexical's build-time compiler: source-to-source passes over Lexical code,
delivered as a Vite/Rollup plugin and as plain transform functions for
builds with no plugin API of their own.

Today it does one thing — **tree-shaking**. It inserts `/* @__PURE__ */`
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
  (`import {defineExtension as define}`) are resolved too;
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
