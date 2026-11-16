/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  ListItemNode,
  ListNode,
  type ListType,
  registerList,
} from '@lexical/list';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  createEditor,
  type ElementNode,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, test} from 'vitest';

// #9661: an item that only wraps a nested list does not count in its list's
// numbering. When it stops or starts wrapping one (its nested list's last
// item removed, a list appended to an empty item), the list itself is not
// written, so its transform did not renumber the items after the item: they
// kept stale values, and a split there started the next list from them.

function build(): LexicalEditor {
  const editor = createEditor({
    namespace: 'renumber',
    nodes: [ListNode, ListItemNode],
    onError: e => {
      throw e;
    },
  });
  registerList(editor);
  return editor;
}

function run(editor: LexicalEditor, fn: () => void): void {
  editor.update(fn, {discrete: true});
}

/** Each top-level list's item values, and its start. */
function lists(editor: LexicalEditor): {start: number; values: number[]}[] {
  return editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .filter($isListNode)
      .map(list => ({
        start: list.getStart(),
        values: list
          .getChildren()
          .filter($isListItemNode)
          .map(item => item.getValue()),
      })),
  );
}

function $list(): ListNode {
  return $getRoot().getFirstChildOrThrow() as ListNode;
}

/** A list of `texts`, with the first item indented into a nested list. */
function indentedFirst(
  editor: LexicalEditor,
  type: ListType,
  texts: string[],
): void {
  run(editor, () => {
    $getRoot().append(
      $createListNode(type).append(
        ...texts.map(text =>
          $createListItemNode().append($createTextNode(text)),
        ),
      ),
      $createParagraphNode().append($createTextNode('end')),
    );
  });
  run(editor, () => {
    ($list().getFirstChildOrThrow() as ListItemNode).setIndent(1);
  });
}

function $removeOnlyNestedItem(): void {
  const wrapper = $list().getFirstChildOrThrow() as ElementNode;
  const nested = wrapper.getFirstChildOrThrow() as ElementNode;
  nested.getFirstChildOrThrow().remove();
}

function $insertParagraphsAtFirstItem(): void {
  const empty = $list().getFirstChildOrThrow() as ElementNode;
  const selection = $createRangeSelection();
  selection.anchor.set(empty.getKey(), 0, 'element');
  selection.focus.set(empty.getKey(), 0, 'element');
  $setSelection(selection);
  selection.insertNodes([
    $createParagraphNode().append($createTextNode('p')),
    $createParagraphNode().append($createTextNode('q')),
  ]);
}

