/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @ts-check
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, test} from 'vitest';

import {bareImportResidue} from '../../shared/bareImportResidue.mjs';
import {packagesManager} from '../../shared/packagesManager.mjs';

/**
 * Entries whose bare import is expected to retain code, with the reason. An
 * entry belongs here only when the retained code is the module's purpose —
 * not when a definition happens to be written in a way a bundler cannot see
 * through, which is what the test exists to catch.
 */
const KNOWN_SIDE_EFFECTS = new Map([
  [
    '@lexical/code-prism',
    'registers its language grammars on the global Prism object when imported',
  ],
]);

/**
 * The published ESM entries: npm module name to the absolute path of the file
 * its `production` (and, when a release build produced one, `development`)
 * import condition resolves to.
 *
 * @returns {Array<[string, string]>}
 */
function publishedEntries() {
  /** @type {Array<[string, string]>} */
  const entries = [];
  for (const pkg of packagesManager.getPublicPackages()) {
    for (const [name, exports] of pkg.getNormalizedNpmModuleExportEntries()) {
      // Only a release build produces the development variant.
      const {development, production} = exports;
      for (const file of [production, development]) {
        if (typeof file === 'string' && fs.existsSync(pkg.resolve(file))) {
          entries.push([name, pkg.resolve(file)]);
        }
      }
    }
  }
  return entries;
}

// A consumer that imports one thing from a Lexical package should pay for
// that thing alone. That holds only when nothing at module scope has to be
// kept for its side effects, because each retained statement keeps its
// transitive references too: one `LexicalEditor.version = ...` after the
// class kept the editor, and with it nearly all of `lexical`, in a bundle
// that only imported `createCommand` (#9120). Guard every published entry:
// a bare import of it must retain nothing. A failure prints what was kept;
// the first statement in it is usually the culprit (a module-scope property
// read, an unannotated call, a spread, an `in` test, a `try`, a mutation, or
// a computed class member), and the rest is what that statement referenced.
describe('a bare import of a published ESM build retains nothing', () => {
  for (const [name, file] of publishedEntries()) {
    const reason = KNOWN_SIDE_EFFECTS.get(name);
    test(`${name} (${path.relative(process.cwd(), file)})`, async () => {
      const residue = await bareImportResidue(file);
      if (reason !== undefined) {
        // The exception has to keep earning its place.
        expect(residue, `${name} ${reason}`).not.toBe('');
      } else {
        expect(residue).toBe('');
      }
    });
  }
});

/**
 * Bundle a consumer of `lexical`'s production ESM build the way #9120 did
 * (esbuild, minified, everything else external) and return the output size.
 *
 * @param {string} consumer the consumer module source
 * @returns {Promise<number>} the minified bundle size in bytes
 */
async function bundleLexicalConsumerSize(consumer) {
  const lexical = packagesManager
    .getPublicPackages()
    .find(pkg => pkg.getNpmName() === 'lexical');
  if (lexical === undefined) {
    throw new Error('lexical package not found');
  }
  const productionFile = lexical.resolve('dist/Lexical.prod.js');
  const result = await esbuild.build({
    bundle: true,
    define: {'process.env.NODE_ENV': '"production"'},
    format: 'esm',
    logLevel: 'silent',
    metafile: true,
    minify: true,
    platform: 'browser',
    plugins: [
      {
        name: 'lexical-production-build',
        setup(build) {
          build.onResolve({filter: /^lexical$/}, () => ({
            path: productionFile,
          }));
        },
      },
    ],
    stdin: {contents: consumer, loader: 'js', resolveDir: process.cwd()},
    write: false,
  });
  // A small bundle from the wrong module (say, the source condition) is not
  // evidence that the built production artifact tree-shakes.
  expect(
    Object.keys(result.metafile.inputs).map(input => path.resolve(input)),
  ).toContain(productionFile);
  return result.outputFiles[0].text.length;
}

describe('a narrow import from lexical', () => {
  // Before the module-scope side effects were removed this consumer bundled
  // to 148,429 bytes — essentially all of lexical — for a function that is a
  // few dozen bytes. The ceiling leaves room for the module's own constants
  // and for createCommand to grow, not for an editor.
  test('bundles only what it uses (#9120)', async () => {
    const size = await bundleLexicalConsumerSize(
      `import {createCommand} from 'lexical'; console.log(createCommand);`,
    );
    expect(size).toBeLessThan(2048);
  });

  test('a consumer that creates an editor still gets one', async () => {
    const size = await bundleLexicalConsumerSize(
      `import {createEditor} from 'lexical'; console.log(createEditor);`,
    );
    expect(size).toBeGreaterThan(100 * 1024);
  });
});
