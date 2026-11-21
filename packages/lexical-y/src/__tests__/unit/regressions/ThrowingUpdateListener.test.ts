/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$getRoot, type LexicalEditor} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $p,
  $selectIn,
  expectConverged,
  setup,
} from '../../utils/harness';

// #9514: a throwing application listener registered before the binding must
// not prevent the binding from writing an already committed delete.
describe.each(['reports', 'rethrows'] as const)(
  'a throwing update listener, onError %s',
  mode => {
    test('the binding writes the delete and every later edit', async () => {
      let armed = false;
      const reported: Error[] = [];
      const failure = new Error('listener bug');
      const t = await setup(
        () =>
          $getRoot().append(
            $p('t1z t2z t3z t4z t5z t6z t7z t8z t9z'),
            $p('tail line'),
          ),
        {
          prepare: (editor: LexicalEditor) => {
            editor._onError = error => {
              reported.push(error);
              if (mode === 'rethrows') {
                throw error;
              }
            };
            editor.registerUpdateListener(() => {
              if (armed) {
                armed = false;
                throw failure;
              }
            });
          },
        },
      );
      armed = true;
      expect(() =>
        t.a.update(() => {
          const at = $block([0]).getTextContent().indexOf('t2z');
          $selectIn([0], at, at + 3).removeText();
        }),
      ).toThrow(failure);
      t.a.update(() => void $selectIn([1], 9).insertText('!'));
      await t.sync();
      await expectConverged(
        t.peers,
        'paragraph("t1z  t3z t4z t5z t6z t7z t8z t9z") / paragraph("tail line!")',
      );
      expect(reported).toEqual([]);
    });
  },
);
