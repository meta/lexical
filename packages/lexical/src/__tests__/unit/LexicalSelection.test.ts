/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {
  buildEditorFromExtensions,
  defineExtension,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {
  $createLinkNode,
  $isLinkNode,
  LinkExtension,
  type LinkNode,
} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $isListNode,
  ListExtension,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import {$createQuoteNode, QuoteNode} from '@lexical/rich-text';
import {
  $caretRangeFromSelection,
  $comparePointCaretNext,
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $formatText,
  $getCaretInDirection,
  $getRoot,
  $getSelection,
  $isDecoratorNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $selectAll,
  $setCompositionKey,
  $setSelection,
  $setTextFormat,
  ElementNode,
  getDOMSelection,
  IS_BOLD,
  type LexicalNode,
  type ParagraphNode,
  type RangeSelection,
  type TextNode,
} from 'lexical';
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
} from 'vitest';

import {$internalCreateRangeSelection} from '../../LexicalSelection';
import {
  $assertNodeType,
  $createTestDecoratorNode,
  $createTestInlineElementNode,
  $createTestShadowRootNode,
  $isTestShadowRootNode,
  TestDecoratorNode,
  TestInlineElementNode,
  TestShadowRootNode,
} from '../utils';

const selectionTestExtension = defineExtension({
  dependencies: [LinkExtension, ListExtension],
  name: '@test/selection',
  nodes: [TestDecoratorNode, TestInlineElementNode, TestShadowRootNode],
});

function mapLatest<T extends LexicalNode>(nodes: T[]): T[] {
  return nodes.map(node => node.getLatest());
}

