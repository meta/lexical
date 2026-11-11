/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Regenerate the specialized `exportJSON` and `updateFromJSON` implementations
 * the built-in node classes ship with: `pnpm run generate-node-json`. The
 * generation itself is `./shared/generateNodeJSON.mjs`; this is the command
 * around it.
 *
 * It runs in two phases, because reading the schemas means importing the
 * packages, and each package imports the file this script writes for it. Phase
 * one replaces every output with a valid do-nothing module so the imports
 * always succeed — otherwise a generator run that produced broken output could
 * never be run again to fix it. Phase two re-enters under `tsx`, which resolves
 * the packages to their TypeScript sources, and writes the real thing.
 *
 * In place by default; given a directory, the repo-relative layout is written
 * under it instead, which is how the drift test regenerates without replacing
 * the modules other test workers are importing at that moment — though that
 * test runs the generation in-process rather than through this command.
 */

import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {MANIFEST, stubSource} from './shared/generateNodeJSONManifest.mjs';

const REPO = join(import.meta.dirname, '..');
const OUT_DIR = process.argv[2] ? resolve(process.argv[2]) : null;

if (!process.env.LEXICAL_CODEGEN_PHASE_TWO) {
  for (const pkg of MANIFEST) {
    const target =
      OUT_DIR === null ? join(REPO, pkg.file) : join(OUT_DIR, pkg.file);
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, stubSource(pkg));
  }
  execFileSync(
    'npx',
    ['tsx', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    {
      cwd: process.cwd(),
      env: {...process.env, LEXICAL_CODEGEN_PHASE_TWO: '1'},
      stdio: 'inherit',
    },
  );
  process.exit(0);
}

// Imported only now: the module reads the schemas by importing the packages,
// which phase one has just made loadable.
const {generateNodeJSON} = await import('./shared/generateNodeJSON.mjs');
for (const {target} of generateNodeJSON(OUT_DIR)) {
  process.stdout.write(`wrote ${target}\n`);
}
