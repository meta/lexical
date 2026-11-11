/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  buildEditorFromExtensions,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $getRoot,
  $isTextNode,
  defineExtension,
} from 'lexical';
import {assert, describe, expect, it} from 'vitest';

import {$createMentionNode, MentionNode} from '../../src/nodes/MentionNode';

const MentionThemeTestExtension = defineExtension({
  $initialEditorState: null,
  dependencies: [RichTextExtension],
  name: '[test-mention-theme]',
  nodes: [MentionNode],
  // Only underline gets a class: bold changes the HTML tag instead, which is
  // what forces the element to be rebuilt through createDOM.
  theme: {text: {underline: 'theme-underline'}},
});

function makeEditor(): LexicalEditorWithDispose {
  const editor = buildEditorFromExtensions(MentionThemeTestExtension);
  editor.setRootElement(document.createElement('div'));
  return editor;
}

function mentionClasses(editor: LexicalEditorWithDispose): string[] {
  const dom = editor
    .getRootElement()
    ?.querySelector<HTMLElement>('[data-lexical-text]');
  assert(dom != null, 'mention DOM');
  return Array.from(dom.classList).sort();
}

describe('MentionNode theme classes', () => {
  it('keeps the theme class of the format it was created with', () => {
    using editor = makeEditor();
    editor.update(
      () => {
        const mention = $createMentionNode('Luke').setFormat('underline');
        $getRoot().clear().append($createParagraphNode().append(mention));
      },
      {discrete: true},
    );

    expect(mentionClasses(editor)).toEqual(['mention', 'theme-underline']);
  });

  it('keeps the theme class when a format change rebuilds the element', () => {
    using editor = makeEditor();
    editor.update(
      () => {
        const mention = $createMentionNode('Luke');
        $getRoot().clear().append($createParagraphNode().append(mention));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const mention = $getRoot().getLastDescendant();
        assert($isTextNode(mention), 'mention node');
        mention.setFormat('underline');
      },
      {discrete: true},
    );
    expect(mentionClasses(editor)).toEqual(['mention', 'theme-underline']);

    // Bold changes the tag, so TextNode.updateDOM returns true and the
    // reconciler rebuilds the element through createDOM.
    editor.update(
      () => {
        const mention = $getRoot().getLastDescendant();
        assert($isTextNode(mention), 'mention node');
        mention.toggleFormat('bold');
      },
      {discrete: true},
    );

    expect(
      editor.read(() => {
        const mention = $getRoot().getLastDescendant();
        assert($isTextNode(mention), 'mention node');
        return mention.hasFormat('underline');
      }),
    ).toBe(true);
    expect(mentionClasses(editor)).toEqual(['mention', 'theme-underline']);
  });
});
