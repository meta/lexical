/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// getYLayoutInfo (API review S1) replaces recordedLayout and layoutEpoch: a
// fixed status union (ready, missing, invalid, unsupported) with the
// layout, the epoch and the raw details; never NaN, and an absent epoch is
// told apart from a malformed one.

import type * as Y from '@y/y';

import {describe, expect, test} from 'vitest';

import {createYDoc, LAYOUT_VERSION, MIN_LAYOUT} from '../../..';
import {getYLayoutInfo, migrateYState} from '../../../migrate';
import {rawDoc, SEED, stamp} from '../../utils/migrateSteps';

const hasNaN = (value: unknown): boolean =>
  JSON.stringify(value, (_k, v) =>
    typeof v === 'number' && Number.isNaN(v) ? '__NaN__' : v,
  ).includes('__NaN__');

describe.each([false, true])('getYLayoutInfo, gc %s', gc => {
  const docWith = (attrs: Record<string, unknown>, base = rawDoc(SEED)) => {
    const doc = createYDoc(base, {gc});
    for (const [k, v] of Object.entries(attrs)) {
      doc.get('lexical-y').setAttr(k, v as never);
    }
    return doc;
  };

  test('every status, with its details and no NaN', () => {
    const cases: [string, Y.Doc, string | null, unknown][] = [
      [
        'absent root',
        createYDoc(null, {gc}),
        null,
        {empty: true, status: 'missing'},
      ],
      [
        'seeded',
        docWith({}),
        null,
        {epoch: null, layout: SEED, status: 'ready'},
      ],
      [
        'a malformed record',
        docWith({'lexical-y:x': true}),
        null,
        {found: true, key: 'lexical-y:x', status: 'invalid'},
      ],
      [
        'a malformed epoch',
        docWith({'lexical-y-epoch': 'broken'}),
        null,
        {found: 'broken', key: 'lexical-y-epoch', status: 'invalid'},
      ],
      [
        'a malformed requirement',
        docWith({'lexical-y-require:a': 1}),
        null,
        {found: 1, key: 'lexical-y-require:a', status: 'invalid'},
      ],
      [
        'an unknown requirement',
        docWith({'lexical-y-require:acme.x': true}),
        null,
        {
          epoch: null,
          features: ['acme.x'],
          layout: SEED,
          min: MIN_LAYOUT,
          reason: 'requires',
          status: 'unsupported',
          supported: LAYOUT_VERSION,
        },
      ],
      [
        'a newer layout',
        docWith({[`lexical-y:${LAYOUT_VERSION + 1}`]: true}),
        null,
        {
          features: [],
          layout: LAYOUT_VERSION + 1,
          reason: 'newer',
          status: 'unsupported',
        },
      ],
      [
        'another root, absent',
        docWith({}),
        'other',
        {empty: true, root: 'other', status: 'missing'},
      ],
    ];
    for (const [name, doc, root, expected] of cases) {
      const info =
        root === null ? getYLayoutInfo(doc) : getYLayoutInfo(doc, root);
      expect({name, ...info}).toMatchObject({name, ...(expected as object)});
      expect(hasNaN(info)).toBe(false);
    }
  });

  test('content without a record is missing and not empty; an empty root is missing and empty; reading creates no root', () => {
    const doc = createYDoc(null, {gc});
    expect(getYLayoutInfo(doc)).toEqual({
      empty: true,
      root: 'lexical-y',
      status: 'missing',
    });
    expect(doc.share.has('lexical-y')).toBe(false);
    const withContent = createYDoc(null, {gc});
    withContent.get('lexical-y').insert(0, ['x'] as never);
    expect(getYLayoutInfo(withContent)).toMatchObject({
      empty: false,
      status: 'missing',
    });
  });

  test('after a migration: ready, with the epoch it recorded', () => {
    const {state} = migrateYState(rawDoc(SEED), [stamp(SEED)], {
      gc,
      to: SEED + 1,
    });
    const info = getYLayoutInfo(createYDoc(state, {gc}));
    if (SEED + 1 <= LAYOUT_VERSION) {
      expect(info).toMatchObject({
        epoch: {kind: 'layout', layout: SEED + 1, v: 1},
        layout: SEED + 1,
        status: 'ready',
      });
    } else {
      expect(info).toMatchObject({
        epoch: {layout: SEED + 1},
        reason: 'newer',
        status: 'unsupported',
      });
    }
  });
});
