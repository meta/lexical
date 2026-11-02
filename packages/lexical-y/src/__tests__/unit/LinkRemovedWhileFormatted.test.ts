/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A removes a link while B, at the same time, formats a range covering the
// whole link (code). B's format sets the link's textFormat too
// (RangeSelection#formatText); with the link's textFormat stored in its
// value, B wrote the link's value again over its text, and that write
// brought the removed link back for everyone. The link stays removed.

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createLinkNode,
  $isLinkNode,
  $toggleLink,
  LinkExtension,
} from '@lexical/link';
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

const extensions = [RichTextExtension, LinkExtension];
const config = {extensions, onWarn: () => {}, schemaVersion: 1};

// "t28z " + link(https://c.test/100: "t29z t30z") + " t31z"
function $build() {
  $getRoot()
    .clear()
    .append(
      $createParagraphNode().append(
        $createTextNode('t28z '),
        $createLinkNode('https://c.test/100').append(
          $createTextNode('t29z t30z'),
        ),
        $createTextNode(' t31z'),
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
      name: 'client' + id,
    }),
  );
  return {doc, editor};
}

function $select(from: string, to: string) {
  const texts = $getRoot().getAllTextNodes();
  const find = (word: string, end: boolean): [TextNode, number] => {
    for (const t of texts) {
      const i = t.getTextContent().indexOf(word);
      if (i >= 0) return [t, end ? i + word.length : i];
    }
    throw new Error(word);
  };
  const [a, ao] = find(from, false);
  const [b, bo] = find(to, true);
  const s = $createRangeSelection();
  s.anchor.set(a.getKey(), ao, 'text');
  s.focus.set(b.getKey(), bo, 'text');
  $setSelection(s);
  return s;
}

const links = (editor: LexicalEditor) =>
  editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .flatMap(p => ($isElementNode(p) ? p.getChildren() : []))
      .filter($isLinkNode)
      .map(l => l.getTextContent()),
  );

for (const ids of [
  [1, 2],
  [2, 1],
]) {
  test(`a removed link stays removed when a collaborator formats over it at the same time (ids ${ids})`, async () => {
    const seed = seedYState(config, $build);
    const a = client(seed, ids[0]);
    const b = client(seed, ids[1]);
    await Promise.resolve();
    // A removes the link; B, at the same time, makes "t28z ... t30z" code
    a.editor.update(
      () => {
        $select('t29z', 't30z');
        $toggleLink(null);
      },
      {discrete: true},
    );
    b.editor.update(
      () => {
        $select('t28z', 't30z').formatText('code');
      },
      {discrete: true},
    );
    const ua = Y.encodeStateAsUpdate(a.doc);
    const ub = Y.encodeStateAsUpdate(b.doc);
    Y.applyUpdate(a.doc, ub);
    Y.applyUpdate(b.doc, ua);
    await Promise.resolve();
    expect(links(a.editor)).toEqual([]);
    expect(links(b.editor)).toEqual([]);
  });
}
