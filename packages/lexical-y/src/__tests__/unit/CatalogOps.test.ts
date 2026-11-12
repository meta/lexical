/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The catalog's core ops (catalog/ops.ts) on every text of every slot
// host shape: insert-paragraph adds a paragraph after the text's top-level
// block, and does nothing for a text inside a slot value (its own
// top-level element, without a parent: a sibling would cross the slot
// boundary, which core refuses by design).

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $getRoot,
  $getSlot,
  $getSlotNames,
  $isElementNode,
  $isTextNode,
  defineExtension,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {catalogAppExtension} from '../catalog/bind';
import {$appendShapes, shapesWith} from '../catalog/nodes';
import {CORE_OPS} from '../catalog/ops';

/** Every simple text, slots included, in the order the ops walk them. */
function $simpleTexts(): TextNode[] {
  const out: TextNode[] = [];
  const walk = (node: LexicalNode) => {
    if ($isTextNode(node) && node.isSimpleText()) {
      out.push(node);
    }
    for (const name of $getSlotNames(node)) {
      const slot = $getSlot(node, name);
      if (slot !== null) {
        walk(slot);
      }
    }
    if ($isElementNode(node)) {
      node.getChildren().forEach(walk);
    }
  };
  walk($getRoot());
  return out;
}

test('insert-paragraph on every text of every slot host: no throw; a no-op inside a slot value', () => {
  const op = CORE_OPS.find(o => o.name === 'insert-paragraph')!;
  let inSlot = 0;
  let outside = 0;
  for (const shape of shapesWith('slots')) {
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [catalogAppExtension({blockIds: 'absent'})],
        name: 'catalog-ops',
        onError: e => {
          throw e;
        },
      }),
    );
    editor.update(() => $appendShapes([shape]), {discrete: true});
    const count = editor.getEditorState().read(() => $simpleTexts().length);
    for (let i = 0; i < count; i++) {
      editor.update(
        () => {
          const texts = $simpleTexts();
          const text = texts[i];
          const block = text.getTopLevelElement();
          const slotValue = block !== null && block.getParent() === null;
          const before = $getRoot().getChildrenSize();
          // A rand that picks text i.
          const ran = op.$run(() => (i + 0.5) / texts.length);
          expect(ran).toBe(!slotValue);
          if (slotValue) {
            inSlot++;
          } else {
            outside++;
            expect($getRoot().getChildrenSize()).toBeGreaterThanOrEqual(before);
          }
        },
        {discrete: true},
      );
    }
  }
  expect(inSlot).toBeGreaterThan(0);
  expect(outside).toBeGreaterThan(0);
});
