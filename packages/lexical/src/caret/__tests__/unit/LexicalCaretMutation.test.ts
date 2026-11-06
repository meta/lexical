/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getSiblingCaret,
  $isRangeSelection,
  $setSelection,
  type ElementNode,
  type LexicalNode,
  type NodeKey,
  type ParagraphNode,
  TextNode,
} from 'lexical';
import {expect, test, vi} from 'vitest';

function key(node: LexicalNode | null | undefined): NodeKey | null {
  return node ? node.getKey() : null;
}

function $expectChildren(parent: ElementNode, children: LexicalNode[]): void {
  expect(parent.getChildrenSize()).toBe(children.length);
  expect(key(parent.getFirstChild())).toBe(key(children[0]));
  expect(key(parent.getLastChild())).toBe(key(children.at(-1)));
  for (const [index, node] of children.entries()) {
    expect(key(node.getParent())).toBe(key(parent));
    expect(key(node.getPreviousSibling())).toBe(key(children[index - 1]));
    expect(key(node.getNextSibling())).toBe(key(children[index + 1]));
  }
  expect(parent.getChildrenKeys()).toEqual(children.map(key));
}

type Fixture = {
  children: TextNode[];
  parent: ParagraphNode;
};

function $createFixture(): Fixture {
  const children = ['a', 'b', 'c', 'd'].map(text =>
    $createTextNode(text).toggleUnmergeable(),
  );
  const parent = $createParagraphNode().append(...children);
  $getRoot().clear().append(parent);
  return {children, parent};
}

test.each(['previous', 'next'] as const)(
  'replacement with an existing %s sibling preserves both links',
  direction => {
    using editor = buildEditorFromExtensions({name: 'caret-mutation-links'});
    let fixture!: Fixture;
    editor.update(
      () => {
        fixture = $createFixture();
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const {parent, children} = fixture;
        const [a, b, c, d] = children;
        b.replace(direction === 'previous' ? a : c);
        $expectChildren(parent, [a, c, d]);
        expect(b.isAttached()).toBe(false);
      },
      {discrete: true},
    );
  },
);

for (const direction of ['previous', 'next'] as const) {
  for (const originIndex of [1, 2]) {
    test.each([0, 1, 2, 3].filter(index => index !== originIndex))(
      `moving sibling %s ${direction} from ${originIndex} preserves committed links`,
      sourceIndex => {
        using editor = buildEditorFromExtensions({name: 'caret-mutation-move'});
        let fixture!: Fixture;
        editor.update(
          () => {
            fixture = $createFixture();
          },
          {discrete: true},
        );
        const previousState = editor.getEditorState();
        editor.update(
          () => {
            const {parent, children} = fixture;
            const source = children[sourceIndex];
            const origin = children[originIndex];
            const expected = children.filter(node => node !== source);
            expected.splice(
              expected.indexOf(origin) + (direction === 'next' ? 1 : 0),
              0,
              source,
            );
            $getSiblingCaret(origin, direction).insert(source);
            $expectChildren(parent, expected);
          },
          {discrete: true},
        );
        previousState.read(() =>
          $expectChildren(fixture.parent, fixture.children),
        );
      },
    );
  }
}

test.each([
  {count: 0, expected: [3, 0, 1, 2], insert: [3], start: 0},
  {count: 1, expected: [0, 1, 3], insert: [1, 3], start: 2},
  {count: 2, expected: [1, 0, 2, 3], insert: [1, 0], start: 0},
  {count: 4, expected: [], insert: [], start: 0},
  {count: 2, expected: [0, 2, 1, 3], insert: [2, 1], start: 1},
])(
  'splice($start, $count, $insert) repairs both boundary links',
  ({start, count, insert, expected}) => {
    using editor = buildEditorFromExtensions({name: 'caret-mutation-splice'});
    let fixture!: Fixture;
    editor.update(
      () => {
        fixture = $createFixture();
      },
      {discrete: true},
    );
    const previousState = editor.getEditorState();
    editor.update(
      () => {
        const {parent, children} = fixture;
        parent.splice(
          start,
          count,
          insert.map(index => children[index]),
        );
        $expectChildren(
          parent,
          expected.map(index => children[index]),
        );
        for (const [index, child] of children.entries()) {
          if (!expected.includes(index)) {
            expect(child.getParent()).toBeNull();
            expect(child.getPreviousSibling()).toBeNull();
            expect(child.getNextSibling()).toBeNull();
          }
        }
      },
      {discrete: true},
    );
    previousState.read(() => $expectChildren(fixture.parent, fixture.children));
  },
);

