/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Builds every dev-examples/* vite app for deployment under the
// lexical-website's static paths, so each example is served at
// https://lexical.dev/dev-examples/<name>/ (and on every Cloudflare/Vercel
// deploy preview of the website). Run from the monorepo root:
//
//   pnpm run build:dev-examples
//
// The website's `build` script runs this automatically after the monorepo
// build. The examples are built in development mode on purpose: they are
// demos, not benchmarks, and the development artifacts keep Lexical's full
// error messages.

import {execFileSync} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const monorepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const devExamplesDir = path.resolve(monorepoRoot, 'dev-examples');
const outputRoot = path.resolve(
  monorepoRoot,
  'packages',
  'lexical-website',
  'static',
  'dev-examples',
);

// The vite builds resolve the monorepo's development dist artifacts; fail
// loudly when they are missing.
if (
  !existsSync(
    path.join(monorepoRoot, 'packages', 'lexical', 'dist', 'Lexical.dev.js'),
  )
) {
  console.error(
    'Dist artifacts are missing. Run `pnpm run build` at the monorepo ' +
      'root first.',
  );
  process.exit(1);
}

const examples = readdirSync(devExamplesDir, {withFileTypes: true})
  .filter(
    entry =>
      entry.isDirectory() &&
      existsSync(path.join(devExamplesDir, entry.name, 'index.html')) &&
      existsSync(path.join(devExamplesDir, entry.name, 'vite.config.ts')),
  )
  .map(entry => entry.name)
  .sort();

for (const name of examples) {
  console.log(`Building dev-examples/${name} -> /dev-examples/${name}/`);
  execFileSync(
    'npx',
    [
      'vite',
      'build',
      // Development mode resolves the .dev.mjs artifacts deterministically
      // (production artifacts may not exist and are not wanted here).
      '--mode',
      'development',
      '--logLevel',
      'warn',
      '--base',
      `/dev-examples/${name}/`,
      '--outDir',
      path.join(outputRoot, name),
      '--emptyOutDir',
    ],
    {
      cwd: path.join(devExamplesDir, name),
      stdio: 'inherit',
    },
  );
}

console.log(`Built ${examples.length} dev example(s) into ${outputRoot}`);
