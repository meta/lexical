/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {OnLoadResult, Plugin} from 'esbuild';

import {glob} from 'glob';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, test} from 'vitest';

import {transformPureAnnotations} from '../../../packages/lexical-compiler/src/passes/pureAnnotations.mjs';
import {bareImportResidue} from '../../shared/bareImportResidue.mjs';
import {packagesManager} from '../../shared/packagesManager.mjs';

/**
 * Modules whose bare import is expected to retain code, by repo-relative path,
 * with the reason. A module belongs here only when the retained code is its
 * purpose — not when a definition happens to be written in a way a bundler
 * cannot see through, which is what the test exists to catch.
 *
 * Keyed by module rather than by package so that an exception covers the file
 * that earns it: `@lexical/code-prism` is one package, but the side effect
 * lives in one of its modules and reaches the other two by import.
 */
const KNOWN_SIDE_EFFECTS = new Map([
  [
    'packages/lexical-code-prism/src/FacadePrism.ts',
    'registers its language grammars on the global Prism object when imported',
  ],
  [
    'packages/lexical-code-prism/src/CodeHighlighterPrism.ts',
    'imports FacadePrism, whose Prism registration is the package side effect',
  ],
  [
    'packages/lexical-code-prism/src/index.ts',
    'imports FacadePrism, whose Prism registration is the package side effect',
  ],
]);

/**
 * Load the TypeScript sources through @lexical/compiler, as the monorepo's
 * Vite plugin and a consumer of the `source` export condition do, so that the
 * factory calls carry the annotations the build would give them.
 */
const compiledSources = new Map<
  string,
  {source: string; result: OnLoadResult}
>();
const lexicalCompiler: Plugin = {
  name: 'lexical-compiler',
  setup(build) {
    build.onLoad({filter: /\.[cm]?[jt]sx?$/}, args => {
      const code = fs.readFileSync(args.path, 'utf8');
      // Each entry builds its own dependency graph, but most dependencies
      // recur across entries. Reuse their transforms without sharing builds:
      // each entry still has to override sideEffects independently. Check the
      // source as well as the path so edits cannot leave stale watch results.
      const cached = compiledSources.get(args.path);
      if (cached?.source === code) {
        return cached.result;
      }
      const result = transformPureAnnotations(code, {
        filename: args.path,
        inline: true,
      });
      const compiled: OnLoadResult = {
        contents: result === null ? code : result.code,
        loader: /\.[cm]?js$/.test(args.path)
          ? 'js'
          : args.path.endsWith('x')
            ? 'tsx'
            : 'ts',
      };
      compiledSources.set(args.path, {result: compiled, source: code});
      return compiled;
    });
  },
};

/**
 * Every source module of every published package, with the npm name of the
 * package it belongs to.
 *
 * Each module rather than each `source` export entry, because
 * {@link bareImportResidue} overrides `sideEffects: false` for the entry alone:
 * for a package whose entry is a barrel — which is most of them — the modules
 * it re-exports keep that declaration and esbuild drops them wholesale, leaving
 * a file with no statements of its own to measure. `@lexical/table`'s barrel
 * reported nothing while `LexicalTableCellNode.ts` retained its whole
 * serialization schema, and only the built bundle, where the two are one file,
 * showed it.
 *
 * Asking the question per module is the same question the published bundle
 * asks, just earlier, and it names the file rather than the package.
 */
function sourceModules(): [string, string][] {
  const entries: [string, string][] = [];
  for (const pkg of packagesManager.getPublicPackages()) {
    const root = pkg.resolve('src');
    // ESM only. No package here declares `"type": "module"`, so a `.js` (or
    // `.cjs`) is CommonJS, and CommonJS has no tree-shaking story to measure:
    // the module is one opaque unit and what a bundler retains is its own
    // interop preamble rather than anything written here. `@lexical/compiler`'s
    // `.mjs` pass is real ESM and stays covered.
    for (const file of glob.sync('**/*.{ts,tsx,mjs}', {
      cwd: root,
      // Neither ships, and a benchmark is written to run, not to be imported.
      ignore: ['**/__tests__/**', '**/__bench__/**', '**/*.d.ts'],
      windowsPathsNoEscape: true,
    })) {
      entries.push([pkg.getNpmName(), path.join(root, file)]);
    }
  }
  return entries;
}

// The source-level counterpart of scripts/__tests__/integration/tree-shaking:
// it needs no build, so it runs on every change, and it covers what a
// consumer of the `source` export condition bundles. A consumer that imports
// one thing from a Lexical package should pay for that thing alone, which
// holds only when a bare import of the module retains nothing — every
// module-scope statement a bundler cannot prove side-effect free is kept,
// together with everything it references (#9120). A failure prints what was
// kept; the first statement in it is usually the culprit (a module-scope
// property read, an unannotated call, a spread, an `in` test, a `try`, a
// mutation, or a computed class member). Move the work into a function
// declared `@__NO_SIDE_EFFECTS__` so the build annotates the call, or
// annotate a call to a builtin by hand; see AGENTS.md.
describe('a bare import of a package source module retains nothing', () => {
  for (const [name, file] of sourceModules()) {
    const relative = path.relative(process.cwd(), file);
    const reason = KNOWN_SIDE_EFFECTS.get(relative);
    test(`${name} (${relative})`, async () => {
      const residue = await bareImportResidue(file, {
        plugins: [lexicalCompiler],
      });
      if (reason !== undefined) {
        // The exception has to keep earning its place.
        expect(residue, `${name} ${reason}`).not.toBe('');
      } else {
        expect(residue).toBe('');
      }
    });
  }
});
