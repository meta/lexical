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
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type ElementNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

function mountEditor(
  followedBy: string | null,
  $block: () => ElementNode = $createParagraphNode,
) {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  const editor = buildEditorFromExtensions({
    $initialEditorState: () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('before')),
        $createHorizontalRuleNode(),
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
