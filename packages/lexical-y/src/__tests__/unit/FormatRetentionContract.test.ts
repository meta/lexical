/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The text class contract (DECISIONS D106): a class may keep format bits by
// its serialized fields or its NodeState (here a mask in a field, a NodeState
// value and a flat NodeState value). Stored formats over a text node of each
// class read as the bits its mask keeps, on every peer and in a fresh read,
// as on main (3 classes × 4 masks, gc off and on).

import {
  $create,
  $createParagraphNode,
  $getRoot,
  $getState,
  $setState,
  createState,
  nodeSchema,
  numberValue,
  TEXT_TYPE_TO_FORMAT,
  type TextFormatType,
  TextNode,
  withAccessors,
} from 'lexical';
import {expect, test} from 'vitest';

import {freshReader, NODES, setup} from '../utils/harness';

const bits = (v: TextFormatType | number) =>
  typeof v === 'number' ? v : TEXT_TYPE_TO_FORMAT[v];
const fieldSchema = nodeSchema<FieldMask>()({
  retain: withAccessors(numberValue(3), {
    getter: {field: '__retain'},
    setter: 'setRetain',
  }),
});
class FieldMask extends TextNode {
  __retain = 3;
  $config() {
    return this.config('test-field-mask', {
      extends: TextNode,
      json: fieldSchema,
    });
  }
  setRetain(mask: number): this {
    this.getWritable().__retain = mask;
    return this.setFormat(this.getFormat());
  }
  setFormat(v: TextFormatType | number): this {
    return super.setFormat(bits(v) & this.getLatest().__retain);
  }
}
const maskState = createState('retainMask', {
  parse: (v: unknown) => (typeof v === 'number' ? v : 3),
});
class StateMask extends TextNode {
  $config() {
    return this.config('test-state-mask', {
      extends: TextNode,
      stateConfigs: [maskState],
    });
  }
  setFormat(v: TextFormatType | number): this {
    return super.setFormat(bits(v) & $getState(this, maskState));
  }
}
class FlatStateMask extends StateMask {
  $config() {
    return this.config('test-flat-state-mask', {
      extends: StateMask,
      stateConfigs: [{flat: true, stateConfig: maskState}],
    });
  }
}
const text = 'abcdefghijklmnop';
// Includes repeated stored values and unequal stored values showing alike.
const stored = [0, 1, 3, 2, 0, 1, 3, 2, 2, 3, 1, 0, 0, 1, 3, 2];

for (const gc of [false, true]) {
  for (const klass of [FieldMask, StateMask, FlatStateMask]) {
    for (const mask of [0, 1, 2, 3]) {
      test(`${klass.name} shows the bits its mask keeps (mask ${mask}, gc ${gc})`, async () => {
        let node: TextNode;
        const t = await setup(
          () => {
            if (klass === FieldMask) {
              node = $create(FieldMask).setTextContent(text).setRetain(mask);
            } else {
              node = $create(klass as typeof StateMask).setTextContent(text);
              $setState(node, maskState, mask);
            }
            $getRoot().append($createParagraphNode().append(node));
          },
          {gc, nodes: [...NODES, FieldMask, StateMask, FlatStateMask]},
        );
        const root = t.a.doc.get('lexical-y');
        const flat = root
          .toDelta()
          .children.map(p => {
            const insert = (p as {insert?: unknown}).insert;
            return typeof insert === 'string' ? insert : '\u0001';
          })
          .join('');
        const at = flat.indexOf(text);
        expect(at).toBeGreaterThanOrEqual(0);
        t.a.doc.transact(() => {
          stored.forEach((f, i) =>
            root.format(at + i, 1, {
              'f:bold': f & 1 ? true : null,
              'f:italic': f & 2 ? true : null,
            }),
          );
        }, 'outside');
        await t.sync();
        const fresh = await freshReader(t.b);
        for (const peer of [t.a, t.b, fresh]) {
          const chars = peer.read(() =>
            $getRoot()
              .getAllTextNodes()
              .flatMap(n =>
                [...n.getTextContent()].map(c => [c, n.getFormat()]),
              ),
          );
          expect(chars).toEqual([...text].map((c, i) => [c, stored[i] & mask]));
        }
        expect(fresh.describe()).toBe(t.b.describe());
        expect(t.b.warnings.filter(w => /self-check/.test(w))).toEqual([]);
      });
    }
  }
}
