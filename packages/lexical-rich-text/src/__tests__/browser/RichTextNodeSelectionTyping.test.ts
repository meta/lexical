/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createHorizontalRuleNode,
  $isHorizontalRuleNode,
  buildEditorFromExtensions,
  HorizontalRuleExtension,
} from '@lexical/extension';
import {
  $createHeadingNode,
  $isHeadingNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getRoot,
  $getSelection,
  $isNodeSelection,
  $setSelection,
  DecoratorNode,
  type ElementNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

class TestControlsNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_controls', {extends: DecoratorNode});
  }

  createDOM(): HTMLElement {
    const doc = $getDocument();
    const element = doc.createElement('div');
    element.contentEditable = 'false';
    const button = doc.createElement('button');
    button.textContent = 'Activate';
    const select = doc.createElement('select');
    for (const text of ['Apple', 'Quince']) {
      const option = doc.createElement('option');
      option.textContent = text;
      option.value = text;
      select.appendChild(option);
    }
    element.append(button, select);
    return element;
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

function mountEditor(
  followedBy: string | null,
  $block: () => ElementNode = $createParagraphNode,
  $decorator: () => DecoratorNode<unknown> = $createHorizontalRuleNode,
) {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  const editor = buildEditorFromExtensions({
    $initialEditorState: () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('before')),
        $decorator(),
      );
      if (followedBy !== null) {
        const block = $block();
        if (followedBy !== '') {
          block.append($createTextNode(followedBy));
        }
        $getRoot().append(block);
      }
      $getRoot().selectEnd();
    },
    dependencies: [RichTextExtension, HorizontalRuleExtension],
    name: 'node-selection-typing',
    nodes: [TestControlsNode],
  });
  editor.setRootElement(root);
  root.focus();
  onTestFinished(() => {
    editor.dispose();
    root.remove();
  });
  return {editor, root};
}

describe('native typing after a selected block decorator', () => {
  test.for([false, true])(
    'inserts an AltGraph keydown with ctrlKey=%s after a selected divider',
    async ctrlKey => {
      const {editor, root} = mountEditor('after');
      const divider = root.querySelector('hr')!;
      await userEvent.click(divider);
      await expect.element(divider).toHaveClass('selected');
      const event = new KeyboardEvent('keydown', {
        altKey: true,
        bubbles: true,
        cancelable: true,
        ctrlKey,
        key: '@',
        modifierAltGraph: true,
      });
      expect(event.getModifierState('AltGraph')).toBe(true);

      root.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(
        editor.read(() =>
          $getRoot()
            .getChildren()
            .map(node =>
              $isHorizontalRuleNode(node) ? '<divider>' : node.getTextContent(),
            ),
        ),
      ).toEqual(['before', '<divider>', '@', 'after']);
    },
  );

  test.for(['button', 'select'] as const)(
    "leaves keyboard input in a selected decorator's %s",
    async tag => {
      const {editor, root} = mountEditor(
        'after',
        $createParagraphNode,
        () => new TestControlsNode(),
      );
      editor.update(
        () => {
          const selection = $createNodeSelection();
          selection.add($getRoot().getChildAtIndex(1)!.getKey());
          $setSelection(selection);
        },
        {discrete: true},
      );
      const button = root.querySelector('button')!;
      const select = root.querySelector('select')!;
      await userEvent.click(button);
      const target = tag === 'button' ? button : select;
      target.focus();
      expect(document.activeElement).toBe(target);
      expect(editor.read(() => $isNodeSelection($getSelection()))).toBe(true);
      const original = editor.getEditorState().toJSON();

      if (tag === 'button') {
        let activations = 0;
        button.addEventListener('click', () => activations++);
        await userEvent.keyboard(' ');
        expect(activations).toBe(1);
      } else {
        await userEvent.keyboard('q');
        expect(select.value).toBe('Quince');
      }

      expect(editor.getEditorState().toJSON()).toEqual(original);
    },
  );

  test.for([
    {
      expected: ['before', '<divider>', 'New text', 'after'],
      followedBy: 'after',
      heading: false,
      name: 'a nonempty paragraph',
    },
    {
      expected: ['before', '<divider>', 'New text', '<h1>after'],
      followedBy: 'after',
      heading: true,
      name: 'a nonempty heading',
    },
    {
      expected: ['before', '<divider>', 'New text'],
      followedBy: '',
      heading: false,
      name: 'an empty paragraph',
    },
    {
      expected: ['before', '<divider>', '<h1>New text'],
      followedBy: '',
      heading: true,
      name: 'an empty heading',
    },
    {
      expected: ['before', '<divider>', 'New text'],
      followedBy: null,
      heading: false,
      name: 'nothing',
    },
    {
      expected: ['before', '<divider>', ' New text', 'after'],
      followedBy: 'after',
      heading: false,
      name: 'Space before text, nonempty paragraph following it',
      text: ' New text',
    },
  ])(
    'typing after a selected divider: $name',
    async ({followedBy, heading, expected, text: inputText = 'New text'}) => {
      const {editor, root} = mountEditor(
        followedBy,
        heading ? () => $createHeadingNode('h1') : $createParagraphNode,
      );
      const divider = root.querySelector('hr')!;
      await userEvent.click(divider);
      await expect.element(divider).toHaveClass('selected');

      await userEvent.keyboard(inputText);

      expect(
        editor.read(() =>
          $getRoot()
            .getChildren()
            .map(node => {
              if ($isHorizontalRuleNode(node)) {
                return '<divider>';
              }
              const text = node.getTextContent();
              return $isHeadingNode(node) ? `<${node.getTag()}>${text}` : text;
            }),
        ),
      ).toEqual(expected);
    },
  );

  test('leaves a shortcut on the selected divider to the editor', async () => {
    const {editor, root} = mountEditor('after');
    const divider = root.querySelector('hr')!;
    await userEvent.click(divider);
    await expect.element(divider).toHaveClass('selected');
    const original = editor.getEditorState().toJSON();

    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}');

    expect(editor.getEditorState().toJSON()).toEqual(original);
  });
});
