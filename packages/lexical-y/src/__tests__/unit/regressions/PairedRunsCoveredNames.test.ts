/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The covered names are the frozen list (design section 4): `f:*`, `w:*`,
// `t`, `k`, `p:*` and `s:` names holding U+001F. Coverage was every name
// but a flat `s:` one, so a raw writer's own key (`foreign`) read as paired
// runs in a layout 3 document.

import {$getRoot, $setSelection} from 'lexical';
import {afterEach, expect, test} from 'vitest';

import {covered} from '../../../internal/Ident';
import {
  $p,
  $selectIn,
  expectConverged,
  freshReader,
  setup,
} from '../../utils/harness';
import {setFormatIdentityWritesDefault} from '../../utils/noSwitch';

afterEach(() => {
  setFormatIdentityWritesDefault(false);
});

test('covered names are the frozen list', () => {
  for (const key of [
    'f:bold',
    'w:link',
    't',
    'k',
    'p:style',
    's:markIds\u001fc1',
    's:odd\u001fset',
  ]) {
    expect([key, covered(key)]).toEqual([key, true]);
  }
  for (const key of [
    'foreign',
    's:markIds',
    's:anchor:ns:1',
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
  test(`a raw writer's own key in a layout 3 document keeps the plain fold (gc ${gc ? 'on' : 'off'})`, async () => {
    setFormatIdentityWritesDefault(true);
    const t = await setup(() => $getRoot().append($p('abc')), {gc});
    t.a.update(() => {
      $selectIn([0], 2, 3).formatText('bold');
      $setSelection(null);
    });
    await t.sync();
    const root = t.a.doc.get('lexical-y');
    expect(root.getAttr('lexical-y:3')).toBe(true);
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
