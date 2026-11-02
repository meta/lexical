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
import {$createMarkNode, MarkNode} from '@lexical/mark';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
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
    if (!$isElementNode(node)) throw new Error('Expected element');
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

for (const parts of [
  ['see ', 'https://a.com', '\n', ' tail'],
  ['see ', 'https://a', '.', 'com', '\n', ' tail'],
  ['see https://a.com end', '\n', ' tail'],
  ['see https://a', '.', 'com end', '\n', ' tail'],
  ['https://a', '.com end', '\n', ' tail'],
  ['https://a.com https://b.com end', '\n', ' tail'],
]) {
  for (const inline of [false, true]) {
    // splitText already loses points before the node it splits. Those
    // pre-existing failures have focused regressions in the split-point file.
    const offsets = Array.from({length: parts.length + 1}, (_, i) => i).filter(
      offset =>
        !(
          (parts[0].includes(' end') || parts[0] === 'see https://a') &&
          offset === 0
        ) &&
        !(parts[0] === 'https://a' && parts[1] === '.com end' && offset === 1),
    );
    for (const anchor of offsets) {
      for (const focus of offsets) {
        test(`parent points ${JSON.stringify(parts)} inline=${inline} ${anchor}:${focus}`, () => {
          let enabled = false;
          using editor = buildEditorFromExtensions({
            $initialEditorState: null,
            dependencies: [
              configExtension(AutoLinkExtension, {
                matchers: [text => (enabled ? autoLinkUrlMatcher(text) : null)],
              }),
            ],
            name: '[autolink parent points]',
            nodes: [MarkNode],
          });
          let firstKey = '';
          let expected: number[] = [];
          editor.update(
            () => {
              const nodes = parts.map((text, i) =>
                text === '\n'
                  ? $createLineBreakNode()
                  : $createTextNode(text).setFormat(1 << i),
              );
              firstKey = nodes[0].getKey();
              const parent = inline
                ? $createMarkNode(['comment'])
                : $createParagraphNode();
              parent.append(...nodes);
              $getRoot().append(
                inline ? $createParagraphNode().append(parent) : parent,
              );
              const selection = $createRangeSelection();
              selection.anchor.set(parent.getKey(), anchor, 'element');
              selection.focus.set(parent.getKey(), focus, 'element');
              $setSelection(selection);
              expected = [$offset(selection.anchor), $offset(selection.focus)];
            },
            {discrete: true},
          );
          enabled = true;
          editor.update(() => $getNodeByKey(firstKey)!.markDirty(), {
            discrete: true,
          });
          editor.read(() => {
            expect($getRoot().getTextContent()).toBe(parts.join(''));
            const links = new Set(
              $getRoot()
                .getAllTextNodes()
                .map(node => node.getParentOrThrow())
                .filter(parent => parent.getType() === 'autolink'),
            );
            expect([...links].map(link => link.getTextContent())).toEqual(
              parts.join('').match(/https:\/\/[a-z.]+/g),
            );
            const selection = $getSelection();
            expect($isRangeSelection(selection)).toBe(true);
            if ($isRangeSelection(selection)) {
              expect([
                $offset(selection.anchor),
                $offset(selection.focus),
              ]).toEqual(expected);
              expect(selection.isCollapsed()).toBe(anchor === focus);
              expect(selection.isBackward()).toBe(anchor > focus);
            }
          });
        });
      }
    }
  }
}

for (const inline of [false, true]) {
  for (let anchor = 0; anchor <= 4; anchor++) {
    for (let focus = 0; focus <= 4; focus++) {
      test(`unwrap in creation update inline=${inline} ${anchor}:${focus}`, () => {
        let enabled = false;
        let created = 0;
        let removed = 0;
        using editor = buildEditorFromExtensions({
          $initialEditorState: null,
          dependencies: [
            configExtension(AutoLinkExtension, {
              changeHandlers: [
                (url, previous) => {
                  if (url !== null && previous === null) {
                    created++;
                    enabled = false;
                  } else if (url === null) {
                    removed++;
                  }
                },
              ],
              matchers: [text => (enabled ? autoLinkUrlMatcher(text) : null)],
            }),
          ],
          name: '[autolink parent points unwrap]',
          nodes: [MarkNode],
        });
        let firstKey = '';
        let expected: number[] = [];
        editor.update(
          () => {
            const nodes = ['https://a', '.', 'com'].map((text, i) =>
              $createTextNode(text).setFormat(1 << i),
            );
            firstKey = nodes[0].getKey();
            const parent = inline
              ? $createMarkNode(['comment'])
              : $createParagraphNode();
            parent.append(...nodes, $createLineBreakNode());
            $getRoot().append(
              inline ? $createParagraphNode().append(parent) : parent,
            );
            const selection = $createRangeSelection();
            selection.anchor.set(parent.getKey(), anchor, 'element');
            selection.focus.set(parent.getKey(), focus, 'element');
            $setSelection(selection);
            expected = [$offset(selection.anchor), $offset(selection.focus)];
          },
          {discrete: true},
        );
        enabled = true;
        editor.update(() => $getNodeByKey(firstKey)!.markDirty(), {
          discrete: true,
        });
        editor.read(() => {
          expect([created, removed]).toEqual([1, 1]);
          expect($getRoot().getTextContent()).toBe('https://a.com\n');
          expect(
            $getRoot()
              .getAllTextNodes()
              .every(node => node.getParentOrThrow().getType() !== 'autolink'),
          ).toBe(true);
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) throw new Error('Expected range');
          expect([$offset(selection.anchor), $offset(selection.focus)]).toEqual(
            expected,
          );
          expect(selection.isCollapsed()).toBe(anchor === focus);
          expect(selection.isBackward()).toBe(anchor > focus);
        });
      });
    }
  }
}
