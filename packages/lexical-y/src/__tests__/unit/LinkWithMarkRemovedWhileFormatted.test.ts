/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// As LinkRemovedWhileFormatted, with the link's text inside a mark: the
// link holds its text through an inline element, and B's format still
// writes no link value, so A's removal of the link stays.

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createLinkNode,
  $isLinkNode,
  $toggleLink,
  LinkExtension,
} from '@lexical/link';
import {$createMarkNode, MarkExtension} from '@lexical/mark';
import {RichTextExtension} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $setSelection,
  configExtension,
  defineExtension,
  type LexicalEditor,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {YCollabExtension} from '../..';
import {createYDoc, seedYState} from '../../headless';

const extensions = [RichTextExtension, LinkExtension, MarkExtension];
const config = {extensions, schemaVersion: 1};

function $build(): void {
  $getRoot()
    .clear()
    .append(
      $createParagraphNode().append(
        $createTextNode('before '),
        $createLinkNode('https://nested.test').append(
          $createMarkNode(['c1']).append($createTextNode('linked words')),
        ),
        $createTextNode(' after'),
      ),
    );
}

function client(seed: Uint8Array, id: number) {
  const doc = createYDoc(seed);
  doc.clientID = id;
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        ...extensions,
        configExtension(YCollabExtension, {doc, schemaVersion: 1}),
      ],
      name: `nested-${id}`,
    }),
  );
  return {doc, editor};
}

function $select(from: string, to: string) {
  const find = (word: string, end: boolean): [TextNode, number] => {
    for (const text of $getRoot().getAllTextNodes() as TextNode[]) {
      const offset = text.getTextContent().indexOf(word);
      if (offset >= 0) {
        return [text, end ? offset + word.length : offset];
      }
    }
    throw new Error(`missing ${word}`);
  };
  const [a, ao] = find(from, false);
  const [b, bo] = find(to, true);
  const selection = $createRangeSelection();
  selection.anchor.set(a.getKey(), ao, 'text');
  selection.focus.set(b.getKey(), bo, 'text');
  $setSelection(selection);
  return selection;
}

function links(editor: LexicalEditor): string[] {
  return editor.read(() => {
    const out: string[] = [];
    const visit = (node: ReturnType<typeof $getRoot>) => {
      for (const child of node.getChildren()) {
        if ($isLinkNode(child)) {
          out.push(child.getTextContent());
        }
        if ($isElementNode(child)) {
          visit(child as ReturnType<typeof $getRoot>);
        }
      }
    };
    visit($getRoot());
    return out;
  });
}

for (const ids of [
  [1, 2],
  [2, 1],
]) {
  test(`a removed link containing a mark stays removed when formatted (ids ${ids})`, async () => {
    const seed = seedYState(config, $build);
    const a = client(seed, ids[0]);
    const b = client(seed, ids[1]);
    await Promise.resolve();
    a.editor.update(
      () => {
        $select('linked', 'words');
        $toggleLink(null);
      },
      {discrete: true},
    );
    expect(links(a.editor)).toEqual([]);
    b.editor.update(
      () => {
        $select('before', 'words').formatText('code');
      },
      {discrete: true},
    );
    expect(links(b.editor)).toEqual(['linked words']);
    const ua = Y.encodeStateAsUpdate(a.doc);
    const ub = Y.encodeStateAsUpdate(b.doc);
    Y.applyUpdate(a.doc, ub);
    Y.applyUpdate(b.doc, ua);
    await Promise.resolve();
    expect(links(a.editor)).toEqual([]);
    expect(links(b.editor)).toEqual([]);
  });
}
