/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {HashtagExtension} from '@lexical/hashtag';
import {registerMarkdownShortcuts} from '@lexical/markdown';
import {$isHeadingNode} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, it} from 'vitest';

import {MarkdownTestExtension} from '../utils';

// The hashtag entity turns the leading "#" of "##Welcome" into its own node,
// which moves the caret to a different leaf while the shortcut is being typed.
// HashtagExtension is a dependency rather than a sibling so that its transform
// is registered ahead of the shortcut listener, which is the order #5366
// reproduces in.
const Issue5366TestExtension = defineExtension({
  dependencies: [MarkdownTestExtension, HashtagExtension],
  name: 'Issue5366Test',
  register: editor => registerMarkdownShortcuts(editor),
});

/** Types each character in its own discrete update, firing the shortcut listener. */
function type(editor: LexicalEditor, text: string): void {
  for (const character of text) {
    editor.update(
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText(character);
        }
      },
      {discrete: true},
    );
  }
}

// https://github.com/facebook/lexical/issues/5366
describe('Issue #5366: hashtags block the heading shortcut', () => {
  it.each([
    ['# ', 'h1'],
    ['## ', 'h2'],
    ['### ', 'h3'],
    ['#### ', 'h4'],
    ['##### ', 'h5'],
    ['###### ', 'h6'],
  ])(
    'transforms with the "%s" shortcut typed before existing text',
    (shortcut, tag) => {
      using editor = buildEditorFromExtensions([Issue5366TestExtension]);

      editor.update(
        () => {
          const root = $getRoot();
          root.clear();
          const paragraph = $createParagraphNode();
          const text = $createTextNode('Welcome to the playground');
          paragraph.append(text);
          root.append(paragraph);
          text.select(0, 0);
        },
        {discrete: true},
      );

      type(editor, shortcut);

      editor.read(() => {
        const heading = $getRoot().getFirstChild();
        expect($isHeadingNode(heading)).toBe(true);
        expect($isHeadingNode(heading) && heading.getTag()).toBe(tag);
        expect(heading?.getTextContent()).toBe('Welcome to the playground');
      });
    },
  );
});
