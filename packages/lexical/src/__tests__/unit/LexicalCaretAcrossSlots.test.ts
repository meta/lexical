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
  $createParagraphNode,
  $createTextNode,
  $getChildCaret,
  $getCommonAncestor,
  $getNodeByKey,
  $getRoot,
  $getSiblingCaret,
  $getTextPointCaret,
  $isElementNode,
  $isParagraphNode,
  $isTextNode,
  $setSlot,
  type DecoratorNode,
  defineExtension,
  type ElementNode,
  type LexicalNode,
  type ParagraphNode,
  type PointCaret,
  type TextNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

import {
  $comparePointCaretNextAcrossSlots,
  $getCommonAncestorAcrossSlots,
} from '../../caret/LexicalCaret';
import {
  $assertNodeType,
  $createTestDecoratorNode,
  $createTestShadowRootNode,
  TestDecoratorNode,
  TestShadowRootNode,
} from '../utils';

// root -> paragraph "Before"
//      -> host paragraph with slots 'aside' ("Aside"), 'title' ("Title",
//         whose paragraph has slot 'note' ("Note")) and children paragraphs
//         "Body" and "More"
//      -> decorator with slots 'caption' ("Caption") and 'credit' ("Credit")
const keys: Record<string, string> = {};
function buildEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => {
        function $slotValue(name: string, text: string) {
          const value = $createTestShadowRootNode();
          const textNode = $createTextNode(text);
          const paragraph = $createParagraphNode().append(textNode);
          value.append(paragraph);
          keys[name] = value.getKey();
          keys[`${name}Paragraph`] = paragraph.getKey();
          keys[`${name}Text`] = textNode.getKey();
          return value;
        }
        function $paragraph(name: string, text: string) {
          const textNode = $createTextNode(text);
          const paragraph = $createParagraphNode().append(textNode);
          keys[name] = paragraph.getKey();
          keys[`${name}Text`] = textNode.getKey();
          return paragraph;
        }
        const host = $createParagraphNode().append(
          $paragraph('body', 'Body'),
          $paragraph('more', 'More'),
        );
        const title = $slotValue('title', 'Title');
        // A slot nested in a slot value: on the title's paragraph.
        $setSlot(
          $element('titleParagraph'),
          'note',
          $slotValue('note', 'Note'),
        );
        $setSlot(host, 'title', title);
        $setSlot(host, 'aside', $slotValue('aside', 'Aside'));
        const decorator = $createTestDecoratorNode().setIsInline(false);
        $setSlot(decorator, 'credit', $slotValue('credit', 'Credit'));
        $setSlot(decorator, 'caption', $slotValue('caption', 'Caption'));
        $getRoot()
          .clear()
          .append($paragraph('before', 'Before'), host, decorator);
        keys.host = host.getKey();
        keys.decorator = decorator.getKey();
      },
      name: '[caret-across-slots]',
      nodes: [TestShadowRootNode, TestDecoratorNode],
    }),
  );
}

function $node(name: string): LexicalNode {
  const node = name === 'root' ? $getRoot() : $getNodeByKey(keys[name]);
  expect(node).not.toBe(null);
  return node!;
}

function $element(name: string) {
  return $assertNodeType($node(name), $isElementNode);
}

function $text(name: string, offset: number): PointCaret<'next'> {
  return $getTextPointCaret(
    $assertNodeType($node(`${name}Text`), $isTextNode),
    'next',
    offset,
  );
}

