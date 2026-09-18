/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import * as impl from './passes/pureAnnotations.mjs';

// The comments here spell the annotations without their leading sigil
// (`__PURE__`) because bundlers scan comments for annotations, and one that
// does not precede a call expression is reported as misplaced (rollup's
// INVALID_ANNOTATION).

/**
 * The subset of a source map that bundlers consume, matching what
 * `magic-string` produces. Declared structurally so this package needs no
 * dependency on any particular bundler's types.
 */
export interface PureAnnotationsSourceMap {
  file?: string;
  mappings: string;
  names: string[];
  sources: string[];
  sourcesContent?: (string | null)[];
  version: number;
}

export interface TransformPureAnnotationsOptions {
  /**
   * Path of the module being transformed, used to choose the TypeScript and
   * JSX parser plugins (and named as the source map's source).
   */
  filename?: string;
  /**
   * Names of the factories whose module-scope calls are annotated. Defaults
   * to {@link PURE_FACTORY_FUNCTIONS}.
   */
  functions?: Iterable<string>;
  /**
   * Replace calls to the factories whose result is a trivial expression over
   * their arguments (`safeCast`, `defineExtension`, `configExtension`,
   * `declarePeerDependency`, `defineImportRule`) with that expression rather
   * than annotating them — a literal needs no annotation to be dropped, and
   * nothing is left to pin the definition it appears in.
   *
   * Off by default, because it assumes the Lexical being built matches this
   * package's version. Lexical's own build turns it on for the bundles it
   * publishes.
   */
  inline?: boolean;
  /**
   * Imported objects whose method calls are side-effect free, so that
   * `sel.tag('p').attr('data-x', true)` is annotated the way a call to a
   * factory function is. Defaults to {@link PURE_NAMESPACES}.
   */
  namespaces?: Iterable<string>;
  /** Extra `@babel/parser` plugins to parse the module with. */
  parserPlugins?: readonly unknown[];
  /**
   * Set to false to skip reading relatively imported modules to look for a
   * `__NO_SIDE_EFFECTS__` declaration. Defaults to true.
   */
  relativeImports?: boolean;
  /** Set to false to skip source map generation. */
  sourceMap?: boolean;
  /**
   * Module specifiers whose exports are trusted to be the factories, without
   * reading the module they come from. Defaults to `lexical` and
   * `@lexical/*`; a call to a same-named function from anywhere else is only
   * annotated when the declaration it resolves to is itself marked
   * `__NO_SIDE_EFFECTS__`.
   */
  sources?: RegExp | readonly RegExp[];
  /**
   * Throw when a call evaluated inside one of the definitions is not known
   * to be side-effect free. Such a call pins the definition into every
   * bundle that imports the module, however well annotated the definition
   * itself is, so this turns a silent loss of tree-shaking into a build
   * error naming the call. Off by default.
   */
  strict?: boolean;
}

export interface PureAnnotationsResult {
  code: string;
  /** The number of annotations that were inserted. */
  count: number;
  /**
   * The number of calls that were replaced by the literal they would have
   * returned. Always 0 unless `inline` is set.
   */
  inlined: number;
  map?: PureAnnotationsSourceMap;
}

export interface PureAnnotationsOptions extends TransformPureAnnotationsOptions {
  /**
   * Vite plugin ordering. Defaults to `'post'` so the transform runs after
   * TypeScript and JSX have been compiled away.
   */
  enforce?: 'post' | 'pre';
  /** Module ids to skip. Defaults to none. */
  exclude?: RegExp | readonly RegExp[];
  /**
   * Module ids to transform. Defaults to every `.js`/`.jsx`/`.ts`/`.tsx`
   * (and `.mjs`/`.cjs`/`.mts`/`.cts`) module, including those in
   * `node_modules` so that a Lexical package consumed through its `source`
   * export condition is annotated.
   */
  include?: RegExp | readonly RegExp[];
}

/**
 * The structural shape of the returned plugin. It is assignable to Vite's
 * `Plugin` and to Rollup's `Plugin`, so it can be dropped into the `plugins`
 * array of either.
 */
export interface PureAnnotationsPlugin {
  enforce?: 'post' | 'pre';
  name: string;
  transform(
    code: string,
    id: string,
  ): {code: string; map: PureAnnotationsSourceMap | null} | null;
}

/**
 * The Lexical factories that are annotated with `__NO_SIDE_EFFECTS__` at
 * their definition and whose module-scope call sites therefore need a
 * `__PURE__` annotation for bundlers to tree-shake unused definitions.
 */
export const PURE_FACTORY_FUNCTIONS: readonly string[] =
  impl.PURE_FACTORY_FUNCTIONS;

/**
 * Objects imported from a Lexical package whose method calls are
 * side-effect free, so that a module-scope `sel.tag('p')` is annotated the
 * way a factory call is. Only the outermost call of a chain is annotated:
 * rollup, terser and esbuild all drop the whole chain from that one.
 */
export const PURE_NAMESPACES: readonly string[] = impl.PURE_NAMESPACES;

/**
 * The factories that `inline` replaces with a literal, and the form each one
 * takes: `identity` returns its single argument and `args` returns all of its
 * arguments as an array. Each is marked `@lexical-inline <form>` where it is
 * defined.
 */
export const INLINE_FACTORY_FORMS: ReadonlyMap<string, string> =
  impl.INLINE_FACTORY_FORMS;

/**
 * Insert a `__PURE__` annotation before every module-scope call to one of the
 * side-effect-free Lexical factories that does not already have one. Returns
 * `null` when the module needs no annotations.
 */
export function transformPureAnnotations(
  code: string,
  options?: TransformPureAnnotationsOptions,
): PureAnnotationsResult | null {
  return impl.transformPureAnnotations(code, options);
}

/**
 * The local names in `code` whose module-scope calls the transform would
 * annotate: `functions` are called directly, `namespaces` are objects whose
 * method calls are annotated. A name qualifies by being imported from a
 * Lexical package, declared in the module as side-effect free, or imported
 * from a relative module that declares it that way. For tooling that needs
 * the same decision without rewriting the module — a lint rule that removes
 * a hand-written annotation only where the build puts one back. Throws on
 * source it cannot parse.
 */
export function pureCallNames(
  code: string,
  options?: TransformPureAnnotationsOptions,
): {
  functions: ReadonlySet<string>;
  namespaces: ReadonlySet<string>;
} {
  return impl.pureCallNames(code, options);
}

/**
 * A Vite/Rollup plugin that inserts the `__PURE__` annotations that let
 * bundlers tree-shake unused Lexical extension, command, and rule
 * definitions.
 *
 * The published `dist` bundles already carry the annotations, so this is for
 * builds that compile Lexical from its TypeScript source (the `source`
 * export condition, a git checkout, or a vendored copy) — and for annotating
 * the extensions and commands your own application defines.
 *
 * ```js
 * import {pureAnnotations} from '@lexical/compiler';
 *
 * export default defineConfig({plugins: [pureAnnotations()]});
 * ```
 */
export function pureAnnotations(
  options?: PureAnnotationsOptions,
): PureAnnotationsPlugin {
  return impl.pureAnnotations(options);
}
