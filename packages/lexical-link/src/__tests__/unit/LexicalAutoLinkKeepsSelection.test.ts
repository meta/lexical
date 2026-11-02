/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  autoLinkEmailMatcher,
  AutoLinkExtension,
  autoLinkUrlMatcher,
  createLinkMatcherWithRegExp,
} from '@lexical/link';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getState,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  $setState,
  configExtension,
  createState,
  type LexicalNode,
  type PointType,
} from 'lexical';
import {expect, test} from 'vitest';

const state = createState('autolink-keeps-selection', {
  parse: value => (typeof value === 'string' ? value : ''),
});

function $absoluteOffset(point: PointType): number {
  let node: LexicalNode = point.getNode();
  expect(node.isAttached()).toBe(true);
  let offset = point.offset;
  if (point.type === 'element') {
    expect($isElementNode(node)).toBe(true);
    if ($isElementNode(node)) {
      expect(offset).toBeLessThanOrEqual(node.getChildrenSize());
      offset = node
        .getChildren()
        .slice(0, offset)
        .reduce((sum, child) => sum + child.getTextContentSize(), 0);
    }
  } else {
    expect(offset).toBeLessThanOrEqual(node.getTextContentSize());
  }
  expect(offset).toBeGreaterThanOrEqual(0);
  while (node.getParent()?.getType() !== 'root') {
    offset += node
      .getPreviousSiblings()
      .reduce((sum, sibling) => sum + sibling.getTextContentSize(), 0);
    node = node.getParentOrThrow();
  }
  return offset;
}

function $characters() {
  return $getRoot()
    .getAllTextNodes()
    .flatMap(node =>
      node
        .getTextContent()
        .split('')
        .map(char => [
          char,
          node.getFormat(),
          node.getStyle(),
          node.getDetail(),
          node.getMode(),
          $getState(node, state),
        ]),
    );
}

const inputs = [
  ['https://a.co'],
  ['see https://a.co'],
  ['https://a.co end'],
  ['see https://a.co end'],
  ['https://a.co https://b.co'],
  ['see https://a', '.co end'],
  ['https://a', '.co'],
  ['https://', 'a', '.co end'],
  ['mail a@b.co end'],
  ['mail a@', 'b.co end'],
  ['GH-', '123 end'],
  ['xhttps://a.co bad'],
];

for (const parts of inputs) {
  const size = parts.join('').length;
  const offsets = [...new Set([0, 1, 5, size - 1, size])].filter(
    offset => offset <= size,
  );
  for (const anchor of offsets) {
    for (const focus of offsets) {
      test(`${JSON.stringify(parts)} preserves characters and range ${anchor}:${focus}`, () => {
        let enabled = false;
        using editor = buildEditorFromExtensions({
          $initialEditorState: null,
          dependencies: [
            configExtension(AutoLinkExtension, {
              matchers: [
                text => (enabled ? autoLinkUrlMatcher(text) : null),
                text => (enabled ? autoLinkEmailMatcher(text) : null),
                text =>
                  enabled ? createLinkMatcherWithRegExp(/GH-\d+/)(text) : null,
              ],
            }),
          ],
          name: '[autolink selection]',
        });
        let before: ReturnType<typeof $characters> = [];
        editor.update(
          () => {
            const nodes = parts.map((text, i) =>
              $setState(
                $createTextNode(text)
                  .setFormat(i % 2 === 0 ? 8 : 1)
                  .setStyle(`color: ${i % 2 === 0 ? 'red' : 'blue'};`)
                  .toggleDirectionless()
                  .toggleUnmergeable(),
                state,
                `part-${i}`,
              ),
            );
            $getRoot().append($createParagraphNode().append(...nodes));
            const selection = $createRangeSelection();
            for (const [point, absolute] of [
              [selection.anchor, anchor],
              [selection.focus, focus],
            ] as const) {
              let at = absolute;
              for (const node of nodes) {
                if (at <= node.getTextContentSize()) {
                  point.set(node.getKey(), at, 'text');
                  break;
                }
                at -= node.getTextContentSize();
              }
            }
            $setSelection(selection);
            before = $characters();
          },
          {discrete: true},
        );
        enabled = true;
        editor.update(() => $getRoot().getAllTextNodes()[0].markDirty(), {
          discrete: true,
        });
        editor.read(() => {
          expect($characters()).toEqual(before);
          const selection = $getSelection();
          expect($isRangeSelection(selection)).toBe(true);
          if ($isRangeSelection(selection)) {
            expect($absoluteOffset(selection.anchor)).toBe(anchor);
            expect($absoluteOffset(selection.focus)).toBe(focus);
            expect(selection.isBackward()).toBe(anchor > focus);
          }
        });
      });
    }
  }
}

test.each(['node', 'none'])(
  'wrapping a whole URL preserves %s selection',
  selectionType => {
    using editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [
        configExtension(AutoLinkExtension, {matchers: [autoLinkUrlMatcher]}),
      ],
      name: '[autolink non-range selection]',
    });
    let key = '';
    editor.update(
      () => {
        const text = $createTextNode('https://a.co');
        key = text.getKey();
        $getRoot().append($createParagraphNode().append(text));
        if (selectionType === 'node') {
          const selection = $createNodeSelection();
          selection.add(key);
          $setSelection(selection);
        } else {
          $setSelection(null);
        }
      },
      {discrete: true},
    );
    editor.read(() => {
      const text = $getRoot().getAllTextNodes()[0];
      expect($isTextNode(text)).toBe(true);
      expect(text.getKey()).toBe(key);
      expect(text.getParentOrThrow().getType()).toBe('autolink');
      const selection = $getSelection();
      if (selectionType === 'node') {
        expect($isNodeSelection(selection)).toBe(true);
        expect(selection?.getNodes().map(node => node.getKey())).toEqual([key]);
      } else {
        expect(selection).toBe(null);
      }
    });
  },
);
