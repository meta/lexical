/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @ts-check

import * as esbuild from 'esbuild';

/**
 * Everything a bundler keeps from a module when a consumer imports it for
 * its side effects alone — `import 'lexical'` — is code that every consumer
 * pays for, however little of the module they use: a bundler can only drop a
 * module-scope statement it can prove is side-effect free, and each retained
 * statement drags its transitive references along. A module whose bare import
 * retains nothing is one whose exports can be tree-shaken independently.
 *
 * esbuild is the bundler here because it has the most conservative purity
 * model of the bundlers in common use: it never looks inside a function it
 * did not see declared side-effect free, so a property read, an unannotated
 * call, a spread, an `in` test, a `try`, or a computed class member at module
 * scope is a side effect to it (and to webpack). Rollup infers more on its
 * own, so anything esbuild drops, the others drop too.
 *
 * The module is bundled as if its package did not declare `sideEffects:
 * false` — otherwise a bare import of it would be dropped wholesale and there
 * would be nothing to measure — with every bare specifier external, so that
 * only the module's own statements count.
 *
 * @param {string} entryPath absolute path of the module to measure
 * @param {Object} [options]
 * @param {import('esbuild').Plugin[]} [options.plugins] plugins run before
 *   the resolver that externalizes bare specifiers, e.g. to load the module
 *   from source through a transform
 * @param {'development' | 'production'} [options.mode] the value baked into
 *   `process.env.NODE_ENV`, production by default
 * @returns {Promise<string>} the retained code, with esbuild's path comments
 *   and the (external) import statements removed; empty when the bare import
 *   retains nothing
 */
export async function bareImportResidue(entryPath, options = {}) {
  const {plugins = [], mode = 'production'} = options;
  /** @type {import('esbuild').Plugin} */
  const entryAndExternals = {
    name: 'bare-import-entry',
    setup(build) {
      build.onResolve({filter: /^bare-import-entry$/}, () => ({
        path: entryPath,
        // Ignore the package's `sideEffects: false`: the point is to see what
        // a bundler keeps when it does have to include the module.
        sideEffects: true,
      }));
      build.onResolve({filter: /^[^./]/}, args =>
        args.kind === 'entry-point'
          ? undefined
          : {external: true, path: args.path},
      );
    },
  };
  const result = await esbuild.build({
    bundle: true,
    define: {'process.env.NODE_ENV': JSON.stringify(mode)},
    format: 'esm',
    logLevel: 'silent',
    platform: 'browser',
    plugins: [...plugins, entryAndExternals],
    stdin: {
      contents: `import 'bare-import-entry';`,
      loader: 'js',
      resolveDir: process.cwd(),
    },
    write: false,
  });
  return (
    result.outputFiles[0].text
      .replace(/^\/\/.*\n/gm, '')
      // An import statement never contains a semicolon before the one that ends
      // it, however many lines esbuild spreads its specifiers over.
      .replace(/^import\b[^;]*;\n/gm, '')
      .trim()
  );
}
