/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  DecoratorNode,
  type LexicalEditor,
  type LexicalNode,
  type Point,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

class TestBlockDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_block_decorator', {extends: DecoratorNode});
  }

  createDOM(): HTMLElement {
    return document.createElement('div');
  }

  updateDOM(): false {
    return false;
  }

  decorate(): null {
    return null;
  }

  isInline(): false {
    return false;
  }
}

function $createTestBlockDecoratorNode(): TestBlockDecoratorNode {
  return new TestBlockDecoratorNode();
}

function mountEditor({
  adjacentElement = false,
  range,
  selectedIndex = 0,
}: {
  adjacentElement?: boolean;
  /** Seed a RangeSelection over these root offsets instead of a NodeSelection */
  range?: [anchor: number, focus: number];
  selectedIndex?: number;
} = {}) {
  const rootElement = document.createElement('div');
  rootElement.contentEditable = 'true';
  document.body.appendChild(rootElement);
  const editor = buildEditorFromExtensions({
    $initialEditorState: () => {
      const nodes = [$createTestBlockDecoratorNode()];
      if (!adjacentElement) {
        nodes.push($createTestBlockDecoratorNode());
      }
      $getRoot()
        .clear()
        .append(
          ...nodes,
          $createParagraphNode().append($createTextNode('text')),
        );
    },
    dependencies: [RichTextExtension],
    name: 'test',
    nodes: [TestBlockDecoratorNode],
  });
  editor.setRootElement(rootElement);
  rootElement.focus();
  editor.update(
    () => {
      if (range) {
        $getRoot().select(range[0], range[1]);
      } else {
        const decorator = $getRoot().getChildAtIndex(selectedIndex)!;
        const selection = $createNodeSelection();
        selection.add(decorator.getKey());
        $setSelection(selection);
      }
    },
    {discrete: true},
  );

  onTestFinished(() => {
    editor.setRootElement(null);
    rootElement.remove();
    editor.dispose();
  });

  return editor;
}

/**
 * Node keys differ between editors, so describe every node by its index path
 * from the root to compare selections across two editors.
 */
function $getPath(node: LexicalNode): number[] {
  const path = [];
  for (
    let current: LexicalNode | null = node;
    current !== null && current.getParent() !== null;
    current = current.getParent()
  ) {
    path.unshift(current.getIndexWithinParent());
  }
  return path;
}

function $describePoint(point: Point) {
  return {
    offset: point.offset,
    path: $getPath(point.getNode()),
    type: point.type,
  };
}

/** A key-independent description of the editor's RangeSelection. */
function describeSelection(editor: LexicalEditor) {
  return editor.read(() => {
    const selection = $getSelection();
    assert($isRangeSelection(selection));
    return {
      anchor: $describePoint(selection.anchor),
      focus: $describePoint(selection.focus),
      isCollapsed: selection.isCollapsed(),
      nodes: selection.getNodes().map($getPath),
    };
  });
}

/**
 * A contiguous NodeSelection is converted to the RangeSelection covering the
 * same siblings, oriented toward the arrow key, and then the regular
 * RangeSelection handling runs. `converted` is that RangeSelection, expressed
 * as root offsets, so each case can be compared against pressing the same key
 * with that selection already in place.
 */
const CASES: {
  converted: [anchor: number, focus: number];
  key: string;
  selectedIndex: number;
}[] = [
  {converted: [0, 1], key: 'ArrowRight', selectedIndex: 0},
  {converted: [0, 1], key: 'ArrowDown', selectedIndex: 0},
  {converted: [2, 1], key: 'ArrowLeft', selectedIndex: 1},
  {converted: [2, 1], key: 'ArrowUp', selectedIndex: 1},
];

describe('Shift+Arrow on a NodeSelection (#9062)', () => {
  // The regression from #9062: every arrow key collapsed the NodeSelection to
  // a caret next to the decorator, even with shift held. `describeSelection`
  // also asserts that the selection is a RangeSelection rather than a
  // NodeSelection. Which nodes end up selected is asserted per direction
  // below, because the browsers do not agree on vertical extension.
  test.for(CASES)(
    '$key on the decorator at index $selectedIndex leaves a non-collapsed RangeSelection',
    async ({key, selectedIndex}) => {
      const editor = mountEditor({selectedIndex});

      await userEvent.keyboard(`{Shift>}{${key}}{/Shift}`);

      expect(describeSelection(editor).isCollapsed).toBe(false);
    },
  );

  test.for(
    CASES.filter(({key}) => key === 'ArrowLeft' || key === 'ArrowRight'),
  )(
    '$key extends over the adjacent decorator like the equivalent RangeSelection',
    async ({converted, key, selectedIndex}) => {
      const nodeSelectionEditor = mountEditor({selectedIndex});

      await userEvent.keyboard(`{Shift>}{${key}}{/Shift}`);

      nodeSelectionEditor.read(() => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        const selectedNodes = selection.getNodes();
        expect(selectedNodes).toContain($getRoot().getChildAtIndex(0));
        expect(selectedNodes).toContain($getRoot().getChildAtIndex(1));
        expect(selectedNodes).not.toContain($getRoot().getChildAtIndex(2));
      });

      const rangeSelectionEditor = mountEditor({range: converted});

      await userEvent.keyboard(`{Shift>}{${key}}{/Shift}`);

      expect(describeSelection(rangeSelectionEditor)).toEqual(
        describeSelection(nodeSelectionEditor),
      );
    },
  );

  /**
   * Vertical extension is left to the browser's default action, and where it
   * lands depends on the rendered layout (the browsers do not agree), so the
   * outcome is only asserted against pressing the same key with the converted
   * RangeSelection already in place. This is what the synchronous commit in
   * `$convertContiguousNodeSelection` buys: without it Firefox extends nothing
   * on the first press, because the conversion would reach the DOM only after
   * the keydown listeners return.
   */
  test.for(CASES.filter(({key}) => key === 'ArrowUp' || key === 'ArrowDown'))(
    '$key extends like the equivalent RangeSelection',
    async ({converted, key, selectedIndex}) => {
      const nodeSelectionEditor = mountEditor({selectedIndex});

      await userEvent.keyboard(`{Shift>}{${key}}{/Shift}`);

      const nodeSelectionResult = describeSelection(nodeSelectionEditor);

      const rangeSelectionEditor = mountEditor({range: converted});

      await userEvent.keyboard(`{Shift>}{${key}}{/Shift}`);

      expect(describeSelection(rangeSelectionEditor)).toEqual(
        nodeSelectionResult,
      );
    },
  );

  test('ArrowRight extends from a decorator into an adjacent element', async () => {
    const editor = mountEditor({adjacentElement: true});

    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');

    editor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      expect(selection.isCollapsed()).toBe(false);
      const selectedNodes = selection.getNodes();
      const decorator = $getRoot().getChildAtIndex(0)!;
      const paragraph = $getRoot().getChildAtIndex(1)!;
      expect(selectedNodes).toContain(decorator);
      expect(
        selectedNodes.some(
          node => node === paragraph || node.getParent() === paragraph,
        ),
      ).toBe(true);
    });
  });
});
