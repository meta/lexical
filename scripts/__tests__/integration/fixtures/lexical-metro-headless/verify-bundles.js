/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Execute every bundle bundle.js produced (a Metro bundle for a platform
// without native modules runs under Node.js) and check what each one
// contains. Metro's default resolution reaches the `default` fork module,
// which imports both the development and the production build, so those
// bundles must simply run in both modes. The single-variant resolver must
// leave exactly the build matching the bundle mode in the bundle.
const assert = require('assert');
const {execFileSync} = require('child_process');
const fs = require('fs');
const path = require('path');

// A message that only the development build carries, and the error-code
// documentation URL that only the production build carries. Both are string
// literals, so minification leaves them alone.
const DEVELOPMENT_ONLY = 'Unable to find an active editor state';
const PRODUCTION_ONLY = 'lexical.dev/docs/error';

const outDir = path.join(__dirname, 'out');

function run(name) {
  const stdout = execFileSync(process.execPath, [path.join(outDir, `${name}.js`)], {
    encoding: 'utf8',
  });
  const source = fs.readFileSync(path.join(outDir, `${name}.js`), 'utf8');
  return {
    hasDevelopment: source.includes(DEVELOPMENT_ONLY),
    hasProduction: source.includes(PRODUCTION_ONLY),
    stdout: stdout.trim(),
  };
}

const results = Object.fromEntries(
  ['default-dev', 'default-release', 'single-dev', 'single-release'].map(
    name => [name, run(name)],
  ),
);
for (const [name, {stdout}] of Object.entries(results)) {
  console.log(`${name}: ${stdout}`);
  // Metro's prelude only defines process.env.NODE_ENV when the environment
  // running the bundle has none (a test runner sets it to `test`), so the
  // mode the entry prints is not asserted; the variant checks below are.
  assert.match(
    stdout,
    /^METRO_OK \S+ Hello Metro$/,
    `${name} did not run the editor`,
  );
}
assert.deepStrictEqual(
  [results['single-dev'].hasDevelopment, results['single-dev'].hasProduction],
  [true, false],
  'single-dev must contain only the development build',
);
assert.deepStrictEqual(
  [
    results['single-release'].hasDevelopment,
    results['single-release'].hasProduction,
  ],
  [false, true],
  'single-release must contain only the production build',
);
console.log('OK');