describe('$getCommonAncestorAcrossSlots', () => {
  test.each([
    ['the same node', 'bodyText', 'bodyText', 'same'],
    ['two children of one parent', 'body', 'more', 'branch'],
    ['an element host and its child', 'host', 'bodyText', 'ancestor'],
    ['a child and its element host', 'bodyText', 'host', 'descendant'],
  ])('returns the CommonAncestorResult shape for %s', (_label, a, b, type) => {
    using editor = buildEditor();
    editor.read('force-commit', () => {
      const result = $getCommonAncestorAcrossSlots($node(a), $node(b));
      expect(result && result.type).toBe(type);
      expect(result).toStrictEqual($getCommonAncestor($node(a), $node(b)));
    });
  });

  test('returns slot-ancestor with the slot name for a host and its slot content', () => {
    using editor = buildEditor();
    editor.read('force-commit', () => {
      expect(
        $getCommonAncestorAcrossSlots($node('host'), $node('titleText')),
      ).toEqual({
        b: $node('title'),
        bSlot: 'title',
        commonAncestor: $node('host'),
        type: 'slot-ancestor',
      });
      expect(
        $getCommonAncestorAcrossSlots($node('decorator'), $node('caption')),
      ).toEqual({
        b: $node('caption'),
        bSlot: 'caption',
        commonAncestor: $node('decorator'),
        type: 'slot-ancestor',
      });
    });
  });

  test('returns plain results for slot content below the common ancestor', () => {
    using editor = buildEditor();
    editor.read('force-commit', () => {
      expect(
        $getCommonAncestorAcrossSlots($node('root'), $node('captionText')),
      ).toStrictEqual({commonAncestor: $node('root'), type: 'ancestor'});
      expect(
        $getCommonAncestorAcrossSlots($node('captionText'), $node('noteText')),
      ).toStrictEqual({
        a: $node('decorator'),
        b: $node('host'),
        commonAncestor: $node('root'),
        type: 'branch',
      });
    });
  });

  test('reports the slot crossed last, at the common ancestor', () => {
    using editor = buildEditor();
    editor.read('force-commit', () => {
      expect(
        $getCommonAncestorAcrossSlots($node('host'), $node('noteText')),
      ).toEqual({
        b: $node('title'),
        bSlot: 'title',
        commonAncestor: $node('host'),
        type: 'slot-ancestor',
      });
      expect(
        $getCommonAncestorAcrossSlots($node('titleText'), $node('noteText')),
      ).toEqual({
        a: $node('titleText'),
        aSlot: null,
        b: $node('note'),
        bSlot: 'note',
        commonAncestor: $node('titleParagraph'),
        type: 'slot-branch',
      });
    });
  });

  test('returns slot-descendant with the slot name for slot content and its host', () => {
    using editor = buildEditor();
    editor.read('force-commit', () => {
      expect(
        $getCommonAncestorAcrossSlots($node('captionText'), $node('decorator')),
      ).toEqual({
        a: $node('caption'),
        aSlot: 'caption',
        commonAncestor: $node('decorator'),
        type: 'slot-descendant',
      });
    });
  });

  test('returns slot-branch for two slots, or a slot and a child, of one host', () => {
    using editor = buildEditor();
    editor.read('force-commit', () => {
      expect(
        $getCommonAncestorAcrossSlots($node('asideText'), $node('titleText')),
      ).toEqual({
        a: $node('aside'),
        aSlot: 'aside',
        b: $node('title'),
        bSlot: 'title',
        commonAncestor: $node('host'),
        type: 'slot-branch',
      });
      expect(
        $getCommonAncestorAcrossSlots($node('moreText'), $node('asideText')),
      ).toEqual({
        a: $node('more'),
        aSlot: null,
        b: $node('aside'),
        bSlot: 'aside',
        commonAncestor: $node('host'),
        type: 'slot-branch',
      });
      expect(
        $getCommonAncestorAcrossSlots(
          $node('creditText'),
          $node('captionText'),
        ),
      ).toEqual({
        a: $node('credit'),
        aSlot: 'credit',
        b: $node('caption'),
        bSlot: 'caption',
        commonAncestor: $node('decorator'),
        type: 'slot-branch',
      });
    });
  });

  test('returns null for nodes with no common ancestor', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const detached = $createTextNode('detached');
        expect(
          $getCommonAncestorAcrossSlots(detached, $node('titleText')),
        ).toBe(null);
      },
      {discrete: true},
    );
  });
});

describe('$getCommonAncestorAcrossSlots result types', () => {
  test('keep the argument types', () => {
    using editor = buildEditor();
    editor.read('force-commit', () => {
      const host = $assertNodeType($node('host'), $isParagraphNode);
      const text = $assertNodeType($node('titleText'), $isTextNode);
      const result = $getCommonAncestorAcrossSlots(host, text);
      assert(result !== null && result.type === 'slot-ancestor');
      // Each assignment type-checks only if the result kept A or B.
      const commonAncestor: ParagraphNode = result.commonAncestor;
      expect(commonAncestor).toBe(host);
      const reverse = $getCommonAncestorAcrossSlots(text, host);
      assert(reverse !== null && reverse.type === 'slot-descendant');
      const reverseAncestor: ParagraphNode = reverse.commonAncestor;
      expect(reverseAncestor).toBe(host);
      const same = $getCommonAncestorAcrossSlots(text, text);
      assert(same !== null && same.type === 'same');
      const sameText: TextNode = same.commonAncestor;
      expect(sameText).toBe(text);
      const branch = $getCommonAncestorAcrossSlots(text, $node('noteText'));
      assert(branch !== null && branch.type === 'slot-branch');
      const side: TextNode | ElementNode | DecoratorNode<unknown> = branch.a;
      expect(side).toBe(text);
    });
  });
});

describe('$comparePointCaretNextAcrossSlots', () => {
  test('orders points before a host, in its slots in slot order, in its children, and after it', () => {
    using editor = buildEditor();
    editor.read('force-commit', () => {
      const host = $element('host');
      const ordered: [string, PointCaret<'next'>][] = [
        ['before', $text('before', 2)],
        ['aside child caret', $getChildCaret($element('aside'), 'next')],
        ['aside start', $text('aside', 0)],
        ['aside end', $text('aside', 5)],
        ['aside sibling caret', $getSiblingCaret($node('aside'), 'next')],
        ['note', $text('note', 1)],
        [
          'title paragraph child caret',
          $getChildCaret($element('titleParagraph'), 'next'),
        ],
        ['title', $text('title', 1)],
        ['host child caret', $getChildCaret(host, 'next')],
        ['body', $text('body', 1)],
        ['more', $text('more', 1)],
        ['host sibling caret', $getSiblingCaret(host, 'next')],
        ['caption child caret', $getChildCaret($element('caption'), 'next')],
        ['caption', $text('caption', 1)],
        ['caption sibling caret', $getSiblingCaret($node('caption'), 'next')],
        ['credit', $text('credit', 1)],
        [
          'decorator sibling caret',
          $getSiblingCaret($node('decorator'), 'next'),
        ],
      ];
      for (const [i, [aLabel, a]] of ordered.entries()) {
        for (const [j, [bLabel, b]] of ordered.entries()) {
          expect([
            aLabel,
            bLabel,
            $comparePointCaretNextAcrossSlots(a, b),
          ]).toEqual([aLabel, bLabel, Math.sign(i - j)]);
        }
      }
    });
  });
});
