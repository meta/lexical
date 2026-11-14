/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A layout 2 document whose covered names hold objects keyed by array
// indices: a raw writer's `{"0": 3}` on a text field and on a text format,
// and the `{"0": 3}` a wrapper whose class declares a field named `0`
// stores. The 2to3 step migrates it, and the live reader (Layout3's pure
// reader, the binding's fold and an editor) reads the same value per unit as
// the frozen layout 2 read did: only an array is an end, in the frozen
// writer and in the live module alike, which also write the same bytes for
// it (gc off and on).

import * as Y from '@y/y';
import {$getRoot, type ElementNode} from 'lexical';
import {describe, expect, test} from 'vitest';

import {readYState} from '../../headless';
import {createRawYDoc} from '../../internal/RawYDoc';
import {getYLayoutInfo, migrateYState} from '../../migrate';
import step1to2 from '../../migrate/1to2';
import step2to3 from '../../migrate/2to3';
import {foldLayout2Units} from '../../migrate/2to3/frozen/fold2';
import step3to4 from '../../migrate/3to4';
import step4to5 from '../../migrate/4to5';
import {NumericFieldWrapperNode} from '../catalog/coveredValues';
import {NODES} from '../utils/harness';
import {layout3Problems} from '../utils/migrate2to3';
import {coreRead, pureRead} from '../utils/rawFormats';

/** The layout `doc`'s root records (see getYLayoutInfo), or null. */
const recordedLayout = (doc: Y.Doc, root = 'lexical-y'): number | null => {
  const info = getYLayoutInfo(doc, root);
  return 'layout' in info ? info.layout : null;
};

const STEPS = [step1to2, step2to3];
const CONFIG = {
  nodes: [...NODES, NumericFieldWrapperNode],
  onWarn: () => {},
  schemaVersion: 1,
};
const TEXT = 'before abc after';

/**
 * A layout 2 document as the release before layout 3 stored one: plain
 * format values, each run closed by null, and a line marker.
 */
function layout2Document(): Uint8Array {
  const doc = new Y.Doc({gc: false});
  doc.cleanupFormatting = false;
  doc.clientID = 4242;
  const root = doc.get('lexical-y');
  doc.transact(() => {
    root.setAttr('lexical-y:1', true);
    root.setAttr('lexical-y:2', true);
    root.setAttr('lexical-y-schema:1', true);
    root.setAttr('k:paragraph', 'line');
    root.setAttr('k:numeric_field_wrapper', 'format|0');
    root.insert(0, TEXT);
    root.insert(TEXT.length, [new Y.Node('¶')]);
  });
  doc.transact(() => {
    root.format(0, 6, {'p:meta': {0: 3}});
    root.format(7, 3, {'w:numeric_field_wrapper': {0: 3}});
    root.format(11, 5, {'f:bold': {0: 3, 1: 4}});
  });
  return Y.encodeStateAsUpdate(doc);
}

/** Per countable unit, {key: value} as JSON. */
const asJSON = (units: readonly Record<string, unknown>[]) =>
  units.map(u => JSON.stringify(u));

describe('a layout 2 document holding objects keyed by array indices', () => {
  const input = layout2Document();
  const before = asJSON(
    foldLayout2Units(createRawYDoc(input).get('lexical-y')).map(m =>
      Object.fromEntries(m),
    ),
  );

  test('the frozen layout 2 read holds each object', () => {
    expect(recordedLayout(createRawYDoc(input))).toBe(2);
    expect(before[0]).toBe('{"p:meta":{"0":3}}');
    expect(before[7]).toBe('{"w:numeric_field_wrapper":{"0":3}}');
    expect(before[11]).toBe('{"f:bold":{"0":3,"1":4}}');
    expect(before[6]).toBe('{}');
  });

  for (const gc of [false, true]) {
    test(`migrates with 2to3 and reads as the same values on the live reader (gc ${gc ? 'on' : 'off'})`, () => {
      const {state} = migrateYState(input, STEPS, {gc, to: 3});
      expect(recordedLayout(createRawYDoc(state, {gc}))).toBe(3);
      expect(layout3Problems(state, gc)).toEqual([]);
      const root = createRawYDoc(state, {gc}).get('lexical-y');
      expect(asJSON(pureRead(root))).toEqual(before);
      expect(asJSON(coreRead(root))).toEqual(before);
      // An editor reads the wrapper with its field (after 3to4: layout 3
      // is below this release's floor, and a headless read refuses it).
      const four = migrateYState(state, [step3to4, step4to5], {gc}).state;
      const read = readYState(four, CONFIG, () => {
        const paragraph = $getRoot().getFirstChildOrThrow() as ElementNode;
        const wrapper = paragraph
          .getChildren()
          .find(n => n instanceof NumericFieldWrapperNode);
        return {
          text: paragraph.getTextContent(),
          wrapped:
            wrapper instanceof NumericFieldWrapperNode
              ? wrapper.getTextContent()
              : null,
          zero:
            wrapper instanceof NumericFieldWrapperNode
              ? wrapper.getLatest().__zero
              : null,
        };
      });
      expect(read).toEqual({text: TEXT, wrapped: 'abc', zero: 3});
    });
  }
});
