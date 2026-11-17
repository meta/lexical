/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// One canonical setup, identical everywhere an app or an agent copies it
// from (layout 4 spec 11.8): the yCollab({...}) call in the package README,
// in y.md and in the playground.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {expect, test} from 'vitest';

const REPO = path.resolve(__dirname, '../../../../..');

/** The `yCollab({...})` call in `file`, its lines unindented. */
function canonicalCall(file: string): string {
  const text = fs.readFileSync(path.join(REPO, file), 'utf8');
  const start = text.indexOf('yCollab({\n');
  expect(start, `${file} has the canonical yCollab({...}) call`).not.toBe(-1);
  const end = text.indexOf('}),', start);
  return text
    .slice(start, end + 3)
    .split('\n')
    .map(line => line.trim())
    .join('\n');
}

test('the README, y.md and the playground share one canonical setup', () => {
  const readme = canonicalCall('packages/lexical-y/README.md');
  expect(readme).toContain('synced: false');
  expect(readme).toContain('onStatus: status => showStatus(status)');
  expect(
    canonicalCall('packages/lexical-website/docs/collaboration/y.md'),
  ).toBe(readme);
  expect(
    canonicalCall('packages/lexical-playground/src/collaborationY.tsx'),
  ).toBe(readme);
});