describe('LexicalSelection tests', () => {
  let editor: LexicalEditorWithDispose;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    container.contentEditable = 'true';
    document.body.appendChild(container);
    editor = buildEditorFromExtensions(selectionTestExtension);
    editor.setRootElement(container);
  });

  afterEach(() => {
    editor[Symbol.dispose]();
    container.remove();
  });

  describe('Inserting text either side of inline elements', () => {
    const setup = async (
      mode: 'start-of-paragraph' | 'mid-paragraph' | 'end-of-paragraph',
    ) => {
      await editor.update(() => {
        const root = $getRoot();
        root.clear();

        const paragraph = $createParagraphNode();
        if (mode === 'start-of-paragraph') {
          paragraph.append(
            $createLinkNode('https://', {}).append($createTextNode('a')),
            $createTextNode('b'),
          );
        } else if (mode === 'mid-paragraph') {
          paragraph.append(
            $createTextNode('a'),
            $createLinkNode('https://', {}).append($createTextNode('b')),
            $createTextNode('c'),
          );
        } else {
          paragraph.append(
            $createTextNode('a'),
            $createLinkNode('https://', {}).append($createTextNode('b')),
          );
        }

        root.append(paragraph);
      });

      const expectations = {
        'end-of-paragraph':
          '<p dir="auto"><span data-lexical-text="true">a</span><a href="https://"><span data-lexical-text="true">b</span></a></p>',
        'mid-paragraph':
          '<p dir="auto"><span data-lexical-text="true">a</span><a href="https://"><span data-lexical-text="true">b</span></a><span data-lexical-text="true">c</span></p>',
        'start-of-paragraph':
          '<p dir="auto"><a href="https://"><span data-lexical-text="true">a</span></a><span data-lexical-text="true">b</span></p>',
      };

      expect(container.innerHTML).toBe(expectations[mode]);
    };

    const $insertTextOrNodes = (
      selection: RangeSelection,
      method: 'insertText' | 'insertNodes',
    ) => {
      if (method === 'insertText') {
        // Insert text (mirroring what LexicalClipboard does when pasting
        // inline plain text)
        selection.insertText('x');
      } else {
        // Insert a paragraph bearing a single text node (mirroring what
        // LexicalClipboard does when pasting inline rich text)
        selection.insertNodes([
          $createParagraphNode().append($createTextNode('x')),
        ]);
      }
    };

    describe('Inserting text before inline elements', () => {
      describe('Start-of-paragraph inline elements', () => {
        const insertText = async (method: 'insertText' | 'insertNodes') => {
          await editor.update(() => {
            const paragraph = $getRoot().getFirstChildOrThrow();
            assert($isParagraphNode(paragraph));
            const linkNode = paragraph.getFirstChildOrThrow();
            assert($isLinkNode(linkNode));

            // Place the cursor at the start of the link node
            // For review: is there a way to select "outside" of the link
            // node?
            const selection = linkNode.select(0, 0);
            $insertTextOrNodes(selection, method);
          });

          expect(container.innerHTML).toBe(
            '<p dir="auto"><span data-lexical-text="true">x</span><a href="https://"><span data-lexical-text="true">a</span></a><span data-lexical-text="true">b</span></p>',
          );
        };

        test('Can insert text before a start-of-paragraph inline element, using insertText', async () => {
          await setup('start-of-paragraph');

          await insertText('insertText');
        });

        test('Can insert text before a start-of-paragraph inline element, using insertNodes', async () => {
          await setup('start-of-paragraph');

          await insertText('insertNodes');
        });
      });

      describe('Mid-paragraph inline elements', () => {
        const insertText = async (method: 'insertText' | 'insertNodes') => {
          await editor.update(() => {
            const paragraph = $getRoot().getFirstChildOrThrow();
            assert($isParagraphNode(paragraph));
            const textNode = paragraph.getFirstChildOrThrow();
            assert($isTextNode(textNode));

            // Place the cursor between the link and the first text node by
            // selecting the end of the text node
            const selection = textNode.select(1, 1);
            $insertTextOrNodes(selection, method);
          });

          expect(container.innerHTML).toBe(
            '<p dir="auto"><span data-lexical-text="true">ax</span><a href="https://"><span data-lexical-text="true">b</span></a><span data-lexical-text="true">c</span></p>',
          );
        };

        test('Can insert text before a mid-paragraph inline element, using insertText', async () => {
          await setup('mid-paragraph');

          await insertText('insertText');
        });

        test('Can insert text before a mid-paragraph inline element, using insertNodes', async () => {
          await setup('mid-paragraph');

          await insertText('insertNodes');
        });
      });

      describe('End-of-paragraph inline elements', () => {
        const insertText = async (method: 'insertText' | 'insertNodes') => {
          await editor.update(() => {
            const paragraph = $getRoot().getFirstChildOrThrow();
            assert($isParagraphNode(paragraph));
            const textNode = paragraph.getFirstChildOrThrow();
            assert($isTextNode(textNode));

            // Place the cursor before the link element by selecting the end
            // of the text node
            const selection = textNode.select(1, 1);
            $insertTextOrNodes(selection, method);
          });

          expect(container.innerHTML).toBe(
            '<p dir="auto"><span data-lexical-text="true">ax</span><a href="https://"><span data-lexical-text="true">b</span></a></p>',
          );
        };

        test('Can insert text before an end-of-paragraph inline element, using insertText', async () => {
          await setup('end-of-paragraph');

          await insertText('insertText');
        });

        test('Can insert text before an end-of-paragraph inline element, using insertNodes', async () => {
          await setup('end-of-paragraph');

          await insertText('insertNodes');
        });
      });
    });

    describe('Inserting text after inline elements', () => {
      describe('Start-of-paragraph inline elements', () => {
        const insertText = async (method: 'insertText' | 'insertNodes') => {
          await editor.update(() => {
            const paragraph = $getRoot().getFirstChildOrThrow();
            assert($isParagraphNode(paragraph));
            const textNode = paragraph.getLastChildOrThrow();
            assert($isTextNode(textNode));

            // Place the cursor between the link and the last text node by
            // selecting the start of the text node
            const selection = textNode.select(0, 0);
            $insertTextOrNodes(selection, method);
          });

          expect(container.innerHTML).toBe(
            '<p dir="auto"><a href="https://"><span data-lexical-text="true">a</span></a><span data-lexical-text="true">xb</span></p>',
          );
        };

        test('Can insert text after a start-of-paragraph inline element, using insertText', async () => {
          await setup('start-of-paragraph');

          await insertText('insertText');
        });

        test('Can insert text after a start-of-paragraph inline element, using insertNodes', async () => {
          await setup('start-of-paragraph');

          await insertText('insertNodes');
        });
      });

      describe('Mid-paragraph inline elements', () => {
        const insertText = async (method: 'insertText' | 'insertNodes') => {
          await editor.update(() => {
            const paragraph = $getRoot().getFirstChildOrThrow();
            assert($isParagraphNode(paragraph));
            const textNode = paragraph.getLastChildOrThrow();
            assert($isTextNode(textNode));

            // Place the cursor between the link and the last text node by
            // selecting the start of the text node
            const selection = textNode.select(0, 0);
            $insertTextOrNodes(selection, method);
          });

          expect(container.innerHTML).toBe(
            '<p dir="auto"><span data-lexical-text="true">a</span><a href="https://"><span data-lexical-text="true">b</span></a><span data-lexical-text="true">xc</span></p>',
          );
        };

        test('Can insert text after a mid-paragraph inline element, using insertText', async () => {
          await setup('mid-paragraph');

          await insertText('insertText');
        });

        test('Can insert text after a mid-paragraph inline element, using insertNodes', async () => {
          await setup('mid-paragraph');

          await insertText('insertNodes');
        });
      });

      describe('End-of-paragraph inline elements', () => {
        const insertText = async (method: 'insertText' | 'insertNodes') => {
          await editor.update(() => {
            const paragraph = $getRoot().getFirstChildOrThrow();
            assert($isParagraphNode(paragraph));
            const linkNode = paragraph.getLastChildOrThrow();
            assert($isLinkNode(linkNode));

            // Place the cursor at the end of the link element
            // For review: not sure if there's a better way to select
            // "outside" of the link element.
            const selection = linkNode.select(1, 1);
            $insertTextOrNodes(selection, method);
          });

          expect(container.innerHTML).toBe(
            '<p dir="auto"><span data-lexical-text="true">a</span><a href="https://"><span data-lexical-text="true">b</span></a><span data-lexical-text="true">x</span></p>',
          );
        };

        test('Can insert text after an end-of-paragraph inline element, using insertText', async () => {
          await setup('end-of-paragraph');

          await insertText('insertText');
        });

        test('Can insert text after an end-of-paragraph inline element, using insertNodes', async () => {
          await setup('end-of-paragraph');

          await insertText('insertNodes');
        });
      });
    });
  });

  describe('insertText()', () => {
    test('inserts into existing paragraph node when selection is on parent of paragraph', () => {
      editor.update(
        () => {
          const root = $getRoot();
          const paragraph = $createParagraphNode();
          root.clear().append(paragraph);

          const selection = $createRangeSelection();
          selection.anchor.set('root', 0, 'element');
          selection.focus.set('root', 0, 'element');
          $setSelection(selection);

          selection.insertText('text');
          expect(root.getChildrenSize()).toBe(1);
          expect(root.getTextContent()).toBe('text');
        },
        {discrete: true},
      );
    });
  });

  describe('removeText', () => {
    describe('with a leading TextNode and a trailing token TextNode', () => {
      let leadingText: TextNode;
      let trailingTokenText: TextNode;
      let paragraph: ParagraphNode;
      beforeEach(() => {
        editor.update(
          () => {
            leadingText = $createTextNode('leading text');
            trailingTokenText = $createTextNode('token text').setMode('token');
            paragraph = $createParagraphNode().append(
              leadingText,
              trailingTokenText,
            );
            $getRoot().clear().append(paragraph);
          },
          {discrete: true},
        );
      });
      test('remove all text', () => {
        editor.update(
          () => {
            const sel = leadingText
              .select(0, 0)
              .setTextNodeRange(
                leadingText,
                0,
                trailingTokenText,
                trailingTokenText.getTextContentSize(),
              );
            sel.removeText();
            expect(leadingText.isAttached()).toBe(false);
            expect(trailingTokenText.isAttached()).toBe(false);
            expect($getRoot().getAllTextNodes()).toHaveLength(0);
            const selection = $getSelection();
            assert($isRangeSelection(selection));
            expect(selection.isCollapsed()).toBe(true);
            expect(selection.anchor.key).toBe(paragraph.getKey());
            expect(selection.anchor.offset).toBe(0);
          },
          {discrete: true},
        );
      });
      test('remove initial TextNode', () => {
        editor.update(
          () => {
            const sel = leadingText.select(0, leadingText.getTextContentSize());
            sel.removeText();
            expect(leadingText.isAttached()).toBe(false);
            expect(trailingTokenText.isAttached()).toBe(true);
            expect($getRoot().getAllTextNodes()).toHaveLength(1);
            const selection = $getSelection();
            assert($isRangeSelection(selection));
            expect(selection.isCollapsed()).toBe(true);
            expect(selection.anchor.key).toBe(trailingTokenText.getKey());
            expect(selection.anchor.offset).toBe(0);
          },
          {discrete: true},
        );
      });
      test('remove trailing token TextNode', () => {
        editor.update(
          () => {
            const sel = trailingTokenText.select(
              0,
              trailingTokenText.getTextContentSize(),
            );
            sel.removeText();
            expect(leadingText.isAttached()).toBe(true);
            expect(trailingTokenText.isAttached()).toBe(false);
            expect($getRoot().getAllTextNodes()).toHaveLength(1);
            const selection = $getSelection();
            assert($isRangeSelection(selection));
            expect(selection.isCollapsed()).toBe(true);
            expect(selection.anchor.key).toBe(leadingText.getKey());
            expect(selection.anchor.offset).toBe(
              leadingText.getTextContentSize(),
            );
          },
          {discrete: true},
        );
      });
      test('remove initial TextNode and partial token TextNode', () => {
        editor.update(
          () => {
            const sel = leadingText
              .select(0, 0)
              .setTextNodeRange(
                leadingText,
                0,
                trailingTokenText,
                'token '.length,
              );
            sel.removeText();
            expect(leadingText.isAttached()).toBe(false);
            // expecting no node since it was token
            expect(trailingTokenText.isAttached()).toBe(false);
            const allTextNodes = $getRoot().getAllTextNodes();
            expect(allTextNodes).toHaveLength(0);
            const selection = $getSelection();
            assert($isRangeSelection(selection));
            expect(selection.isCollapsed()).toBe(true);
            expect(selection.anchor.key).toBe(paragraph.getKey());
            expect(selection.anchor.offset).toBe(0);
          },
          {discrete: true},
        );
      });
      test('remove partial initial TextNode and partial token TextNode', () => {
        editor.update(
          () => {
            const sel = leadingText
              .select(0, 0)
              .setTextNodeRange(
                leadingText,
                'lead'.length,
                trailingTokenText,
                'token '.length,
              );
            sel.removeText();
            expect(leadingText.isAttached()).toBe(true);
            expect(trailingTokenText.isAttached()).toBe(false);
            const allTextNodes = $getRoot().getAllTextNodes();
            // The token node will be completely removed
            expect(allTextNodes.map(node => node.getTextContent())).toEqual([
              'lead',
            ]);
            const selection = $getSelection();
            assert($isRangeSelection(selection));
            expect(selection.isCollapsed()).toBe(true);
            expect(selection.anchor.key).toBe(leadingText.getKey());
            expect(selection.anchor.offset).toBe('lead'.length);
          },
          {discrete: true},
        );
      });
    });
    describe('with a leading token TextNode and a trailing TextNode', () => {
      let leadingTokenText: TextNode;
      let trailingText: TextNode;
      let paragraph: ParagraphNode;
      beforeEach(() => {
        editor.update(
          () => {
            leadingTokenText = $createTextNode('token text').setMode('token');
            trailingText = $createTextNode('trailing text');
            paragraph = $createParagraphNode().append(
              leadingTokenText,
              trailingText,
            );
            $getRoot().clear().append(paragraph);
          },
          {discrete: true},
        );
      });
      test('remove all text', () => {
        editor.update(
          () => {
            const sel = leadingTokenText
              .select(0, 0)
              .setTextNodeRange(
                leadingTokenText,
                0,
                trailingText,
                trailingText.getTextContentSize(),
              );
            sel.removeText();
            expect(leadingTokenText.isAttached()).toBe(false);
            expect(trailingText.isAttached()).toBe(false);
            expect($getRoot().getAllTextNodes()).toHaveLength(0);
            const selection = $getSelection();
            assert($isRangeSelection(selection));
            expect(selection.isCollapsed()).toBe(true);
            expect(selection.anchor.key).toBe(paragraph.getKey());
            expect(selection.anchor.offset).toBe(0);
          },
          {discrete: true},
        );
      });
      test('remove trailing TextNode', () => {
        editor.update(
          () => {
            const sel = trailingText.select(
              0,
              trailingText.getTextContentSize(),
            );
            sel.removeText();
            expect(leadingTokenText.isAttached()).toBe(true);
            expect(trailingText.isAttached()).toBe(false);
            expect($getRoot().getAllTextNodes()).toHaveLength(1);
            const selection = $getSelection();
            assert($isRangeSelection(selection));
            expect(selection.isCollapsed()).toBe(true);
            expect(selection.anchor.key).toBe(leadingTokenText.getKey());
            expect(selection.anchor.offset).toBe(
              leadingTokenText.getTextContentSize(),
            );
          },
          {discrete: true},
        );
      });
      test('remove leading token TextNode', () => {
        editor.update(
          () => {
            const sel = leadingTokenText.select(
              0,
              leadingTokenText.getTextContentSize(),
            );
            sel.removeText();
            expect(leadingTokenText.isAttached()).toBe(false);
            expect(trailingText.isAttached()).toBe(true);
            expect($getRoot().getAllTextNodes()).toHaveLength(1);
            const selection = $getSelection();
            assert($isRangeSelection(selection));
            expect(selection.isCollapsed()).toBe(true);
            expect(selection.anchor.key).toBe(trailingText.getKey());
            expect(selection.anchor.offset).toBe(0);
          },
          {discrete: true},
        );
      });
      test('remove partial leading token TextNode and trailing TextNode', () => {
        editor.update(
          () => {
            const sel = leadingTokenText
              .select(0, 0)
              .setTextNodeRange(
                leadingTokenText,
                'token '.length,
                trailingText,
                trailingText.getTextContentSize(),
              );
            sel.removeText();
            expect(trailingText.isAttached()).toBe(false);
            // expecting no node since it was token
            expect(leadingTokenText.isAttached()).toBe(false);
            const allTextNodes = $getRoot().getAllTextNodes();
            expect(allTextNodes).toHaveLength(0);
            const selection = $getSelection();
            assert($isRangeSelection(selection));
            expect(selection.isCollapsed()).toBe(true);
            expect(selection.anchor.key).toBe(paragraph.getKey());
            expect(selection.anchor.offset).toBe(0);
          },
          {discrete: true},
        );
      });
      test('remove partial token TextNode and partial trailing TextNode', () => {
        editor.update(
          () => {
            const sel = leadingTokenText
              .select(0, 0)
              .setTextNodeRange(
                leadingTokenText,
                'token '.length,
                trailingText,
                'trail'.length,
              );
            sel.removeText();
            expect(leadingTokenText.isAttached()).toBe(false);
            expect(trailingText.isAttached()).toBe(true);
            const allTextNodes = $getRoot().getAllTextNodes();
            // The token node will be completely removed
            expect(allTextNodes.map(node => node.getTextContent())).toEqual([
              'ing text',
            ]);
            const selection = $getSelection();
            assert($isRangeSelection(selection));
            expect(selection.isCollapsed()).toBe(true);
            expect(selection.anchor.key).toBe(trailingText.getKey());
            expect(selection.anchor.offset).toBe(0);
          },
          {discrete: true},
        );
      });
    });
    describe('with a leading TextNode and a trailing segmented TextNode', () => {
      let leadingText: TextNode;
      let trailingSegmentedText: TextNode;
      let paragraph: ParagraphNode;
      beforeEach(() => {
        editor.update(
          () => {
            leadingText = $createTextNode('leading text');
            trailingSegmentedText =
              $createTextNode('segmented text').setMode('segmented');
            paragraph = $createParagraphNode().append(
              leadingText,
              trailingSegmentedText,
            );
            $getRoot().clear().append(paragraph);
          },
          {discrete: true},
        );
      });
      test('remove all text', () => {
        editor.update(
          () => {
            const sel = leadingText
              .select(0, 0)
              .setTextNodeRange(
                leadingText,
                0,
                trailingSegmentedText,
                trailingSegmentedText.getTextContentSize(),
              );
            sel.removeText();
            expect(leadingText.isAttached()).toBe(false);
            expect(trailingSegmentedText.isAttached()).toBe(false);
            expect($getRoot().getAllTextNodes()).toHaveLength(0);
            const selection = $getSelection();
            assert($isRangeSelection(selection));
            expect(selection.isCollapsed()).toBe(true);
            expect(selection.anchor.key).toBe(paragraph.getKey());
            expect(selection.anchor.offset).toBe(0);
          },
          {discrete: true},
        );
      });
      test('remove initial TextNode', () => {
        editor.update(
          () => {
            const sel = leadingText.select(0, leadingText.getTextContentSize());
            sel.removeText();
            expect(leadingText.isAttached()).toBe(false);
            expect(trailingSegmentedText.isAttached()).toBe(true);
            expect($getRoot().getAllTextNodes()).toHaveLength(1);
            const selection = $getSelection();
            assert($isRangeSelection(selection));
            expect(selection.isCollapsed()).toBe(true);
            expect(selection.anchor.key).toBe(trailingSegmentedText.getKey());
            expect(selection.anchor.offset).toBe(0);
          },
          {discrete: true},
        );
      });
      test('remove trailing segmented TextNode', () => {
        editor.update(
          () => {
            const sel = trailingSegmentedText.select(
              0,
              trailingSegmentedText.getTextContentSize(),
            );
            sel.removeText();
            expect(leadingText.isAttached()).toBe(true);
            expect(trailingSegmentedText.isAttached()).toBe(false);
            expect($getRoot().getAllTextNodes()).toHaveLength(1);
            const selection = $getSelection();
            assert($isRangeSelection(selection));
            expect(selection.isCollapsed()).toBe(true);
            expect(selection.anchor.key).toBe(leadingText.getKey());
            expect(selection.anchor.offset).toBe(
              leadingText.getTextContentSize(),
            );
          },
          {discrete: true},
        );
      });
      test('remove initial TextNode and partial segmented TextNode', () => {
        editor.update(
          () => {
            const sel = leadingText
              .select(0, 0)
              .setTextNodeRange(
                leadingText,
                0,
                trailingSegmentedText,
                'segmented '.length,
              );
            sel.removeText();
            expect(leadingText.isAttached()).toBe(false);
            // expecting a new node since it was segmented
            expect(trailingSegmentedText.isAttached()).toBe(false);
            const allTextNodes = $getRoot().getAllTextNodes();
            expect(allTextNodes.map(node => node.getTextContent())).toEqual([
              'text',
            ]);
            const selection = $getSelection();
            assert($isRangeSelection(selection));
            expect(selection.isCollapsed()).toBe(true);
            expect(selection.anchor.key).toBe(allTextNodes[0].getKey());
            expect(selection.anchor.offset).toBe(0);
          },
          {discrete: true},
        );
      });
      test('remove partial initial TextNode and partial segmented TextNode', () => {
        editor.update(
          () => {
            const sel = leadingText
              .select(0, 0)
              .setTextNodeRange(
                leadingText,
                'lead'.length,
                trailingSegmentedText,
                'segmented '.length,
              );
            expect($getSelection()).toBe(sel);
            sel.removeText();
            expect($getSelection()).toBe(sel);
            expect(leadingText.isAttached()).toBe(true);
            expect(trailingSegmentedText.isAttached()).toBe(false);
            const allTextNodes = $getRoot().getAllTextNodes();
            // These should get merged in reconciliation
            expect(allTextNodes.map(node => node.getTextContent())).toEqual([
              'lead',
              'text',
            ]);
            const selection = $getSelection();
            assert($isRangeSelection(selection));
            expect(selection.isCollapsed()).toBe(true);
            expect(selection.anchor.key).toBe(leadingText.getKey());
            expect(selection.anchor.offset).toBe('lead'.length);
          },
          {discrete: true},
        );
        editor.read('latest', () => {
          const allTextNodes = $getRoot().getAllTextNodes();
          // These should get merged in reconciliation
          expect(allTextNodes.map(node => node.getTextContent())).toEqual([
            'leadtext',
          ]);
          expect(leadingText.isAttached()).toBe(true);
        });
      });
    });
  });
});

