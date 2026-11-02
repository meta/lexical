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
import {registerLexicalTextEntity} from '@lexical/text';
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

class Letter extends TextNode {
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

// #9725 (known limit, see transforms.md): typing into a run of repeated
// characters, read as text inserted at the end of the run, drops the NodeState
// of the last existing character when a matcher that looks back into the run
// makes it an entity. `test.fails` until the edit's reading is fixed.

// Matches an "A" only when "$AA" comes right before it.
// eslint-disable-next-line compat/compat -- a Node test
const LOOKBEHIND = /^x$|^A$|(?<=^#)x|(?<=\$AA)A/;
const getMatch = (text: string) => {
  const m = LOOKBEHIND.exec(text);
  return m ? {end: m.index + m[0].length, start: m.index} : null;
};

test.fails(
  'typing into a run of repeated characters keeps NodeState on an existing character',
  () => {
    const editor = createEditor({
      nodes: [HashtagNode, Letter],
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
    registerLexicalTextEntity(editor, getMatch, Letter, node =>
      $create(Letter).setTextContent(node.getTextContent()),
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
          .find(node => node.getTextContent() === '$AA')!
          .select(1, 1)
          .insertText('A');
      },
      {discrete: true},
    );
    const nodes = editor.read(() =>
      $getRoot()
        .getAllTextNodes()
        .map(node => ({
          note: $getState(node, note),
          text: node.getTextContent(),
          type: node.getType(),
        })),
    );
    const chars = nodes.flatMap(node =>
      node.text.split('').map(text => ({note: node.note, text})),
    );
    // "ya#x$AAA": the typed A is at index 5; the A that was last before typing is at index 7.
    expect(chars.map(c => c.text).join('')).toBe('ya#x$AAA');
    expect(chars[7]).toEqual({note: 'c1', text: 'A'});
  },
);