describe('registerList renumbers when an item stops or starts wrapping a nested list (#9661)', () => {
  test('removing the only item of a nested list renumbers the items after it', () => {
    const editor = build();
    indentedFirst(editor, 'number', ['ff', 'gg hh']);
    expect(lists(editor)).toEqual([{start: 1, values: [1, 1]}]);
    run(editor, $removeOnlyNestedItem);
    // The empty item now counts, so "gg hh" is item 2.
    expect(lists(editor)).toEqual([{start: 1, values: [1, 2]}]);
    // A split there continues the numbering in the list after it.
    run(editor, $insertParagraphsAtFirstItem);
    expect(lists(editor).map(l => l.start)).toEqual([1, 2]);
  });

  test('control: the same split when the values are up to date', () => {
    const editor = build();
    run(editor, () => {
      $getRoot().append(
        $createListNode('number').append(
          $createListItemNode(),
          $createListItemNode().append($createTextNode('gg hh')),
        ),
        $createParagraphNode().append($createTextNode('end')),
      );
    });
    expect(lists(editor)).toEqual([{start: 1, values: [1, 2]}]);
    run(editor, $insertParagraphsAtFirstItem);
    expect(lists(editor).map(l => l.start)).toEqual([1, 2]);
  });

  test('several items after it, and a list that starts at 5', () => {
    const editor = build();
    indentedFirst(editor, 'number', ['a', 'b', 'c', 'd']);
    run(editor, () => $list().setStart(5));
    expect(lists(editor)).toEqual([{start: 5, values: [5, 5, 6, 7]}]);
    run(editor, $removeOnlyNestedItem);
    expect(lists(editor)).toEqual([{start: 5, values: [5, 6, 7, 8]}]);
  });

  test('the last item of a nested list that has two', () => {
    const editor = build();
    indentedFirst(editor, 'number', ['a', 'b', 'c']);
    run(editor, () => {
      // Indent "b" too: the nested list holds "a" and "b".
      ($list().getChildAtIndex(1) as ListItemNode).setIndent(1);
    });
    expect(lists(editor)).toEqual([{start: 1, values: [1, 1]}]);
    run(editor, () => {
      const wrapper = $list().getFirstChildOrThrow() as ElementNode;
      const nested = wrapper.getFirstChildOrThrow() as ElementNode;
      nested.getLastChildOrThrow().remove();
    });
    // The wrapper still wraps a nested list ("a"): nothing changes.
    expect(lists(editor)).toEqual([{start: 1, values: [1, 1]}]);
    run(editor, $removeOnlyNestedItem);
    expect(lists(editor)).toEqual([{start: 1, values: [1, 2]}]);
  });

  test('an empty item that comes to hold only a nested list stops counting', () => {
    const editor = build();
    run(editor, () => {
      $getRoot().append(
        $createListNode('number').append(
          $createListItemNode().append($createTextNode('a')),
          $createListItemNode(),
          $createListItemNode().append($createTextNode('c')),
        ),
      );
    });
    expect(lists(editor)).toEqual([{start: 1, values: [1, 2, 3]}]);
    run(editor, () => {
      ($list().getChildAtIndex(1) as ListItemNode).append(
        $createListNode('number').append(
          $createListItemNode().append($createTextNode('b')),
        ),
      );
    });
    expect(lists(editor)).toEqual([{start: 1, values: [1, 2, 2]}]);
  });

  test('a removal that leaves the item wrapping its nested list leaves the outer list unwritten', () => {
    const editor = build();
    indentedFirst(editor, 'number', ['a', 'b', 'c']);
    run(editor, () => {
      ($list().getChildAtIndex(1) as ListItemNode).setIndent(1);
    });
    const outer = editor.getEditorState().read(() => $list().getKey());
    let outerWritten = false;
    const remove = editor.registerUpdateListener(({dirtyElements}) => {
      outerWritten = outerWritten || dirtyElements.get(outer) === true;
    });
    run(editor, () => {
      // "a" is removed from the nested list, which still holds "b".
      const wrapper = $list().getFirstChildOrThrow() as ElementNode;
      const nested = wrapper.getFirstChildOrThrow() as ElementNode;
      nested.getFirstChildOrThrow().remove();
    });
    remove();
    expect(lists(editor)).toEqual([{start: 1, values: [1, 1]}]);
    expect(outerWritten).toBe(false);
  });

  test('control: a value an app sets on an item is not renumbered by this', () => {
    const editor = build();
    run(editor, () => {
      $getRoot().append(
        $createListNode('number').append(
          $createListItemNode().append($createTextNode('a')),
          $createListItemNode().append($createTextNode('b')),
        ),
      );
    });
    run(editor, () => {
      ($list().getFirstChildOrThrow() as ListItemNode).setValue(7);
    });
    expect(lists(editor)).toEqual([{start: 1, values: [7, 2]}]);
  });

  for (const type of ['bullet', 'check'] as const) {
    test(`${type} lists renumber the same way`, () => {
      const editor = build();
      indentedFirst(editor, type, ['ff', 'gg hh']);
      run(editor, $removeOnlyNestedItem);
      expect(lists(editor)).toEqual([{start: 1, values: [1, 2]}]);
    });
  }

  test('a value an app sets in the same update as the removal stays', () => {
    const editor = build();
    indentedFirst(editor, 'number', ['a', 'b']);
    run(editor, () => {
      $removeOnlyNestedItem();
      ($list().getFirstChildOrThrow() as ListItemNode).setValue(7);
    });
    // The empty item keeps 7, and "b" counts on from it.
    expect(lists(editor)).toEqual([{start: 1, values: [7, 8]}]);
  });

  test('an app transform that keeps a value does not conflict with the renumbering', () => {
    const editor = build();
    indentedFirst(editor, 'number', ['a', 'b']);
    const errors: string[] = [];
    editor._onError = e => {
      errors.push(e.message);
    };
    const key = editor
      .getEditorState()
      .read(() => $list().getFirstChildOrThrow().getKey());
    const unregister = editor.registerNodeTransform(ListItemNode, node => {
      if (node.getKey() === key && node.getValue() !== 7) {
        node.setValue(7);
      }
    });
    run(editor, () => {});
    run(editor, $removeOnlyNestedItem);
    unregister();
    expect(errors).toEqual([]);
    expect(lists(editor)).toEqual([{start: 1, values: [7, 8]}]);
  });

  // Many wrappers emptied in one update: one renumbering, whatever order the
  // items' transforms run in.
  for (const order of ['first to last', 'last to first'] as const) {
    test(`removals in many wrappers at once cost linear work (${order})`, () => {
      const counts: number[] = [];
      for (const n of [64, 128, 256]) {
        const editor = build();
        run(editor, () => {
          $getRoot().append(
            $createListNode('number').append(
              ...Array.from({length: n}, (_, i) =>
                $createListItemNode().append(
                  $createListNode('number').append(
                    $createListItemNode().append($createTextNode(`x${i}`)),
                  ),
                ),
              ),
            ),
          );
        });
        let reads = 0;
        const original = ListItemNode.prototype.getValue;
        ListItemNode.prototype.getValue = function (this: ListItemNode) {
          reads++;
          return original.call(this);
        };
        try {
          run(editor, () => {
            const wrappers = $list().getChildren() as ElementNode[];
            if (order === 'last to first') {
              wrappers.reverse();
            }
            for (const wrapper of wrappers) {
              (wrapper.getFirstChildOrThrow() as ElementNode)
                .getFirstChildOrThrow()
                .remove();
            }
          });
        } finally {
          ListItemNode.prototype.getValue = original;
        }
        expect(lists(editor)[0].values).toEqual(
          Array.from({length: n}, (_, i) => i + 1),
        );
        counts.push(reads);
      }
      expect(counts[0]).toBeGreaterThan(0);
      expect(counts[2]).toBeLessThan(counts[0] * 4 * 1.5);
    });
  }
});