describe('Segmented node composition (#5065)', () => {
  test('insertText during composition preserves node key', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const segmented = $createTextNode('JohnSmith').setMode('segmented');
        $getRoot().clear().append($createParagraphNode().append(segmented));
        const key = segmented.getKey();

        $setCompositionKey(key);
        const sel = segmented.select(4, 4);
        sel.insertText('');

        const latest = segmented.getLatest();
        expect(latest.getKey()).toBe(key);
        expect(latest.isSegmented()).toBe(false);
        expect(latest.getTextContent()).toBe('JohnSmith');
      },
      {discrete: true},
    );
  });

  test('insertText without composition replaces segmented node', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const segmented = $createTextNode('JohnSmith').setMode('segmented');
        $getRoot().clear().append($createParagraphNode().append(segmented));

        const sel = segmented.select(4, 4);
        sel.insertText('');

        expect(segmented.isAttached()).toBe(false);
        const allText = $getRoot().getAllTextNodes();
        expect(allText).toHaveLength(1);
        expect(allText[0].getKey()).not.toBe(segmented.getKey());
        expect(allText[0].getTextContent()).toBe('JohnSmith');
      },
      {discrete: true},
    );
  });

  test('insertText without composition types into a segmented node', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const segmented = $createTextNode('JohnSmith').setMode('segmented');
        $getRoot().clear().append($createParagraphNode().append(segmented));

        const sel = segmented.select(4, 4);
        sel.insertText('X');

        expect(segmented.isAttached()).toBe(false);
        const allText = $getRoot().getAllTextNodes();
        expect(allText).toHaveLength(1);
        expect(allText[0].isSegmented()).toBe(false);
        expect(allText[0].getTextContent()).toBe('JohnXSmith');
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        expect(selection.isCollapsed()).toBe(true);
        expect(selection.anchor.key).toBe(allText[0].getKey());
        expect(selection.anchor.offset).toBe(5);
      },
      {discrete: true},
    );
  });

  test('insertText during composition preserves format and style', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const segmented = $createTextNode('JohnSmith')
          .setMode('segmented')
          .setFormat('bold');
        $getRoot().clear().append($createParagraphNode().append(segmented));
        const key = segmented.getKey();

        $setCompositionKey(key);
        const sel = segmented.select(4, 4);
        sel.format = 1; // bold
        sel.insertText('');

        const latest = segmented.getLatest();
        expect(latest.isAttached()).toBe(true);
        expect(latest.getKey()).toBe(key);
        expect(latest.getFormat()).toBe(1);
      },
      {discrete: true},
    );
  });
});

describe('Non-collapsed selection + composition preserves node identity', () => {
  test('spliceText into existing node instead of creating new one', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const textNode = $createTextNode('Hello World');
        $getRoot().clear().append($createParagraphNode().append(textNode));
        const key = textNode.getKey();

        $setCompositionKey(key);
        const sel = textNode.select(5, 11);
        sel.insertText('!');

        const latest = textNode.getLatest();
        expect(latest.getKey()).toBe(key);
        expect(latest.getTextContent()).toBe('Hello!');
      },
      {discrete: true},
    );
  });

  test('without composition creates a new node', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const textNode = $createTextNode('Hello World');
        $getRoot().clear().append($createParagraphNode().append(textNode));
        const key = textNode.getKey();

        const sel = textNode.select(5, 11);
        sel.insertText('!');

        const allText = $getRoot().getAllTextNodes();
        expect(allText).toHaveLength(2);
        expect(allText[0].getTextContent()).toBe('Hello');
        expect(allText[1].getTextContent()).toBe('!');
        expect(allText[1].getKey()).not.toBe(key);
      },
      {discrete: true},
    );
  });
});

describe('Regression tests for #6701', () => {
  test('insertNodes fails an invariant when there is no Block ancestor', async () => {
    class InlineElementNode extends ElementNode {
      $config() {
        return this.config('inline-element-node', {extends: ElementNode});
      }
      isInline() {
        return true;
      }
      createDOM() {
        return document.createElement('span');
      }
      updateDOM() {
        return false;
      }
    }
    using editor = buildEditorFromExtensions(
      defineExtension({name: '@test/6701', nodes: [InlineElementNode]}),
    );
    expect(() =>
      editor.update(
        () => {
          const textNode = $createTextNode('test');
          $getRoot().clear().append(new InlineElementNode().append(textNode));
          textNode.select().insertNodes([$createTextNode('more text')]);
        },
        {discrete: true},
      ),
    ).toThrow(
      /Expected node TextNode of type text to have a block ElementNode ancestor/,
    );
  });
});

