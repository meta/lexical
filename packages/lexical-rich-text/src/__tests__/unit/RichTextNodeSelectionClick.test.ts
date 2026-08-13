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
  $isElementNode,
  $isNodeSelection,
  $setSelection,
  CLICK_COMMAND,
  type LexicalEditor,
} from 'lexical';
import {
  $createTestDecoratorNode,
  TestDecoratorNode,
} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

function makeClick(target: EventTarget | null): MouseEvent {
  const event = new MouseEvent('click', {bubbles: true, cancelable: true});
  Object.defineProperty(event, 'target', {value: target});
  return event;
}

function createEditor(inline: boolean) {
  return buildEditorFromExtensions({
    $initialEditorState: () => {
      const decorator = $createTestDecoratorNode().setIsInline(inline);
      if (inline) {
        // Inline decorator flows inside the paragraph, as in #8907.
        $getRoot().append(
          $createParagraphNode().append($createTextNode('before'), decorator),
        );
      } else {
        // Block decorator sits at root level, next to the paragraph.
        $getRoot().append(
          $createParagraphNode().append($createTextNode('before')),
          decorator,
        );
      }
    },
    dependencies: [RichTextExtension],
    name: 'test',
    nodes: [TestDecoratorNode],
    register: editor => {
      const rootElement = document.createElement('div');
      document.body.appendChild(rootElement);
      editor.setRootElement(rootElement);
      return () => rootElement.remove();
    },
  });
}

/** The decorator is the last root child (block) or its last child (inline). */
function $decorator(): TestDecoratorNode {
  const last = $getRoot().getLastChild()!;
  if ($isElementNode(last)) {
    return last.getLastChild() as TestDecoratorNode;
  }
  return last as TestDecoratorNode;
}

function selectDecorator(editor: LexicalEditor): void {
  editor.update(
    () => {
      const selection = $createNodeSelection();
      selection.add($decorator().getKey());
      $setSelection(selection);
    },
    {discrete: true},
  );
}

function decoratorKey(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => $decorator().getKey());
}

describe('CLICK_COMMAND on a NodeSelection', () => {
  // Regression for facebook/lexical#8907: a click on an already-selected
  // decorator used to clear the NodeSelection, so click-to-select inline
  // decorators (whose click handler sets the NodeSelection) lost their
  // selection immediately. A click inside the selected node's DOM is an
  // interaction with that node, not a deselect gesture.
  test('inline decorator: click inside the node keeps the selection', () => {
    using editor = createEditor(true);
    selectDecorator(editor);

    const key = decoratorKey(editor);
    const decoratorDOM = editor.getElementByKey(key)!;
    const target = document.createElement('span');
    decoratorDOM.appendChild(target);

    const handled = editor.dispatchCommand(CLICK_COMMAND, makeClick(target));
    expect(handled).toBe(false);

    editor.read(() => {
      const selection = $getSelection();
      if ($isNodeSelection(selection)) {
        expect(selection.has(key)).toBe(true);
      } else {
        expect.fail('expected a NodeSelection');
      }
    });
  });

  test('block decorator: click inside the node keeps the selection', () => {
    using editor = createEditor(false);
    selectDecorator(editor);

    const key = decoratorKey(editor);
    const decoratorDOM = editor.getElementByKey(key)!;
    const target = document.createElement('span');
    decoratorDOM.appendChild(target);

    const handled = editor.dispatchCommand(CLICK_COMMAND, makeClick(target));
    expect(handled).toBe(false);

    editor.read(() => {
      const selection = $getSelection();
      if ($isNodeSelection(selection)) {
        expect(selection.has(key)).toBe(true);
      } else {
        expect.fail('expected a NodeSelection');
      }
    });
  });

  test('click outside the selected node still deselects', () => {
    using editor = createEditor(true);
    selectDecorator(editor);

    const outside = document.createElement('div');

    const handled = editor.dispatchCommand(CLICK_COMMAND, makeClick(outside));
    expect(handled).toBe(true);

    editor.read(() => {
      const selection = $getSelection();
      expect(selection).toBeNull();
    });
  });

  test('click with a non-element target still deselects', () => {
    using editor = createEditor(true);
    selectDecorator(editor);

    const handled = editor.dispatchCommand(CLICK_COMMAND, makeClick(null));
    expect(handled).toBe(true);

    editor.read(() => {
      const selection = $getSelection();
      expect(selection).toBeNull();
    });
  });
});
