/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {$generateNodesFromDOM} from '@lexical/html';
import {$createLinkNode, $isLinkNode} from '@lexical/link';
import {
  $createMarkNode,
  $isMarkNode,
  $wrapSelectionInMarkNode,
} from '@lexical/mark';
import {$insertNodeIntoLeaf} from '@lexical/utils';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  $isParagraphNode,
  $isTextNode,
  $setSelection,
  type ElementNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {
  $assertNodeType,
  $createTestDecoratorNode,
  $createTestElementNode,
  $createTestInlineElementNode,
  initializeUnitTest,
} from 'lexical/src/__tests__/utils';
import {assert, beforeEach, describe, expect, test} from 'vitest';

describe('LexicalMarkNode tests', () => {
  initializeUnitTest(testEnv => {
    describe('$wrapSelectionInMarkNode', () => {
      beforeEach(() => {
        testEnv.editor.update(
          () => {
            $getRoot().clear().append($createParagraphNode());
          },
          {discrete: true},
        );
      });

      test('wraps a whole text node', () => {
        const {editor} = testEnv;

        editor.update(() => {
          const textNode = $createTextNode('marked');
          const paragraphNode = $assertNodeType(
            $getRoot().getFirstChild(),
            $isParagraphNode,
          );
          paragraphNode.append(textNode);
          const selection = $createRangeSelection();
          selection.anchor.set(textNode.getKey(), 0, 'text');
          selection.focus.set(
            textNode.getKey(),
            textNode.getTextContent().length,
            'text',
          );
          $wrapSelectionInMarkNode(selection, false, 'my-id');

          expect(paragraphNode.getChildren()).toHaveLength(1);
          const markNode = $assertNodeType(
            paragraphNode.getFirstChild(),
            $isMarkNode,
          );
          expect(markNode.getType()).toEqual('mark');
          expect(markNode.getIDs()).toEqual(['my-id']);
          expect(markNode.getChildren()).toHaveLength(1);
          expect(markNode.getFirstChildOrThrow().getKey()).toEqual(
            textNode.getKey(),
          );
          expect(markNode.getFirstChildOrThrow().getTextContent()).toEqual(
            'marked',
          );
        });
      });

      test('splits a text node if the selection is not at the start/end', () => {
        const {editor} = testEnv;

        editor.update(() => {
          const textNode = $createTextNode('unmarked marked unmarked');
          const paragraphNode = $assertNodeType(
            $getRoot().getFirstChild(),
            $isParagraphNode,
          );
          paragraphNode.append(textNode);
          const selection = $createRangeSelection();
          selection.anchor.set(textNode.getKey(), 'unmarked '.length, 'text');
          selection.focus.set(
            textNode.getKey(),
            'unmarked marked'.length,
            'text',
          );
          $wrapSelectionInMarkNode(selection, false, 'my-id');

          expect(paragraphNode.getTextContent()).toEqual(
            'unmarked marked unmarked',
          );
          expect(paragraphNode.getChildren().map(c => c.getType())).toEqual([
            'text',
            'mark',
            'text',
          ]);
          expect(
            paragraphNode.getChildren().map(c => c.getTextContent()),
          ).toEqual(['unmarked ', 'marked', ' unmarked']);
        });
      });

      test('includes inline decorator nodes', () => {
        const {editor} = testEnv;

        editor.update(() => {
          const decoratorNode = $createTestDecoratorNode();
          const textNode = $createTextNode('more text');
          const paragraphNode = $assertNodeType(
            $getRoot().getFirstChild(),
            $isParagraphNode,
          );
          paragraphNode.append(decoratorNode, textNode);
          const selection = $createRangeSelection();
          selection.anchor.set(paragraphNode.getKey(), 0, 'element');
          selection.focus.set(
            paragraphNode.getKey(),
            paragraphNode.getChildrenSize(),
            'element',
          );
          $wrapSelectionInMarkNode(selection, false, 'my-id');

          expect(paragraphNode.getChildren()).toHaveLength(1);
          const markNode = $assertNodeType(
            paragraphNode.getFirstChild(),
            $isMarkNode,
          );
          expect(markNode.getType()).toEqual('mark');
          expect(markNode.getChildren().map(c => c.getKey())).toEqual([
            decoratorNode.getKey(),
            textNode.getKey(),
          ]);
        });
      });

      test('keeps decorator nodes inside an existing mark', () => {
        const {editor} = testEnv;

        editor.update(() => {
          const paragraphNode = $getRoot().getFirstChild();
          assert($isParagraphNode(paragraphNode), 'Expecting ParagraphNode');
          const textNode = $createTextNode('aaa x^2 bbb');
          paragraphNode.append(textNode);

          const selection = textNode.select(0);
          $wrapSelectionInMarkNode(selection, false, 'comment-id');

          const markNode = paragraphNode.getFirstChildOrThrow();
          assert($isMarkNode(markNode), 'Expecting MarkNode');
          const markedTextNode = markNode.getFirstChildOrThrow();
          assert($isTextNode(markedTextNode), 'Expecting TextNode');
          const equationSelection = markedTextNode.select(
            'aaa '.length,
            'aaa x^2'.length,
          );
          $setSelection(equationSelection);

          $insertNodeIntoLeaf($createTestDecoratorNode());

          expect(paragraphNode.getChildren().map(c => c.getType())).toEqual([
            'mark',
          ]);
          const updatedMarkNode = paragraphNode.getFirstChildOrThrow();
          assert($isMarkNode(updatedMarkNode), 'Expecting MarkNode');
          expect(updatedMarkNode.getIDs()).toEqual(['comment-id']);
          const markChildren = updatedMarkNode.getChildren();
          expect(markChildren).toHaveLength(3);
          expect(markChildren[0].getTextContent()).toBe('aaa ');
          expect(markChildren[1].getType()).toBe('test_decorator');
          expect(markChildren[2].getTextContent()).toBe(' bbb');
        });
      });

      test('includes inline element nodes', () => {
        const {editor} = testEnv;

        editor.update(() => {
          const elementNode = $createTestInlineElementNode();
          const textNode = $createTextNode('more text');
          const paragraphNode = $assertNodeType(
            $getRoot().getFirstChild(),
            $isParagraphNode,
          );
          paragraphNode.append(elementNode, textNode);
          const selection = $createRangeSelection();
          selection.anchor.set(paragraphNode.getKey(), 0, 'element');
          selection.focus.set(
            paragraphNode.getKey(),
            paragraphNode.getChildrenSize(),
            'element',
          );
          $wrapSelectionInMarkNode(selection, false, 'my-id');

          expect(paragraphNode.getChildren()).toHaveLength(1);
          const markNode = $assertNodeType(
            paragraphNode.getFirstChild(),
            $isMarkNode,
          );
          expect(markNode.getType()).toEqual('mark');
          expect(markNode.getChildren().map(c => c.getKey())).toEqual([
            elementNode.getKey(),
            textNode.getKey(),
          ]);
        });
      });

      test('does not include block element nodes', () => {
        const {editor} = testEnv;

        editor.update(() => {
          const elementNode = $createTestElementNode();
          const textNode = $createTextNode('more text');
          const paragraphNode = $assertNodeType(
            $getRoot().getFirstChild(),
            $isParagraphNode,
          );
          paragraphNode.append(elementNode, textNode);
          const selection = $createRangeSelection();
          selection.anchor.set(paragraphNode.getKey(), 0, 'element');
          selection.focus.set(
            paragraphNode.getKey(),
            paragraphNode.getChildrenSize(),
            'element',
          );
          $wrapSelectionInMarkNode(selection, false, 'my-id');

          expect(paragraphNode.getChildren()).toHaveLength(2);
          expect(paragraphNode.getChildAtIndex(0)!.getKey()).toEqual(
            elementNode.getKey(),
          );

          // the text part of the selection should still be marked
          const markNode = $assertNodeType(
            paragraphNode.getChildAtIndex(1),
            $isMarkNode,
          );
          expect(markNode.getType()).toEqual('mark');
          expect(markNode.getChildren()).toHaveLength(1);
          expect(markNode.getTextContent()).toEqual('more text');
        });
      });
    });
    // https://github.com/facebook/lexical/issues/5606
    describe('$wrapSelectionInMarkNode with a partly selected link', () => {
      // Renders the paragraph as eg. `bef,mark[ore ],link[mark[li],nk], after`
      function $describe(node: LexicalNode): string {
        if ($isTextNode(node)) {
          return node.getTextContent();
        }
        const children = (node as ElementNode)
          .getChildren()
          .map($describe)
          .join(',');
        if ($isMarkNode(node)) {
          return `mark[${children}]`;
        }
        if ($isLinkNode(node)) {
          return `link[${children}]`;
        }
        return children;
      }

      // Builds `before link after`, where `link` is a link, and wraps the
      // range [start, end) of the paragraph's text content in a mark.
      function $wrapRange(start: number, end: number, isBackward = false) {
        const paragraph = $createParagraphNode();
        $getRoot().clear().append(paragraph);
        paragraph.append(
          $createTextNode('before '),
          $createLinkNode('https://lexical.dev').append(
            $createTextNode('link'),
          ),
          $createTextNode(' after'),
        );
        const texts = paragraph.getAllTextNodes();
        // A start point at a node boundary goes at the start of the next
        // text node, an end point at the end of the previous one.
        const $point = (offset: number, isEnd: boolean): [TextNode, number] => {
          for (const text of texts) {
            const size = text.getTextContentSize();
            if (
              offset < size ||
              (isEnd && offset === size) ||
              text === texts[texts.length - 1]
            ) {
              return [text, offset];
            }
            offset -= size;
          }
          throw new Error('unreachable');
        };
        const [startNode, startOffset] = $point(start, false);
        const [endNode, endOffset] = $point(end, true);
        const selection = $createRangeSelection();
        const anchor: [TextNode, number] = isBackward
          ? [endNode, endOffset]
          : [startNode, startOffset];
        const focus: [TextNode, number] = isBackward
          ? [startNode, startOffset]
          : [endNode, endOffset];
        selection.anchor.set(anchor[0].getKey(), anchor[1], 'text');
        selection.focus.set(focus[0].getKey(), focus[1], 'text');
        $wrapSelectionInMarkNode(selection, isBackward, 'id');
        expect(paragraph.getTextContent()).toBe('before link after');
        return $describe(paragraph);
      }

      test('marks only the selected start of the link', () => {
        testEnv.editor.update(() => {
          expect($wrapRange(3, 9)).toBe(
            'bef,mark[ore ],link[mark[li],nk], after',
          );
        });
      });

      test('marks only the selected end of the link', () => {
        testEnv.editor.update(() => {
          expect($wrapRange(9, 14)).toBe(
            'before ,link[li,mark[nk]],mark[ af],ter',
          );
        });
      });

      test('marks only the selected middle of the link', () => {
        testEnv.editor.update(() => {
          expect($wrapRange(8, 10)).toBe('before ,link[l,mark[in],k], after');
        });
      });

      test('marks a partly selected link with a backward selection', () => {
        testEnv.editor.update(() => {
          expect($wrapRange(3, 9, true)).toBe(
            'bef,mark[ore ],link[mark[li],nk], after',
          );
        });
      });

      test('marks the selected children of a link with several text nodes', () => {
        testEnv.editor.update(() => {
          const bold = $createTextNode('nk').toggleFormat('bold');
          const paragraph = $createParagraphNode();
          $getRoot().clear().append(paragraph);
          const before = $createTextNode('before ');
          paragraph.append(
            before,
            $createLinkNode('https://lexical.dev').append(
              $createTextNode('li'),
              bold,
            ),
          );
          const selection = $createRangeSelection();
          selection.anchor.set(before.getKey(), 3, 'text');
          selection.focus.set(bold.getKey(), 1, 'text');
          $wrapSelectionInMarkNode(selection, false, 'id');
          expect($describe(paragraph)).toBe(
            'bef,mark[ore ],link[mark[li,n],k]',
          );
        });
      });

      test('marks the selected parts of two links', () => {
        testEnv.editor.update(() => {
          const first = $createTextNode('one');
          const second = $createTextNode('two');
          const paragraph = $createParagraphNode();
          $getRoot().clear().append(paragraph);
          paragraph.append(
            $createLinkNode('https://a.dev').append(first),
            $createTextNode(' and '),
            $createLinkNode('https://b.dev').append(second),
          );
          const selection = $createRangeSelection();
          selection.anchor.set(first.getKey(), 1, 'text');
          selection.focus.set(second.getKey(), 2, 'text');
          $wrapSelectionInMarkNode(selection, false, 'id');
          expect($describe(paragraph)).toBe(
            'link[o,mark[ne]],mark[ and ],link[mark[tw],o]',
          );
        });
      });

      test('still wraps a fully selected link whole', () => {
        testEnv.editor.update(() => {
          expect($wrapRange(3, 14)).toBe('bef,mark[ore ,link[link], af],ter');
        });
      });

      test('still wraps a link whose text is exactly selected', () => {
        testEnv.editor.update(() => {
          expect($wrapRange(7, 11)).toBe('before ,link[mark[link]], after');
        });
      });
    });
    describe('$generateNodesFromDOM', () => {
      beforeEach(() => {
        testEnv.editor.update(
          () => {
            $getRoot().clear();
          },
          {discrete: true},
        );
      });

      test('retains spaces around mark elements', () => {
        const {editor} = testEnv;

        editor.update(() => {
          const dom = new DOMParser().parseFromString(
            `<html><body><p><span>Foo </span><mark>Bar</mark><span> !</span></p></body></html>`,
            'text/html',
          );
          const nodes = $generateNodesFromDOM(editor, dom);

          expect(nodes).toHaveLength(1);
          const paragraphNode = $assertNodeType(nodes[0], $isElementNode);
          expect(paragraphNode.getChildren()).toHaveLength(3);
          // The <mark> element is imported as plain text in this test, so all
          // three children are TextNodes.
          const textNode1 = $assertNodeType(
            paragraphNode.getChildAtIndex(0),
            $isTextNode,
          );
          const markNode = $assertNodeType(
            paragraphNode.getChildAtIndex(1),
            $isTextNode,
          );
          const textNode2 = $assertNodeType(
            paragraphNode.getChildAtIndex(2),
            $isTextNode,
          );

          expect(textNode1.getTextContent()).toEqual('Foo ');
          expect(markNode.getTextContent()).toEqual('Bar');
          expect(textNode2.getTextContent()).toEqual(' !');
        });
      });
    });
  });
});