describe('Regression tests for #8707', () => {
  // A shadow root that holds block-level children directly (e.g. a
  // decorator-only container). Placing the caret adjacent to a block child
  // shows the block cursor, whose RangeSelection is a collapsed element point
  // on the shadow root itself. Inserting block-level content there (such as
  // pasting a copied decorator) used to throw because a shadow root has no
  // block ancestor to split. Roots and shadow roots hold blocks directly, so
  // the block goes straight in at the anchor offset with no paragraph wrapper.
  test('inserts a block decorator after the block cursor at the end of a shadow root', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    let shadowKey = '';
    editor.update(
      () => {
        const shadow = $createTestShadowRootNode();
        shadow.append($createTestDecoratorNode().setIsInline(false));
        $getRoot().clear().append(shadow);
        shadowKey = shadow.getKey();
        // Block cursor: collapsed element point after the decorator.
        shadow.select(1, 1);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.insertNodes([$createTestDecoratorNode().setIsInline(false)]);
      },
      {discrete: true},
    );

    editor.read(() => {
      const root = $getRoot();
      // The decorator landed in the same shadow root as the block cursor,
      // not the outer document root.
      expect(root.getChildrenSize()).toBe(1);
      const shadow = root.getFirstChildOrThrow();
      assert($isTestShadowRootNode(shadow), 'Expected shadow root');
      expect(shadow.getKey()).toBe(shadowKey);
      const children = shadow.getChildren();
      expect(children).toHaveLength(2);
      expect(children.every($isDecoratorNode)).toBe(true);
    });
  });

  test('inserts a block decorator before the block cursor at the start of a shadow root', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    let existingKey = '';
    editor.update(
      () => {
        const shadow = $createTestShadowRootNode();
        const existing = $createTestDecoratorNode().setIsInline(false);
        shadow.append(existing);
        $getRoot().clear().append(shadow);
        existingKey = existing.getKey();
        // Block cursor: collapsed element point before the decorator.
        shadow.select(0, 0);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.insertNodes([$createTestDecoratorNode().setIsInline(false)]);
      },
      {discrete: true},
    );

    editor.read(() => {
      const shadow = $getRoot().getFirstChildOrThrow();
      assert($isTestShadowRootNode(shadow), 'Expected shadow root');
      const children = shadow.getChildren();
      expect(children).toHaveLength(2);
      expect(children.every($isDecoratorNode)).toBe(true);
      // Inserted before the pre-existing decorator.
      expect(children[1].getKey()).toBe(existingKey);
    });
  });

  test('inserts a block decorator into an empty shadow root', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const shadow = $createTestShadowRootNode();
        $getRoot().clear().append(shadow);
        shadow.select(0, 0);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.insertNodes([$createTestDecoratorNode().setIsInline(false)]);
      },
      {discrete: true},
    );

    editor.read(() => {
      const shadow = $getRoot().getFirstChildOrThrow();
      assert($isTestShadowRootNode(shadow), 'Expected shadow root');
      const children = shadow.getChildren();
      expect(children).toHaveLength(1);
      assert($isDecoratorNode(children[0]));
    });
  });

  test('inserts a block element at the block cursor inside a shadow root', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const shadow = $createTestShadowRootNode();
        shadow.append($createTestDecoratorNode().setIsInline(false));
        $getRoot().clear().append(shadow);
        shadow.select(1, 1);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.insertNodes([
          $createParagraphNode().append($createTextNode('inserted')),
        ]);
      },
      {discrete: true},
    );

    editor.read(() => {
      const shadow = $getRoot().getFirstChildOrThrow();
      assert($isTestShadowRootNode(shadow), 'Expected shadow root');
      const children = shadow.getChildren();
      expect(children).toHaveLength(2);
      assert($isDecoratorNode(children[0]));
      assert($isParagraphNode(children[1]));
      expect(children[1].getTextContent()).toBe('inserted');
    });
  });

  test('insertParagraph at an element point on a shadow root seeds into that shadow root', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const shadow = $createTestShadowRootNode();
        shadow.append($createTestDecoratorNode().setIsInline(false));
        $getRoot().clear().append(shadow);
        shadow.select(1, 1);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        const paragraph = selection.insertParagraph();
        assert(paragraph !== null, 'Expected a paragraph to be inserted');
        expect(paragraph.getParent()!.is($getRoot().getFirstChild())).toBe(
          true,
        );
      },
      {discrete: true},
    );

    editor.read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(1);
      const shadow = root.getFirstChildOrThrow();
      assert($isTestShadowRootNode(shadow), 'Expected shadow root');
      expect(shadow.getChildrenSize()).toBe(2);
      assert($isParagraphNode(shadow.getLastChild()));
    });
  });

  test('inserts a block decorator at a root element point without wrapping it in a paragraph', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('existing')));
        // Element point directly on the root, after the paragraph.
        $getRoot().select(1, 1);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.insertNodes([$createTestDecoratorNode().setIsInline(false)]);
      },
      {discrete: true},
    );

    editor.read(() => {
      const children = $getRoot().getChildren();
      // The decorator is a direct child of root; no empty paragraph wrapper
      // was created for it.
      expect(children).toHaveLength(2);
      assert($isParagraphNode(children[0]));
      assert($isDecoratorNode(children[1]));
    });
  });
});

describe('Regression tests for #8075', () => {
  test('forward delete removes an empty block before a shadow root', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        const shadow = $createTestShadowRootNode().append(
          $createParagraphNode().append($createTextNode('inside')),
        );
        $getRoot().clear().append(paragraph, shadow);
        paragraph.selectStart();
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.deleteCharacter(false);
      },
      {discrete: true},
    );

    editor.read(() => {
      const children = $getRoot().getChildren();
      // The empty paragraph is gone and the shadow root is untouched.
      expect(children).toHaveLength(1);
      expect(
        $assertNodeType(children[0], $isTestShadowRootNode).getTextContent(),
      ).toBe('inside');
    });
  });

  test('forward delete keeps a non-empty block before a shadow root', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const paragraph = $createParagraphNode().append(
          $createTextNode('before'),
        );
        const shadow = $createTestShadowRootNode().append(
          $createParagraphNode().append($createTextNode('inside')),
        );
        $getRoot().clear().append(paragraph, shadow);
        paragraph.selectEnd();
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.deleteCharacter(false);
      },
      {discrete: true},
    );

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(2);
      expect(children[0].getTextContent()).toBe('before');
      expect(
        $assertNodeType(children[1], $isTestShadowRootNode).getTextContent(),
      ).toBe('inside');
    });
  });

  test('forward delete from an empty block at the end of a shadow root does nothing', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const inner = $createParagraphNode();
        $getRoot()
          .clear()
          .append(
            $createTestShadowRootNode().append(inner),
            $createTestShadowRootNode().append(
              $createParagraphNode().append($createTextNode('next')),
            ),
          );
        inner.selectStart();
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.deleteCharacter(false);
      },
      {discrete: true},
    );

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(2);
      const shadow = $assertNodeType(children[0], $isTestShadowRootNode);
      // The empty block still belongs to the first shadow root; the
      // following shadow root was not pulled into it.
      expect(shadow.getChildrenSize()).toBe(1);
      expect(shadow.getTextContent()).toBe('');
      expect(children[1].getTextContent()).toBe('next');
    });
  });
});

describe('Regression tests for #9095', () => {
  // insertNodes with block-level content at a collapsed selection first
  // splits the target paragraph (insertParagraph), then tries to merge the
  // split-off paragraph into the last inserted block. The merge branch
  // required $isElementNode(lastInsertedBlock), so a pasted block-level
  // DecoratorNode (which is its own INTERNAL_$isBlock ancestor) skipped the
  // cleanup entirely, and a container element such as a ListNode failed the
  // INTERNAL_$isBlock(lastToInsert) clause instead (its first child is a
  // ListItemNode). Both left a stray empty paragraph after the pasted node
  // whenever the caret sat at the end of a paragraph, while pasting a plain
  // paragraph or quote at the same caret cleaned up correctly. The split-off
  // paragraph is now also removed when it is empty, which keeps the
  // mid-paragraph case (where it holds the text after the caret) intact.
  const insertBlockTestExtension = defineExtension({
    dependencies: [selectionTestExtension],
    name: '@test/selection-insert-block',
    nodes: [QuoteNode],
  });

  const $placeCaretInFirstText = (offset: number) => {
    const paragraph = $getRoot().getFirstChildOrThrow();
    assert($isParagraphNode(paragraph), 'Expected a paragraph');
    const text = paragraph.getFirstChildOrThrow();
    assert($isTextNode(text), 'Expected a text node');
    text.select(offset, offset);
  };

  const setupParagraph = (
    editor: LexicalEditorWithDispose,
    text: string,
    caretOffset: number,
  ) => {
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode(text)));
        $placeCaretInFirstText(caretOffset);
      },
      {discrete: true},
    );
  };

  const insertBlocks = (
    editor: LexicalEditorWithDispose,
    $makeNodes: () => LexicalNode[],
  ) => {
    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.insertNodes($makeNodes());
      },
      {discrete: true},
    );
  };

  const $makeList = () =>
    $createListNode('bullet').append(
      $createListItemNode().append($createTextNode('item')),
    );

  test('pasting a block decorator at the end of a paragraph leaves no empty paragraph', () => {
    using editor = buildEditorFromExtensions(insertBlockTestExtension);
    setupParagraph(editor, 'hello', 5);
    insertBlocks(editor, () => [$createTestDecoratorNode().setIsInline(false)]);

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(2);
      assert($isParagraphNode(children[0]));
      expect(children[0].getTextContent()).toBe('hello');
      assert($isDecoratorNode(children[1]));
    });
  });

  test('pasting a block decorator in the middle of a paragraph keeps the trailing text', () => {
    using editor = buildEditorFromExtensions(insertBlockTestExtension);
    setupParagraph(editor, 'helloworld', 5);
    insertBlocks(editor, () => [$createTestDecoratorNode().setIsInline(false)]);

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(3);
      assert($isParagraphNode(children[0]));
      expect(children[0].getTextContent()).toBe('hello');
      assert($isDecoratorNode(children[1]));
      assert($isParagraphNode(children[2]));
      expect(children[2].getTextContent()).toBe('world');
    });
  });

  test('pasting a block decorator at the start of a paragraph keeps the paragraph after it', () => {
    using editor = buildEditorFromExtensions(insertBlockTestExtension);
    setupParagraph(editor, 'hello', 0);
    insertBlocks(editor, () => [$createTestDecoratorNode().setIsInline(false)]);

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(2);
      assert($isDecoratorNode(children[0]));
      assert($isParagraphNode(children[1]));
      expect(children[1].getTextContent()).toBe('hello');
    });
  });

  test('pasting a list at the end of a paragraph leaves no empty paragraph', () => {
    using editor = buildEditorFromExtensions(insertBlockTestExtension);
    setupParagraph(editor, 'hello', 5);
    insertBlocks(editor, () => [$makeList()]);

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(2);
      assert($isParagraphNode(children[0]));
      expect(children[0].getTextContent()).toBe('hello');
      assert($isListNode(children[1]));
      expect(children[1].getTextContent()).toBe('item');
    });
  });

  test('pasting a list in the middle of a paragraph keeps the trailing text', () => {
    using editor = buildEditorFromExtensions(insertBlockTestExtension);
    setupParagraph(editor, 'helloworld', 5);
    insertBlocks(editor, () => [$makeList()]);

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(3);
      assert($isParagraphNode(children[0]));
      expect(children[0].getTextContent()).toBe('hello');
      assert($isListNode(children[1]));
      assert($isParagraphNode(children[2]));
      expect(children[2].getTextContent()).toBe('world');
    });
  });

  test('pasting a list at the start of a paragraph keeps the paragraph after it', () => {
    using editor = buildEditorFromExtensions(insertBlockTestExtension);
    setupParagraph(editor, 'hello', 0);
    insertBlocks(editor, () => [$makeList()]);

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(2);
      assert($isListNode(children[0]));
      assert($isParagraphNode(children[1]));
      expect(children[1].getTextContent()).toBe('hello');
    });
  });

  // Control cases: at the same caret, a leaf block element merges through
  // the existing branch and never leaves a stray paragraph. This is the
  // in-function inconsistency the regression tests above pin down.
  test('pasting a quote at the end of a paragraph merges into it (control)', () => {
    using editor = buildEditorFromExtensions(insertBlockTestExtension);
    setupParagraph(editor, 'hello', 5);
    insertBlocks(editor, () => [
      $createQuoteNode().append($createTextNode('quoted')),
    ]);

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(1);
      assert($isParagraphNode(children[0]));
      expect(children[0].getTextContent()).toBe('helloquoted');
    });
  });

  test('pasting a paragraph at the end of a paragraph merges into it (control)', () => {
    using editor = buildEditorFromExtensions(insertBlockTestExtension);
    setupParagraph(editor, 'hello', 5);
    insertBlocks(editor, () => [
      $createParagraphNode().append($createTextNode('world')),
    ]);

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(1);
      assert($isParagraphNode(children[0]));
      expect(children[0].getTextContent()).toBe('helloworld');
    });
  });

  test('typing after pasting a block decorator at the end creates a paragraph on demand', () => {
    using editor = buildEditorFromExtensions(insertBlockTestExtension);
    setupParagraph(editor, 'hello', 5);
    insertBlocks(editor, () => [$createTestDecoratorNode().setIsInline(false)]);

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.insertText('x');
      },
      {discrete: true},
    );

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(3);
      assert($isParagraphNode(children[0]));
      expect(children[0].getTextContent()).toBe('hello');
      assert($isDecoratorNode(children[1]));
      assert($isParagraphNode(children[2]));
      expect(children[2].getTextContent()).toBe('x');
    });
  });
});

