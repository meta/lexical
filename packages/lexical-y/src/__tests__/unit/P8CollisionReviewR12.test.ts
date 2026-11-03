/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// GPT layout 3 review round 12's cells (P8 dormant runs; the text format
// rule of main's #9768).
import {$getRoot} from 'lexical';
import {expect, test} from 'vitest';

import {$p, freshReader, setup} from '../utils/harness';

for (const gc of [false, true])
  test(`R12 raw format key cannot corrupt dormant stacks gc=${gc}`, async () => {
    const t = await setup(() => $getRoot().append($p('abc')), {gc});
    const root = t.a.binding.root;
    let failed: unknown;
    try {
      t.a.doc.transact(() => {
        root.format(0, 3, {'\u0002\u0000': true});
        root.format(0, 1, {'f:bold': true});
      }, 'raw');
    } catch (e) {
      failed = e;
    }
    const fresh = await freshReader(t.a);
    expect(failed).toBeUndefined();
    expect(t.a.binding.status).toBe('active');
    expect(t.a.read(() => $getRoot().getTextContent())).toBe('abc');
    expect(fresh.binding.status).toBe('active');
    expect(fresh.describe()).toBe(t.a.describe());
  });
