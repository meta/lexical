/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  $selectAll,
  defineExtension,
  type LexicalNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, it} from 'vitest';

import {
  $createLayoutContainerNode,
  $isLayoutContainerNode,
} from '../../src/nodes/LayoutContainerNode';
import {
  $createLayoutItemNode,
  $isLayoutItemNode,
} from '../../src/nodes/LayoutItemNode';
import {LayoutExtension} from '../../src/plugins/LayoutExtension/LayoutExtension';

const LayoutTestExtension = defineExtension({
  $initialEditorState: null,
  dependencies: [LayoutExtension],
  name: '[test-layout]',
});

function $createColumns() {
  const container = $createLayoutContainerNode('1fr 1fr');
  const item1 = $createLayoutItemNode();
  item1.append($createParagraphNode().append($createTextNode('col1')));
  const item2 = $createLayoutItemNode();
  item2.append($createParagraphNode().append($createTextNode('col2')));
  return container.append(item1, item2);
}

function describeNode(node: LexicalNode): string {
  return $isElementNode(node)
    ? `${node.getType()}(${node.getChildren().map(describeNode).join(',')})`
    : `${node.getType()}[${node.getTextContent()}]`;
}

function $describeRoot(): string {
  return $getRoot().getChildren().map(describeNode).join('|');
}

describe('Select-all + delete over a columns layout (#6938)', () => {
  it('removes the widget when it is the first node', () => {
    using editor = buildEditorFromExtensions(LayoutTestExtension);
    editor.update(() => void $getRoot().clear().append($createColumns()), {
      discrete: true,
    });

    editor.update(
      () => {
        const selection = $selectAll();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.deleteCharacter(true);
      },
      {discrete: true},
    );

    editor.read(() => {
      // Previously the container survived with two empty layout items.
      expect($describeRoot()).toBe('paragraph()');
      expect(
        $assertNodeType($getRoot().getFirstChild(), $isParagraphNode).isEmpty(),
      ).toBe(true);
    });
  });

  it('removes the widget when it is the first node via removeText', () => {
    using editor = buildEditorFromExtensions(LayoutTestExtension);
    editor.update(() => void $getRoot().clear().append($createColumns()), {
      discrete: true,
    });

    editor.update(() => void $selectAll().removeText(), {discrete: true});

    editor.read(() => {
      expect($describeRoot()).toBe('paragraph()');
    });
  });

  it('replaces the widget when typing over a select-all', () => {
    using editor = buildEditorFromExtensions(LayoutTestExtension);
    editor.update(() => void $getRoot().clear().append($createColumns()), {
      discrete: true,
    });

    editor.update(
      () => {
        const selection = $selectAll();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.insertText('typed');
      },
      {discrete: true},
    );

    editor.read(() => {
      expect($describeRoot()).toBe('paragraph(text[typed])');
    });
  });

  it('replaces the widget when Enter is pressed over a select-all', () => {
    using editor = buildEditorFromExtensions(LayoutTestExtension);
    editor.update(() => void $getRoot().clear().append($createColumns()), {
      discrete: true,
    });

    editor.update(
      () => {
        const selection = $selectAll();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.insertParagraph();
      },
      {discrete: true},
    );

    editor.read(() => {
      // insertParagraph's root/shadow-root branch only splices a paragraph
      // in, so without removing the selection first it left the widget in
      // place and merely prepended an empty paragraph. Two empty paragraphs
      // is what Enter over a select-all of ordinary paragraphs produces.
      expect($describeRoot()).toBe('paragraph()|paragraph()');
    });
  });

  it('already worked, and still works, with a paragraph before the widget', () => {
    using editor = buildEditorFromExtensions(LayoutTestExtension);
    editor.update(
      () =>
        void $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('before')),
            $createColumns(),
          ),
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $selectAll();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.deleteCharacter(true);
      },
      {discrete: true},
    );

    editor.read(() => {
      expect($describeRoot()).toBe('paragraph()');
    });
  });

  it('keeps select-all scoped to a single column when the caret is inside one', () => {
    using editor = buildEditorFromExtensions(LayoutTestExtension);
    editor.update(() => void $getRoot().clear().append($createColumns()), {
      discrete: true,
    });

    editor.update(
      () => {
        const container = $assertNodeType(
          $getRoot().getFirstChild(),
          $isLayoutContainerNode,
        );
        const item = $assertNodeType(
          container.getFirstChild(),
          $isLayoutItemNode,
        );
        const paragraph = $assertNodeType(
          item.getFirstChild(),
          $isParagraphNode,
        );
        const selection = $selectAll(paragraph.select(0, 0));
        selection.removeText();
      },
      {discrete: true},
    );

    editor.read(() => {
      // Only the first column is cleared; the widget and the other column
      // are untouched.
      expect($describeRoot()).toBe(
        'layout-container(layout-item(paragraph()),layout-item(paragraph(text[col2])))',
      );
    });
  });
});