describe('getNodes() and extract()', () => {
  let editor: LexicalEditorWithDispose;
  let paragraphNode: ParagraphNode;
  let paragraphText: TextNode;
  let linkNode: LinkNode;
  let linkText: TextNode;
  let listNode: ListNode;
  let listItemText1: TextNode;
  let listItemText2: TextNode;
  let listItem1: ListItemNode;
  let listItem2: ListItemNode;
  let emptyParagraph: ParagraphNode;

  beforeEach(() => {
    editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(() => {
      paragraphText = $createTextNode('paragraph text');
      linkText = $createTextNode('link text');
      linkNode = $createLinkNode();
      paragraphNode = $createParagraphNode();
      listItemText1 = $createTextNode('item 1');
      listItemText2 = $createTextNode('item 2');
      listItem1 = $createListItemNode();
      listItem2 = $createListItemNode();
      listNode = $createListNode('bullet');
      emptyParagraph = $createParagraphNode();
      $getRoot()
        .clear()
        .append(
          paragraphNode.append(paragraphText, linkNode.append(linkText)),
          listNode.append(
            listItem1.append(listItemText1),
            listItem2.append(listItemText2),
          ),
          emptyParagraph,
        );
    });
  });
  afterEach(() => {
    editor[Symbol.dispose]();
  });
  describe('getNodes()', () => {
    describe('$selectAll()', () => {
      test('with test document', () => {
        editor.update(
          () => {
            const selection = $selectAll();
            // Normalized to the text nodes
            expect(selection).toMatchObject({
              anchor: {key: paragraphText.getKey(), offset: 0, type: 'text'},
              focus: {key: emptyParagraph.getKey(), offset: 0, type: 'element'},
            });
            expect(selection.getNodes()).toEqual([
              paragraphText,
              linkNode,
              linkText,
              // The parent paragraphNode comes after its children because the
              // selection started inside of it at paragraphText
              paragraphNode,
              listNode,
              listItem1,
              listItemText1,
              listItem2,
              listItemText2,
              emptyParagraph,
            ]);
          },
          {discrete: true},
        );
      });
      test('with leading inline decorator', () => {
        editor.update(
          () => {
            const inlineDecoratorLeading = $createTestDecoratorNode();
            paragraphNode.splice(0, 0, [inlineDecoratorLeading]);
            const selection = $selectAll();
            // Normalized to the text nodes
            expect(selection).toMatchObject({
              anchor: {key: paragraphNode.getKey(), offset: 0, type: 'element'},
              focus: {key: emptyParagraph.getKey(), offset: 0, type: 'element'},
            });
            expect(selection.getNodes()).toEqual(
              [
                inlineDecoratorLeading,
                paragraphText,
                linkNode,
                linkText,
                // The parent paragraphNode comes after its children because the
                // selection started inside of it at paragraphText
                paragraphNode,
                listNode,
                listItem1,
                listItemText1,
                listItem2,
                listItemText2,
                emptyParagraph,
              ].map(node => node.getLatest()),
            );
          },
          {discrete: true},
        );
      });
      test('with trailing inline decorator', () => {
        editor.update(
          () => {
            const inlineDecoratorTrailing = $createTestDecoratorNode();
            const noLongerEmptyParagraph = emptyParagraph;
            noLongerEmptyParagraph.splice(0, 0, [inlineDecoratorTrailing]);
            const selection = $selectAll();
            // Normalized to the text nodes
            expect(selection).toMatchObject({
              anchor: {key: paragraphText.getKey(), offset: 0, type: 'text'},
              focus: {key: emptyParagraph.getKey(), offset: 1, type: 'element'},
            });
            expect(selection.getNodes()).toEqual(
              [
                paragraphText,
                linkNode,
                linkText,
                // The parent paragraphNode comes after its children because the
                // selection started inside of it at paragraphText
                paragraphNode,
                listNode,
                listItem1,
                listItemText1,
                listItem2,
                listItemText2,
                noLongerEmptyParagraph,
                inlineDecoratorTrailing,
              ].map(node => node.getLatest()),
            );
          },
          {discrete: true},
        );
      });
      test('with leading empty inline element', () => {
        editor.update(
          () => {
            const inlineElementLeading = $createTestInlineElementNode();
            paragraphNode.splice(0, 0, [inlineElementLeading]);
            const selection = $selectAll();
            // Normalized to the text nodes
            expect(selection).toMatchObject({
              anchor: {
                key: inlineElementLeading.getKey(),
                offset: 0,
                type: 'element',
              },
              focus: {key: emptyParagraph.getKey(), offset: 0, type: 'element'},
            });
            expect(selection.getNodes()).toEqual(
              [
                inlineElementLeading,
                paragraphText,
                linkNode,
                linkText,
                // The parent paragraphNode comes after its children because the
                // selection started inside of it at paragraphText
                paragraphNode,
                listNode,
                listItem1,
                listItemText1,
                listItem2,
                listItemText2,
                emptyParagraph,
              ].map(node => node.getLatest()),
            );
          },
          {discrete: true},
        );
      });
      test('with trailing empty inline element', () => {
        editor.update(
          () => {
            const inlineElementTrailing = $createTestInlineElementNode();
            const noLongerEmptyParagraph = emptyParagraph;
            noLongerEmptyParagraph.splice(0, 0, [inlineElementTrailing]);
            const selection = $selectAll();
            // Normalized to the text nodes
            expect(selection).toMatchObject({
              anchor: {key: paragraphText.getKey(), offset: 0, type: 'text'},
              focus: {
                key: inlineElementTrailing.getKey(),
                offset: 0,
                type: 'element',
              },
            });
            expect(selection.getNodes()).toEqual(
              [
                paragraphText,
                linkNode,
                linkText,
                // The parent paragraphNode comes after its children because the
                // selection started inside of it at paragraphText
                paragraphNode,
                listNode,
                listItem1,
                listItemText1,
                listItem2,
                listItemText2,
                noLongerEmptyParagraph,
                inlineElementTrailing,
              ].map(node => node.getLatest()),
            );
          },
          {discrete: true},
        );
      });
      test('after removing empty paragraph', () => {
        editor.update(
          () => {
            emptyParagraph.remove();
            const selection = $selectAll();
            // Normalized to the text nodes
            expect(selection).toMatchObject({
              anchor: {key: paragraphText.getKey(), offset: 0, type: 'text'},
              focus: {
                key: listItemText2.getKey(),
                offset: listItemText2.getTextContentSize(),
                type: 'text',
              },
            });
            expect(selection.getNodes()).toEqual(
              [
                paragraphText,
                linkNode,
                linkText,
                // The parent paragraphNode comes after its children because the
                // selection started inside of it at paragraphText
                paragraphNode,
                listNode,
                listItem1,
                listItemText1,
                listItem2,
                listItemText2,
              ].map(n => n.getLatest()),
            );
          },
          {discrete: true},
        );
      });
    });
    test('Manual select all without normalization', () => {
      editor.update(
        () => {
          const selection = $createRangeSelection();
          selection.anchor.set('root', 0, 'element');
          selection.focus.set('root', $getRoot().getChildrenSize(), 'element');
          expect(selection.getNodes()).toEqual([
            paragraphText,
            linkNode,
            linkText,
            // The parent paragraphNode comes later because there is
            // an implicit normalization in the beginning of getNodes
            // to work around… something? See the getDescendantByIndex usage.
            paragraphNode,
            listNode,
            listItem1,
            listItemText1,
            listItem2,
            listItemText2,
            emptyParagraph,
          ]);
        },
        {discrete: true},
      );
    });
    test('Manual select all from first text to last empty paragraph', () => {
      editor.update(
        () => {
          const selection = $createRangeSelection();
          selection.anchor.set(paragraphText.getKey(), 0, 'text');
          selection.focus.set(emptyParagraph.getKey(), 0, 'element');
          expect(selection.getNodes()).toEqual([
            paragraphText,
            linkNode,
            linkText,
            // The parent paragraphNode comes later because there is
            // an implicit normalization in the beginning of getNodes
            // to work around… something? See the getDescendantByIndex usage.
            paragraphNode,
            listNode,
            listItem1,
            listItemText1,
            listItem2,
            listItemText2,
            emptyParagraph,
          ]);
        },
        {discrete: true},
      );
    });
    test('Manual select with focus collapsed between inline decorators', () => {
      editor.update(
        () => {
          const inlineDecoratorLeading = $createTestDecoratorNode();
          const inlineDecoratorTrailing = $createTestDecoratorNode();
          const noLongerEmptyParagraph = emptyParagraph;
          noLongerEmptyParagraph.splice(0, 0, [
            inlineDecoratorLeading,
            inlineDecoratorTrailing,
          ]);
          const selection = $createRangeSelection();
          // Collapsed between decorators
          selection.anchor.set(noLongerEmptyParagraph.getKey(), 1, 'element');
          selection.focus.set(noLongerEmptyParagraph.getKey(), 1, 'element');
          expect(selection.isCollapsed()).toBe(true);
          expect(selection).toMatchObject({
            anchor: {
              key: noLongerEmptyParagraph.getKey(),
              offset: 1,
              type: 'element',
            },
            focus: {
              key: noLongerEmptyParagraph.getKey(),
              offset: 1,
              type: 'element',
            },
          });
          expect(selection.getNodes()).toEqual(
            // The bias is towards the right
            [inlineDecoratorTrailing].map(node => node.getLatest()),
          );
        },
        {discrete: true},
      );
    });
    test('Manual select with focus collapsed after inline decorator', () => {
      editor.update(
        () => {
          const inlineDecoratorLeading = $createTestDecoratorNode();
          const inlineDecoratorTrailing = $createTestDecoratorNode();
          const noLongerEmptyParagraph = emptyParagraph;
          noLongerEmptyParagraph.splice(0, 0, [
            inlineDecoratorLeading,
            inlineDecoratorTrailing,
          ]);
          const selection = $createRangeSelection();
          // Collapsed after decorators
          selection.anchor.set(noLongerEmptyParagraph.getKey(), 2, 'element');
          selection.focus.set(noLongerEmptyParagraph.getKey(), 2, 'element');
          expect(selection.isCollapsed()).toBe(true);
          expect(selection).toMatchObject({
            anchor: {
              key: noLongerEmptyParagraph.getKey(),
              offset: 2,
              type: 'element',
            },
            focus: {
              key: noLongerEmptyParagraph.getKey(),
              offset: 2,
              type: 'element',
            },
          });
          expect(selection.getNodes()).toEqual(
            // The bias is towards the last descendant since no
            // nodes exist to the right
            [inlineDecoratorTrailing].map(node => node.getLatest()),
          );
        },
        {discrete: true},
      );
    });
    test('Manual select with focus between inline decorators', () => {
      editor.update(
        () => {
          const inlineDecoratorLeading = $createTestDecoratorNode();
          const inlineDecoratorTrailing = $createTestDecoratorNode();
          const noLongerEmptyParagraph = emptyParagraph;
          noLongerEmptyParagraph.splice(0, 0, [
            inlineDecoratorLeading,
            inlineDecoratorTrailing,
          ]);
          const selection = $createRangeSelection();
          selection.anchor.set(paragraphText.getKey(), 0, 'text');
          selection.focus.set(noLongerEmptyParagraph.getKey(), 1, 'element');
          expect(selection).toMatchObject({
            anchor: {key: paragraphText.getKey(), offset: 0, type: 'text'},
            focus: {
              key: noLongerEmptyParagraph.getKey(),
              offset: 1,
              type: 'element',
            },
          });
          expect(selection.getNodes()).toEqual(
            [
              paragraphText,
              linkNode,
              linkText,
              // The parent paragraphNode comes after its children because the
              // selection started inside of it at paragraphText
              paragraphNode,
              listNode,
              listItem1,
              listItemText1,
              listItem2,
              listItemText2,
              noLongerEmptyParagraph,
              inlineDecoratorLeading,
            ].map(node => node.getLatest()),
          );
        },
        {discrete: true},
      );
    });
    test('select only the paragraph (not normalized)', () => {
      editor.update(
        () => {
          const selection = paragraphNode.select(
            0,
            paragraphNode.getChildrenSize(),
          );
          expect(selection).toMatchObject({
            anchor: {key: paragraphNode.getKey(), offset: 0, type: 'element'},
            focus: {
              key: paragraphNode.getKey(),
              offset: paragraphNode.getChildrenSize(),
              type: 'element',
            },
          });
          // The selection doesn't visit outside of the paragraph
          expect(selection.getNodes()).toEqual([
            paragraphText,
            linkNode,
            linkText,
          ]);
        },
        {discrete: true},
      );
    });
    test('select around the paragraph (not normalized)', () => {
      editor.update(
        () => {
          const selection = $createRangeSelection();
          selection.anchor.set(
            'root',
            paragraphNode.getIndexWithinParent(),
            'element',
          );
          selection.focus.set(
            'root',
            paragraphNode.getIndexWithinParent() + 1,
            'element',
          );
          expect(selection).toMatchObject({
            anchor: {key: 'root', offset: 0, type: 'element'},
            focus: {key: 'root', offset: 1, type: 'element'},
          });
          // The selection shouldn't visit outside of the paragraph
          expect(selection.getNodes()).toEqual([
            paragraphText,
            linkNode,
            linkText,
            paragraphNode,
          ]);
        },
        {discrete: true},
      );
    });
    test('selection collapsed inside an empty element', () => {
      editor.update(
        () => {
          const selection = $createRangeSelection();
          selection.anchor.set(emptyParagraph.getKey(), 0, 'element');
          selection.focus.set(emptyParagraph.getKey(), 0, 'element');
          // The selection should include the node it is collapsed inside
          expect(selection.getNodes()).toEqual([emptyParagraph]);
        },
        {discrete: true},
      );
    });
    test('select an empty ListItemNode (collapsed)', () => {
      editor.update(
        () => {
          const emptyListItem = $createListItemNode();
          listItem2.insertBefore(emptyListItem);
          const selection = $createRangeSelection();
          selection.anchor.set(emptyListItem.getKey(), 0, 'element');
          selection.focus.set(emptyListItem.getKey(), 0, 'element');
          expect(selection).toMatchObject({
            anchor: {key: emptyListItem.getKey(), offset: 0, type: 'element'},
            focus: {key: emptyListItem.getKey(), offset: 0, type: 'element'},
          });
          expect(selection.getNodes()).toEqual([emptyListItem]);
        },
        {discrete: true},
      );
    });
  });
  describe('extract()', () => {
    test('Manual select all without normalization', () => {
      editor.update(
        () => {
          const selection = $createRangeSelection();
          selection.anchor.set('root', 0, 'element');
          selection.focus.set('root', $getRoot().getChildrenSize(), 'element');
          const extracted = selection.extract();
          expect(extracted).toEqual([
            paragraphText,
            linkNode,
            linkText,
            // The parent paragraphNode comes later because there is
            // an implicit normalization in the beginning of getNodes
            // to work around… something? See the getDescendantByIndex usage.
            paragraphNode,
            listNode,
            listItem1,
            listItemText1,
            listItem2,
            listItemText2,
            emptyParagraph,
          ]);
          expect(selection.getNodes()).toEqual(extracted);
        },
        {discrete: true},
      );
    });
    test('Manual select all from first text to last empty paragraph', () => {
      editor.update(
        () => {
          const selection = $createRangeSelection();
          selection.anchor.set(paragraphText.getKey(), 0, 'text');
          selection.focus.set(emptyParagraph.getKey(), 0, 'element');
          const extracted = selection.extract();
          expect(extracted).toEqual([
            paragraphText,
            linkNode,
            linkText,
            // The parent paragraphNode comes later because there is
            // an implicit normalization in the beginning of getNodes
            // to work around… something? See the getDescendantByIndex usage.
            paragraphNode,
            listNode,
            listItem1,
            listItemText1,
            listItem2,
            listItemText2,
            emptyParagraph,
          ]);
          expect(selection.getNodes()).toEqual(extracted);
        },
        {discrete: true},
      );
    });
    test('select partial TextNode extracts paragraph text', () => {
      editor.update(
        () => {
          const selection = paragraphText.select(2, 8);
          const extracted = selection.extract();
          expect(extracted).toEqual([
            expect.objectContaining({__text: 'ragrap'}),
          ]);
          expect(selection.getNodes()).toEqual(extracted);
        },
        {discrete: true},
      );
    });
    test('select partial TextNode extracts link text', () => {
      editor.update(
        () => {
          const selection = linkText.select(1, 4);
          const extracted = selection.extract();
          expect(extracted).toEqual([expect.objectContaining({__text: 'ink'})]);
          expect(selection.getNodes()).toEqual(extracted);
        },
        {discrete: true},
      );
    });
    test('select multiple partial TextNode extracts text', () => {
      editor.update(
        () => {
          const selection = $createRangeSelection();
          selection.setTextNodeRange(paragraphText, 10, linkText, 4);
          const extracted = selection.extract();
          expect(mapLatest(extracted)).toEqual([
            expect.objectContaining({__text: 'text'}),
            linkNode.getLatest(),
            expect.objectContaining({__text: 'link'}),
          ]);
          expect(mapLatest(selection.getNodes())).toEqual(mapLatest(extracted));
        },
        {discrete: true},
      );
    });
    test('select last offset TextNode as first node removes node', () => {
      editor.update(
        () => {
          const selection = $createRangeSelection();
          selection.setTextNodeRange(
            paragraphText,
            paragraphText.getTextContentSize(),
            linkText,
            4,
          );
          const beforeNodes = selection.getNodes();
          const extracted = selection.extract();
          expect(mapLatest(extracted)).toEqual([
            linkNode.getLatest(),
            expect.objectContaining({__text: 'link'}),
          ]);
          // The identity of the linkText does not change
          // since the first node is re-used
          expect(mapLatest(selection.getNodes())).toEqual(
            mapLatest(beforeNodes),
          );
        },
        {discrete: true},
      );
    });
    test('select 0 offset TextNode as last node removes node', () => {
      editor.update(
        () => {
          const selection = $createRangeSelection();
          selection.setTextNodeRange(paragraphText, 4, linkText, 0);
          const beforeNodes = selection.getNodes();
          expect(mapLatest(selection.extract())).toEqual([
            expect.objectContaining({__text: 'graph text'}),
            linkNode.getLatest(),
          ]);
          // The identity is not paragraphText anymore because
          // that is the left side outside of the extraction
          expect(mapLatest(selection.getNodes())).toEqual([
            paragraphText.getNextSibling(),
            ...mapLatest(beforeNodes.slice(1)),
          ]);
        },
        {discrete: true},
      );
    });
  });
});

