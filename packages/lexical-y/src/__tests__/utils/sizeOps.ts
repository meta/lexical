/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Binding-independent edit script for size measurements: every operation is
// plain Lexical, so the same script measures any collaboration binding.

import {$toggleLink} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import {$addMarkID, $getNodeMarkIDs, $removeMarkID} from '@lexical/mark';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $createTableNodeWithDimensions,
  $deleteTableRowAtSelection,
  $insertTableRowAtSelection,
  $isTableNode,
} from '@lexical/table';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getState,
  $getWritableNodeState,
  $isElementNode,
  $isTextNode,
  $setSelection,
  $setState,
  createState,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type StateConfig,
  type TextNode,
} from 'lexical';

const markStates = new Map<string, StateConfig<string, boolean>>();
/** A boolean NodeState key per id (a NodeState change on a text range). */
export function markState(id: string): StateConfig<string, boolean> {
  let s = markStates.get(id);
  if (s === undefined) {
    s = createState('mark:' + id, {parse: v => v === true});
    markStates.set(id, s);
  }
  return s;
}

/**
 * Make MarkStateExtension's set-valued `markIds` state known to TextNode and
 * LineBreakNode on a plain editor (the extension does this for every node
 * type when the editor is built), so that the editor joins the per-id
 * formats it reads back into one set.
 */
export function prepareMarkState(editor: LexicalEditor): void {
  editor.update(
    () => {
      for (const node of [$createTextNode(), $createLineBreakNode()]) {
        // $getState registers the StateConfig once the node has a NodeState
        $getWritableNodeState(node);
        $getNodeMarkIDs(node);
      }
    },
    {discrete: true},
  );
}

export function $block(path: number[]): ElementNode {
  let node: LexicalNode = $getRoot();
  for (const i of path) {
    node = (node as ElementNode).getChildAtIndex(i)!;
  }
  return node as ElementNode;
}

function $locate(block: ElementNode, offset: number): [TextNode, number] {
  const texts = block.getAllTextNodes();
  let acc = 0;
  for (let i = 0; i < texts.length; i++) {
    const size = texts[i].getTextContentSize();
    if (
      offset < acc + size ||
      (offset === acc + size && i === texts.length - 1)
    ) {
      return [texts[i], offset - acc];
    }
    acc += size;
  }
  throw new Error(`offset ${offset} out of range`);
}

export function $select(path: number[], start: number, end = start) {
  const block = $block(path);
  const [a, ao] = $locate(block, start);
  const [b, bo] = $locate(block, end);
  const sel = $createRangeSelection();
  sel.anchor.set(a.getKey(), ao, 'text');
  sel.focus.set(b.getKey(), bo, 'text');
  $setSelection(sel);
  return sel;
}

const LINE = 'The quick brown fox jumps over the lazy dog.';
const $p = (t: string) => $createParagraphNode().append($createTextNode(t));
const $li = (t: string) => $createListItemNode().append($createTextNode(t));

/** The document every operation starts from. */
export function $initDoc() {
  $getRoot().append(
    $p(LINE),
    $p(LINE),
    $createListNode('bullet').append($li('one'), $li('two'), $li('three')),
    $createTableNodeWithDimensions(3, 3, false),
    $p(LINE),
  );
}

function $cellParagraph(r: number, c: number): ElementNode {
  const table = $getRoot().getChildren().find($isTableNode)!;
  const row = table.getChildAtIndex(r) as ElementNode;
  return (row.getChildAtIndex(c) as ElementNode).getFirstChild() as ElementNode;
}

export type SizeOp = {name: string; prepare?: () => void; run: () => void};

const PASTE = 'x'.repeat(1000);

