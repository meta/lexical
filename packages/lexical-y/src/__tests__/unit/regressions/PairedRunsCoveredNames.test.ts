/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The covered names are the frozen list: `f:*`, `w:*`, `t`, `k`, `p:*` and,
// from layout 4 on (D120), every `s:*` name, a flat NodeState value as well
// as a member entry (layout 3 covered only `s:` names holding U+001F). Any
// other name, a raw writer's own key (`foreign`), keeps the plain fold.

import {$getRoot, $setSelection} from 'lexical';
import {expect, test} from 'vitest';

import {covered} from '../../../internal/Ident';
import {
  $p,
  $selectIn,
  expectConverged,
  freshReader,
  setup,
} from '../../utils/harness';

test('covered names are the frozen list', () => {
  for (const key of [
    'f:bold',
    'w:link',
    't',
    'k',
    'p:style',
    's:markIds\u001fc1',
    's:odd\u001fset',
    's:markIds',
    's:anchor:ns:1',
    's:',
  ]) {
    expect([key, covered(key)]).toEqual([key, true]);
  }
  for (const key of [
    'foreign',
    's',
    'sx',
    'm:c1',
    'tt',
    'kk',
    'b:x',
    'f',
    'x:y',
    '',
  ]) {
    expect([key, covered(key)]).toEqual([key, false]);
  }
});

for (const gc of [false, true]) {
  test(`a raw writer's own key keeps the plain fold (gc ${gc ? 'on' : 'off'})`, async () => {
    const t = await setup(() => $getRoot().append($p('abc')), {gc});
    t.a.update(() => {
      $selectIn([0], 2, 3).formatText('bold');
      $setSelection(null);
    });
    await t.sync();
    const root = t.a.doc.get('lexical-y');
    expect(root.getAttr('lexical-y:5')).toBe(true);
    // An array on a name the list does not cover is a plain value: stored
    // as written, and the null after "a" ends it.
    t.a.doc.transact(() => root.format(0, 1, {foreign: [1]}), 'raw');
    await t.sync();
    const delta = JSON.parse(JSON.stringify(root.toDelta())) as {
      children: {insert: unknown; format?: Record<string, unknown>}[];
    };
    expect(delta.children[0].format).toEqual({foreign: [1]});
    expect(delta.children[1].format?.foreign).toBeUndefined();
    await expectConverged([...t.peers, await freshReader(t.a)]);
  });
}
