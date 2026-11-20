/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// An array under a covered name is an end. One of a shape layout 3 does
// not write (see catalog/coveredValues: another length, an element that is
// not such an integer, a nested array) names nothing: a later layout's end
// or a raw writer's array, it reads as a clearer, as an orphan end does, and
// is never shown as a value. Each shape is stored raw in a paragraph alone,
// between paired runs, inside a paired run and inside an unpaired run (its
// opener written before or after it), under a text format, a text field and
// a link; the editor that reads it as a change, a peer, fresh readers loaded
// from a JSON and a binary update, the binding's fold and Layout3's pure
// reader agree (gc off and on). Each stays an array, an end, through either
// update, and a whole-container write stores one as `{json}`, so it reads
// back as the value written.

import * as Y from '@y/y';
import {$createParagraphNode, $getRoot} from 'lexical';
import {describe, expect, test} from 'vitest';

import {isEndValue} from '../../../internal/Ident';
import {writeLayout4Formats} from '../../../migrate/3to4/frozen/layout4';
import {RESERVED_END_SHAPES} from '../../catalog/coveredValues';
import {expectConverged, freshReader, setup, shape} from '../../utils/harness';
import {
  coreRead,
  FAMILIES,
  freshReaderV2,
  lineView,
  pureRead,
  rootOf,
  SCENARIOS,
  storeBefore,
  storeOrphanEndBefore,
  transported,
} from '../../utils/rawFormats';

/** What the line shows once the clearer is stored, per family. */
const EXPECTED: Record<string, Record<string, string>> = {
  alone: {
    'f:bold': '"abcd"',
    'p:style': '"abcd"',
    'w:link': '"abcd"',
  },
  'between paired runs': {
    'f:bold': '"ab"{1} "cd" "ef"{1}',
    'p:style': '"ab"[color: red;] "cd" "ef"[color: red;]',
    'w:link': 'link<https://x.test>("ab") "cd" link<https://x.test>("ef")',
  },
  'inside a paired run': {
    'f:bold': '"abcd"{1}',
    'p:style': '"abcd"[color: red;]',
    'w:link': 'link<https://x.test>("abcd")',
  },
  // The unpaired run (a raw writer's plain value) ends at the clearer.
  'inside an unpaired run': {
    'f:bold': '"ab"{1} "cd"',
    'p:style': '"ab"[color: red;] "cd"',
    'w:link': 'link<https://x.test>("ab") "cd"',
  },
};

for (const gc of [false, true]) {
  describe(`reserved end shapes read as clearers (gc ${gc ? 'on' : 'off'})`, () => {
    test('each stays an end through a JSON update and a binary one; the wire shapes too, and [] stays an opener', () => {
      const cases: [string, () => unknown, boolean][] = [
        ...RESERVED_END_SHAPES.map(
          ([label, make]) =>
            [label, make, true] as [string, () => unknown, boolean],
        ),
        ['a distance', () => [3], true],
        ['a client and a clock', () => [1, 2], true],
        ['an empty array', () => [], false],
      ];
      for (const [label, make, end] of cases) {
        const {docs, values} = transported(gc, 'f:bold', make());
        for (const value of values) {
          expect(JSON.stringify(value), label).toBe(JSON.stringify(make()));
          expect(isEndValue(value), label).toBe(end);
        }
        // Over "a" of "ab", with nothing open: it shows nothing.
        for (const doc of docs) {
          expect(pureRead(doc.get('c')), label).toEqual([{}, {}]);
          expect(coreRead(doc.get('c')), label).toEqual([{}, {}]);
        }
      }
    });

    test('a whole-container write stores each as {json}, so it reads back as the value written', () => {
      for (const [label, make] of RESERVED_END_SHAPES) {
        const doc = new Y.Doc({gc});
        doc.cleanupFormatting = false;
        doc.clientID = 7;
        const root = doc.get('c');
        root.insert(0, 'ab');
        const value = make();
        doc.transact(tr =>
          writeLayout4Formats(tr, root, [
            new Map([['p:meta', value]]),
            new Map(),
          ]),
        );
        const expected = [{'p:meta': {json: JSON.stringify(value)}}, {}];
        expect(pureRead(root), label).toEqual(expected);
        expect(coreRead(root), label).toEqual(expected);
      }
    });

    for (const scenario of SCENARIOS) {
      for (const family of FAMILIES) {
        test(`${scenario.name}, under ${family.key}`, async () => {
          const expected = EXPECTED[scenario.name][family.key];
          const $init = () =>
            $getRoot().append(
              $createParagraphNode().append(...scenario.$line(family)),
            );
          // The control: an orphan end there reads so.
          {
            const t = await setup($init, {gc});
            if (scenario.before) {
              scenario.before(t.a, family);
            }
            storeOrphanEndBefore(t.a, scenario.at, family.key);
            await t.sync();
            expect(lineView(t.a)).toBe(expected);
            await expectConverged(t.peers);
          }
          for (const [label, make] of RESERVED_END_SHAPES) {
            for (const order of ['run first', 'reserved first'] as const) {
              if (order === 'reserved first' && !scenario.before) {
                continue;
              }
              const t = await setup($init, {gc});
              // A reads each item as a change (the incremental read); the
              // unpaired run's opener comes before or after the reserved
              // value, so A re-reads the line either way.
              if (order === 'run first' && scenario.before) {
                scenario.before(t.a, family);
              }
              const item = storeBefore(t.a, scenario.at, family.key, make());
              if (order === 'reserved first' && scenario.before) {
                scenario.before(t.a, family);
              }
              await t.sync();
              const what = `${label} (${order})`;
              const fresh = await freshReader(t.a);
              const binary = await freshReaderV2(t.a);
              for (const peer of [t.a, t.b, fresh, binary]) {
                expect(lineView(peer), what).toBe(expected);
                expect(shape(peer), what).toEqual(shape(t.a));
                // Layout3's pure reader reads as the binding's fold.
                expect(pureRead(rootOf(peer)), what).toEqual(
                  coreRead(rootOf(peer)),
                );
              }
              // The item is still there, as stored.
              expect(item.deleted, what).toBe(false);
              await expectConverged([...t.peers, fresh, binary]);
            }
          }
        });
      }
    }
  });
}
