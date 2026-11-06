/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A peer removes the line holding the caret, and it was the last line of
// its container, after a list, a table or a box: the caret goes to the
// nearest text position before it, never onto the list, table or box
// itself (where typing is dropped, or lands inside the table's structure,
// and Backspace deletes a whole item of other users' text).

import {$createListItemNode, $createListNode} from '@lexical/list';
import {
  $createTableNodeWithDimensions,
  registerTablePlugin,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type ElementNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {
  $createBoxNode,
  describeNode,
  expectConverged,
  flush,
  type Peer,
  setup,
} from '../utils/harness';

const caret = (p: Peer) =>
  p.read(() => {
    const s = $getSelection();
    if (!$isRangeSelection(s)) {
      return String(s);
    }
    const n: LexicalNode = s.anchor.getNode();
    return `${s.anchor.type} ${
      $isTextNode(n)
        ? JSON.stringify(n.getTextContent())
        : describeNode(n).slice(0, 50)
    }@${s.anchor.offset}`;
  });

/** Put the caret in `line`: at its start if empty, else at `offset`. */
function $caretIn(line: ElementNode, offset: number) {
  if (line.getTextContentSize() === 0) {
    line.select(0, 0);
    return;
  }
  const t = line.getFirstDescendant() as TextNode;
  const s = $createRangeSelection();
  s.anchor.set(t.getKey(), offset, 'text');
  s.focus.set(t.getKey(), offset, 'text');
  $setSelection(s);
}

/** Backspace at the caret, as the DOM-less editor can apply it. */
function $backspace() {
  const s = $getSelection();
  if (!$isRangeSelection(s)) {
    return;
  }
  const an = s.anchor;
  if (s.isCollapsed() && an.type === 'text' && an.offset > 0) {
    (an.getNode() as TextNode).spliceText(an.offset - 1, 1, '', true);
  } else {
    s.deleteCharacter(true);
  }
}

function $lastLineIn(where: string): ElementNode {
  if (where === 'root') {
    return $getRoot().getLastChild() as ElementNode;
  }
  const table = $getRoot().getChildAtIndex(1) as ElementNode;
  const cell = (
    table.getFirstChild() as ElementNode
  ).getFirstChild() as ElementNode;
  return cell.getLastChild() as ElementNode;
}

for (const where of ['table cell', 'root']) {
  for (const line of ['empty', 'with text']) {
    test(`the last line after a list (${where}, ${line}), removed by a peer: Backspace removes at most one character`, async () => {
      const {a, b, sync} = await setup(() => {
        const list = $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('alpha beta')),
        );
        const last =
          line === 'empty'
            ? $createParagraphNode()
            : $createParagraphNode().append($createTextNode('xyz'));
        const top = $createParagraphNode().append($createTextNode('top'));
        if (where === 'root') {
          $getRoot().append(top, list, last);
        } else {
          const table = $createTableNodeWithDimensions(1, 1, false);
          const cell = (
            table.getFirstChild() as ElementNode
          ).getFirstChild() as ElementNode;
          (cell.getFirstChild() as ElementNode).remove();
          cell.append(list, last);
          $getRoot().append(
            top,
            table,
            $createParagraphNode().append($createTextNode('end')),
          );
        }
      });
      b.update(() => $caretIn($lastLineIn(where), 1));
      a.update(() => {
        $lastLineIn(where).remove();
      });
      await sync();
      await flush();
      expect(caret(b)).toMatch(/^text "alpha beta"@10$/);
      const before = a.read(() => $getRoot().getTextContent()).length;
      b.update($backspace);
      await sync();
      await flush();
      const after = a.read(() => $getRoot().getTextContent());
      expect(after).toContain('alpha bet');
      expect(before - after.length).toBeLessThanOrEqual(1);
      await expectConverged([a, b]);
    });
  }
}

for (const shape of ['empty line', 'line with text']) {
  for (const after of ['table', 'box']) {
    for (const then of ['type', 'backspace']) {
      test(`the caret in the last ${shape} after a ${after}, removed by a peer; then ${then}`, async () => {
        const {a, b, sync} = await setup(() => {
          const block =
            after === 'table'
              ? $createTableNodeWithDimensions(1, 2, false)
              : $createBoxNode().append(
                  $createParagraphNode().append($createTextNode('in box')),
                );
          $getRoot().append(
            $createParagraphNode().append($createTextNode('top')),
            block,
            shape === 'empty line'
              ? $createParagraphNode()
              : $createParagraphNode().append($createTextNode('line')),
          );
        });
        b.update(() => $caretIn($getRoot().getLastChild() as ElementNode, 2));
        a.update(() => {
          ($getRoot().getLastChild() as ElementNode).remove();
        });
        await sync();
        await flush();
        expect(caret(b)).not.toMatch(/^element (table|tablerow|tablecell|box)/);
        b.update(() => {
          const s = $getSelection();
          if (then === 'type' && $isRangeSelection(s)) {
            s.insertText('Z');
          } else if (then === 'backspace') {
            $backspace();
          }
        });
        await sync();
        await flush();
        await expectConverged([a, b]);
        if (then === 'type') {
          expect(a.describe()).toContain('Z');
        }
      });
    }
  }
}

for (const plugin of [false, true]) {
  test(`the caret in the last paragraph after a table, removed by a peer, then typing (table plugin: ${plugin}): the text lands outside the table`, async () => {
    const {a, b, sync} = await setup(() => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('top')),
        $createTableNodeWithDimensions(2, 2, false),
        $createParagraphNode().append($createTextNode('last line')),
      );
    });
    const unregister = plugin
      ? [registerTablePlugin(a.editor), registerTablePlugin(b.editor)]
      : [];
    await flush();
    b.update(() => {
      ($getRoot().getLastChild() as ElementNode).selectEnd();
    });
    a.update(() => {
      ($getRoot().getLastChild() as ElementNode).remove();
    });
    await sync();
    await flush();
    b.update(() => {
      const s = $getSelection();
      if ($isRangeSelection(s)) {
        s.insertText('typed by B');
      }
    });
    await sync();
    await flush();
    unregister.forEach(f => f());
    await expectConverged([a, b]);
    expect(a.describe()).toContain('typed by B');
    expect(a.describe()).not.toMatch(/table\([^/]*paragraph\("typed by B"\)\)/);
  });
}

test('a caret a read leaves on a list item that holds a nested list goes into the nested list: Backspace removes one character', async () => {
  const {a, b, sync} = await setup(() => {
    $getRoot().append(
      $createParagraphNode().append($createTextNode('top')),
      $createListNode('number').append(
        $createListItemNode().append($createTextNode('one')),
        $createListItemNode().append(
          $createListNode('bullet').append(
            $createListItemNode().append($createTextNode('nested text')),
          ),
        ),
      ),
    );
  });
  // B's caret right after the nested list, on the item that holds it.
  b.update(() => {
    const wrapper = (
      $getRoot().getChildAtIndex(1) as ElementNode
    ).getLastChild() as ElementNode;
    wrapper.select(1, 1);
  });
  a.update(() => {
    ($getRoot().getFirstChild() as ElementNode).selectEnd().insertText('!');
  });
  await sync();
  await flush();
  expect(caret(b)).toBe('text "nested text"@11');
  const before = a.read(() => $getRoot().getTextContent()).length;
  b.update($backspace);
  await sync();
  await flush();
  expect(a.read(() => $getRoot().getTextContent()).length).toBe(before - 1);
  await expectConverged([a, b]);
});