test.each(['previous', 'next'] as const)(
  'caret insertion dispatches to the %s node method',
  direction => {
    using editor = buildEditorFromExtensions({name: 'caret-mutation-dispatch'});
    const spy = vi.spyOn(
      TextNode.prototype,
      direction === 'next' ? 'insertAfter' : 'insertBefore',
    );
    try {
      editor.update(
        () => {
          const {children} = $createFixture();
          $getSiblingCaret(children[1], direction).insert(children[3]);
          expect(spy).toHaveBeenCalledExactlyOnceWith(children[3]);
        },
        {discrete: true},
      );
    } finally {
      spy.mockRestore();
    }
  },
);

test.each(
  (['insertBefore', 'insertAfter', 'replace'] as const).flatMap(operation =>
    [false, true].flatMap(backward =>
      [0, 2].map(offset => ({backward, offset, operation})),
    ),
  ),
)(
  'moving a text endpoint beside its parent endpoint ($operation, backward=$backward, offset=$offset)',
  ({operation, backward, offset}) => {
    using editor = buildEditorFromExtensions({name: 'move-mixed-endpoints'});
    editor.update(
      () => {
        const first = $createTextNode('first').toggleUnmergeable();
        const moved = $createTextNode('second').toggleUnmergeable();
        const parent = $createParagraphNode().append(first, moved);
        $getRoot().append(parent);
        const selection = $createRangeSelection();
        const [textPoint, elementPoint] = backward
          ? [selection.focus, selection.anchor]
          : [selection.anchor, selection.focus];
        textPoint.set(moved.getKey(), 1, 'text');
        elementPoint.set(parent.getKey(), offset, 'element');
        $setSelection(selection);
        first[operation](moved);
        $expectChildren(
          parent,
          operation === 'replace'
            ? [moved]
            : operation === 'insertBefore'
              ? [moved, first]
              : [first, moved],
        );
        const after = $getSelection();
        expect($isRangeSelection(after)).toBe(true);
        if ($isRangeSelection(after)) {
          const retained = backward ? after.focus : after.anchor;
          expect(retained.key).toBe(moved.getKey());
          expect(retained.type).toBe('text');
          expect(retained.offset).toBe(1);
          expect(after.anchor.getNode().isAttached()).toBe(true);
          expect(after.focus.getNode().isAttached()).toBe(true);
          // A primed direction cache must not survive the structural move.
          expect(after.isBackward()).toBe(after.clone().isBackward());
        }
      },
      {discrete: true},
    );
  },
);

test.each(['insertBefore', 'insertAfter'] as const)(
  'invalidates text-only selection direction after %s reorders siblings',
  operation => {
    using editor = buildEditorFromExtensions({name: 'move-text-endpoints'});
    editor.update(
      () => {
        const first = $createTextNode('first').toggleUnmergeable();
        const second = $createTextNode('second').toggleUnmergeable();
        const parent = $createParagraphNode().append(first, second);
        $getRoot().append(parent);
        const selection = $createRangeSelection();
        selection.anchor.set(first.getKey(), 1, 'text');
        selection.focus.set(second.getKey(), 1, 'text');
        $setSelection(selection);
        expect(selection.isBackward()).toBe(false);
        if (operation === 'insertAfter') {
          second.insertAfter(first);
        } else {
          first.insertBefore(second);
        }
        $expectChildren(parent, [second, first]);
        expect(selection.isBackward()).toBe(true);
        expect(selection.isBackward()).toBe(selection.clone().isBackward());
      },
      {discrete: true},
    );
  },
);