describe('Regression #7081', () => {
  test('Firefox selection & paste before linebreak', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const textNode =
          $createTextNode('XXXX').setStyle(`color: --color-test`);
        const paragraphNode = $createParagraphNode();
        $getRoot()
          .clear()
          .append(
            paragraphNode.append(
              $createTextNode('ID: '),
              textNode,
              $createLineBreakNode(),
              $createTextNode('aa'),
            ),
          );
        const selection = textNode.select(0);
        selection.focus.set(
          paragraphNode.getKey(),
          1 + textNode.getIndexWithinParent(),
          'element',
        );
        selection.insertText('123');
        const children = paragraphNode.getChildren();
        const styledChild = children.find(
          c => $isTextNode(c) && c.getStyle() === 'color: --color-test',
        );
        expect(styledChild).toBeDefined();
        expect(styledChild?.getTextContent()).toBe('123');
      },
      {discrete: true},
    );
  });
});

describe('Regression #7173', () => {
  test('Can insertNodes of multiple blocks with a target of an initial empty block and the entire next block', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const emptyParagraph = $createParagraphNode();
        const replacedParagraph = $createParagraphNode().append(
          $createTextNode('replaced!'),
        );
        $getRoot().clear().append(emptyParagraph, replacedParagraph);
        const selection = $selectAll();
        const insertedNodes = [
          $createParagraphNode().append($createTextNode('p1')),
          $createParagraphNode().append($createTextNode('p2')),
        ];
        selection.insertNodes(insertedNodes);
        const children = $getRoot().getChildren();
        expect(children).toHaveLength(2);
        expect(children).toEqual(insertedNodes);
      },
      {discrete: true},
    );
  });
});