export const SIZE_OPS: SizeOp[] = [
  {
    name: 'type a char at line start',
    run: () => $select([1], 0).insertText('a'),
  },
  {name: 'type a char mid line', run: () => $select([1], 20).insertText('a')},
  {
    name: 'type a char at line end',
    run: () => $select([1], LINE.length).insertText('a'),
  },
  {name: 'paste 1k chars', run: () => $select([1], 20).insertText(PASTE)},
  {name: 'Enter mid line', run: () => $select([1], 20).insertParagraph()},
  {
    name: 'Backspace join',
    run: () => {
      // Join line 1 into line 0 (what Backspace at the start of line 1 does).
      const second = $block([1]);
      const first = $block([0]);
      const end = first.getTextContentSize();
      first.append(...second.getChildren());
      second.remove();
      $select([0], end);
    },
  },
  {
    name: 'heading toggle',
    run: () => $setBlocksType($select([1], 0), () => $createHeadingNode('h2')),
  },
  {
    name: 'quote toggle',
    run: () => $setBlocksType($select([1], 0), () => $createQuoteNode()),
  },
  {
    name: 'indent list item',
    run: () => ($block([2, 1]) as ListItemNode).setIndent(1),
  },
  {
    name: 'outdent list item',
    prepare: () => ($block([2, 1]) as ListItemNode).setIndent(1),
    run: () => {
      const item = $block([2])
        .getAllTextNodes()
        .find(t => t.getTextContent() === 'two')!
        .getParent() as ListItemNode;
      item.setIndent(0);
    },
  },
  {
    name: 'list type change',
    run: () => ($block([2]) as ListNode).setListType('number'),
  },
  {
    name: 'link a word',
    run: () => {
      $select([1], 4, 9);
      $toggleLink('https://example.com');
    },
  },
  {
    name: 'unlink',
    prepare: () => {
      $select([1], 4, 9);
      $toggleLink('https://example.com');
    },
    run: () => {
      $select([1], 4, 9);
      $toggleLink(null);
    },
  },
  {name: 'bold a range', run: () => $select([1], 4, 19).formatText('bold')},
  {
    name: 'set a NodeState key on a range',
    run: () => {
      const sel = $select([1], 4, 19);
      for (const n of sel.extract()) {
        if ($isTextNode(n)) {
          $setState(n, markState('c1'), true);
        }
      }
    },
  },
  {
    name: 'add a comment (MarkStateExtension)',
    run: () => {
      $addMarkID('c1', $select([1], 4, 19));
    },
  },
  {
    name: 'add an overlapping comment (MarkStateExtension)',
    prepare: () => {
      $addMarkID('c1', $select([1], 4, 19));
    },
    run: () => {
      $addMarkID('c2', $select([1], 10, 25));
    },
  },
  {
    name: 'remove a comment (MarkStateExtension)',
    prepare: () => {
      $addMarkID('c1', $select([1], 4, 19));
      $addMarkID('c2', $select([1], 10, 25));
    },
    run: () => $removeMarkID('c1'),
  },
  {
    name: 'reset a NodeState key on a range',
    prepare: () => {
      const sel = $select([1], 4, 19);
      for (const n of sel.extract()) {
        if ($isTextNode(n)) {
          $setState(n, markState('c1'), true);
        }
      }
    },
    run: () => {
      for (const n of $block([1]).getAllTextNodes()) {
        if ($getState(n, markState('c1'))) {
          $setState(n, markState('c1'), false);
        }
      }
    },
  },
  {
    name: 'table row insert',
    run: () => {
      $cellParagraph(1, 1).selectEnd();
      $insertTableRowAtSelection(true);
    },
  },
  {
    name: 'table row delete',
    run: () => {
      $cellParagraph(1, 1).selectEnd();
      $deleteTableRowAtSelection();
    },
  },
  {name: 'move a block', run: () => $block([1]).insertAfter($block([0]))},
  {
    name: 'delete a container (table)',
    run: () => $getRoot().getChildren().find($isTableNode)!.remove(),
  },
];

/** A deterministic scripted session of `n` edits (seeded). */
export function* scriptedSession(n: number, seed = 7): Generator<() => void> {
  let x = seed;
  const rnd = () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
  for (let i = 0; i < n; i++) {
    const r = rnd();
    const r2 = rnd();
    const r3 = rnd();
    yield () => {
      const root = $getRoot();
      const lines: ElementNode[] = [];
      for (const c of root.getChildren()) {
        if ($isElementNode(c) && !$isTableNode(c)) {
          if (c.getType() === 'list') {
            for (const item of c.getChildren()) {
              if (
                $isListItemNode(item) &&
                item.getChildren().every($isTextNode)
              ) {
                lines.push(item);
              }
            }
          } else if (c.getChildren().every($isTextNode)) {
            lines.push(c);
          }
        }
      }
      const line = lines[Math.floor(r2 * lines.length)];
      if (line === undefined) {
        root.append($p('again'));
        return;
      }
      const texts = line.getAllTextNodes();
      const len = line.getTextContentSize();
      const off = Math.floor(r3 * (len + 1));
      const $select_ = (from: number, to = from) => {
        if (texts.length === 0) {
          line.selectStart();
          return null;
        }
        let acc = 0;
        let a: [TextNode, number] | null = null;
        let b: [TextNode, number] | null = null;
        for (let k = 0; k < texts.length; k++) {
          const s = texts[k].getTextContentSize();
          if (a === null && (from < acc + s || k === texts.length - 1)) {
            a = [texts[k], Math.min(from - acc, s)];
          }
          if (b === null && (to < acc + s || k === texts.length - 1)) {
            b = [texts[k], Math.min(to - acc, s)];
          }
          acc += s;
        }
        const sel = $createRangeSelection();
        sel.anchor.set(a![0].getKey(), Math.max(0, a![1]), 'text');
        sel.focus.set(b![0].getKey(), Math.max(0, b![1]), 'text');
        $setSelection(sel);
        return sel;
      };
      if (r < 0.7) {
        const sel = $select_(off);
        if (sel) {
          sel.insertText('e');
        } else {
          line.append($createTextNode('e'));
        }
      } else if (r < 0.8 && len > 0) {
        const sel = $select_(Math.max(0, off - 1), off);
        if (sel && !sel.isCollapsed()) {
          sel.removeText();
        }
      } else if (r < 0.87) {
        const sel = $select_(off);
        if (sel) {
          sel.insertParagraph();
        }
      } else if (r < 0.92 && len > 3) {
        const sel = $select_(0, Math.min(3, len));
        if (sel) {
          sel.formatText('bold');
        }
      } else if (
        r < 0.96 &&
        lines.length > 3 &&
        line.getType() === 'paragraph'
      ) {
        const prev = line.getPreviousSibling();
        if ($isElementNode(prev) && prev.getType() === 'paragraph') {
          prev.append(...line.getChildren());
          line.remove();
        }
      } else if (line.getType() === 'paragraph') {
        const sel = $select_(0);
        if (sel) {
          $setBlocksType(sel, () => $createHeadingNode('h3'));
        }
      }
    };
  }
}
