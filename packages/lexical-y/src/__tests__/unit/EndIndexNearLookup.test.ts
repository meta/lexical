/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The end index's near lookup (a short scan left of an end before the
// per-document index) agrees with structural validity: with 0 to 25 items
// between them, an end that names its opener is valid and indexed, and an
// end naming an opener of another key, one after it, one that is itself an
// end, or one that is deleted is not (7 distances × 5 shapes, gc off and on).

import * as Y from '@y/y';
import {expect, test} from 'vitest';

import {createYDoc} from '../..';
import {endsOf, isValidEnd, STORED_FOLD} from '../../internal/Ident';

for (const gc of [false, true]) {
  test(`the near end lookup agrees with structural validity (gc ${gc})`, () => {
    for (const n of [0, 1, 14, 15, 16, 17, 25]) {
      for (const mode of [
        'valid',
        'wrong key',
        'before target',
        'end target',
        'deleted target',
      ] as const) {
        const d = createYDoc(null, {gc});
        d.clientID = 17;
        const r = d.get('c');
        r.setAttr('lexical-y:3', true);
        let open: Y.Item | undefined;
        let end: Y.Item | undefined;
        d.transact(tr => {
          let left: Y.Item | null = null;
          const append = (key: string, value: unknown) => {
            const it: Y.Item = new Y.Item(
              Y.createID(17, d.store.getClock(17)),
              left,
              left && left.lastId,
              null,
              null,
              r,
              null,
              new Y.ContentFormat(key, value as object),
            );
            it.integrate(tr, 0);
            left = it;
            return it;
          };
          if (mode === 'before target') {
            const clock = d.store.getClock(17);
            end = append('f:bold', [17, clock + n + 1]);
            for (let i = 0; i < n; i++) {
              append('s:flat' + i, true);
            }
            open = append('f:bold', true);
          } else {
            open = append(
              mode === 'wrong key' ? 'f:italic' : 'f:bold',
              mode === 'end target' ? [9999] : true,
            );
            for (let i = 0; i < n; i++) {
              append('s:flat' + i, true);
            }
            end = append('f:bold', [17, open.id.clock]);
            if (mode === 'deleted target') {
              open.delete(tr);
            }
          }
        });
        expect(isValidEnd(end!, STORED_FOLD)).toBe(mode === 'valid');
        if (mode === 'valid') {
          expect(endsOf(open!)).toContain(end);
        }
        d.destroy();
      }
    }
  });
}