describe('MarkNode overlap theme class', () => {
  initializeUnitTest(
    testEnv => {
      function markElement(ids: string[], nextIds?: string[]): HTMLElement {
        const {editor} = testEnv;
        let key = '';
        editor.update(
          () => {
            const markNode = $createMarkNode(ids);
            markNode.append($createTextNode('marked'));
            key = markNode.getKey();
            $getRoot().clear().append($createParagraphNode().append(markNode));
          },
          {discrete: true},
        );
        if (nextIds) {
          editor.update(
            () => {
              const markNode = $getNodeByKey(key);
              assert($isMarkNode(markNode), 'Expected a MarkNode');
              markNode.setIDs(nextIds);
            },
            {discrete: true},
          );
        }
        const element = editor.getElementByKey(key);
        assert(element !== null, 'Expected a rendered MarkNode');
        return element;
      }

      test('createDOM adds the overlap class for more than one id', () => {
        expect(markElement(['a', 'b', 'c']).className).toContain('mk-overlap');
      });

      test('updateDOM adds the overlap class when going from 1 to 3 ids', () => {
        expect(markElement(['a'], ['a', 'b', 'c']).className).toContain(
          'mk-overlap',
        );
      });

      test('updateDOM removes the overlap class when going from 2 to 0 ids', () => {
        expect(markElement(['a', 'b'], []).className).not.toContain(
          'mk-overlap',
        );
      });
    },
    {namespace: 'test', theme: {mark: 'mk', markOverlap: 'mk-overlap'}},
  );
});
