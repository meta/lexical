/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import copy from 'rollup-plugin-copy';

function parseImportMapImportEntries() {
  const m = /<script type="importmap">([\s\S]+?)<\/script>/g.exec(
    fs.readFileSync('./esm/index.html', 'utf8'),
  );
  if (!m) {
    throw new Error('Could not parse importmap from esm/index.html');
  }
  return Object.entries<string>(JSON.parse(m[1]).imports);
}

export default function viteCopyEsm() {
  return copy({
    hook: 'writeBundle',
    targets: [
      {dest: './build/esm/', src: './esm/*'},
      {dest: './build/', src: ['./*.png', './*.ico']},
      ...parseImportMapImportEntries().map(([mod, fn]) => ({
        dest: './build/esm/dist/',
        // The importmap points directly at each package's `.dev` bundle
        // (e.g. `./dist/Lexical.dev.js`) rather than the fork module, so we
        // copy exactly that self-contained file. The bundles only import bare
        // specifiers, which the importmap resolves to their sibling bundles.
        src: path.join(`../${mod.replace(/^@/, '').replace(/\//g, '-')}`, fn),
      })),
    ],
    verbose: true,
  });
}
