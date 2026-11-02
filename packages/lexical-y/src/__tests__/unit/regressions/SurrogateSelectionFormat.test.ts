/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// #9717: After a write with a lone surrogate half is stored as U+FFFD (D57)
// and read again, typing over a range formatted from inside an emoji keeps
// the format of the formatted node instead of taking the format of the
// neighbouring node before it.
// Also ensures the re-read re-reads only the touched line in place without
// re-reading the entire container.
// @vitest-environment node

import {createHeadlessEditor} from '@lexical/headless';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {expectConverged, setup} from '../../utils/harness';

const EMOJI_LINE = 'ab\u{1F600}cd';

const $typeZ = () => {
  const s = $getSelection();
  if ($isRangeSelection(s)) {
    s.insertText('Z');
  }
};

const $show = () =>
  $getRoot()
    .getAllTextNodes()
    .map(
      n =>
        JSON.stringify(n.getTextContent()) +
        (n.getFormat() ? '{' + n.getFormat() + '}' : ''),
    )
    .join(' ');

describe('typing over a range formatted from inside an emoji (#9717)', () => {
  for (const [name, a, f, plainExpected, collabExpected, convergedText] of [
    [
      '[3,6)',
      3,
      6,
      '"ab\\ud83d" "Z"{1}',
      '"ab\ufffd" "Z"{1}',
      'paragraph("ab\ufffd" "Z"{1})',
    ],
    [
      '[6,3)',
      6,
      3,
      '"ab\\ud83d" "Z"{1}',
      '"ab\ufffd" "Z"{1}',
      'paragraph("ab\ufffd" "Z"{1})',
    ],
    [
      '[2,3)',
      2,
      3,
      '"ab" "Z"{1} "\\ude00cd"',
      '"ab" "Z"{1} "\ufffdcd"',
      'paragraph("ab" "Z"{1} "\ufffdcd")',
    ],
  ] as const) {
    test(`type over range ${name}: bold format is kept in collab and plain`, async () => {
      const $sel = () => {
        const n = $getRoot().getFirstDescendant() as TextNode;
        const s = $createRangeSelection();
        s.anchor.set(n.getKey(), a, 'text');
        s.focus.set(n.getKey(), f, 'text');
        $setSelection(s);
        s.formatText('bold');
      };

      const plain = createHeadlessEditor({
        namespace: 'p',
        onError: e => {
          throw e;
        },
      });
      plain.update(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode(EMOJI_LINE)),
          ),
        {discrete: true},
      );
      plain.update($sel, {discrete: true});
      plain.update($typeZ, {discrete: true});
      expect(plain.getEditorState().read($show)).toBe(plainExpected);

      const t = await setup(() =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode(EMOJI_LINE)),
        ),
      );
      t.b.update($sel);
      await t.sync();
      t.b.editor.update($typeZ, {discrete: true});
      await t.sync();

      expect(t.b.read($show)).toBe(collabExpected);
      await expectConverged(t.peers, convergedText);
    });
  }

  test('re-reads only the touched line without recreating other lines in the container', async () => {
    const t = await setup(() => {
      const root = $getRoot();
      for (let i = 0; i < 10; i++) {
        root.append(
          $createParagraphNode().append(
            $createTextNode(i === 5 ? EMOJI_LINE : `line ${i}`),
          ),
        );
      }
    });

    const initialKeys = t.b.read(() =>
      $getRoot()
        .getChildren()
        .map(c => c.getKey()),
    );
    expect(initialKeys).toHaveLength(10);

    // Format inside emoji on paragraph 5
    t.b.update(() => {
      const targetP = $getRoot().getChildAtIndex(5) as ElementNode;
      const textNode = targetP.getFirstChild() as TextNode;
      const s = $createRangeSelection();
      s.anchor.set(textNode.getKey(), 3, 'text');
      s.focus.set(textNode.getKey(), 6, 'text');
      $setSelection(s);
      s.formatText('bold');
    });

    await t.sync();

    // The other paragraphs must retain their exact node keys
    const afterKeys = t.b.read(() =>
      $getRoot()
        .getChildren()
        .map(c => c.getKey()),
    );
    for (let i = 0; i < 10; i++) {
      expect(afterKeys[i]).toBe(initialKeys[i]);
    }
  });
});
