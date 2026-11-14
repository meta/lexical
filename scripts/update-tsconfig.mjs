/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import fs from 'fs-extra';
import {globSync} from 'glob';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import prettier from 'prettier';
import ts from 'typescript';

import {packagesManager} from './shared/packagesManager.mjs';

/**
 * @typedef {Object} UpdateTsconfigOptions
 * @property {Array<[string, Array<string>]>} extraPaths additional paths to add
 * @property {string} jsonFileName path to the tsconfig.json
 * @property {import('prettier').Options} prettierConfig the monorepo prettier config
 * @property {boolean} test true to include the test paths (default: false)
 */

/**
 * @param {UpdateTsconfigOptions} options
 * @returns {Promise<void>}
 */
async function updateTsconfig({
  extraPaths,
  jsonFileName,
  prettierConfig,
  test,
}) {
  const prevTsconfigContents = fs.readFileSync(jsonFileName, 'utf8');
  // Parse JSONC and replace only the generated paths object, preserving
  // comments and all other hand-maintained compiler options.
  const source = ts.parseJsonText(jsonFileName, prevTsconfigContents);
  const statement = source.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) {
    throw new Error(`${jsonFileName}: expected a JSON object`);
  }
  /** @type {ts.Expression} */
  let pathsNode = statement.expression;
  for (const name of ['compilerOptions', 'paths']) {
    const property =
      ts.isObjectLiteralExpression(pathsNode) &&
      pathsNode.properties.find(
        node =>
          ts.isPropertyAssignment(node) &&
          ts.isStringLiteral(node.name) &&
          node.name.text === name,
      );
    if (!property || !ts.isPropertyAssignment(property)) {
      throw new Error(`${jsonFileName}: missing ${name} object`);
    }
    pathsNode = property.initializer;
  }
  const publicPaths = [];
  const testPaths = [];
  const configDir = path.resolve(path.dirname(jsonFileName));
  for (const pkg of packagesManager.getPackages()) {
    const resolveRelative = (/** @type {string[]} */ ...subPaths) =>
      path
        .relative(configDir, pkg.resolve(...subPaths))
        .replace(/^(?!\.)/, './');

    // Private packages are not published and not imported by their package
    // name across the monorepo, so they need no path aliases.
    if (pkg.isPrivate()) {
      continue;
    }
    for (const {name, sourceFileName} of pkg.getExportedNpmModuleEntries()) {
      publicPaths.push([name, [resolveRelative('src', sourceFileName)]]);
    }
    if (test) {
      testPaths.push([`${pkg.getNpmName()}/src`, [resolveRelative('src')]]);
      for (const fn of globSync(
        // Only the directory's index module backs the bare
        // `<pkg>/src/__tests__/utils` specifier. Matching every file let
        // glob order pick a sibling module (e.g. assertNodeType.ts) instead.
        pkg.resolve('src', '__tests__', 'utils', 'index.{ts,tsx,mjs,jsx}'),
        {windowsPathsNoEscape: true},
      )) {
        testPaths.push([
          `${pkg.getNpmName()}/src/__tests__/utils`,
          [resolveRelative(fn)],
        ]);
      }
      // Deep source imports (e.g. `lexical/src/environment`). Tests need to
      // address a package's internal modules by a stable specifier so that
      // `vi.mock` can intercept the exact module the source imports relatively
      // (e.g. environment constants or `@internal` helpers like caretFromPoint).
      testPaths.push([
        `${pkg.getNpmName()}/src/*`,
        [resolveRelative('src', '*')],
      ]);
    }
  }
  const paths = Object.fromEntries([
    ...extraPaths,
    ...publicPaths,
    ...testPaths,
  ]);
  const updatedContents =
    prevTsconfigContents.slice(0, pathsNode.getStart(source)) +
    JSON.stringify(paths) +
    prevTsconfigContents.slice(pathsNode.end);
  const nextTsconfigContents = await prettier.format(updatedContents, {
    ...prettierConfig,
    filepath: jsonFileName,
  });
  if (prevTsconfigContents !== nextTsconfigContents) {
    fs.writeFileSync(jsonFileName, nextTsconfigContents);
  }
}

// Example/site aliases relative to packages/lexical-website (the website
// type-checks the out-of-workspace @examples sources embedded in its docs).
/** @type {Array<[string, Array<string>]>} */
const WEBSITE_EXTRA_PATHS = [
  [
    '@examples/agent-example/Editor',
    ['../../examples/agent-example/src/Editor.tsx'],
  ],
  [
    '@examples/website-chat/Editor',
    ['../../examples/website-chat/src/Editor.tsx'],
  ],
  [
    '@examples/website-notion/Editor',
    ['../../examples/website-notion/src/Editor.tsx'],
  ],
  [
    '@examples/website-rich-input/Editor',
    ['../../examples/website-rich-input/src/Editor.tsx'],
  ],
  [
    '@examples/website-toolbar/Editor',
    ['../../examples/website-toolbar/src/Editor.tsx'],
  ],
  ['@site/*', ['./*']],
];

// The monorepo's package path aliases exist for two reasons:
// - The unit-test typecheck (tsconfig.test.json) needs them because tests
//   import sibling packages without declaring them, including deep subpaths
//   like `*/src/__tests__/utils` that aren't part of the public exports.
// - VSCode walks up from a test file to the nearest tsconfig.json (the root
//   one) and uses that for editor diagnostics. To make those resolve to the
//   same source the unit tests use, the root tsconfig also carries the test
//   paths. tsconfig.build.json is hand-maintained and resolves via the
//   `source` export condition (customConditions) instead — it is not
//   generated here.
async function updateAllTsconfig() {
  // fileURLToPath, not URL.pathname: pathname is a URI path, so on a checkout
  // under a space, `#`, `%`, `~` or a non-ASCII directory prettier is asked to
  // resolve its config from a folder that does not exist. It answers null, the
  // fallback below takes over, and the files are rewritten with default options
  // instead of the monorepo's.
  const prettierConfig =
    (await prettier.resolveConfig(fileURLToPath(import.meta.url))) || {};
  await updateTsconfig({
    extraPaths: [],
    jsonFileName: './tsconfig.test.json',
    prettierConfig,
    test: true,
  });
  await updateTsconfig({
    extraPaths: [],
    jsonFileName: './tsconfig.json',
    prettierConfig,
    test: true,
  });
  await updateTsconfig({
    extraPaths: WEBSITE_EXTRA_PATHS,
    jsonFileName: './packages/lexical-website/tsconfig.json',
    prettierConfig,
    test: false,
  });
  await updateTsconfig({
    extraPaths: [['lexicalOriginal', ['../lexical/src/']]],
    jsonFileName: './packages/lexical-devtools/tsconfig.json',
    prettierConfig,
    test: false,
  });
}

updateAllTsconfig();
