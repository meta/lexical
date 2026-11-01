/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @ts-check
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import {afterAll, beforeAll, describe, expect, test} from 'vitest';

import {packagesManager} from '../../shared/packagesManager.mjs';

/**
 * The published packages are `"type": "module"` packages, which makes every
 * `.d.ts` in them an ES module declaration. Under TypeScript's `nodenext`
 * resolution an extensionless relative import in such a declaration
 * (`from './LexicalEditor'`, which is what tsc emits from the sources) does
 * not resolve at all, and a consumer with `skipLibCheck` sees no error: the
 * whole package silently types as `any`. scripts/build.mjs rewrites those
 * imports with an explicit `.js` extension; this test is the consumer that
 * would notice if that stopped working.
 *
 * A temporary project links every public package into its node_modules and
 * imports each entry point as a namespace under `nodenext`. Assigning the
 * namespace to a `0` literal must fail with TS2322 naming the module's own
 * type, which is only possible when the declarations resolved. A relative
 * import that fails to resolve anywhere in the declarations (they are
 * checked rather than skipped) fails the test with its message.
 */

/** @type {string} */
let projectDir;
/** @type {Array<[string, string]>} name to the identifier it is imported as */
const entries = packagesManager
  .getPublicPackages()
  .flatMap(pkg => pkg.getExportedNpmModuleNames())
  .map((name, i) => [name, `ns${i}`]);

beforeAll(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexical-nodenext-'));
  const nodeModules = path.join(projectDir, 'node_modules');
  for (const pkg of packagesManager.getPublicPackages()) {
    const link = path.join(nodeModules, pkg.getNpmName());
    fs.mkdirpSync(path.dirname(link));
    fs.symlinkSync(pkg.resolve('.'), link, 'dir');
  }
  fs.writeJsonSync(path.join(projectDir, 'package.json'), {
    name: 'lexical-nodenext-consumer',
    private: true,
    type: 'module',
  });
  fs.writeFileSync(
    path.join(projectDir, 'consumer.ts'),
    entries
      .flatMap(([name, id]) => [
        `import * as ${id} from '${name}';`,
        `export const check_${id}: 0 = ${id};`,
      ])
      .join('\n') + '\n',
  );
});

afterAll(() => {
  fs.removeSync(projectDir);
});

/**
 * Whether the package that owns a declaration file declares the package a
 * bare specifier names as a dependency.
 *
 * @param {string} fileName the declaration file (a real path under a
 *   package's `dist/`)
 * @param {string} specifier a bare import specifier
 * @returns {boolean}
 */
function isDeclaredDependency(fileName, specifier) {
  const packageName = /^(@[^/]+\/[^/]+|[^/]+)/.exec(specifier)?.[1];
  const owner = packagesManager
    .getPublicPackages()
    .find(pkg => fileName.startsWith(`${pkg.resolve('dist')}${path.sep}`));
  return (
    packageName !== undefined &&
    owner !== undefined &&
    packageName in (owner.packageJson.dependencies ?? {})
  );
}

describe('every published entry point types under nodenext resolution', () => {
  /** @type {Map<string, string[]>} */
  const diagnosticsByEntry = new Map();
  /** @type {string[]} */
  const otherDiagnostics = [];

  beforeAll(() => {
    const consumer = path.join(projectDir, 'consumer.ts');
    const program = ts.createProgram([consumer], {
      lib: ['lib.esnext.d.ts', 'lib.dom.d.ts'],
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      // A side-effect import (`import 'prismjs/components/prism-clike.js'`)
      // is only resolved with this on.
      noUncheckedSideEffectImports: true,
      // Check the declarations themselves too: an import inside a `.d.ts`
      // that does not resolve is only reported this way.
      skipLibCheck: false,
      strict: true,
      types: [],
    });
    const lines = fs.readFileSync(consumer, 'utf8').split('\n');
    for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
      const message = ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        '\n',
      );
      const {file, start} = diagnostic;
      if (file && file.fileName === consumer && start !== undefined) {
        const {line} = file.getLineAndCharacterOfPosition(start);
        const id = /check_(ns\d+)/.exec(lines[line])?.[1];
        const entry = entries.find(([, candidate]) => candidate === id)?.[0];
        if (entry !== undefined && diagnostic.code === 2322) {
          diagnosticsByEntry.set(entry, [
            ...(diagnosticsByEntry.get(entry) ?? []),
            message,
          ]);
          continue;
        }
      }
      // A relative import that fails is exactly what this test is about. A
      // bare one is too when the declaration's package declares that
      // dependency: it is installed next to the package, so it can only
      // fail to resolve because of the specifier (an extensionless
      // `prismjs/components/prism-clike`, say). An undeclared one (a
      // transitive `@preact/signals-core`) is not installed next to the
      // package and is out of scope here.
      const specifier = /'([^']+)'/.exec(message)?.[1];
      const isResolutionFailure =
        diagnostic.code === 2834 ||
        diagnostic.code === 2835 ||
        ((diagnostic.code === 2307 || diagnostic.code === 2882) &&
          specifier !== undefined &&
          (/^\.{1,2}(\/|$)/.test(specifier) ||
            (file !== undefined &&
              isDeclaredDependency(file.fileName, specifier))));
      if (isResolutionFailure || (file && file.fileName === consumer)) {
        otherDiagnostics.push(
          `${file ? path.relative(projectDir, file.fileName) : '?'}: TS${diagnostic.code}: ${message}`,
        );
      }
    }
  });

  test('reports nothing but the expected assignability errors', () => {
    expect(otherDiagnostics).toEqual([]);
  });

  test.each(entries.map(([name]) => name))('%s', name => {
    // `typeof import("lexical")` (or a `.d.ts` path) in the message is the
    // resolved declaration; an unresolved module would type as `any` and
    // assign to `0` without complaint.
    expect(diagnosticsByEntry.get(name)?.join('\n')).toMatch(/typeof import\(/);
  });
});
