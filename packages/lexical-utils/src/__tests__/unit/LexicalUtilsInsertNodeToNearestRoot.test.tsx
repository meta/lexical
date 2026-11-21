/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$generateHtmlFromNodes, $generateNodesFromDOM} from '@lexical/html';
import {$insertNodeToNearestRoot} from '@lexical/utils';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  $setSelection,
  type BaseSelection,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
} from 'lexical';
import {
  $createTestDecoratorNode,
  $createTestShadowRootNode,
  createTestEditor,
} from 'lexical/src/__tests__/utils';
import {beforeEach, describe, expect, it, vi} from 'vitest';

describe('LexicalUtils#insertNodeToNearestRoot', () => {
  let editor: LexicalEditor;

  const update = async (updateFn: () => void) => {
    editor.update(updateFn);
    await Promise.resolve();
  };

  beforeEach(async () => {
    editor = createTestEditor();
    editor._headless = true;
  });

  const testCases: {
    _: string;
    expectedHtml: string;
    initialHtml: string;
    selectionPath: number[];
    selectionOffset: number;
    only?: boolean;
  }[] = [
    {
      _: 'insert into paragraph in between two text nodes',
      expectedHtml:
        '<p><span style="white-space: pre-wrap;">Hello</span></p><test-decorator></test-decorator><p><span style="white-space: pre-wrap;">world</span></p>',
      initialHtml: '<p><span>Helloworld</span></p>',
      selectionOffset: 5, // Selection on text node after "Hello" world
      selectionPath: [0, 0],
    },
    {
      _: 'insert into nested list items',
      expectedHtml:
        '<ul>' +
        '<li><span style="white-space: pre-wrap;">Before</span><ul><li><span style="white-space: pre-wrap;">Hello</span></li></ul></li>' +
        '</ul>' +
        '<test-decorator></test-decorator>' +
        '<ul>' +
        '<li><ul><li><span style="white-space: pre-wrap;">world</span></li></ul></li>' +
        '<li><span style="white-space: pre-wrap;">After</span></li>' +
        '</ul>',
      initialHtml:
        '<ul>' +
        '<li><span>Before</span></li>' +
        '<ul><li><span>Helloworld</span></li></ul>' +
        '<li><span>After</span></li>' +
        '</ul>',
      selectionOffset: 5, // Selection on text node after "Hello" world
      selectionPath: [0, 1, 0, 0, 0],
    },
    {
      _: 'insert into empty paragraph',
      expectedHtml: '<p><br></p><test-decorator></test-decorator><p><br></p>',
      initialHtml: '<p></p>',
      selectionOffset: 0, // Selection on text node after "Hello" world
      selectionPath: [0],
    },
    {
      _: 'insert in the end of paragraph',
      expectedHtml:
        '<p><span style="white-space: pre-wrap;">Hello world</span></p>' +
        '<test-decorator></test-decorator>' +
        '<p><br></p>',
      initialHtml: '<p>Hello world</p>',
      selectionOffset: 'Hello world'.length, // Selection on text node after "Hello" world
      selectionPath: [0, 0],
    },
    {
      // The empty paragraph created by splitting at the end of a block is
      // only useful when nothing follows it, otherwise it is spurious (#5433)
      _: 'insert in the end of paragraph that is followed by another block',
      expectedHtml:
        '<p><span style="white-space: pre-wrap;">Hello world</span></p>' +
        '<test-decorator></test-decorator>' +
        '<p><span style="white-space: pre-wrap;">Second</span></p>',
      initialHtml: '<p>Hello world</p><p>Second</p>',
      selectionOffset: 'Hello world'.length,
      selectionPath: [0, 0],
    },
    {
      _: 'insert in the end of the last nested list item',
      expectedHtml:
        '<ul>' +
        '<li><span style="white-space: pre-wrap;">Before</span><ul><li><span style="white-space: pre-wrap;">Hello</span></li></ul></li>' +
        '</ul>' +
        '<test-decorator></test-decorator>' +
        '<ul>' +
        '<li><span style="white-space: pre-wrap;">After</span></li>' +
        '</ul>',
      initialHtml:
        '<ul>' +
        '<li><span>Before</span></li>' +
        '<ul><li><span>Hello</span></li></ul>' +
        '<li><span>After</span></li>' +
        '</ul>',
      selectionOffset: 'Hello'.length,
      selectionPath: [0, 1, 0, 0, 0],
    },
    {
      _: 'insert in the beginning of paragraph',
      expectedHtml:
        '<p><br></p>' +
        '<test-decorator></test-decorator>' +
        '<p><span style="white-space: pre-wrap;">Hello world</span></p>',
      initialHtml: '<p>Hello world</p>',
      selectionOffset: 0, // Selection on text node before "Hello" world
      selectionPath: [0, 0],
    },
    {
      _: 'insert with selection on root start',
      expectedHtml:
        '<test-decorator></test-decorator>' +
        '<test-decorator></test-decorator>' +
        '<p><span style="white-space: pre-wrap;">Before</span></p>' +
        '<p><span style="white-space: pre-wrap;">After</span></p>',
      initialHtml:
        '<test-decorator></test-decorator>' +
        '<p><span>Before</span></p>' +
        '<p><span>After</span></p>',
      selectionOffset: 0,
      selectionPath: [],
    },
    {
      _: 'insert with selection on root child',
      expectedHtml:
        '<p><span style="white-space: pre-wrap;">Before</span></p>' +
        '<test-decorator></test-decorator>' +
        '<p><span style="white-space: pre-wrap;">After</span></p>',
      initialHtml: '<p>Before</p><p>After</p>',
      selectionOffset: 1,
      selectionPath: [],
    },
    {
      _: 'insert with selection on root end',
      expectedHtml:
        '<p><span style="white-space: pre-wrap;">Before</span></p>' +
        '<test-decorator></test-decorator>',
      initialHtml: '<p>Before</p>',
      selectionOffset: 1,
      selectionPath: [],
    },
  ];

  for (const testCase of testCases) {
    it(testCase._, async () => {
      await update(() => {
        // Running init, update, assert in the same update loop
        // to skip text nodes normalization (then separate text
        // nodes will still be separate and represented by its own
        // spans in html output) and make assertions more precise
        const parser = new DOMParser();
        const dom = parser.parseFromString(testCase.initialHtml, 'text/html');
        const nodesToInsert = $generateNodesFromDOM(editor, dom);
        $getRoot()
          .clear()
          .append(...nodesToInsert);

        let selectionNode: LexicalNode = $getRoot();
        for (const index of testCase.selectionPath) {
          if (!$isElementNode(selectionNode)) {
            throw new Error(
              'Expected node to be element (to traverse the tree)',
            );
          }
          selectionNode = selectionNode.getChildAtIndex(index)!;
        }

        // Calling selectionNode.select() would "normalize" selection and move it
        // to text node (if available), while for the purpose of the test we'd want
        // to use whatever was passed (e.g. keep selection on root node)
        const selection = $createRangeSelection();
        const type = $isElementNode(selectionNode) ? 'element' : 'text';
        selection.anchor.set(
          selectionNode.getKey(),
          testCase.selectionOffset,
          type,
        );
        selection.focus.set(
          selectionNode.getKey(),
          testCase.selectionOffset,
          type,
        );
        $setSelection(selection);

        $insertNodeToNearestRoot($createTestDecoratorNode().setIsInline(false));

        // Cleaning up list value attributes as it's not really needed in this test
        // and it clutters expected output
        const actualHtml = $generateHtmlFromNodes(editor).replace(
          /\svalue="\d{1,}"/g,
          '',
        );
        expect(actualHtml).toEqual(testCase.expectedHtml);
      });
    });
  }

  it.each([false, true])(
    'inserts at the end of the focus block container for a non-range selection (empty: %s)',
    empty => {
      let focusKey: NodeKey;
      let paragraphKey: NodeKey | undefined;
      let lastSelectedKey: NodeKey;
      let insertedKey: NodeKey;
      editor.update(
        () => {
          const focus = $createTestShadowRootNode();
          if (!empty) {
            const paragraph = $createParagraphNode().append(
              $createTextNode('inside'),
            );
            focus.append(paragraph);
            paragraphKey = paragraph.getKey();
          }
          const lastSelected = $createTestDecoratorNode().setIsInline(false);
          $getRoot().clear().append(focus, lastSelected);
          focusKey = focus.getKey();
          lastSelectedKey = lastSelected.getKey();
          const points = $createRangeSelection();
          points.focus.set(focusKey, 0, 'element');
          const nodeSelection = $createNodeSelection();
          nodeSelection.add(lastSelectedKey);
          const selection: BaseSelection = nodeSelection;
          // Model a non-range selection that exposes focus points.
          vi.spyOn(selection, 'getStartEndPoints').mockReturnValue([
            points.anchor,
            points.focus,
          ]);
          $setSelection(selection);
          insertedKey = $insertNodeToNearestRoot(
            $createTestDecoratorNode().setIsInline(false),
          ).getKey();
        },
        {discrete: true},
      );
      editor.read(() => {
        const focus = $getNodeByKey(focusKey);
        const inserted = $getNodeByKey(insertedKey);
        if (!$isElementNode(focus)) {
          throw new Error('Expected the focus container to remain an element');
        }
        expect(inserted?.isAttached()).toBe(true);
        expect(inserted?.getParent()?.getKey()).toBe(focusKey);
        const expectedChildren =
          paragraphKey === undefined
            ? [insertedKey]
            : [paragraphKey, insertedKey];
        expect(
          focus.getChildrenKeys().slice(0, expectedChildren.length),
        ).toEqual(expectedChildren);
        if (paragraphKey !== undefined) {
          expect($getNodeByKey(paragraphKey)?.getTextContent()).toBe('inside');
        }
        expect($getRoot().getLastChild()?.getKey()).toBe(lastSelectedKey);
      });
    },
  );

  it('keeps inserting after the selected node for a NodeSelection', () => {
    let selectedKey: NodeKey;
    let insertedKey: NodeKey;
    let beforeKey: NodeKey;
    let afterKey: NodeKey;
    editor.update(
      () => {
        const before = $createParagraphNode().append($createTextNode('before'));
        const selected = $createTestDecoratorNode().setIsInline(false);
        const after = $createParagraphNode().append($createTextNode('after'));
        $getRoot().clear().append(before, selected, after);
        beforeKey = before.getKey();
        selectedKey = selected.getKey();
        afterKey = after.getKey();
        const selection = $createNodeSelection();
        selection.add(selectedKey);
        $setSelection(selection);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        insertedKey = $insertNodeToNearestRoot(
          $createTestDecoratorNode().setIsInline(false),
        ).getKey();
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($getRoot().getChildrenKeys()).toEqual([
        beforeKey,
        selectedKey,
        insertedKey,
        afterKey,
      ]);
    });
  });

  it('keeps inserting at the document end when there is no selection', () => {
    let insertedKey: NodeKey;
    let beforeKey: NodeKey;
    editor.update(
      () => {
        const before = $createParagraphNode().append($createTextNode('before'));
        $getRoot().clear().append(before);
        beforeKey = before.getKey();
        $setSelection(null);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        insertedKey = $insertNodeToNearestRoot(
          $createTestDecoratorNode().setIsInline(false),
        ).getKey();
      },
      {discrete: true},
    );
    editor.read(() => {
      const root = $getRoot();
      const inserted = $getNodeByKey(insertedKey);
      expect(inserted?.isAttached()).toBe(true);
      expect(inserted?.getParent()?.getKey()).toBe(root.getKey());
      expect(root.getFirstChild()?.getKey()).toBe(beforeKey);
      expect(root.getChildrenKeys().indexOf(insertedKey)).toBeGreaterThan(0);
      expect($getNodeByKey(beforeKey)?.getTextContent()).toBe('before');
    });
  });
});
