/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Produce the bundles verify-bundles.js executes: a development and a
// release bundle (the latter minified, as `react-native bundle` does for a
// release build) with Metro's default resolution, and the same two with the
// single-variant resolver from metro.config.js.
const {execFileSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, 'out');
fs.rmSync(outDir, {force: true, recursive: true});
fs.mkdirSync(outDir);

const BUNDLES = [
  ['default-dev', {dev: true, singleVariant: false}],
  ['default-release', {dev: false, singleVariant: false}],
  ['single-dev', {dev: true, singleVariant: true}],
  ['single-release', {dev: false, singleVariant: true}],
];

for (const [name, {dev, singleVariant}] of BUNDLES) {
  execFileSync(
    'pnpm',
    [
      'exec',
      'metro',
      'build',
      'index.js',
      '--out',
      path.join(outDir, `${name}.js`),
      '--platform',
      'ios',
      '--dev',
      String(dev),
      '--minify',
      String(!dev),
      '--reset-cache',
    ],
    {
      cwd: __dirname,
      env: {...process.env, LEXICAL_SINGLE_VARIANT: singleVariant ? '1' : '0'},
      stdio: 'inherit',
    },
  );
}