describe('Regression #3181', () => {
  test('Point.isBefore edge case with mixed TextNode & ElementNode and matching descendants', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        const targetText = $createTextNode('target').setMode('token');
        $getRoot()
          .clear()
          .append(
            paragraph.append(
              $createTextNode('a').setMode('token'),
              $createTextNode('b').setMode('token'),
              targetText,
            ),
          );
        const selection = paragraph.select(2, 2);
        selection.focus.set(targetText.getKey(), 1, 'text');
        expect(selection).toMatchObject({
          anchor: {key: paragraph.getKey(), offset: 2, type: 'element'},
          focus: {key: targetText.getKey(), offset: 1, type: 'text'},
        });
        const caretRange = $caretRangeFromSelection(selection);
        expect(
          $comparePointCaretNext(
            $getCaretInDirection(caretRange.anchor, 'next'),
            $getCaretInDirection(caretRange.focus, 'next'),
          ),
        ).toBe(-1);
        expect(selection.anchor.isBefore(selection.focus)).toBe(true);
        expect(selection.focus.isBefore(selection.anchor)).toBe(false);
      },
      {discrete: true},
    );
  });
});

describe('Regression #8067', () => {
  test('Formatting issue when replacing text with format', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        const firstNode = $createTextNode('hello');
        firstNode.toggleFormat('bold');
        const lastNode = $createTextNode(' world!');
        paragraph.append(firstNode, lastNode);
        root.clear().append(paragraph);
        const selection = $selectAll();
        selection.insertText('hello');
        const children = $assertNodeType(
          paragraph.getChildren()[0],
          $isTextNode,
        );
        expect(children.getTextContent()).toBe('hello');
        expect(children.hasFormat('bold')).toBe(true);
      },
      {discrete: true},
    );
  });
});

describe('insertText with backward selection inherits first node format', () => {
  test('backward selection across bold+plain inherits bold', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        const boldNode = $createTextNode('hello');
        boldNode.toggleFormat('bold');
        const plainNode = $createTextNode(' world');
        paragraph.append(boldNode, plainNode);
        root.clear().append(paragraph);
        // Backward selection: anchor at end of plain, focus at start of bold
        const selection = plainNode
          .select(6, 6)
          .setTextNodeRange(plainNode, 6, boldNode, 0);
        selection.insertText('X');
        const child = $assertNodeType(paragraph.getChildren()[0], $isTextNode);
        expect(child.getTextContent()).toBe('X');
        expect(child.hasFormat('bold')).toBe(true);
      },
      {discrete: true},
    );
  });
});

describe('insertText needsRedirect paths', () => {
  test('token node at middle offset replaces entire node', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const token = $createTextNode('abcdef').setMode('token');
        const paragraph = $createParagraphNode().append(token);
        $getRoot().clear().append(paragraph);
        const sel = token.select(3, 3);
        sel.insertText('X');
        const children = paragraph.getChildren();
        expect(children).toHaveLength(1);
        const child = $assertNodeType(children[0], $isTextNode);
        expect(child.getTextContent()).toBe('X');
        expect(token.isAttached()).toBe(false);
      },
      {discrete: true},
    );
  });

  test('offset 0 on token reuses insertable previous sibling', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const prev = $createTextNode('before');
        const token = $createTextNode('locked').setMode('token');
        const paragraph = $createParagraphNode().append(prev, token);
        $getRoot().clear().append(paragraph);
        token.select(0, 0);
        const sel = $getSelection();
        assert($isRangeSelection(sel));
        sel.insertText('X');
        expect(prev.getLatest().getTextContent()).toBe('beforeX');
        expect(token.isAttached()).toBe(true);
      },
      {discrete: true},
    );
  });

  test('offset at end of token reuses insertable next sibling', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const token = $createTextNode('locked').setMode('token');
        const next = $createTextNode('after');
        const paragraph = $createParagraphNode().append(token, next);
        $getRoot().clear().append(paragraph);
        token.select(6, 6);
        const sel = $getSelection();
        assert($isRangeSelection(sel));
        sel.insertText('X');
        expect(next.getLatest().getTextContent()).toBe('Xafter');
        expect(token.isAttached()).toBe(true);
      },
      {discrete: true},
    );
  });
});

describe('insertText formatDiffers on empty text node', () => {
  test('applies format in-place on empty anchor then splices text', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const empty = $createTextNode('');
        const paragraph = $createParagraphNode().append(empty);
        $getRoot().clear().append(paragraph);
        const sel = empty.select(0, 0);
        sel.format = IS_BOLD;
        sel.insertText('typed');
        expect(empty.isAttached()).toBe(true);
        expect(empty.getLatest().getTextContent()).toBe('typed');
        expect(empty.getLatest().hasFormat('bold')).toBe(true);
        expect(paragraph.getChildrenSize()).toBe(1);
      },
      {discrete: true},
    );
  });
});

describe('RangeSelection.isBackward() caching (#5825)', () => {
  test('caches the result and invalidates on Point mutations', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        const text = $createTextNode('hello');
        paragraph.append(text);
        root.append(paragraph);

        const selection = text.select(0, 5);
        expect(selection._cachedIsBackward).toBeNull();

        // First call computes and caches.
        expect(selection.isBackward()).toBe(false);
        expect(selection._cachedIsBackward).toBe(false);

        // Hits the cache without recomputing.
        expect(selection.isBackward()).toBe(false);

        // setTextNodeRange routes through anchor.set + focus.set,
        // invalidating the cache.
        selection.setTextNodeRange(text, 5, text, 0);
        expect(selection._cachedIsBackward).toBeNull();

        // anchor=5, focus=0 → now backward, recomputed and re-cached.
        expect(selection.isBackward()).toBe(true);
        expect(selection._cachedIsBackward).toBe(true);
      },
      {discrete: true},
    );
  });
});

describe('Regression #8098', () => {
  test('Do not apply format and style when moving to different node', () => {
    const container = document.createElement('div');
    container.contentEditable = 'true';
    document.body.appendChild(container);
    onTestFinished(() => container.remove());
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.setRootElement(container);
    let normalTextKey: string;

    editor.update(
      () => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        const firstNode = $createTextNode('가다');
        firstNode.toggleFormat('bold');
        const lastNode = $createTextNode('라바');
        paragraph.append(firstNode, lastNode);
        root.clear().append(paragraph);
        firstNode.select(0, 0).format = 1;
        normalTextKey = lastNode.getKey();
      },
      {discrete: true},
    );

    const domSelection = getDOMSelection(editor._window ?? window);
    const range = document.createRange();
    range.setStart(editor.getElementByKey(normalTextKey!)!.firstChild!, 1);
    range.collapse(true);
    domSelection?.removeAllRanges();
    domSelection?.addRange(range);

    editor.update(
      () => {
        const selection = $internalCreateRangeSelection(
          $getSelection(),
          domSelection,
          editor,
          {type: 'selectionchange'} as Event,
        );
        expect(selection).not.toBeNull();
        expect(selection!.format).toBe(0);
        expect(selection!.style).toBe('');
      },
      {discrete: true},
    );
  });
});

describe('$wrapInlineNodes regression', () => {
  test('Wraps all inline nodes, preserving first linebreak if contain a block element', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        $getRoot().clear();
        const selection = $selectAll();

        const inlineNodes = [
          $createLineBreakNode(),
          $createTextNode('p1'),
          $createTextNode('p1').setFormat('bold'),
        ];
        selection.insertNodes([...inlineNodes, $createParagraphNode()]);

        const children = $getRoot().getChildren();
        expect(children).toHaveLength(2);
        assert($isParagraphNode(children[0]));
        expect(children[0].getChildren()).toEqual(inlineNodes);
      },
      {discrete: true},
    );
  });

  test('Collapses a lone linebreak run into an empty paragraph at the end of a non-empty paragraph', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode().append($createTextNode('abc'));
        root.append(paragraph);

        paragraph
          .selectEnd()
          .insertNodes([
            $createLineBreakNode(),
            $createParagraphNode().append($createTextNode('x')),
          ]);

        const children = root.getChildren();
        expect(children).toHaveLength(3);
        assert($isParagraphNode(children[0]));
        expect(children[0].getTextContent()).toBe('abc');
        assert($isParagraphNode(children[1]));
        expect(children[1].getChildrenSize()).toBe(0);
        assert($isParagraphNode(children[2]));
        expect(children[2].getTextContent()).toBe('x');
      },
      {discrete: true},
    );
  });

  test('Preserves a linebreak followed by inline content when merging into a non-empty paragraph', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode().append($createTextNode('abc'));
        root.append(paragraph);

        paragraph
          .selectEnd()
          .insertNodes([
            $createLineBreakNode(),
            $createTextNode('tail'),
            $createParagraphNode().append($createTextNode('x')),
          ]);

        const children = root.getChildren();
        expect(children).toHaveLength(2);
        assert($isParagraphNode(children[0]));
        expect(children[0].getChildren().map(child => child.getType())).toEqual(
          ['text', 'linebreak', 'text'],
        );
        expect(children[0].getTextContent()).toBe('abc\ntail');
        assert($isParagraphNode(children[1]));
        expect(children[1].getTextContent()).toBe('x');
      },
      {discrete: true},
    );
  });

  test('Collapses a lone trailing linebreak after a block into an empty paragraph', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        root.append(paragraph);

        paragraph
          .selectEnd()
          .insertNodes([
            $createParagraphNode().append($createTextNode('x')),
            $createLineBreakNode(),
          ]);

        const children = root.getChildren();
        expect(children).toHaveLength(2);
        assert($isParagraphNode(children[0]));
        expect(children[0].getTextContent()).toBe('x');
        assert($isParagraphNode(children[1]));
        expect(children[1].getChildrenSize()).toBe(0);
      },
      {discrete: true},
    );
  });
});

