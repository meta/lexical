/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Other shared types in the same document.
// @vitest-environment node
import {$getRoot, createEditor} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YBinding} from '../..';
import {$p, NODES} from '../utils/harness';

const mk = (warnings: string[] = []) =>
  createEditor({
    namespace: 'x',
    nodes: NODES,
    onError: e => {
      throw e;
    },
    onWarn: e => warnings.push(e.message),
  });

describe('other roots in the same doc', () => {
  test('app metadata root written before initialize', () => {
    const doc = createYDoc();
    doc.get('meta').setAttr('title', 'My doc');
    const warnings: string[] = [];
    const ed = mk(warnings);
    ed.update(() => $getRoot().clear().append($p('hello')), {discrete: true});
    const b = new YBinding(ed, doc, {schemaVersion: 1, selfCheck: true});
    b.start();
    b.initialize();
    expect(b.status).toBe('active');
    expect(warnings).toEqual([]);
  });
  test('two bindings on two roots of one doc (main editor + a second editor)', () => {
    const doc = createYDoc();
    const e1 = mk();
    e1.update(() => $getRoot().clear().append($p('main')), {discrete: true});
    const b1 = new YBinding(e1, doc, {
      root: doc.get('main'),
      schemaVersion: 1,
      selfCheck: true,
    });
    b1.start();
    b1.initialize();
    const warnings: string[] = [];
    const e2 = mk(warnings);
    e2.update(() => $getRoot().clear().append($p('caption')), {discrete: true});
    const b2 = new YBinding(e2, doc, {
      root: doc.get('caption-1'),
      schemaVersion: 1,
      selfCheck: true,
    });
    b2.start();
    b2.initialize();
    expect(b2.status).toBe('active');
    expect(warnings).toEqual([]);
  });
});
