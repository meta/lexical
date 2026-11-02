/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Edits from the core packages (lexical, @lexical/table, @lexical/list,
// @lexical/rich-text, @lexical/mark), as data: each picks its target from
// the document with a seeded PRNG and does nothing where it has none. Used
// by the multi-peer contracts and the soak generators.

import {$isListNode, type ListNode} from '@lexical/list';
import {$wrapSelectionInMarkNode} from '@lexical/mark';
import {
  $deleteTableColumnAtSelection,
  $deleteTableRowAtSelection,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  $isTableCellNode,
  type TableCellNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getSlot,
  $getSlotNames,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type LexicalNode,
  type RangeSelection,
  type TextNode,
} from 'lexical';

function $getRangeSelection(): RangeSelection | null {
  const s = $getSelection();
  return $isRangeSelection(s) ? s : null;
}

export interface CoreOp {
  readonly name: string;
  /** Runs inside an update; returns false when it found no target. */
  readonly $run: (rand: () => number) => boolean;
}

function $all<T extends LexicalNode>(
  test: (node: LexicalNode) => node is T,
): T[] {
  const out: T[] = [];
  const walk = (node: LexicalNode) => {
    if (test(node)) {
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

const pick = <T>(rand: () => number, items: readonly T[]): T | undefined =>
  items.length === 0 ? undefined : items[Math.floor(rand() * items.length)];

const isSimpleText = (node: LexicalNode): node is TextNode =>
  $isTextNode(node) && node.isSimpleText();

function $selectIn(node: TextNode, from: number, to: number = from): void {
  const s = $createRangeSelection();
  s.anchor.set(node.getKey(), from, 'text');
  s.focus.set(node.getKey(), to, 'text');
  $setSelection(s);
}

function $inCell(rand: () => number): boolean {
  const cell = pick(
    rand,
    $all($isTableCellNode as (n: LexicalNode) => n is TableCellNode),
  );
  if (cell === undefined) {
    return false;
  }
  const text = cell.getAllTextNodes().find(isSimpleText);
  if (text !== undefined) {
    $selectIn(text, 0);
  } else {
    cell.selectStart();
  }
  return true;
}

export const CORE_OPS: readonly CoreOp[] = [
  {
    $run: rand => {
      const t = pick(rand, $all(isSimpleText));
      if (t === undefined) {
        return false;
      }
      const at = Math.floor(rand() * (t.getTextContentSize() + 1));
      $selectIn(t, at);
      $getRangeSelection()?.insertText('xyz'[Math.floor(rand() * 3)]);
      return true;
    },
    name: 'type',
  },
  {
    $run: rand => {
      const t = pick(
        rand,
        $all(isSimpleText).filter(n => n.getTextContentSize() > 1),
      );
      if (t === undefined) {
        return false;
      }
      const at = Math.floor(rand() * (t.getTextContentSize() - 1));
      t.spliceText(at, 1, '');
      return true;
    },
    name: 'delete-char',
  },
  {
    $run: rand => {
      const t = pick(
        rand,
        $all(isSimpleText).filter(n => n.getTextContentSize() > 2),
      );
      if (t === undefined) {
        return false;
      }
      const a = Math.floor(rand() * (t.getTextContentSize() - 1));
      $selectIn(t, a, a + 1 + Math.floor(rand() * 2));
      $getRangeSelection()?.formatText('bold');
      return true;
    },
    name: 'toggle-bold',
  },
  {
    $run: rand => {
      const t = pick(
        rand,
        $all(isSimpleText).filter(n => n.getTextContentSize() > 2),
      );
      if (t === undefined) {
        return false;
      }
      const a = Math.floor(rand() * (t.getTextContentSize() - 1));
      $selectIn(t, a, a + 1);
      const selection = $getRangeSelection();
      if (selection === null) {
        return false;
      }
      $wrapSelectionInMarkNode(
        selection,
        selection.isBackward(),
        'c' + Math.floor(rand() * 3),
      );
      return true;
    },
    name: 'mark',
  },
  {
    $run: rand => {
      const t = pick(rand, $all(isSimpleText));
      if (t === undefined) {
        return false;
      }
      const block = t.getTopLevelElement();
      if (block === null) {
        return false;
      }
      block.insertAfter(
        $createParagraphNode().append($createTextNode('new line')),
      );
      return true;
    },
    name: 'insert-paragraph',
  },
  {
    $run: rand =>
      $inCell(rand) && ($insertTableRowAtSelection(rand() < 0.5), true),
    name: 'table-insert-row',
  },
  {
    $run: rand =>
      $inCell(rand) && ($insertTableColumnAtSelection(rand() < 0.5), true),
    name: 'table-insert-column',
  },
  {
    $run: rand => $inCell(rand) && ($deleteTableRowAtSelection(), true),
    name: 'table-delete-row',
  },
  {
    $run: rand => $inCell(rand) && ($deleteTableColumnAtSelection(), true),
    name: 'table-delete-column',
  },
  {
    $run: rand => {
      const list = pick(
        rand,
        $all($isListNode as (n: LexicalNode) => n is ListNode),
      );
      if (list === undefined) {
        return false;
      }
      const types = ['bullet', 'number', 'check'] as const;
      list.setListType(types[Math.floor(rand() * 3)]);
      return true;
    },
    name: 'list-type',
  },
  {
    $run: rand => {
      const list = pick(
        rand,
        $all($isListNode as (n: LexicalNode) => n is ListNode),
      );
      if (list === undefined) {
        return false;
      }
      list.setStart(1 + Math.floor(rand() * 9));
      return true;
    },
    name: 'list-start',
  },
];
