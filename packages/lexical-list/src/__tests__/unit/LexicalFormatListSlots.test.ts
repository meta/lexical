/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  $insertList,
  $isListNode,
  $removeList,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSlot,
  $isParagraphNode,
  $setSlot,
  type ParagraphNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

function runInEditor(fn: () => void): void {
  using editor = buildEditorFromExtensions({
    name: '@formatList-slots-test',
    nodes: [ListNode, ListItemNode],
  });
  editor.update(fn, {discrete: true});
}

function $createHostWithSlottedList(): {
  host: ParagraphNode;
  list: ListNode;
  text: TextNode;
} {
  const host = $createParagraphNode();
  $getRoot().append(host);
  const list = $createListNode('bullet');
  const text = $createTextNode('item');
  const item = $createListItemNode().append(text);
  list.append(item);
  $setSlot(host, 'items', list);
  return {host, list, text};
}

// A named-slot value has no __parent (its up-link is __slotHost), so it is not
// eligible for generic list conversion: the slot assignment is managed by the
// node or extension that owns the slot. See the review discussion on
// facebook/lexical#8901 ($setBlocksType has the same rule).
describe('$insertList and named slots', () => {
  test('no-ops on a non-empty bare-block slot value', () => {
    runInEditor(() => {
      const host = $createParagraphNode();
      $getRoot().append(host);
      const text = $createTextNode('title text');
      const slotPara = $createParagraphNode().append(text);
      $setSlot(host, 'title', slotPara);
      text.select(0, 0);

      $insertList('bullet');

      const value = $getSlot(host, 'title');
      expect(value).not.toBe(null);
      expect(value!.is(slotPara)).toBe(true);
      expect($isParagraphNode(value)).toBe(true);
    });
  });

  test('no-ops on an empty bare-block slot value', () => {
    runInEditor(() => {
      const host = $createParagraphNode();
      $getRoot().append(host);
      const slotPara = $createParagraphNode();
      $setSlot(host, 'title', slotPara);
      slotPara.select();

      $insertList('bullet');

      const value = $getSlot(host, 'title');
      expect(value).not.toBe(null);
      expect(value!.is(slotPara)).toBe(true);
      expect($isParagraphNode(value)).toBe(true);
    });
  });

  test('does not change the type of a slotted list', () => {
    runInEditor(() => {
      const {host, list, text} = $createHostWithSlottedList();
      text.select(0, 0);

      $insertList('number');

      const value = $getSlot(host, 'items');
      expect(value).not.toBe(null);
      expect(value!.is(list)).toBe(true);
      expect($isListNode(value)).toBe(true);
      expect(list.getListType()).toBe('bullet');
    });
  });

  test('does not change the type of a slotted list from an empty item', () => {
    runInEditor(() => {
      const host = $createParagraphNode();
      $getRoot().append(host);
      const list = $createListNode('bullet');
      const item = $createListItemNode();
      list.append(item);
      $setSlot(host, 'items', list);
      item.select();

      $insertList('number');

      const value = $getSlot(host, 'items');
      expect(value).not.toBe(null);
      expect(value!.is(list)).toBe(true);
      expect(list.getListType()).toBe('bullet');
      expect(item.isAttached()).toBe(true);
    });
  });
});

describe('$removeList and named slots', () => {
  test('no-ops on a slotted list', () => {
    runInEditor(() => {
      const {host, list, text} = $createHostWithSlottedList();
      text.select(0, 0);

      $removeList();

      const value = $getSlot(host, 'items');
      expect(value).not.toBe(null);
      expect(value!.is(list)).toBe(true);
      expect($isListNode(value)).toBe(true);
      expect(list.getTextContent()).toBe('item');
    });
  });
});
