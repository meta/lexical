/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Shared by the list's drawn-number tests (local, undo/redo, and two
// collaborating clients). Live list items carry `value` only where the browser's own count would draw
// another number (see `$updateListItemValueDOM`). An item's decision depends
// on the item before it, so these tests compare the number a browser draws
// for every item (its `value`, else the list's `start` or the previous item's
// number plus one) with the item's own `getValue()`, after each kind of edit
// and after undoing and redoing it.

import {$generateNodesFromDOM} from '@lexical/html';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import {
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';

export function $item(text: string, ...children: LexicalNode[]): ListItemNode {
  const item = $createListItemNode();
  if (text !== '') {
    item.append($createTextNode(text));
  }
  return item.append(...children);
}

/** `a`, `p` holding text and a nested list, `n`, `m`. */
export function $mixedList(start = 1): ListNode {
  return $createListNode('number', start).append(
    $item('a'),
    $item('p', $createListNode('number').append($item('x'), $item('y'))),
    $item('n'),
    $item('m'),
  );
}

/** `a`, a wrapper holding a nested list, `n`, `m`. */
export function $wrapperList(start = 1): ListNode {
  return $createListNode('number', start).append(
    $item('a'),
    $item('', $createListNode('number').append($item('x'))),
    $item('n'),
    $item('m'),
  );
}

function $topList(): ListNode {
  const list = $getRoot().getFirstChild();
  if (!$isListNode(list)) {
    throw new Error('expected a list');
  }
  return list;
}

function $at(index: number, list: ListNode = $topList()): ListItemNode {
  const item = list.getChildAtIndex(index);
  if (!$isListItemNode(item)) {
    throw new Error(`expected a list item at ${index}`);
  }
  return item;
}

export interface ListEditCase {
  name: string;
  /** Fails on the branch before the fix (the rest are regression guards). */
  fixes?: true;
  /** The model's numbers right after `$build`, where the build is an import. */
  built?: string[];
  $build: () => LexicalNode[];
  $edit: () => void;
}

/** Each case starts from `$build` and makes one edit in one update. */
export const LIST_EDIT_CASES: ListEditCase[] = [
  {
    // rootnode-bot's case on #9958: `p` becomes a wrapper, then an item is
    // inserted above it.
    $build: () => [$mixedList()],
    $edit: () => {
      $at(1).getFirstChild()!.remove();
      $at(0).insertAfter($item('b'));
    },
    fixes: true,
    name: 'item becomes a wrapper, then an item is inserted above it',
  },
  {
    $build: () => [$wrapperList()],
    $edit: () => $at(0).insertAfter($item('b')),
    name: 'item inserted above a wrapper',
  },
  {
    $build: () => [
      $createListNode('number').append(
        $item('a'),
        $item('b'),
        $item('', $createListNode('number').append($item('x'))),
        $item('n'),
      ),
    ],
    $edit: () => $at(1).remove(),
    name: 'item removed above a wrapper',
  },
  {
    $build: () => [$wrapperList()],
    $edit: () => {
      const wrapper = $at(1);
      wrapper.getFirstChildOrThrow().insertBefore($createTextNode('w'));
    },
    name: 'wrapper becomes a normal item again',
  },
  {
    $build: () => [$mixedList()],
    $edit: () => $at(1).getFirstChild()!.remove(),
    name: 'item becomes a wrapper',
  },
  {
    $build: () => [$wrapperList()],
    $edit: () => $topList().setStart(7),
    name: 'start changes on a list with a wrapper',
  },
  {
    $build: () => [$mixedList()],
    $edit: () => $topList().setStart(25),
    name: 'start changes on a list with a mixed item',
  },
  {
    $build: () => [$wrapperList()],
    $edit: () => {
      // Split the list before `n`: a paragraph between two lists.
      const list = $topList();
      const tail = $createListNode('number');
      const n = $at(2);
      const m = $at(3);
      tail.append(n, m);
      list.insertAfter($createParagraphNode().append($createTextNode('cut')));
      list.getNextSibling()!.insertAfter(tail);
    },
    name: 'list split after a wrapper',
  },
  {
    $build: () => [
      $wrapperList(),
      $createParagraphNode().append($createTextNode('gap')),
      $createListNode('number').append($item('q'), $item('r')),
    ],
    $edit: () => {
      // Merge the second list into the first, as deleting the gap does.
      const [first, gap, second] = $getRoot().getChildren() as ListNode[];
      gap.remove();
      first.append(...second.getChildren());
      second.remove();
    },
    name: 'two lists merge after a wrapper',
  },
  {
    $build: () => [
      $wrapperList(),
      $createParagraphNode().append($createTextNode('gap')),
      $createListNode('number').append($item('q'), $item('r')),
    ],
    $edit: () => {
      const second = $getRoot().getLastChild() as ListNode;
      $at(0).insertAfter(second.getFirstChildOrThrow());
    },
    name: 'item moved from another list to above a wrapper',
  },
  {
    $build: () => [$wrapperList()],
    $edit: () => $at(2).setIndent(1),
    name: 'item after a wrapper indented',
  },
  {
    $build: () => [$wrapperList()],
    $edit: () => {
      const nested = $at(1).getFirstChildOrThrow() as ListNode;
      $at(0, nested).setIndent(0);
    },
    name: 'nested item outdented out of a wrapper',
  },
  {
    $build: () => [$wrapperList()],
    $edit: () => $topList().setListType('check'),
    name: 'numbered list with a wrapper becomes a check list',
  },
  {
    $build: () => [
      $createListNode('check').append(
        $item('a'),
        $item('', $createListNode('check').append($item('x'))),
        $item('n'),
      ),
    ],
    $edit: () => $topList().setListType('number'),
    name: 'check list with a wrapper becomes a numbered list',
  },
  {
    $build: () => [
      $createListNode('number').append(
        $item('a'),
        $item('', $createListNode('number').append($item('x'))),
        $item('', $createListNode('number').append($item('y'))),
        $item('n'),
        $item('m'),
      ),
    ],
    $edit: () => $at(0).insertAfter($item('b')),
    name: 'item inserted above two consecutive wrappers',
  },
  {
    $build: () => [
      $createListNode('number').append(
        $item('a'),
        $item('b'),
        $item('', $createListNode('number').append($item('x'))),
        $item('', $createListNode('number').append($item('y'))),
        $item('n'),
      ),
    ],
    $edit: () => $at(1).remove(),
    name: 'item removed above two consecutive wrappers',
  },
  {
    $build: () => [
      $createListNode('number', 4).append(
        $item('', $createListNode('number').append($item('x'))),
        $item('n'),
        $item('m'),
      ),
    ],
    $edit: () => $at(1).insertBefore($item('b')),
    name: 'wrapper as the first item, then an item inserted after it',
  },
  {
    $build: () => [
      $createListNode('number').append(
        $item('a'),
        $item('n'),
        $item('', $createListNode('number').append($item('x'))),
      ),
    ],
    $edit: () => $at(0).insertAfter($item('b')),
    name: 'wrapper as the last item, then an item inserted above it',
  },
  {
    $build: () => [$wrapperList()],
    $edit: () => $at(1).remove(),
    name: 'whole wrapper deleted',
  },
  {
    $build: () => [$wrapperList()],
    $edit: () => {
      const nested = $at(1).getFirstChildOrThrow() as ListNode;
      nested.append($item('y'));
      nested.setStart(5);
    },
    name: 'start changes on a nested list inside a wrapper',
  },
  {
    $build: () => [
      $createListNode('number').append(
        $item('a'),
        $item('', $createListNode('check').append($item('x'))),
        $item('', $createListNode('bullet').append($item('y'))),
        $item('n'),
      ),
    ],
    $edit: () => $at(0).insertAfter($item('b')),
    name: 'check and bullet lists nested in numbered wrappers, insert above',
  },
  {
    $build: () => [
      $createListNode('check').append(
        $item('a'),
        $item('', $createListNode('number', 3).append($item('x'), $item('y'))),
        $item('n'),
      ),
    ],
    $edit: () => {
      const nested = $at(1).getFirstChildOrThrow() as ListNode;
      nested.getFirstChildOrThrow().insertBefore($item('w'));
    },
    name: 'numbered list nested in a check list, item inserted',
  },
  {
    $build: () => [$wrapperList()],
    $edit: () => {
      const nested = $at(1).getFirstChildOrThrow() as ListNode;
      nested.setListType('bullet');
    },
    name: "nested list's type changes while its wrapper stays numbered",
  },
  {
    // Pasted HTML with `value` on every item, an item holding text and then
    // a nested list, and a gap in the numbers. The import puts `p` and its
    // nested list in separate items and renumbers the gap away (`built`).
    // The edit makes `p`'s item the wrapper and inserts above it, but taking
    // the nested list's own item away marks `n` dirty too, so this case is a
    // regression guard for imported lists, not the bot's path.
    $build: () => {
      const dom = new DOMParser().parseFromString(
        '<ol><li value="1">a</li><li value="2">p<ol><li value="1">x</li></ol></li>' +
          '<li value="5">n</li><li value="6">m</li></ol>',
        'text/html',
      );
      return $generateNodesFromDOM($getEditor(), dom);
    },
    $edit: () => {
      const p = $at(1);
      const holder = $at(2);
      p.getFirstChildOrThrow().remove();
      p.append(holder.getFirstChildOrThrow());
      holder.remove();
      $at(0).insertAfter($item('b'));
    },
    built: ['1 a', '2 p', '3 n', '4 m', '1 x'],
    name: "pasted HTML list (values on every item, a gap the import renumbers), then the bot's edit",
  },
];

/** What a browser draws for every marker of every numbered list, and the model's numbers. */
export function drawnAndModel(editor: LexicalEditor): {
  drawn: string[];
  model: string[];
} {
  const root = editor.getRootElement();
  if (root === null) {
    throw new Error('no root element');
  }
  // `read` commits a pending update (an undo's) first, so the DOM is current.
  const model = editor.read(() => {
    const out: string[] = [];
    const walk = (node: LexicalNode) => {
      if ($isListNode(node) && node.getListType() === 'number') {
        for (const child of node.getChildren()) {
          if ($isListItemNode(child) && !$isListNode(child.getFirstChild())) {
            out.push(`${child.getValue()} ${$ownText(child)}`);
          }
        }
      }
      if ('getChildren' in node) {
        (node as ListNode).getChildren().forEach(walk);
      }
    };
    walk($getRoot());
    return out;
  });
  const drawn: string[] = [];
  for (const ol of Array.from(root.querySelectorAll('ol'))) {
    let previous: number | null = null;
    const start = Number(ol.getAttribute('start') ?? '1');
    for (const li of Array.from(ol.children)) {
      if (li.tagName !== 'LI') {
        continue;
      }
      const shown: number = li.hasAttribute('value')
        ? Number(li.getAttribute('value'))
        : previous === null
          ? start
          : previous + 1;
      previous = shown;
      const first = li.firstElementChild;
      if (
        first !== null &&
        (first.tagName === 'OL' || first.tagName === 'UL')
      ) {
        continue;
      }
      drawn.push(`${shown} ${ownText(li)}`);
    }
  }
  return {drawn, model};
}

function ownText(li: Element): string {
  return Array.from(li.childNodes)
    .filter(
      c =>
        !(c instanceof Element && (c.tagName === 'OL' || c.tagName === 'UL')),
    )
    .map(c => c.textContent ?? '')
    .join('');
}

function $ownText(item: ListItemNode): string {
  return item
    .getChildren()
    .filter(c => !$isListNode(c))
    .map(c => c.getTextContent())
    .join('');
}
