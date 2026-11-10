/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Only an array is an end. Every value that is not an array is a value
// under a covered name, also one shaped like an array (see
// catalog/coveredValues: an object keyed by array indices, a typed array, a
// typed array with other properties): it stays a value through a JSON and a
// binary update (a binary update keeps a typed array's bytes, not its other
// properties), a whole-container write stores it as its JSON, not as
// `{json}`, and it reads as a value as layout 2 read it: stored raw in a
// paragraph alone, between paired runs, inside a paired run and inside an
// unpaired run, under a text format, a text field and a link, it is the
// key's value from where it stands, in the editor that reads it as a change,
// a peer, fresh readers loaded from a JSON and a binary update, the
// binding's fold and Layout3's pure reader (gc off and on).

import * as Y from '@y/y';
import {$createParagraphNode, $getRoot} from 'lexical';
import {describe, expect, test} from 'vitest';

import {isEndValue} from '../../../internal/Ident';
import {writeLayout3Formats} from '../../../internal/Layout3';
import {ARRAY_SHAPED_VALUES} from '../../catalog/coveredValues';
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
  transported,
} from '../../utils/rawFormats';

/**
 * What the line shows once the value is stored, per family: no format bit
 * (only `true` sets one), no style and a link with no fields (none of the
 * value's keys is one the class declares), over the text from the value on,
 * up to the next item of its key.
 */
const EXPECTED: Record<string, Record<string, string>> = {
  alone: {
    'f:bold': '"abcd"',
    'p:style': '"abcd"',
    'w:link': '"ab" link<>("cd")',
  },
  'between paired runs': {
    'f:bold': '"ab"{1} "cd" "ef"{1}',
    'p:style': '"ab"[color: red;] "cd" "ef"[color: red;]',
    'w:link':
      'link<https://x.test>("ab") "c" link<>("d") link<https://x.test>("ef")',
  },
  // A value above the paired run hides it.
  'inside a paired run': {
    'f:bold': '"ab"{1} "cd"',
    'p:style': '"ab"[color: red;] "cd"',
    'w:link': 'link<https://x.test>("ab") link<>("cd")',
  },
  'inside an unpaired run': {
    'f:bold': '"ab"{1} "cd"',
    'p:style': '"ab"[color: red;] "cd"',
    'w:link': 'link<https://x.test>("ab") link<>("cd")',
  },
};

/**
 * A text field's value with a string member `json` is read as that JSON
 * (the binding stores a field's object values as `{json}`): a typed array
 * with a `json` property shows its style, "v", where a JSON update keeps the
 * property, and as any other typed array where a binary update drops it.
 */
const JSON_FIELD_STYLE: Record<string, string> = {
  alone: '"ab" "cd"[v]',
  'between paired runs': '"ab"[color: red;] "c" "d"[v] "ef"[color: red;]',
  'inside a paired run': '"ab"[color: red;] "cd"[v]',
  'inside an unpaired run': '"ab"[color: red;] "cd"[v]',
};

for (const gc of [false, true]) {
  describe(`objects shaped like arrays read as values (gc ${gc ? 'on' : 'off'})`, () => {
    test('each stays a value through a JSON update and a binary one, and shows where it stands', () => {
      for (const [label, make] of ARRAY_SHAPED_VALUES) {
        const {docs, values} = transported(gc, 'p:meta', make());
        docs.forEach((doc, i) => {
          const value = values[i];
          expect(isEndValue(value), label).toBe(false);
          // Over "a" of "ab": the value as this document holds it.
          const expected = [{'p:meta': value}, {}];
          expect(pureRead(doc.get('c')), label).toEqual(expected);
          expect(coreRead(doc.get('c')), label).toEqual(expected);
        });
        // A JSON update keeps it whole; a binary one keeps a typed array's
        // bytes only.
        expect(JSON.stringify(values[1]), label).toBe(JSON.stringify(make()));
      }
    });

    test('a whole-container write stores each as its JSON, so it reads back as that value', () => {
      for (const [label, make] of ARRAY_SHAPED_VALUES) {
        const doc = new Y.Doc({gc});
        doc.cleanupFormatting = false;
        doc.clientID = 7;
        const root = doc.get('c');
        root.insert(0, 'ab');
        const value = make();
        doc.transact(tr =>
          writeLayout3Formats(tr, root, [
            new Map([['p:meta', value]]),
            new Map(),
          ]),
        );
        const expected = [{'p:meta': JSON.parse(JSON.stringify(value))}, {}];
        expect(pureRead(root), label).toEqual(expected);
        expect(coreRead(root), label).toEqual(expected);
      }
    });

    for (const scenario of SCENARIOS) {
      for (const family of FAMILIES) {
        test(`${scenario.name}, under ${family.key}`, async () => {
          const $init = () =>
            $getRoot().append(
              $createParagraphNode().append(...scenario.$line(family)),
            );
          for (const [label, make] of ARRAY_SHAPED_VALUES) {
            const jsonField = label === 'a typed array with a json field';
            for (const order of ['run first', 'value first'] as const) {
              if (order === 'value first' && !scenario.before) {
                continue;
              }
              const t = await setup($init, {gc});
              if (order === 'run first' && scenario.before) {
                scenario.before(t.a, family);
              }
              const item = storeBefore(t.a, scenario.at, family.key, make());
              if (order === 'value first' && scenario.before) {
                scenario.before(t.a, family);
              }
              await t.sync();
              const what = `${label} (${order})`;
              const general = EXPECTED[scenario.name][family.key];
              const expected =
                jsonField && family.key === 'p:style'
                  ? JSON_FIELD_STYLE[scenario.name]
                  : general;
              const fresh = await freshReader(t.a);
              const binary = await freshReaderV2(t.a);
              for (const peer of [t.a, t.b, fresh]) {
                expect(lineView(peer), what).toBe(expected);
                expect(shape(peer), what).toEqual(shape(t.a));
              }
              expect(lineView(binary), what).toBe(
                jsonField ? general : expected,
              );
              // The value is the key's value where it stands, in every
              // reader, as its document holds it.
              const unit = 'abcdef'.indexOf(scenario.at);
              for (const peer of [t.a, t.b, fresh, binary]) {
                const root = rootOf(peer);
                const read = pureRead(root);
                expect(read, what).toEqual(coreRead(root));
                const held = peer.doc.store.getItem(item.id) as Y.Item;
                expect(held.deleted, what).toBe(false);
                expect(
                  JSON.stringify(read[unit][family.key]),
                  `${what}: shown at "${scenario.at}"`,
                ).toBe(JSON.stringify((held.content as Y.ContentFormat).value));
              }
              await expectConverged(t.peers);
            }
          }
        });
      }
    }
  });
}
