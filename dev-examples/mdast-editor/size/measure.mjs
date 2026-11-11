/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint-disable no-console -- CLI script; the printed table is the output */

// Builds two functionally-equivalent markdown-editor bundles — one on
// @lexical/mdast, one on the legacy @lexical/markdown — and prints their
// minified and gzipped sizes. Run from the example directory:
//
//   npm run size
//
// Both bundles include the lexical core and the markdown node set, so the
// delta between them is attributable to the markdown machinery itself
// (micromark + mdast-util vs. the bespoke regex implementation).

import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const exampleDir = path.resolve(here, '..');
const monorepoRoot = path.resolve(exampleDir, '..', '..');

// vite build resolves the monorepo's PRODUCTION dist artifacts; without them
// the module resolution silently falls back to development builds and the
// measurement is meaningless. Fail loudly instead.
if (
  !existsSync(
    path.join(monorepoRoot, 'packages', 'lexical', 'dist', 'Lexical.prod.js'),
  )
) {
  console.error(
    'Production dist artifacts are missing. Run `pnpm run build-prod` (or ' +
      '`node scripts/build.mjs --prod`) at the monorepo root first.',
  );
  process.exit(1);
}

const entries = ['legacy', 'mdast'];
const results = {};

for (const entry of entries) {
  console.log(`\nBuilding ${entry} bundle...`);
  execFileSync(
    'npx',
    ['vite', 'build', '-c', 'size/vite.size.config.ts', '--logLevel', 'warn'],
    {
      cwd: exampleDir,
      env: {...process.env, SIZE_ENTRY: entry},
      stdio: 'inherit',
    },
  );
  const file = path.join(exampleDir, 'dist-size', entry, `${entry}.js`);
  const contents = readFileSync(file);
  results[entry] = {
    gzip: gzipSync(contents, {level: 9}).length,
    min: contents.length,
  };
}

const kb = n => `${(n / 1024).toFixed(1)} kB`;
const labels = {
  legacy: 'legacy `@lexical/markdown`',
  mdast: '`@lexical/mdast`',
};
console.log('\n| bundle | minified | min+gzip |');
console.log('| --- | --- | --- |');
for (const entry of entries) {
  const {min, gzip} = results[entry];
  console.log(`| ${labels[entry]} | ${kb(min)} | ${kb(gzip)} |`);
}
const dMin = results.mdast.min - results.legacy.min;
const dGzip = results.mdast.gzip - results.legacy.gzip;
const sign = n => (n >= 0 ? '+' : '');
console.log(
  `| delta (full vs legacy) | ${sign(dMin)}${kb(dMin)} | ${sign(dGzip)}${kb(
    dGzip,
  )} |`,
);
