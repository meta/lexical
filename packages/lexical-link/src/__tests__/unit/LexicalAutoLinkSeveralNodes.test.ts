/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {AutoLinkExtension, autoLinkUrlMatcher} from '@lexical/link';
import {
  $createLineBreakNode,
  $createNodeSelection,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $setCompositionKey,
  $setSelection,
  configExtension,
  type LexicalNode,
  type PointType,
} from 'lexical';
import {expect, test} from 'vitest';

function $offset(point: PointType): number {
  let node: LexicalNode = point.getNode();
  expect(node.isAttached()).toBe(true);
  let offset = point.offset;
  if (point.type === 'element') {
    if (!$isElementNode(node)) {
      throw new Error('Expected an element point');
    }
    expect(offset).toBeLessThanOrEqual(node.getChildrenSize());
    offset = node
      .getChildren()
      .slice(0, offset)
      .reduce((sum, child) => sum + child.getTextContentSize(), 0);
  }
  while (node.getParent()?.getType() !== 'root') {
    offset += node
      .getPreviousSiblings()
      .reduce((sum, sibling) => sum + sibling.getTextContentSize(), 0);
    node = node.getParentOrThrow();
  }
  return offset;
}

test.each([
  [1, 1, 9, 9],
  [2, 2, 10, 10],
  [3, 3, 13, 13],
  [4, 4, 14, 14],
  [1, 4, 9, 14],
  [4, 1, 14, 9],
])(
  'several-node link preserves parent element range %i:%i',
  (anchor, focus, expectedAnchor, expectedFocus) => {
    let enabled = false;
    using editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [
        configExtension(AutoLinkExtension, {
          matchers: [text => (enabled ? autoLinkUrlMatcher(text) : null)],
        }),
      ],
      name: '[autolink element points]',
    });
    let firstKey = '';
    editor.update(
      () => {
        const first = $createTextNode('https://a').setFormat(8);
        firstKey = first.getKey();
        const paragraph = $createParagraphNode().append(
          first,
          $createTextNode('.').setFormat(1),
          $createTextNode('com').setFormat(2),
          $createLineBreakNode(),
        );
        $getRoot().append(paragraph);
        const selection = $createRangeSelection();
        selection.anchor.set(paragraph.getKey(), anchor, 'element');
        selection.focus.set(paragraph.getKey(), focus, 'element');
        $setSelection(selection);
      },
      {discrete: true},
    );
    enabled = true;
    editor.update(() => $getNodeByKey(firstKey)!.markDirty(), {discrete: true});
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      expect(
        $isElementNode(paragraph) &&
          paragraph.getChildren().map(n => n.getType()),
      ).toEqual(['autolink', 'linebreak']);
      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if ($isRangeSelection(selection)) {
        expect([$offset(selection.anchor), $offset(selection.focus)]).toEqual([
          expectedAnchor,
          expectedFocus,
        ]);
        expect(selection.isBackward()).toBe(anchor > focus);
      }
    });
  },
);

test.each([false, true])(
  'wrapping a composing matched node keeps a text composition target (several: %s)',
  several => {
    let enabled = false;
    using editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [
        configExtension(AutoLinkExtension, {
          matchers: [text => (enabled ? autoLinkUrlMatcher(text) : null)],
        }),
      ],
      name: '[autolink composition]',
    });
    let prefixKey = '';
    let composingKey = '';
    editor.update(
      () => {
        const prefix = $createTextNode('see ').setFormat(1);
        const composing = $createTextNode(
          several ? 'https://a' : 'https://a.com',
        ).setFormat(8);
        prefixKey = prefix.getKey();
        composingKey = composing.getKey();
        const paragraph = $createParagraphNode().append(prefix, composing);
        if (several) {
          paragraph.append($createTextNode('.com').setFormat(2));
        }
        $getRoot().append(paragraph);
        composing.select(5, 5);
        $setCompositionKey(composingKey);
      },
      {discrete: true},
    );
    enabled = true;
    // The composing node's own transform is skipped. A dirty preceding text
    // node can still collect it and wrap it as part of the match.
    editor.update(() => $getNodeByKey(prefixKey)!.markDirty(), {
      discrete: true,
    });
    editor.read(() => {
      expect($getNodeByKey(composingKey)!.getParentOrThrow().getType()).toBe(
        'autolink',
      );
    });
    expect(editor._compositionKey).toBe(composingKey);
  },
);

