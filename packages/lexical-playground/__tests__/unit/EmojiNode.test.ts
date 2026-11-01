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
  $createTextNode,
  $getRoot,
  $isTextNode,
  defineExtension,
} from 'lexical';
import {assert, describe, expect, it} from 'vitest';

import {
  $createEmojiNode,
  EmojiNode,
  type SerializedEmojiNode,
} from '../../src/nodes/EmojiNode';

const EmojiThemeTestExtension = defineExtension({
  $initialEditorState: null,
  dependencies: [RichTextExtension],
  name: '[test-emoji-theme]',
  nodes: [EmojiNode],
  theme: {text: {bold: 'theme-bold', underline: 'theme-underline'}},
});

function makeEditor(): LexicalEditorWithDispose {
  const editor = buildEditorFromExtensions(EmojiThemeTestExtension);
  editor.setRootElement(document.createElement('div'));
  return editor;
}

function $appendEmoji(): EmojiNode {
  const emoji = $createEmojiNode('emoji happysmile', '🙂');
  $getRoot()
    .clear()
    .append($createParagraphNode().append($createTextNode('hi '), emoji));
  return emoji;
}

function $getEmoji(): EmojiNode {
  const emoji = $getRoot().getLastDescendant();
  assert($isTextNode(emoji) && emoji instanceof EmojiNode, 'EmojiNode');
  return emoji;
}

function emojiDOM(editor: LexicalEditorWithDispose): HTMLElement {
  const dom = editor.getRootElement()?.querySelector<HTMLElement>('.emoji');
  assert(dom != null, 'emoji DOM');
  return dom;
}

describe('EmojiNode', () => {
  it('renders a tag-changing format applied after the emoji exists', () => {
    using editor = makeEditor();
    editor.update(() => void $appendEmoji(), {discrete: true});
    expect(emojiDOM(editor).querySelector('strong')).toBe(null);

    // Formatting a selection that covers the emoji formats the whole token
    // node, so the emoji really does become bold in the state.
    editor.update(() => void $getEmoji().setFormat('bold'), {discrete: true});

    expect(editor.read(() => $getEmoji().hasFormat('bold'))).toBe(true);
    expect(emojiDOM(editor).querySelector('strong')).not.toBe(null);
  });

  it('keeps the theme class of a class-only format on the inner element', () => {
    using editor = makeEditor();
    editor.update(() => void $appendEmoji().setFormat('underline'), {
      discrete: true,
    });

    const inner = emojiDOM(editor).firstElementChild as HTMLElement;
    expect(Array.from(inner.classList).sort()).toEqual([
      'emoji-inner',
      'theme-underline',
    ]);
  });

  // The class could not change after construction before setClassName and
  // the schema-driven updateFromJSON existed, so updateDOM only ever had the
  // inner text element to update. Now that it can, the outer span has to
  // follow it, or the emoji shown disagrees with the node.
  it('updates the outer class when setClassName changes it', () => {
    using editor = makeEditor();
    editor.update(() => void $appendEmoji(), {discrete: true});
    expect(emojiDOM(editor).className).toBe('emoji happysmile');

    editor.update(() => void $getEmoji().setClassName('emoji sad'), {
      discrete: true,
    });

    expect(editor.read(() => $getEmoji().getClassName())).toBe('emoji sad');
    expect(emojiDOM(editor).className).toBe('emoji sad');
  });

  it('updates the outer class when updateFromJSON changes it', () => {
    using editor = makeEditor();
    editor.update(() => void $appendEmoji(), {discrete: true});

    editor.update(
      () => {
        const emoji = $getEmoji();
        const json: SerializedEmojiNode = {
          ...emoji.exportJSON(),
          className: 'emoji sad',
        };
        emoji.updateFromJSON(json);
      },
      {discrete: true},
    );

    expect(editor.read(() => $getEmoji().getClassName())).toBe('emoji sad');
    expect(emojiDOM(editor).className).toBe('emoji sad');
  });
});
