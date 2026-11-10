/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Stored keys in the fold's U+0002 namespace
// are never read; text and convergence agree with main.
import * as Y from '@y/y';
import {$getRoot, $getState, $setState, createState} from 'lexical';
import {expect, test} from 'vitest';

import {$p, freshReader, setup} from '../utils/harness';

const state = createState('\u0002\u0000user', {
  parse: v => (typeof v === 'string' ? v : ''),
});
for (const gc of [false, true]) {
  test(`NodeState U+0002 keys retain their wire prefix gc=${gc}`, async () => {
    const t = await setup(
      () => {
        const p = $p('abc');
        $setState(p.getFirstChild()!, state, 'kept');
        $getRoot().append(p);
      },
      {gc},
    );
    const keys: string[] = [];
    for (let it = t.a.binding.root._start; it; it = it.right)
      if (!it.deleted && it.content instanceof Y.ContentFormat)
        keys.push(it.content.key);
    expect(keys.some(k => k.charCodeAt(0) === 2)).toBe(false);
    expect(keys).toContain('s:\u0002\u0000user');
    const fresh = await freshReader(t.a);
    expect(
      fresh.read(() => $getState($getRoot().getAllTextNodes()[0], state)),
    ).toBe('kept');
    t.a.update(() =>
      $setState($getRoot().getAllTextNodes()[0], state, 'changed'),
    );
    await t.sync();
    expect(
      t.b.read(() => $getState($getRoot().getAllTextNodes()[0], state)),
    ).toBe('changed');
  });
  test(`raw U+0002 format keys remain stored but are not user formats gc=${gc}`, async () => {
    const t = await setup(() => $getRoot().append($p('abc')), {gc});
    t.a.doc.transact(
      () => t.a.binding.root.format(0, 1, {'\u0002raw': 'v'}),
      'raw',
    );
    await t.sync();
    let stored = false;
    for (let it = t.a.binding.root._start; it; it = it.right)
      if (
        !it.deleted &&
        it.content instanceof Y.ContentFormat &&
        it.content.key === '\u0002raw' &&
        it.content.value === 'v'
      )
        stored = true;
    expect(stored).toBe(true);
    expect(t.a.read(() => $getRoot().getTextContent())).toBe('abc');
    t.a.update(() => {
      $getRoot().getAllTextNodes()[0].select(1, 1).insertText('X');
    });
    await t.sync();
    expect(t.a.describe()).toBe(t.b.describe());
    expect((await freshReader(t.a)).describe()).toBe(t.a.describe());
  });
}
