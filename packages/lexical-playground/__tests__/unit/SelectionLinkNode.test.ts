/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {$createLinkNode, LinkExtension} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  defineExtension,
  type LexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {$getSelectionLinkNode} from '../../src/utils/getSelectionLinkNode';

const extension = defineExtension({
  dependencies: [RichTextExtension, LinkExtension],
  name: '[test-selection-link]',
});

describe('$getSelectionLinkNode', () => {
  test.each(['root', 'paragraph', 'link'] as const)(
    'resolves a link from %s element points in either direction',
    boundary => {
      using editor = buildEditorFromExtensions(extension);
      editor.update(
        () => {
          const link = $createLinkNode('https://lexical.dev').append(
            $createTextNode('hello'),
            $createTextNode('world').toggleFormat('bold'),
          );
          const paragraph = $createParagraphNode().append(link);
          const root = $getRoot().clear().append(paragraph);
          const element =
            boundary === 'root'
              ? root
              : boundary === 'paragraph'
                ? paragraph
                : link;
          for (const backward of [false, true]) {
            const selection = element.select(
              backward ? element.getChildrenSize() : 0,
              backward ? 0 : element.getChildrenSize(),
            );
            expect($getSelectionLinkNode(selection)).toBe(link);
          }
        },
        {discrete: true},
      );
    },
  );

  test.each([
    'plain text',
    'text before the link',
    'another link',
    'empty paragraph',
    'line break',
  ] as const)(
    'does not treat a whole selection containing %s as one link',
    extra => {
      using editor = buildEditorFromExtensions(extension);
      editor.update(
        () => {
          const paragraph = $createParagraphNode().append(
            $createLinkNode('https://lexical.dev').append(
              $createTextNode('hello'),
            ),
          );
          const root = $getRoot().clear().append(paragraph);
          if (extra === 'empty paragraph') {
            root.append($createParagraphNode());
          } else if (extra === 'plain text') {
            paragraph.append($createTextNode('world'));
          } else if (extra === 'text before the link') {
            paragraph.splice(0, 0, [$createTextNode('world')]);
          } else if (extra === 'line break') {
            paragraph.append($createLineBreakNode());
          } else {
            paragraph.append(
              $createLinkNode('https://example.com').append(
                $createTextNode('world'),
              ),
            );
          }
          expect(
            $getSelectionLinkNode(root.select(0, root.getChildrenSize())),
          ).toBe(null);
          expect(
            $getSelectionLinkNode(root.select(root.getChildrenSize(), 0)),
          ).toBe(null);
        },
        {discrete: true},
      );
    },
  );

  test('preserves collapsed and partial text selections inside a link', () => {
    using editor = buildEditorFromExtensions(extension);
    editor.update(
      () => {
        const text = $createTextNode('hello');
        const link = $createLinkNode('https://lexical.dev').append(text);
        $getRoot().clear().append($createParagraphNode().append(link));
        expect($getSelectionLinkNode(text.select(2, 2))).toBe(link);
        expect($getSelectionLinkNode(text.select(1, 4))).toBe(link);
        expect($getSelectionLinkNode(text.select(4, 1))).toBe(link);
      },
      {discrete: true},
    );
  });

  test('does not activate a link for a collapsed paragraph point', () => {
    using editor = buildEditorFromExtensions(extension);
    editor.update(
      () => {
        const paragraph = $createParagraphNode().append(
          $createLinkNode('https://lexical.dev').append(
            $createTextNode('hello'),
          ),
        );
        $getRoot().clear().append(paragraph);
        expect($getSelectionLinkNode(paragraph.select(0, 0))).toBe(null);
      },
      {discrete: true},
    );
  });
  describe('text point selections around a link', () => {
    function $setup() {
      const before = $createTextNode('pre');
      const inside = $createTextNode('hello');
      const link = $createLinkNode('https://lexical.dev').append(inside);
      const after = $createTextNode('tail');
      $getRoot()
        .clear()
        .append($createParagraphNode().append(before, link, after));
      return {after, before, inside, link};
    }

    function $selectText(
      anchorNode: LexicalNode,
      anchorOffset: number,
      focusNode: LexicalNode,
      focusOffset: number,
    ) {
      const selection = $createRangeSelection();
      selection.anchor.set(anchorNode.getKey(), anchorOffset, 'text');
      selection.focus.set(focusNode.getKey(), focusOffset, 'text');
      return selection;
    }

    test.each([
      [
        'from the start of the link into the following text',
        'inside',
        0,
        'after',
        2,
      ],
      [
        'from the end of the link into the following text',
        'inside',
        5,
        'after',
        2,
      ],
      ['from the preceding text into the link', 'before', 1, 'inside', 3],
      [
        'backward from the following text into the link',
        'after',
        2,
        'inside',
        3,
      ],
    ] as const)(
      'does not resolve a link for a selection %s',
      (_label, anchorKey, anchorOffset, focusKey, focusOffset) => {
        using editor = buildEditorFromExtensions(extension);
        editor.update(
          () => {
            const nodes = $setup();
            expect(
              $getSelectionLinkNode(
                $selectText(
                  nodes[anchorKey],
                  anchorOffset,
                  nodes[focusKey],
                  focusOffset,
                ),
              ),
            ).toBe(null);
          },
          {discrete: true},
        );
      },
    );

    test.each([
      ['whole link text', 'inside', 0, 'inside', 5],
      [
        'from the end of the preceding text to the start of the following text',
        'before',
        3,
        'after',
        0,
      ],
      [
        'backward from the start of the following text to the end of the preceding text',
        'after',
        0,
        'before',
        3,
      ],
    ] as const)(
      'resolves the link for a selection covering exactly the %s',
      (_label, anchorKey, anchorOffset, focusKey, focusOffset) => {
        using editor = buildEditorFromExtensions(extension);
        editor.update(
          () => {
            const nodes = $setup();
            expect(
              $getSelectionLinkNode(
                $selectText(
                  nodes[anchorKey],
                  anchorOffset,
                  nodes[focusKey],
                  focusOffset,
                ),
              ),
            ).toBe(nodes.link);
          },
          {discrete: true},
        );
      },
    );
  });
});