test('several-node link preserves a node selection on all moved children', () => {
  using editor = buildEditorFromExtensions({
    $initialEditorState: null,
    dependencies: [
      configExtension(AutoLinkExtension, {
        matchers: [autoLinkUrlMatcher],
      }),
    ],
    name: '[autolink node selection]',
  });
  const keys: string[] = [];
  editor.update(
    () => {
      const nodes = ['https://a', '.', 'com'].map((text, i) =>
        $createTextNode(text).setFormat(1 << i),
      );
      keys.push(...nodes.map(node => node.getKey()));
      $getRoot().append($createParagraphNode().append(...nodes));
      const selection = $createNodeSelection();
      keys.forEach(key => selection.add(key));
      $setSelection(selection);
    },
    {discrete: true},
  );
  editor.read(() => {
    const selection = $getSelection();
    expect($isNodeSelection(selection)).toBe(true);
    expect(selection?.getNodes().map(node => node.getKey())).toEqual(keys);
    for (const key of keys) {
      expect($getNodeByKey(key)?.getParent()?.getType()).toBe('autolink');
    }
  });
});

test.each([false, true])(
  'composition without a range selection still targets text (several: %s)',
  several => {
    let enabled = false;
    using editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [
        configExtension(AutoLinkExtension, {
          matchers: [text => (enabled ? autoLinkUrlMatcher(text) : null)],
        }),
      ],
      name: '[autolink composition without selection]',
    });
    let prefixKey = '';
    editor.update(
      () => {
        const prefix = $createTextNode('see ').setFormat(1);
        const text = $createTextNode(
          several ? 'https://a' : 'https://a.com',
        ).setFormat(8);
        prefixKey = prefix.getKey();
        const paragraph = $createParagraphNode().append(prefix, text);
        if (several) paragraph.append($createTextNode('.com').setFormat(2));
        $getRoot().append(paragraph);
        $setSelection(null);
        $setCompositionKey(text.getKey());
      },
      {discrete: true},
    );
    enabled = true;
    editor.update(() => $getNodeByKey(prefixKey)!.markDirty(), {
      discrete: true,
    });
    const compositionKey = editor._compositionKey;
    editor.read(() => {
      expect($getSelection()).toBe(null);
      expect(compositionKey && $getNodeByKey(compositionKey)?.getType()).toBe(
        'text',
      );
    });
  },
);

for (const parts of [
  ['see https://a.com end'],
  ['see https://a', '.', 'com end'],
]) {
  const size = parts.join('').length;
  for (let anchor = 0; anchor <= size; anchor++) {
    for (let focus = 0; focus <= size; focus++) {
      test(`all text points ${JSON.stringify(parts)} ${anchor}:${focus}`, () => {
        let enabled = false;
        using editor = buildEditorFromExtensions({
          $initialEditorState: null,
          dependencies: [
            configExtension(AutoLinkExtension, {
              matchers: [text => (enabled ? autoLinkUrlMatcher(text) : null)],
            }),
          ],
          name: '[autolink split boundaries]',
        });
        let firstKey = '';
        editor.update(
          () => {
            const nodes = parts.map((text, i) =>
              $createTextNode(text).setFormat(1 << i),
            );
            firstKey = nodes[0].getKey();
            $getRoot().append($createParagraphNode().append(...nodes));
            const selection = $createRangeSelection();
            for (const [point, absolute] of [
              [selection.anchor, anchor],
              [selection.focus, focus],
            ] as const) {
              let remaining = absolute;
              for (const node of nodes) {
                if (remaining <= node.getTextContentSize()) {
                  point.set(node.getKey(), remaining, 'text');
                  break;
                }
                remaining -= node.getTextContentSize();
              }
            }
            $setSelection(selection);
          },
          {discrete: true},
        );
        enabled = true;
        editor.update(() => $getNodeByKey(firstKey)!.markDirty(), {
          discrete: true,
        });
        editor.read(() => {
          expect($getRoot().getTextContent()).toBe(parts.join(''));
          const selection = $getSelection();
          expect($isRangeSelection(selection)).toBe(true);
          if ($isRangeSelection(selection)) {
            expect([
              $offset(selection.anchor),
              $offset(selection.focus),
            ]).toEqual([anchor, focus]);
            expect(selection.isBackward()).toBe(anchor > focus);
          }
        });
      });
    }
  }
}
