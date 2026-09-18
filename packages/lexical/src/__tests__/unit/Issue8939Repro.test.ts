/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  $needsBlockCursorBeside,
  type LexicalNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

import {
  $assertNodeType,
  $createTestDecoratorNode,
  $createTestShadowRootNode,
  $isTestShadowRootNode,
  TestDecoratorNode,
  TestShadowRootNode,
} from '../utils';

const ext = defineExtension({
  dependencies: [RichTextExtension],
  name: '[8939]',
  nodes: [TestDecoratorNode, TestShadowRootNode],
});

function $blockDecorator(): LexicalNode {
  return $createTestDecoratorNode().setIsInline(false);
}

function $shadowRoot(label: string): LexicalNode {
  return $createTestShadowRootNode().append(
    $createParagraphNode().append($createTextNode(label)),
  );
}

// The block cursor is what Lexical renders when the selection is an element
// point directly beside a node that `$needsBlockCursorBeside`. There is no
// text position there, so Backspace/Delete can only mean "remove that node".
// That already worked for a block DecoratorNode, but a shadow-root
// ElementNode host (a table, or a slot-bearing card) was left untouched.
describe('block cursor deletion beside an ElementNode (#8939)', () => {
  test.for([
    {isBackward: true, kind: 'decorator' as const},
    {isBackward: false, kind: 'decorator' as const},
    {isBackward: true, kind: 'shadowRoot' as const},
    {isBackward: false, kind: 'shadowRoot' as const},
  ])(
    'deletes the adjacent $kind (isBackward: $isBackward)',
    ({kind, isBackward}) => {
      using editor = buildEditorFromExtensions(ext);
      const $make =
        kind === 'decorator' ? $blockDecorator : () => $shadowRoot('x');
      let keyA = '';
      let keyB = '';

      editor.update(
        () => {
          const a = $make();
          const b = $make();
          keyA = a.getKey();
          keyB = b.getKey();
          $getRoot().clear().append(a, b);
          // The block cursor position between the two nodes.
          $getRoot().select(1, 1);
        },
        {discrete: true},
      );

      editor.read(() => {
        // Both sides render a block cursor, so both must delete the same way.
        expect($needsBlockCursorBeside($getRoot().getChildAtIndex(0))).toBe(
          true,
        );
        expect($needsBlockCursorBeside($getRoot().getChildAtIndex(1))).toBe(
          true,
        );
      });

      editor.update(
        () => {
          const selection = $getSelection();
          assert($isRangeSelection(selection), 'Expected RangeSelection');
          selection.deleteCharacter(isBackward);
        },
        {discrete: true},
      );

      editor.read(() => {
        expect($getRoot().getChildrenSize()).toBe(1);
        // Backspace removes the node before the cursor, Delete the one after.
        expect($getRoot().getChildAtIndex(0)!.getKey()).toBe(
          isBackward ? keyB : keyA,
        );
      });
    },
  );

  test('Backspace after the last shadow root deletes it', () => {
    using editor = buildEditorFromExtensions(ext);

    editor.update(
      () => {
        $getRoot().clear().append($shadowRoot('A'), $shadowRoot('B'));
        $getRoot().select(2, 2);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.deleteCharacter(true);
      },
      {discrete: true},
    );

    editor.read(() => {
      expect($getRoot().getChildrenSize()).toBe(1);
      expect($getRoot().getTextContent()).toBe('A');
    });
  });

  // Removing the last top-level node would otherwise leave the root with no
  // children at all, so there is nowhere left to put a caret.
  test.for([{kind: 'decorator' as const}, {kind: 'shadowRoot' as const}])(
    'deleting the only $kind leaves the root editable',
    ({kind}) => {
      using editor = buildEditorFromExtensions(ext);
      const $make =
        kind === 'decorator' ? $blockDecorator : () => $shadowRoot('A');

      editor.update(
        () => {
          $getRoot().clear().append($make());
          $getRoot().select(1, 1);
        },
        {discrete: true},
      );

      editor.update(
        () => {
          const selection = $getSelection();
          assert($isRangeSelection(selection), 'Expected RangeSelection');
          selection.deleteCharacter(true);
        },
        {discrete: true},
      );

      editor.read(() => {
        const children = $getRoot().getChildren();
        expect(children).toHaveLength(1);
        const paragraph = $assertNodeType(children[0], $isParagraphNode);
        expect(paragraph.isEmpty()).toBe(true);
        // The caret is inside the restored paragraph, not on the root before
        // it, so the next keystroke acts on the paragraph.
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        expect(selection.anchor.getNode().getKey()).toBe(paragraph.getKey());
      });

      // Enter therefore behaves as it does in any other document holding a
      // single empty paragraph: the caret ends up in the second one.
      editor.update(
        () => {
          const selection = $getSelection();
          assert($isRangeSelection(selection), 'Expected RangeSelection');
          selection.insertParagraph();
          selection.insertText('X');
        },
        {discrete: true},
      );

      editor.read(() => {
        expect(
          $getRoot()
            .getChildren()
            .map(child =>
              $assertNodeType(child, $isParagraphNode).getTextContent(),
            ),
        ).toEqual(['', 'X']);
      });
    },
  );

  // The same rule one level down: a shadow root emptied by the deletion has
  // nowhere to put a caret either.
  test('deleting the only block inside a shadow root keeps it editable', () => {
    using editor = buildEditorFromExtensions(ext);

    editor.update(
      () => {
        const shadow = $createTestShadowRootNode().append($blockDecorator());
        $getRoot().clear().append(shadow);
        shadow.select(1, 1);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.deleteCharacter(true);
      },
      {discrete: true},
    );

    editor.read(() => {
      const shadow = $assertNodeType(
        $getRoot().getFirstChild(),
        $isTestShadowRootNode,
      );
      // Previously the shadow root was left with no children at all and the
      // caret on the shadow root itself.
      expect(shadow.getChildrenSize()).toBe(1);
      const paragraph = $assertNodeType(
        shadow.getFirstChild(),
        $isParagraphNode,
      );
      expect(paragraph.isEmpty()).toBe(true);
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'Expected RangeSelection');
      expect(selection.anchor.getNode().getKey()).toBe(paragraph.getKey());
    });
  });

  // Guard the boundary of the new branch: an empty block whose caret merely
  // sits next to a shadow root is not a block cursor, so the existing
  // "remove the empty block, keep the shadow root" behaviour must survive.
  test('Backspace in an empty block after a shadow root removes the block, not the shadow root', () => {
    using editor = buildEditorFromExtensions(ext);

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().clear().append($shadowRoot('A'), paragraph);
        paragraph.select(0, 0);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.deleteCharacter(true);
      },
      {discrete: true},
    );

    editor.read(() => {
      expect($getRoot().getChildrenSize()).toBe(1);
      expect($getRoot().getTextContent()).toBe('A');
    });
  });

  // Deleting all of a shadow root's content restores the empty paragraph the
  // same way the document root does, so Enter over that selection does not
  // depend on whether the selection is described with element or text points
  // ($selectAll scoped to a top-level shadow root produces the former).
  test.for([{points: 'element' as const}, {points: 'text' as const}])(
    'Enter over all of a shadow root splits an empty paragraph ($points points)',
    ({points}) => {
      using editor = buildEditorFromExtensions(ext);

      editor.update(
        () => {
          const shadow = $createTestShadowRootNode().append(
            $createParagraphNode().append($createTextNode('inside')),
          );
          $getRoot().clear().append(shadow);
          if (points === 'element') {
            shadow.select(0, shadow.getChildrenSize());
          } else {
            const paragraph = $assertNodeType(
              shadow.getFirstChild(),
              $isParagraphNode,
            );
            const selection = paragraph.select(0, 0);
            selection.focus.set(
              paragraph.getFirstChildOrThrow().getKey(),
              'inside'.length,
              'text',
            );
          }
        },
        {discrete: true},
      );

      editor.update(
        () => {
          const selection = $getSelection();
          assert($isRangeSelection(selection), 'Expected RangeSelection');
          selection.insertParagraph();
        },
        {discrete: true},
      );

      editor.read(() => {
        const shadow = $assertNodeType(
          $getRoot().getFirstChild(),
          $isTestShadowRootNode,
        );
        const paragraphs = shadow
          .getChildren()
          .map(child => $assertNodeType(child, $isParagraphNode));
        expect(paragraphs.map(paragraph => paragraph.isEmpty())).toEqual([
          true,
          true,
        ]);
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        expect(selection.anchor.getNode().getKey()).toBe(
          paragraphs[1].getKey(),
        );
      });
    },
  );

  // A plain paragraph never renders a block cursor, so it must not be
  // removed as a unit.
  test('a paragraph does not need a block cursor beside it', () => {
    using editor = buildEditorFromExtensions(ext);

    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('A')));
      },
      {discrete: true},
    );

    editor.read(() => {
      expect($needsBlockCursorBeside($getRoot().getChildAtIndex(0))).toBe(
        false,
      );
    });
  });
});
