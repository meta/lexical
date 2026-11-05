/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A binding disposed and started again (the same instance) read the document
// again into its state, but the shared nodes it had read before kept their
// old containers (the binding's container of each shared node is looked up
// by the node itself, and dispose cleared only its other maps), which the
// new read reused without mapping them back to the editor's nodes. Edits
// inside such a container (a box's) were then not written: the editor showed
// them, peers and a fresh reader did not. https://github.com/meta/lexical/issues/9809

import {$createLinkNode} from '@lexical/link';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  type LexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $createBoxNode,
  expectConverged,
  freshReader,
  setup,
} from '../../utils/harness';

// [what, content, fails on main]
const CONTAINERS: [string, () => LexicalNode, boolean][] = [
  [
    'a link',
    () =>
      $createParagraphNode().append(
        $createTextNode('see '),
        $createLinkNode('https://example.com').append($createTextNode('abc')),
      ),
    false,
  ],
  [
    'a box',
    () =>
      $createBoxNode().append(
        $createParagraphNode().append($createTextNode('abc')),
      ),
    true,
  ],
];

describe.each([false, true])('a binding started again, gc %s', gc => {
  for (const [what, $make, fails] of CONTAINERS) {
    (fails ? test.fails : test)(
      `writes an edit inside ${what} it had read`,
      async () => {
        const t = await setup(() => $getRoot().append($make()), {
          gc,
          ids: [1, 2],
        });
        const {a, b} = t;
        a.binding.dispose();
        a.binding.start();
        a.update(() => {
          const text = $getRoot()
            .getAllTextNodes()
            .find(n => n.getTextContent() === 'abc')!;
          text.select(3, 3).insertText('X');
          $setSelection(null);
        });
        await t.sync();
        const fresh = await freshReader(a);
        expect(a.read(() => $getRoot().getTextContent())).toContain('abcX');
        expect(fresh.describe()).toBe(a.describe());
        expect(b.describe()).toBe(a.describe());
        fresh.stop();
        await expectConverged(t.peers);
      },
    );
  }
});
