/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {HashtagExtension} from '@lexical/hashtag';
import {PlainTextExtension} from '@lexical/plain-text';
import {RichTextExtension} from '@lexical/rich-text';
import {$getRoot} from 'lexical';
import {expect, test} from 'vitest';

import {assertHTML, assertSelection, html, setupEditor} from './utils';

const expected = html`
  <p class="PlaygroundEditorTheme__paragraph" dir="auto">
    <span data-lexical-text="true">Hello</span>
    <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
      #world
    </span>
    <span data-lexical-text="true">. This content</span>
    <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
      #should
    </span>
    <span data-lexical-text="true">remain</span>
    <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
      #intact
    </span>
    <span data-lexical-text="true">.</span>
  </p>
`;
const text = 'Hello #world. This content #should remain #intact.';

// These mutate the live DOM, without editor.update or a mocked observer.
// Each edit must reconcile before the next edit begins.
const mutations: [string, (root: HTMLElement) => void][] = [
  ['remove paragraph', root => root.firstElementChild!.remove()],
  [
    'clear paragraph',
    root => {
      root.firstElementChild!.textContent = '';
    },
  ],
  ['remove first text', root => root.firstElementChild!.children[0].remove()],
  [
    'clear first text',
    root => {
      root.firstElementChild!.children[0].textContent = '';
    },
  ],
  ['remove second text', root => root.firstElementChild!.children[1].remove()],
  ['remove third text', root => root.firstElementChild!.children[2].remove()],
  ['remove fourth text', root => root.firstElementChild!.children[3].remove()],
  [
    'move fourth text to first',
    root => {
      const p = root.firstElementChild!;
      p.insertBefore(p.children[3], p.firstChild);
    },
  ],
  [
    'reverse first four children',
    root => {
      const p = root.firstElementChild!;
      const [a, b, c, d] = Array.from(p.children);
      p.insertBefore(d, a);
      p.insertBefore(c, a);
      p.insertBefore(b, a);
    },
  ],
  [
    'append foreign root nodes',
    root =>
      root.append(
        document.createElement('span'),
        document.createElement('span'),
        document.createTextNode('123'),
      ),
  ],
  [
    'insert foreign paragraph nodes',
    root => {
      const p = root.firstElementChild!;
      const first = p.firstChild;
      p.append(document.createElement('span'), document.createTextNode('123'));
      p.insertBefore(document.createElement('span'), first);
    },
  ],
  [
    'append foreign text children',
    root =>
      root.firstElementChild!.children[0].append(
        document.createElement('span'),
        document.createTextNode('123'),
      ),
  ],
  [
    'replace text child',
    root =>
      root.firstElementChild!.children[0].firstChild!.replaceWith(
        document.createTextNode('123'),
      ),
  ],
  [
    'replace text child with line break',
    root =>
      root.firstElementChild!.children[0].firstChild!.replaceWith(
        document.createElement('br'),
      ),
  ],
];

test.each([true, false])(
  'restores externally mutated DOM (rich text: %s)',
  async isRichText => {
    const {editor, root} = setupEditor([
      isRichText ? RichTextExtension : PlainTextExtension,
      HashtagExtension,
    ]);
    // Insert the text as typing would rather than type it: fifty keys sent
    // one at a time take most of this test's time on a busy runner, and
    // without text input, text mutations are never ignored as typing.
    editor.update(() => $getRoot().selectEnd().insertText(text), {
      discrete: true,
    });
    const selection = {
      anchorOffset: 1,
      anchorPath: [0, 6, 0],
      focusOffset: 1,
      focusPath: [0, 6, 0],
    };
    await assertHTML(root, expected);
    await assertSelection(root, selection);
    for (const [name, mutate] of mutations) {
      mutate(root);
      await assertHTML(root, expected);
      await assertSelection(root, selection);
      expect(
        editor.read(() => $getRoot().getTextContent()),
        name,
      ).toBe(text);
    }
    root.firstElementChild!.children[0].firstChild!.nodeValue = 'Bonjour ';
    await assertHTML(root, expected.replace('Hello', 'Bonjour'));
    await assertSelection(root, selection);
    await expect
      .poll(() => editor.read(() => $getRoot().getTextContent()))
      .toBe(text.replace('Hello', 'Bonjour'));
  },
);