describe('Regression #7551 - Selection boundary normalization for single-child inline elements', () => {
  test('collapsed selection at end of single-child inline element stays inside', async () => {
    const container = document.createElement('div');
    container.contentEditable = 'true';
    document.body.appendChild(container);
    onTestFinished(() => container.remove());
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.setRootElement(container);
    let linkTextKey: string;

    await editor.update(() => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      const before = $createTextNode('hello ');
      const linkText = $createTextNode('A');
      const link = $createLinkNode('https://example.com', {}).append(linkText);
      const after = $createTextNode(' world');
      paragraph.append(before, link, after);
      root.append(paragraph);
      linkTextKey = linkText.__key;
    });

    editor.update(
      () => {
        const domSelection = getDOMSelection(editor._window ?? window);
        const linkTextDOM = editor.getElementByKey(linkTextKey)!.firstChild!;
        const range = document.createRange();
        range.setStart(linkTextDOM, 1);
        range.collapse(true);
        domSelection?.removeAllRanges();
        domSelection?.addRange(range);

        const selection = $internalCreateRangeSelection(
          $getSelection(),
          domSelection,
          editor,
          {type: 'selectionchange'} as Event,
        );
        assert(selection !== null);
        const {anchor} = selection;
        const anchorNode = anchor.getNode();
        assert($isTextNode(anchorNode));
        const parent = anchorNode.getParent();
        assert($isLinkNode(parent));
        expect(anchor.offset).toBe(1);
      },
      {discrete: true},
    );
  });

  test('collapsed selection at end of multi-child inline element normalizes to next sibling', async () => {
    const container = document.createElement('div');
    container.contentEditable = 'true';
    document.body.appendChild(container);
    onTestFinished(() => container.remove());
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.setRootElement(container);
    let boldBKey: string;

    await editor.update(() => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      const before = $createTextNode('hello ');
      const boldB = $createTextNode('B').toggleFormat('bold');
      const link = $createLinkNode('https://example.com', {}).append(
        $createTextNode('A'),
        boldB,
      );
      const after = $createTextNode(' world');
      paragraph.append(before, link, after);
      root.append(paragraph);
      boldBKey = boldB.__key;
    });

    editor.update(
      () => {
        const domSelection = getDOMSelection(editor._window ?? window);
        const boldBDOM = editor.getElementByKey(boldBKey)!.firstChild!;
        const range = document.createRange();
        range.setStart(boldBDOM, 1);
        range.collapse(true);
        domSelection?.removeAllRanges();
        domSelection?.addRange(range);

        const selection = $internalCreateRangeSelection(
          $getSelection(),
          domSelection,
          editor,
          {type: 'selectionchange'} as Event,
        );
        assert(selection !== null);
        const {anchor} = selection;
        const anchorNode = anchor.getNode();
        assert($isTextNode(anchorNode));
        expect(anchorNode.getTextContent()).toBe(' world');
        expect(anchor.offset).toBe(0);
      },
      {discrete: true},
    );
  });
});

describe('$formatText toggle direction (#6935)', () => {
  test('uses selection.format (AND) instead of first node for toggle direction', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        const boldText = $createTextNode('bold');
        boldText.setFormat(IS_BOLD);
        const plainText = $createTextNode('plain');
        paragraph.append(boldText, plainText);
        root.append(paragraph);

        const selection = $selectAll();
        expect(selection.hasFormat('bold')).toBe(false);

        $formatText(selection, 'bold');
        const children = paragraph.getChildren();
        const first = $assertNodeType(children[0], $isTextNode);
        const second = $assertNodeType(children[1], $isTextNode);
        expect(first.hasFormat('bold')).toBe(true);
        expect(second.hasFormat('bold')).toBe(true);
      },
      {discrete: true},
    );
  });

  test('toggling off works when all nodes share the format', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        const bold1 = $createTextNode('aaa');
        bold1.setFormat(IS_BOLD);
        const bold2 = $createTextNode('bbb');
        bold2.setFormat(IS_BOLD);
        paragraph.append(bold1, bold2);
        root.append(paragraph);

        const selection = $selectAll();
        // onSelectionChange computes this as AND of all text nodes;
        // unit tests bypass the event handler so we set it manually.
        selection.format = IS_BOLD;
        expect(selection.hasFormat('bold')).toBe(true);

        $formatText(selection, 'bold');
        const children = paragraph.getChildren();
        const first = $assertNodeType(children[0], $isTextNode);
        const second = $assertNodeType(children[1], $isTextNode);
        expect(first.hasFormat('bold')).toBe(false);
        expect(second.hasFormat('bold')).toBe(false);
      },
      {discrete: true},
    );
  });

  test('explicit alignWithFormat bypasses selection.format reference', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        const boldText = $createTextNode('bold');
        boldText.setFormat(IS_BOLD);
        const plainText = $createTextNode('plain');
        paragraph.append(boldText, plainText);
        root.append(paragraph);

        const selection = $selectAll();
        $formatText(selection, 'bold', IS_BOLD);
        const children = paragraph.getChildren();
        const first = $assertNodeType(children[0], $isTextNode);
        const second = $assertNodeType(children[1], $isTextNode);
        expect(first.hasFormat('bold')).toBe(true);
        expect(second.hasFormat('bold')).toBe(true);
      },
      {discrete: true},
    );
  });
});

describe('$setTextFormat (#5518)', () => {
  test('sets bold to true on mixed formatting', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        const boldText = $createTextNode('bold');
        boldText.setFormat(IS_BOLD);
        const plainText = $createTextNode('plain');
        paragraph.append(boldText, plainText);
        root.append(paragraph);

        const selection = $selectAll();
        $setTextFormat(selection, {bold: true});
        const children = paragraph.getChildren();
        const first = $assertNodeType(children[0], $isTextNode);
        const second = $assertNodeType(children[1], $isTextNode);
        expect(first.hasFormat('bold')).toBe(true);
        expect(second.hasFormat('bold')).toBe(true);
      },
      {discrete: true},
    );
  });

  test('sets bold to false on all-bold text', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        const bold1 = $createTextNode('aaa');
        bold1.setFormat(IS_BOLD);
        const bold2 = $createTextNode('bbb');
        bold2.setFormat(IS_BOLD);
        paragraph.append(bold1, bold2);
        root.append(paragraph);

        const selection = $selectAll();
        // $setTextFormat uses explicit alignWithFormat, so selection.format
        // doesn't matter here — but we set it for realism.
        selection.format = IS_BOLD;
        $setTextFormat(selection, {bold: false});
        const children = paragraph.getChildren();
        const first = $assertNodeType(children[0], $isTextNode);
        const second = $assertNodeType(children[1], $isTextNode);
        expect(first.hasFormat('bold')).toBe(false);
        expect(second.hasFormat('bold')).toBe(false);
      },
      {discrete: true},
    );
  });

  test('sets multiple formats at once', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        const text = $createTextNode('hello');
        paragraph.append(text);
        root.append(paragraph);

        const selection = $selectAll();
        $setTextFormat(selection, {bold: true, italic: true});
        const node = $assertNodeType(paragraph.getFirstChild(), $isTextNode);
        expect(node.hasFormat('bold')).toBe(true);
        expect(node.hasFormat('italic')).toBe(true);
      },
      {discrete: true},
    );
  });
});

describe('insertNodes() selection', () => {
  /**
   * Pastes blocks at the start of "asdf" and returns the collapsed selection
   * as `"textContent"@offset`, where the text content is that of the node the
   * anchor points at.
   */
  function $pasteAtStartAndDescribeSelection(blocks: LexicalNode[]): string {
    const text = $createTextNode('asdf');
    $getRoot().clear().append($createParagraphNode().append(text));
    text.select(0, 0);
    const selection = $getSelection();
    assert($isRangeSelection(selection), 'Expected RangeSelection');
    selection.insertNodes(blocks);
    const after = $getSelection();
    assert($isRangeSelection(after), 'Expected RangeSelection');
    expect(after.isCollapsed()).toBe(true);
    return `${after.anchor.type}:${JSON.stringify(
      after.anchor.getNode().getTextContent(),
    )}@${after.anchor.offset}`;
  }

  test('leaves the caret where pasted content ending in an empty block joins', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        // Copying several blocks out of an editor carries a trailing empty
        // paragraph, which is the node the split-off content is appended into.
        // Marking the caret after that append put it at the end of the
        // document instead of at the join. The point type is asserted because
        // marking it on the still-empty block leaves an element point, which
        // describes the same position as the text point every other insertion
        // produces.
        const selectionDescription = $pasteAtStartAndDescribeSelection([
          $createParagraphNode().append($createTextNode('AA')),
          $createParagraphNode().append($createTextNode('BB')),
          $createParagraphNode(),
        ]);
        expect(
          $getRoot()
            .getChildren()
            .map(node => node.getTextContent()),
        ).toEqual(['AA', 'BB', 'asdf']);
        expect(selectionDescription).toBe('text:"asdf"@0');
      },
      {discrete: true},
    );
  });

  test('leaves the caret where pasted content ending in a text block joins', () => {
    using editor = buildEditorFromExtensions(selectionTestExtension);
    editor.update(
      () => {
        // Unchanged: the split-off content lands beside the text node the
        // caret is marked on rather than inside it.
        const selectionDescription = $pasteAtStartAndDescribeSelection([
          $createParagraphNode().append($createTextNode('AA')),
          $createParagraphNode().append($createTextNode('BB')),
        ]);
        expect(
          $getRoot()
            .getChildren()
            .map(node => node.getTextContent()),
        ).toEqual(['AA', 'BBasdf']);
        expect(selectionDescription).toBe('text:"BB"@2');
      },
      {discrete: true},
    );
  });
});
