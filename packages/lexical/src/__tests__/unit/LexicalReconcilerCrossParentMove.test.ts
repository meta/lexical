/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  type ElementNode,
  type LexicalNode,
  type NodeKey,
} from 'lexical';
import {
  $createTestElementNode,
  $createTestInlineElementNode,
  TestElementNode,
  TestInlineElementNode,
} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

// The reconciler reuses the DOM of a node that moves to another parent in an
// update. A new element created in a parent builds its children first; when
// one of them is a node moved out of that same parent, its DOM can be the
// sibling the new element was to be inserted before.

function buildEditor() {
  const errors: string[] = [];
  const editor = buildEditorFromExtensions({
    name: 'lexical-reconciler-cross-parent-move',
    nodes: [TestElementNode, TestInlineElementNode],
    onError: (error: Error) => {
      errors.push(error.message);
    },
  });
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  editor.setRootElement(root);
  return {editor, errors, root};
}

// The DOM a fresh editor renders for the same state.
function freshDOM(json: string): string {
  const {editor, root} = buildEditor();
  editor.setEditorState(editor.parseEditorState(json));
  const html = root.innerHTML;
  editor.dispose();
  root.remove();
  return html;
}

describe('LexicalReconciler: nodes moved between parents in one update', () => {
  test('a new inline element takes in the sibling it is inserted before', () => {
    const {editor, errors, root} = buildEditor();
    const keys: Record<string, NodeKey> = {};
    editor.update(
      () => {
        const x = $createTextNode('x');
        const lineBreak = $createLineBreakNode();
        const y = $createTextNode('y').setFormat('bold');
        const m = $createTestInlineElementNode().append($createTextNode('m'));
        const w = $createTextNode('w').setFormat('italic');
        keys.x = x.getKey();
        keys.lineBreak = lineBreak.getKey();
        keys.m = m.getKey();
        keys.w = w.getKey();
        $getRoot()
          .clear()
          .append($createParagraphNode().append(x, lineBreak, y, m, w));
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const $get = (name: string) => $getNodeByKey(keys[name]) as LexicalNode;
        const paragraph = $get('x').getParentOrThrow() as ElementNode;
        // y is removed, m moves forward, w moves into a new inline element
        // created where it was, and the line break moves to the end.
        const children = [
          $get('x'),
          $get('m'),
          $createTestInlineElementNode().append($get('w')),
          $get('lineBreak'),
        ];
        paragraph.splice(0, paragraph.getChildrenSize(), children);
      },
      {discrete: true},
    );
    expect(errors).toEqual([]);
    expect(root.innerHTML).toBe(
      freshDOM(JSON.stringify(editor.getEditorState().toJSON())),
    );
    editor.dispose();
    root.remove();
  });

  test('a nested block that takes the previous block’s place, with its inline nodes reshuffled', () => {
    const {editor, errors, root} = buildEditor();
    const keys: Record<string, NodeKey> = {};
    editor.update(
      () => {
        const $text = (name: string, text: string) => {
          const node = $createTextNode(text);
          keys[name] = node.getKey();
          return node;
        };
        const $inline = (name: string, ...children: LexicalNode[]) => {
          const node = $createTestInlineElementNode().append(...children);
          keys[name] = node.getKey();
          return node;
        };
        const $block = (name: string, ...children: LexicalNode[]) => {
          const node = $createTestElementNode().append(...children);
          keys[name] = node.getKey();
          return node;
        };
        const lineBreak = $createLineBreakNode();
        keys.lineBreak = lineBreak.getKey();
        $getRoot()
          .clear()
          .append(
            $block(
              'first',
              $text('a', 'a '),
              $inline('b', $text('bText', 'b')),
              $text('space', ' '),
              $inline('c', $text('cText', 'c')),
            ),
            $block(
              'outer',
              $block(
                'nested',
                $text('d', 'd'),
                lineBreak,
                $text('e', 'e '),
                $inline('f', $text('fText', 'f')),
                $text('g', ' g'),
              ),
              $block('other', $text('h', 'h')),
            ),
          );
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const $get = <T extends LexicalNode>(name: string) =>
          $getNodeByKey(keys[name]) as T;
        const nested = $get<ElementNode>('nested');
        const first = $get<ElementNode>('first');
        first.insertBefore(nested);
        first.remove();
        const link = $get<ElementNode>('f');
        link.append($get('e'));
        const children = [
          $get('d'),
          link,
          $get('fText'),
          $createTestInlineElementNode().append($get('g')),
          $createTextNode('d2'),
          $get('lineBreak'),
          $createTextNode('e2 '),
        ];
        nested.splice(0, nested.getChildrenSize(), children);
      },
      {discrete: true},
    );
    expect(errors).toEqual([]);
    expect(root.innerHTML).toBe(
      freshDOM(JSON.stringify(editor.getEditorState().toJSON())),
    );
    editor.dispose();
    root.remove();
  });
});
