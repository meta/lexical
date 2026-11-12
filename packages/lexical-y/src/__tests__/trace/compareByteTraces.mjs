/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Compares two runs of the byte-identity harness (see byteTrace.setup.ts):
//
//   node compareByteTraces.mjs <before dir> <after dir> [--allow <file>]...
//
// Prints the test files traced in both runs, how many are identical in
// every hash and count, and each one that differs with the fields that do.
// Exits with 1 where any differs, or where a test file was traced in one
// run only (its worker died before it wrote the record, or the file was
// added or removed). `--allow <file>` (a path as the records hold it,
// `packages/...`) names a test file known not to be deterministic on the
// base itself, or one the change adds or removes: its difference is printed
// and not counted.
import * as fs from 'node:fs';
import * as path from 'node:path';

const print = line => process.stdout.write(line + '\n');
const dirs = [];
const allowed = new Set();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--allow') {
    allowed.add(args[++i]);
  } else {
    dirs.push(args[i]);
  }
}
if (dirs.length !== 2) {
  console.error(
    'usage: compareByteTraces.mjs <before dir> <after dir> [--allow <file>]...',
  );
  process.exit(2);
}

const load = dir =>
  new Map(
    fs
      .readdirSync(dir)
      .filter(name => name.endsWith('.json'))
      .map(name => {
        const record = JSON.parse(
          fs.readFileSync(path.join(dir, name), 'utf8'),
        );
        return [record.file, record];
      }),
  );
const [before, after] = dirs.map(load);
const files = [...new Set([...before.keys(), ...after.keys()])].sort();
const totals = {
  docs: 0,
  finalBytes: 0,
  states: 0,
  transactions: 0,
  updateBytes: 0,
  updates: 0,
  warnings: 0,
};
let both = 0;
let identical = 0;
const different = [];
const known = [];
const single = [];
const singleAllowed = [];
for (const file of files) {
  const a = before.get(file);
  const b = after.get(file);
  if (a === undefined || b === undefined) {
    (allowed.has(file) ? singleAllowed : single).push(
      `${file} (${a === undefined ? 'after' : 'before'} only)`,
    );
    continue;
  }
  both++;
  const fields = Object.keys({...a, ...b}).filter(key => a[key] !== b[key]);
  if (fields.length === 0) {
    identical++;
    for (const key of Object.keys(totals)) {
      totals[key] += a[key];
    }
  } else {
    (allowed.has(file) ? known : different).push(
      `${file}: ${fields.join(', ')}`,
    );
  }
}
print(
  `test files traced in both runs: ${both}; identical: ${identical}; different: ${different.length}; different and allowed: ${known.length}`,
);
print(`in the identical files: ${JSON.stringify(totals)}`);
for (const line of different) {
  print(`different: ${line}`);
}
for (const line of known) {
  print(`different (allowed): ${line}`);
}
for (const line of single) {
  print(`one run only: ${line}`);
}
for (const line of singleAllowed) {
  print(`one run only (allowed): ${line}`);
}
process.exit(different.length === 0 && single.length === 0 ? 0 : 1);
