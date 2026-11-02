/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $createHashtagNode,
  HashtagExtension,
  HashtagNode,
} from '@lexical/hashtag';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $setState,
  createEditor,
  createState,
  TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {registerLexicalTextEntity} from '../..';

class LetterNode extends TextNode {
  $config() {
    return this.config('letter', {extends: TextNode});
  }
  isTextEntity(): true {
    return true;
  }
}

const note = createState('note', {
  parse: value => (typeof value === 'string' ? value : ''),
});

const getMatch = (text: string) => {
  // Equivalent to /^x$|^A$|(?<=^#)x|(?<=\$AA)A/ without requiring
  // RegExp lookbehind support: the prefix is context, not part of the entity.
  const match = /^(x|A)$|^#(x)|\$AA(A)/.exec(text);
  return match
    ? {
        end: match.index + match[0].length,
        start: match.index + match[0].length - 1,
      }
    : null;
};

test.each([1, 2])(
  '#9725: inserting a repeated character at offset %i preserves the existing matched character state',
  offset => {
    const editor = createEditor({
      nodes: [HashtagNode, LetterNode],
      onError: error => {
        throw error;
      },
    });
    registerLexicalTextEntity(
      editor,
      HashtagExtension.config!.getHashtagMatch,
      HashtagNode,
      node => $createHashtagNode(node.getTextContent()),
    );
    registerLexicalTextEntity(editor, getMatch, LetterNode, node =>
      $create(LetterNode).setTextContent(node.getTextContent()),
    );
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('y').setFormat('bold'),
            $createTextNode('a'),
            $createHashtagNode('#x'),
            $setState($createTextNode('$AA'), note, 'c1'),
          ),
        );
      },
      {discrete: true},
    );
    editor.update(
      () => {
        $getRoot()
          .getAllTextNodes()
          .at(-1)!
          .select(offset, offset)
          .insertText('A');
      },
      {discrete: true},
    );
    editor.read(() => {
      const nodes = $getRoot().getAllTextNodes();
      expect(nodes.map(node => node.getTextContent()).join('')).toBe(
        'ya#x$AAA',
      );
      const letter = nodes.at(-1)!;
      expect(letter.getType()).toBe('letter');
      expect(letter.getTextContent()).toBe('A');
      expect($getState(letter, note)).toBe('c1');
    });
  },
);
