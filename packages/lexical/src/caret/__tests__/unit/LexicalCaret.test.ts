/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$createLinkNode, type LinkNode} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import {$createMarkNode} from '@lexical/mark';
import {$createHeadingNode, $isHeadingNode} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import {
  $caretRangeFromSelection,
  $comparePointCaretNext,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $extendCaretToRange,
  $getCaretRange,
  $getChildCaret,
  $getChildCaretAtIndex,
  $getCommonAncestor,
  $getRoot,
  $getSelection,
  $getSiblingCaret,
  $getTextPointCaret,
  $isParagraphNode,
  $isSiblingCaret,
  $isTextNode,
  $isTextPointCaret,
  $isTextPointCaretSlice,
  $removeTextFromCaretRange,
  $rewindSiblingCaret,
  $selectAll,
  $setPointFromCaret,
  $setSelection,
  $setSelectionFromCaretRange,
  $splitAtPointCaretNext,
  type ChildCaret,
  type ElementNode,
  type LexicalNode,
  type NodeCaret,
  type ParagraphNode,
  type RootNode,
  type SiblingCaret,
  type TextNode,
} from 'lexical';
import {beforeEach, describe, expect, test} from 'vitest';

import {
  $assertRangeSelection,
  $createTestDecoratorNode,
  initializeUnitTest,
  invariant,
} from '../../../__tests__/utils';

const DIRECTIONS = ['next', 'previous'] as const;
const BIASES = ['inside', 'outside'] as const;

function combinations<A, B>(as: Iterable<A>, bs: Iterable<B>): [A, B][] {
  const rval: [A, B][] = [];
  for (const a of as) {
    for (const b of bs) {
      rval.push([a, b]);
    }
  }
  return rval;
}

function startOfNode(size: number) {
  return 0;
}
function endOfNode(size: number) {
  return size;
}
function insideNode(size: number) {
  return 1;
}

describe('LexicalCaret', () => {
  initializeUnitTest(testEnv => {
    describe('$getChildCaret', () => {
      for (const direction of DIRECTIONS) {
        test(`direction ${direction}`, async () => {
          await testEnv.editor.update(
            () => {
              const paragraph = $createParagraphNode();
              const root = $getRoot();
              root.clear().append(paragraph);
              // Note that the type declarations here would normally be inferred, these are
              // used just to demonstrate that inference is working as expected
              const caret: ChildCaret<RootNode, typeof direction> =
                $getChildCaret(root, direction);
              expect(root.is(caret.origin)).toBe(true);
              expect(caret.direction).toBe(direction);
              expect(caret.type).toBe('child');
              expect(paragraph.is(caret.getNodeAtCaret())).toBe(true);
              expect(root.is(caret.getParentAtCaret())).toBe(true);

              const flipped = caret.getFlipped();
              expect(flipped).not.toBe(caret);
              expect(flipped.getFlipped().isSameNodeCaret(caret)).toBe(true);
              expect(flipped.direction).not.toBe(direction);
              expect(flipped.type).toBe('sibling');
              expect(flipped.getNodeAtCaret()).toBe(null);
              expect(flipped.getAdjacentCaret()).toBe(null);
              for (const mode of ['root', 'shadowRoot'] as const) {
                expect(caret.getParentCaret(mode)).toBe(null);
                expect(flipped.getParentCaret(mode)).toBe(null);
              }
              const adjacent: SiblingCaret<
                LexicalNode,
                typeof direction
              > | null = caret.getAdjacentCaret();
              invariant(
                adjacent !== null,
                'depth caret of a non-empty element must always have an adjacent caret',
              );
              expect(paragraph.is(adjacent.origin)).toBe(true);
              expect(adjacent.type).toBe('sibling');
              expect(adjacent.getAdjacentCaret()).toBe(null);

              expect(root.getChildrenSize()).toBe(1);
              caret.remove();
              expect(root.isEmpty()).toBe(true);
              caret.replaceOrInsert(paragraph);
              expect(root.getChildrenSize()).toBe(1);
              caret.remove();
              caret.insert(paragraph);
              expect(root.getChildrenSize()).toBe(1);

              // When direction === 'next' we are prepending the second node, otherwise we are appending it
              const secondParagraph = $createParagraphNode();
              caret.insert(secondParagraph);
              expect(root.getChildrenSize()).toBe(2);
              const paragraphKeys = [
                paragraph.getKey(),
                secondParagraph.getKey(),
              ];
              expect(root.getChildrenKeys()).toEqual(
                direction === 'next'
                  ? [...paragraphKeys].reverse()
                  : paragraphKeys,
              );

              caret.splice(2, []);
              expect(root.getChildrenSize()).toBe(0);
              caret.splice(0, [paragraph, secondParagraph]);
              expect(root.getChildrenKeys()).toEqual(paragraphKeys);
              caret.splice(0, [secondParagraph, paragraph]);
              expect(root.getChildrenKeys()).toEqual(
                [...paragraphKeys].reverse(),
              );
              caret.splice(0, [paragraph, secondParagraph]);
              expect(root.getChildrenKeys()).toEqual(paragraphKeys);
              caret.splice(2, [secondParagraph, paragraph]);
              expect(root.getChildrenKeys()).toEqual(
                [...paragraphKeys].reverse(),
              );
              caret.splice(2, [paragraph, secondParagraph]);
              expect(root.getChildrenKeys()).toEqual(paragraphKeys);
              caret.splice(20, [paragraph]);
              expect(root.getChildrenKeys()).toEqual([paragraph.getKey()]);
              caret.splice(-1, [secondParagraph]);
              expect(root.getChildrenKeys()).toEqual(
                direction === 'next'
                  ? [...paragraphKeys].reverse()
                  : paragraphKeys,
              );
              caret.splice(Infinity, [paragraph, secondParagraph], direction);
              expect(root.getChildrenKeys()).toEqual(
                direction === 'next'
                  ? paragraphKeys
                  : [...paragraphKeys].reverse(),
              );

              expect(
                Array.from(caret, nextCaret => nextCaret.origin.getKey()),
              ).toEqual(
                direction === 'next'
                  ? root.getChildrenKeys()
                  : [...root.getChildrenKeys()].reverse(),
              );
            },
            {discrete: true},
          );
        });
      }
    });
    describe('$getSiblingCaret', () => {
      for (const direction of DIRECTIONS) {
        test(`direction ${direction}`, async () => {
          await testEnv.editor.update(
            () => {
              const paragraph = $createParagraphNode();
              const tokens = ['-2', '-1', '0', '1', '2'].map(text =>
                $createTextNode(text).setMode('token'),
              );
              const root = $getRoot();
              root.clear().append(paragraph.append(...tokens));
              const ZERO_INDEX = 2;
              const zToken = tokens[ZERO_INDEX];
              const nextToken =
                direction === 'next'
                  ? zToken.getNextSibling()
                  : zToken.getPreviousSibling();
              invariant(nextToken !== null, 'nextToken must exist');
              // Note that the type declarations here would normally be inferred, these are
              // used just to demonstrate that inference is working as expected
              const caret: SiblingCaret<TextNode, typeof direction> =
                $getSiblingCaret(zToken, direction);
              expect(zToken.is(caret.origin)).toBe(true);
              expect(caret.direction).toBe(direction);
              expect(caret.type).toBe('sibling');
              expect(nextToken.is(caret.getNodeAtCaret())).toBe(true);
              expect(paragraph.is(caret.getParentAtCaret())).toBe(true);

              expect(
                Array.from(
                  caret,
                  nextCaret =>
                    (direction === 'next' ? 1 : -1) *
                    +nextCaret.origin.getTextContent(),
                ),
              ).toEqual([1, 2]);

              const flipped = caret.getFlipped();
              expect(flipped).not.toBe(caret);
              expect(flipped.getFlipped().isSameNodeCaret(caret));
              expect(flipped.origin.is(caret.getNodeAtCaret())).toBe(true);
              expect(flipped.direction).not.toBe(direction);
              expect(flipped.type).toBe('sibling');
              expect(zToken.is(flipped.getNodeAtCaret())).toBe(true);
              const flippedAdjacent = flipped.getAdjacentCaret();
              invariant(
                flippedAdjacent !== null,
                'A flipped SiblingCaret always has an adjacent caret because it points back to the origin',
              );
              expect(flippedAdjacent.origin.is(caret.origin)).toBe(true);

              for (const mode of ['root', 'shadowRoot'] as const) {
                expect(
                  $getSiblingCaret(paragraph, caret.direction).isSameNodeCaret(
                    caret.getParentCaret(mode),
                  ),
                ).toBe(true);
                expect(
                  $getSiblingCaret(
                    paragraph,
                    flipped.direction,
                  ).isSameNodeCaret(flipped.getParentCaret(mode)),
                ).toBe(true);
              }

              const adjacent: SiblingCaret<
                LexicalNode,
                typeof direction
              > | null = caret.getAdjacentCaret();
              invariant(adjacent !== null, 'expecting adjacent caret');
              const offset = direction === 'next' ? 1 : -1;
              expect(tokens[ZERO_INDEX + offset].is(adjacent.origin)).toBe(
                true,
              );
              expect(adjacent.type).toBe('sibling');
              expect(adjacent.origin.getTextContent()).toBe(String(offset));

              expect(tokens[ZERO_INDEX + offset].isAttached()).toBe(true);
              expect(
                tokens[ZERO_INDEX + offset].is(caret.getNodeAtCaret()),
              ).toBe(true);
              expect(
                tokens[ZERO_INDEX + offset].is(caret.getNodeAtCaret()),
              ).toBe(true);
              expect(paragraph.getChildrenSize()).toBe(tokens.length);
              caret.remove();
              expect(paragraph.getChildrenSize()).toBe(tokens.length - 1);
              expect(tokens[ZERO_INDEX + offset].isAttached()).toBe(false);
              expect(
                tokens[ZERO_INDEX + 2 * offset].is(caret.getNodeAtCaret()),
              ).toBe(true);
              expect(
                Array.from(
                  caret,
                  nextCaret =>
                    (direction === 'next' ? 1 : -1) *
                    +nextCaret.origin.getTextContent(),
                ),
              ).toEqual([2]);
              expect(
                paragraph
                  .getLatest()
                  .getChildren()
                  .map(node => node.getTextContent()),
              ).toEqual(
                tokens
                  .map(n => n.getTextContent())
                  .filter(t => t !== String(offset)),
              );
              caret.insert(tokens[ZERO_INDEX + offset]);
              expect(
                paragraph
                  .getLatest()
                  .getChildren()
                  .map(node => node.getTextContent()),
              ).toEqual(tokens.map(n => n.getTextContent()));
              caret.replaceOrInsert(tokens[ZERO_INDEX + offset]);
              expect(
                paragraph
                  .getLatest()
                  .getChildren()
                  .map(node => node.getTextContent()),
              ).toEqual(tokens.map(n => n.getTextContent()));

              caret.replaceOrInsert($createTextNode('replaced!'));
              expect(
                paragraph
                  .getLatest()
                  .getChildren()
                  .map(node => node.getTextContent()),
              ).toEqual(
                tokens.map((n, i) =>
                  i === ZERO_INDEX + offset ? 'replaced!' : n.getTextContent(),
                ),
              );
              caret.replaceOrInsert(tokens[ZERO_INDEX + offset]);

              const abNodes = ['a', 'b'].map(t => $createTextNode(t));
              caret.splice(0, abNodes);
              expect(
                paragraph
                  .getLatest()
                  .getChildren()
                  .map(node => node.getTextContent()),
              ).toEqual(
                tokens.flatMap((n, i) => {
                  if (i !== ZERO_INDEX) {
                    return [n.getTextContent()];
                  } else if (direction === 'next') {
                    return ['0', 'a', 'b'];
                  } else {
                    return ['a', 'b', '0'];
                  }
                }),
              );
              abNodes.forEach(n => n.remove());

              caret.splice(0, abNodes, 'previous');
              expect(
                paragraph
                  .getLatest()
                  .getChildren()
                  .map(node => node.getTextContent()),
              ).toEqual(
                tokens.flatMap((n, i) => {
                  if (i !== ZERO_INDEX) {
                    return [n.getTextContent()];
                  } else if (direction === 'next') {
                    return ['0', 'b', 'a'];
                  } else {
                    return ['b', 'a', '0'];
                  }
                }),
              );
              abNodes.forEach(n => n.remove());

              caret.splice(1, abNodes);
              expect(
                paragraph
                  .getLatest()
                  .getChildren()
                  .map(node => node.getTextContent()),
              ).toEqual(
                tokens.flatMap((n, i) => {
                  if (i === ZERO_INDEX + offset) {
                    return [];
                  } else if (i !== ZERO_INDEX) {
                    return [n.getTextContent()];
                  } else if (direction === 'next') {
                    return ['0', 'a', 'b'];
                  } else {
                    return ['a', 'b', '0'];
                  }
                }),
              );
              paragraph.clear().append(...tokens);

              caret.splice(1, abNodes.slice(0, 1));
              expect(
                paragraph
                  .getLatest()
                  .getChildren()
                  .map(node => node.getTextContent()),
              ).toEqual(
                tokens.map((n, i) =>
                  i === ZERO_INDEX + offset ? 'a' : n.getTextContent(),
                ),
              );
              paragraph.clear().append(...tokens);

              caret.splice(2, abNodes.slice(0, 1));
              expect(
                paragraph
                  .getLatest()
                  .getChildren()
                  .map(node => node.getTextContent()),
              ).toEqual(
                direction === 'next'
                  ? ['-2', '-1', '0', 'a']
                  : ['a', '0', '1', '2'],
              );
              paragraph.clear().append(...tokens);

              caret.splice(Infinity, abNodes);
              expect(
                paragraph
                  .getLatest()
                  .getChildren()
                  .map(node => node.getTextContent()),
              ).toEqual(
                direction === 'next'
                  ? ['-2', '-1', '0', 'a', 'b']
                  : ['a', 'b', '0', '1', '2'],
              );
              paragraph.clear().append(...tokens);
            },
            {discrete: true},
          );
        });
      }
    });
    describe('$caretRangeFromSelection', () => {
      test('collapsed text point selection', async () => {
        await testEnv.editor.update(() => {
          const textNodes = ['first', 'second', 'third'].map(text =>
            $createTextNode(text).setMode('token'),
          );
          $getRoot()
            .clear()
            .append($createParagraphNode().append(...textNodes));
          const node = textNodes[1];
          const cases = [
            [() => node.selectStart(), 0],
            [() => node.selectEnd(), node.getTextContentSize()],
            [() => node.select(3, 3), 3],
          ] as const;
          for (const [$makeSelection, offset] of cases) {
            const key = node.getKey();
            const selection = $makeSelection();
            expect(selection).toMatchObject({
              anchor: {key, offset, type: 'text'},
              focus: {key, offset, type: 'text'},
            });
            const range = $caretRangeFromSelection(selection);
            expect(range.isCollapsed()).toBe(true);
            invariant(
              $isTextPointCaret(range.anchor),
              '$isTextPointCaret(range.anchor)',
            );
            invariant(
              $isTextPointCaret(range.focus),
              '$isTextPointCaret(range.anchor)',
            );
            expect(range).toMatchObject({
              anchor: {
                direction: 'next',
                offset,
              },
              focus: {
                direction: 'next',
                offset,
              },
            });
            expect(
              range.getTextSlices().filter($isTextPointCaretSlice),
            ).toMatchObject([
              {
                caret: {
                  direction: 'next',
                  offset,
                  origin: node,
                  type: 'text',
                },
                distance: 0,
              },
            ]);
            expect([...range.iterNodeCarets('root')]).toEqual([]);
          }
        });
      });
      for (const direction of DIRECTIONS) {
        test(`full text node selection (${direction})`, async () => {
          await testEnv.editor.update(() => {
            const textNodes = ['first', 'second', 'third'].map(text =>
              $createTextNode(text).setMode('token'),
            );
            $getRoot()
              .clear()
              .append($createParagraphNode().append(...textNodes));
            for (const node of textNodes) {
              const key = node.getKey();
              const textSize = node.getTextContentSize();
              const [anchorOffset, focusOffset] =
                direction === 'next' ? [0, textSize] : [textSize, 0];
              const selection = node.select(anchorOffset, focusOffset);
              expect(selection).toMatchObject({
                anchor: {key, offset: anchorOffset, type: 'text'},
                focus: {key, offset: focusOffset, type: 'text'},
              });
              const range = $caretRangeFromSelection(selection);
              invariant(
                $isTextPointCaret(range.anchor),
                '$isTextPointCaret(range.anchor)',
              );
              invariant(
                $isTextPointCaret(range.focus),
                '$isTextPointCaret(range.anchor)',
              );
              expect(range).toMatchObject({
                anchor: {direction, offset: anchorOffset, origin: node},
                direction,
                focus: {direction, offset: focusOffset, origin: node},
              });
              expect(
                range.getTextSlices().filter($isTextPointCaretSlice),
              ).toMatchObject([
                {
                  caret: {
                    direction,
                    offset: anchorOffset,
                    origin: node,
                  },
                  distance: focusOffset - anchorOffset,
                },
              ]);
              expect([...range.iterNodeCarets('root')]).toEqual([]);
              expect(range.isCollapsed()).toBe(false);
            }
          });
        });
      }
      test('single text node non-empty selection', async () => {
        await testEnv.editor.update(() => {
          const textNodes = ['first', 'second', 'third'].map(text =>
            $createTextNode(text).setMode('token'),
          );
          $getRoot()
            .clear()
            .append($createParagraphNode().append(...textNodes));
          for (const node of textNodes) {
            // Test all non-empty selections
            const textSize = node.getTextContentSize();
            for (let indexStart = 0; indexStart < textSize; indexStart++) {
              for (
                let indexEnd = indexStart + 1;
                indexEnd <= textSize;
                indexEnd++
              ) {
                for (const direction of DIRECTIONS) {
                  const [offset, size] =
                    direction === 'next'
                      ? [indexStart, indexEnd - indexStart]
                      : [indexEnd, indexStart - indexEnd];
                  const selection =
                    direction === 'next'
                      ? node.select(indexStart, indexEnd)
                      : node.select(indexEnd, indexStart);
                  const range = $caretRangeFromSelection(selection);
                  invariant(
                    $isTextPointCaret(range.anchor),
                    '$isTextPointCaret(range.anchor)',
                  );
                  invariant(
                    $isTextPointCaret(range.focus),
                    '$isTextPointCaret(range.anchor)',
                  );
                  expect(range.direction).toBe(direction);
                  expect(
                    range.getTextSlices().filter($isTextPointCaretSlice),
                  ).toMatchObject([
                    {caret: {direction, offset, origin: node}, distance: size},
                  ]);
                  expect([...range.iterNodeCarets('root')]).toMatchObject([]);
                }
              }
            }
          }
        });
      });
      for (const direction of DIRECTIONS) {
        test(`multiple text node non-empty selection (${direction})`, async () => {
          await testEnv.editor.update(() => {
            const textNodes = ['first', 'second', 'third'].map(text =>
              $createTextNode(text).setMode('token'),
            );
            $getRoot()
              .clear()
              .append($createParagraphNode().append(...textNodes));
            const selection = $getRoot().select();

            // test all start and end nodes (where different)
            const nodeCount = textNodes.length;
            for (
              let indexNodeStart = 0;
              indexNodeStart < nodeCount;
              indexNodeStart++
            ) {
              for (
                let indexNodeEnd = indexNodeStart + 1;
                indexNodeEnd < nodeCount;
                indexNodeEnd++
              ) {
                const startNode = textNodes[indexNodeStart]!;
                const endNode = textNodes[indexNodeEnd]!;
                for (const indexStart of [
                  0,
                  1,
                  startNode.getTextContentSize(),
                ]) {
                  for (const indexEnd of [0, 1, endNode.getTextContentSize()]) {
                    const [anchorNode, anchorOffset, focusNode, focusOffset] =
                      direction === 'next'
                        ? [startNode, indexStart, endNode, indexEnd]
                        : [endNode, indexEnd, startNode, indexStart];
                    selection.setTextNodeRange(
                      anchorNode,
                      anchorOffset,
                      focusNode,
                      focusOffset,
                    );
                    const range = $caretRangeFromSelection(selection);
                    invariant(
                      $isTextPointCaret(range.anchor),
                      '$isTextPointCaret(range.anchor)',
                    );
                    invariant(
                      $isTextPointCaret(range.focus),
                      '$isTextPointCaret(range.anchor)',
                    );
                    expect(range.direction).toBe(direction);
                    const textSliceCarets = range
                      .getTextSlices()
                      .filter($isTextPointCaretSlice);
                    expect(textSliceCarets).toHaveLength(2);
                    const [anchorSlice, focusSlice] = textSliceCarets;
                    expect(anchorSlice).toMatchObject({
                      caret: {
                        direction,
                        offset: anchorOffset,
                        origin: anchorNode,
                        type: 'text',
                      },
                      distance:
                        direction === 'next'
                          ? anchorNode.getTextContentSize() - anchorOffset
                          : 0 - anchorOffset,
                    });
                    expect(focusSlice).toMatchObject({
                      caret: {
                        direction,
                        offset: focusOffset,
                        origin: focusNode,
                        type: 'text',
                      },
                      distance:
                        direction === 'next'
                          ? 0 - focusOffset
                          : focusNode.getTextContentSize() - focusOffset,
                    });
                    expect([...range.iterNodeCarets('root')]).toMatchObject(
                      textNodes
                        .slice(indexNodeStart + 1, indexNodeEnd)
                        .map(origin => ({
                          direction,
                          origin,
                          type: 'sibling',
                        })),
                    );
                  }
                }
              }
            }
          });
        });
      }
    });
    describe('$removeTextFromCaretRange', () => {
      const texts = ['first', 'second', 'third'] as const;
      describe('ported Headings e2e tests', () => {
        test('Pressing return in the middle of a heading creates a new heading below', () => {
          testEnv.editor.update(
            () => {
              const initialTextNode = $createTextNode('[before][after]');
              const headingNode = $createHeadingNode().append(initialTextNode);
              $getRoot().clear().append(headingNode);
              const newHeadingNode = initialTextNode
                .select('[before]'.length, '[before]'.length)
                .insertParagraph();
              expect(
                $getRoot()
                  .getAllTextNodes()
                  .map(n => n.getTextContent()),
              ).toEqual(['[before]', '[after]']);
              invariant($isHeadingNode(newHeadingNode), 'paragraph inserted');
              expect($getRoot().getChildren()).toEqual([
                headingNode,
                newHeadingNode,
              ]);
              expect(initialTextNode.getTextContent()).toBe('[before]');
              expect(initialTextNode.getParent()).toBe(headingNode);
              const newTextNodes = newHeadingNode.getAllTextNodes();
              expect(newTextNodes).toHaveLength(1);
              invariant($isTextNode(newTextNodes[0]), 'new text node created');
              expect(newTextNodes[0].getTextContent()).toBe('[after]');
            },
            {discrete: true},
          );
        });
      });
      describe('ported File e2e tests', () => {
        test('$selectAll() with nesting and a trailing decorator', () => {
          testEnv.editor.update(
            () => {
              const paragraphNode = $createParagraphNode().append(
                $createTextNode('Hello').setFormat('bold'),
                $createTextNode('World'),
              );
              const listNode = $createListNode('number').append(
                $createListItemNode().append($createTextNode('one')),
                $createListItemNode().append($createTextNode('two')),
                $createListItemNode().append($createTestDecoratorNode()),
              );
              $getRoot().clear().append(paragraphNode, listNode);
              expect($getRoot().getChildrenSize()).toBe(2);
              const range = $caretRangeFromSelection($selectAll());
              const resultRange = $removeTextFromCaretRange(range);
              expect($getRoot().getAllTextNodes()).toEqual([]);
              expect($getRoot().getChildren()).toEqual([paragraphNode]);
              expect(resultRange).toMatchObject({
                anchor: {
                  direction: 'next',
                  origin: paragraphNode,
                  type: 'child',
                },
              });
            },
            {discrete: true},
          );
        });
      });
      describe('ported Table e2e tests', () => {
        test('Can delete all with range selection anchored in table', () => {
          testEnv.editor.update(
            () => {
              const tableNode = $createTableNode().append(
                $createTableRowNode().append(
                  $createTableCellNode().append(
                    $createParagraphNode().append($createTextNode('cell 1')),
                  ),
                  $createTableCellNode().append(
                    $createParagraphNode().append($createTextNode('cell 2')),
                  ),
                ),
              );
              const paragraphNode = $createParagraphNode().append(
                $createTextNode('paragraph 2'),
              );
              $getRoot().clear().append(tableNode, paragraphNode);
              const selection = $selectAll();
              // The table plug-in would normally do this normalization
              selection.anchor.set('root', 0, 'element');
              const range = $caretRangeFromSelection(selection);
              const resultRange = $removeTextFromCaretRange(range);
              expect($getRoot().getAllTextNodes()).toEqual([]);
              expect($getRoot().getChildren()).toEqual([paragraphNode]);
              expect(resultRange).toMatchObject({
                anchor: {
                  direction: 'next',
                  origin: paragraphNode,
                  type: 'child',
                },
              });
            },
            {discrete: true},
          );
        });
      });
      describe('ported LexicalSelection tests', () => {
        test('remove partial initial TextNode and partial segmented TextNode', () => {
          let leadingText: TextNode;
          let trailingSegmentedText: TextNode;
          testEnv.editor.update(
            () => {
              const sel = $createRangeSelection();
              leadingText = $createTextNode('leading text');
              trailingSegmentedText =
                $createTextNode('segmented text').setMode('segmented');
              $getRoot()
                .clear()
                .append(
                  $createParagraphNode().append(
                    leadingText,
                    trailingSegmentedText,
                  ),
                );
              sel.anchor.set(leadingText.getKey(), 'lead'.length, 'text');
              sel.focus.set(
                trailingSegmentedText.getKey(),
                'segmented '.length,
                'text',
              );
              $setSelection(sel);
              const resultRange = $removeTextFromCaretRange(
                $caretRangeFromSelection(sel),
              );
              $setSelectionFromCaretRange(resultRange);
              expect(resultRange).toMatchObject({
                anchor: {
                  offset: 'lead'.length,
                  origin: leadingText.getLatest(),
                },
                direction: 'next',
              });
              expect(leadingText.isAttached()).toBe(true);
              expect(trailingSegmentedText.isAttached()).toBe(false);
              const allTextNodes = $getRoot().getAllTextNodes();
              // These should get merged in reconciliation
              expect(allTextNodes.map(node => node.getTextContent())).toEqual([
                'lead',
                'text',
              ]);
              const selection = $assertRangeSelection($getSelection());
              expect(selection.isCollapsed()).toBe(true);
              expect(selection.anchor.key).toBe(leadingText.getKey());
              expect(selection.anchor.offset).toBe('lead'.length);
            },
            {discrete: true},
          );
          // Reconciliation has happened
          testEnv.editor.read('latest', () => {
            const allTextNodes = $getRoot().getAllTextNodes();
            // These should get merged in reconciliation
            expect(allTextNodes.map(node => node.getTextContent())).toEqual([
              'leadtext',
            ]);
            expect(leadingText.isAttached()).toBe(true);
            expect(trailingSegmentedText.isAttached()).toBe(false);
          });
        });
      });
      describe('single block', () => {
        beforeEach(() => {
          testEnv.editor.update(() => {
            // Ensure that the separate texts don't get merged
            const textNodes = texts.map(text =>
              $createTextNode(text).setStyle(`color: --color-${text}`),
            );
            $getRoot()
              .clear()
              .append($createParagraphNode().append(...textNodes));
          });
        });
        test('remove second TextNode when wrapped in a LinkNode that will become empty', () => {
          testEnv.editor.update(
            () => {
              const sel = $createRangeSelection();
              const originalNodes = $getRoot().getAllTextNodes();
              const [leadingText, trailingLinkText] = originalNodes;
              const linkWrapper = $createLinkNode('https://lexical.dev');
              trailingLinkText.replace(linkWrapper);
              linkWrapper.append(trailingLinkText);
              sel.anchor.set(trailingLinkText.getKey(), 0, 'text');
              sel.focus.set(
                trailingLinkText.getKey(),
                trailingLinkText.getTextContentSize(),
                'text',
              );
              const direction = 'next';
              const range = $caretRangeFromSelection(sel);
              $setSelection(sel);
              expect(range).toMatchObject({
                anchor: {
                  direction,
                  offset: 0,
                  origin: trailingLinkText.getLatest(),
                },
                focus: {
                  direction,
                  offset: trailingLinkText.getTextContentSize(),
                  origin: trailingLinkText.getLatest(),
                },
              });
              const resultRange = $removeTextFromCaretRange(range);
              $setSelectionFromCaretRange(resultRange);
              expect(leadingText.isAttached()).toBe(true);
              expect(trailingLinkText.isAttached()).toBe(false);
              expect($getRoot().getAllTextNodes()).toHaveLength(2);
              expect(resultRange.isCollapsed()).toBe(true);
              expect(sel.isCollapsed()).toBe(true);
              expect(sel.anchor.getNode()).toBe(leadingText.getLatest());
              expect(sel.anchor.key).toBe(leadingText.getKey());
              expect(sel.anchor.offset).toBe(leadingText.getTextContentSize());
              expect(resultRange.anchor).toMatchObject({
                direction,
                offset: leadingText.getTextContentSize(),
                origin: leadingText.getLatest(),
              });
            },
            {discrete: true},
          );
        });
        test('remove first TextNode with second in token mode', () => {
          testEnv.editor.update(
            () => {
              const sel = $createRangeSelection();
              const originalNodes = $getRoot().getAllTextNodes();
              const [leadingText, trailingTokenText] = originalNodes;
              trailingTokenText.setMode('token');
              sel.anchor.set(leadingText.getKey(), 0, 'text');
              sel.focus.set(
                leadingText.getKey(),
                leadingText.getTextContentSize(),
                'text',
              );
              const direction = 'next';
              const range = $caretRangeFromSelection(sel);
              $setSelection(sel);
              expect(range).toMatchObject({
                anchor: {direction, offset: 0, origin: leadingText},
                focus: {
                  direction,
                  offset: leadingText.getTextContentSize(),
                  origin: leadingText,
                },
              });
              const resultRange = $removeTextFromCaretRange(range);
              $setSelectionFromCaretRange(resultRange);
              expect(leadingText.isAttached()).toBe(false);
              expect(trailingTokenText.isAttached()).toBe(true);
              expect($getRoot().getAllTextNodes()).toHaveLength(2);
              expect(resultRange.isCollapsed()).toBe(true);
              expect(sel.isCollapsed()).toBe(true);
              expect(sel.anchor.key).toBe(trailingTokenText.getKey());
              expect(sel.anchor.offset).toBe(0);
              expect(resultRange.anchor).toMatchObject({
                direction,
                offset: 0,
                origin: trailingTokenText.getLatest(),
              });
            },
            {discrete: true},
          );
        });
        test('collapsed text point selection', async () => {
          await testEnv.editor.update(() => {
            const textNodes = $getRoot().getAllTextNodes();
            const originalText = $getRoot().getTextContent();
            const node = textNodes[1];
            const cases = [
              [() => node.selectStart(), 0],
              [() => node.selectEnd(), node.getTextContentSize()],
              [() => node.select(3, 3), 3],
            ] as const;
            for (const [$makeSelection, offset] of cases) {
              const key = node.getKey();
              const selection = $makeSelection();
              expect(selection).toMatchObject({
                anchor: {key, offset, type: 'text'},
                focus: {key, offset, type: 'text'},
              });
              const range = $caretRangeFromSelection(selection);
              expect(range.isCollapsed()).toBe(true);
              invariant(
                $isTextPointCaret(range.anchor),
                '$isTextPointCaret(range.anchor)',
              );
              invariant(
                $isTextPointCaret(range.focus),
                '$isTextPointCaret(range.anchor)',
              );
              const originalRangeMatch = {
                anchor: {
                  direction: 'next',
                  offset,
                },
                focus: {
                  direction: 'next',
                  offset,
                },
              } as const;
              expect(range).toMatchObject(originalRangeMatch);
              expect(
                range.getTextSlices().filter($isTextPointCaretSlice),
              ).toMatchObject([
                {
                  caret: {
                    direction: 'next',
                    offset,
                    origin: node,
                    type: 'text',
                  },
                  distance: 0,
                },
              ]);
              expect([...range.iterNodeCarets('root')]).toEqual([]);
              expect($removeTextFromCaretRange(range)).toMatchObject(
                originalRangeMatch,
              );
              expect($getRoot().getTextContent()).toEqual(originalText);
              $setSelection(null);
            }
          });
        });
        describe('full text node internal selection', () => {
          for (const direction of DIRECTIONS) {
            texts.forEach((text, i) => {
              test(`${text} node (${direction})`, async () => {
                await testEnv.editor.update(() => {
                  const originalNodes = $getRoot().getAllTextNodes();
                  const [node] = originalNodes.splice(i, 1);
                  invariant($isTextNode(node), `Missing TextNode ${i}`);
                  const key = node.getKey();
                  const size = node.getTextContentSize();
                  const [anchorOffset, focusOffset] =
                    direction === 'next' ? [0, size] : [size, 0];
                  const selection = node.select(anchorOffset, focusOffset);
                  expect(selection).toMatchObject({
                    anchor: {key, offset: anchorOffset, type: 'text'},
                    focus: {key, offset: focusOffset, type: 'text'},
                  });
                  const range = $caretRangeFromSelection(selection);
                  invariant(
                    $isTextPointCaret(range.anchor),
                    '$isTextPointCaret(range.anchor)',
                  );
                  invariant(
                    $isTextPointCaret(range.focus),
                    '$isTextPointCaret(range.anchor)',
                  );
                  expect(range).toMatchObject({
                    anchor: {offset: anchorOffset, origin: node},
                    direction,
                    focus: {offset: focusOffset, origin: node},
                  });
                  expect(
                    range.getTextSlices().filter($isTextPointCaretSlice),
                  ).toMatchObject([
                    {
                      caret: {
                        offset:
                          direction === 'next' ? 0 : node.getTextContentSize(),
                        origin: node,
                      },
                      distance:
                        (direction === 'next' ? 1 : -1) *
                        node.getTextContentSize(),
                    },
                  ]);
                  expect([...range.iterNodeCarets('root')]).toEqual([]);
                  expect(range.isCollapsed()).toBe(false);
                  const resultRange = $removeTextFromCaretRange(range);
                  $setSelection(null);
                  const remainingNodes = $getRoot().getAllTextNodes();
                  expect(remainingNodes).toEqual(
                    originalNodes.map(n => n.getLatest()),
                  );
                  expect(remainingNodes.map(n => n.getTextContent())).toEqual(
                    texts.filter((_v, j) => j !== i),
                  );
                  expect(resultRange.isCollapsed()).toBe(true);
                  // bias towards the start
                  const adjacentIndex = Math.max(0, i - 1);
                  const newOrigin = remainingNodes[adjacentIndex];
                  const offset = i === 0 ? 0 : newOrigin.getTextContentSize();
                  const pt = {
                    direction,
                    offset,
                    origin: newOrigin,
                    type: 'text',
                  };
                  expect(resultRange).toMatchObject({
                    anchor: pt,
                    direction,
                    focus: pt,
                    type: 'node-caret-range',
                  });
                });
              });
            });
          }
        });
        describe('full text node biased selection', () => {
          for (const [direction, [anchorBias, focusBias]] of combinations(
            DIRECTIONS,
            combinations(BIASES, BIASES),
          )) {
            if (anchorBias === 'inside' && focusBias === 'inside') {
              // These cases are tested above
              continue;
            }
            texts.forEach((text, i) => {
              test(`${text} node (${direction} ${anchorBias} ${focusBias})`, async () => {
                await testEnv.editor.update(() => {
                  const originalNodes = $getRoot().getAllTextNodes();
                  const [node] = originalNodes.splice(i, 1);
                  invariant($isTextNode(node), `Missing TextNode ${i}`);
                  const size = node.getTextContentSize();
                  const [anchorOffset, focusOffset] =
                    direction === 'next' ? [0, size] : [size, 0];
                  // Create the inside selection, will mutate for outside
                  const selection = node.select(anchorOffset, focusOffset);
                  const nodeCaret = $getSiblingCaret(node, direction);
                  if (anchorBias === 'outside') {
                    $setPointFromCaret(
                      selection.anchor,
                      $rewindSiblingCaret(nodeCaret),
                    );
                    if (direction === 'next') {
                      if (i === 0) {
                        expect(selection.anchor).toMatchObject({
                          key: node.getParentOrThrow().getKey(),
                          offset: 0,
                          type: 'element',
                        });
                      } else {
                        const adj = originalNodes[i - 1]!;
                        expect(selection.anchor).toMatchObject({
                          key: adj.getKey(),
                          offset: adj.getTextContentSize(),
                          type: 'text',
                        });
                      }
                    } else {
                      if (i === texts.length - 1) {
                        const parent = node.getParentOrThrow();
                        expect(selection.anchor).toMatchObject({
                          key: parent.getKey(),
                          offset: parent.getChildrenSize(),
                          type: 'element',
                        });
                      } else {
                        const adj = originalNodes[i]!;
                        expect(selection.anchor).toMatchObject({
                          key: adj.getKey(),
                          offset: 0,
                          type: 'text',
                        });
                      }
                    }
                  }
                  if (focusBias === 'outside') {
                    $setPointFromCaret(
                      selection.focus,
                      $getSiblingCaret(node, direction).getFlipped(),
                    );
                    if (direction === 'next') {
                      if (i === texts.length - 1) {
                        const parent = node.getParentOrThrow();
                        expect(selection.focus).toMatchObject({
                          key: parent.getKey(),
                          offset: parent.getChildrenSize(),
                          type: 'element',
                        });
                      } else {
                        const adj = originalNodes[i]!;
                        expect(selection.focus).toMatchObject({
                          key: adj.getKey(),
                          offset: 0,
                          type: 'text',
                        });
                      }
                    } else {
                      if (i === 0) {
                        const parent = node.getParentOrThrow();
                        expect(selection.focus).toMatchObject({
                          key: parent.getKey(),
                          offset: 0,
                          type: 'element',
                        });
                      } else {
                        const adj = originalNodes[i - 1]!;
                        expect(selection.focus).toMatchObject({
                          key: adj.getKey(),
                          offset: adj.getTextContentSize(),
                          type: 'text',
                        });
                      }
                    }
                  }
                  const range = $caretRangeFromSelection(selection);
                  expect(range.isCollapsed()).toBe(false);
                  expect([...range.iterNodeCarets('root')].length).toBe(
                    anchorBias === 'outside' && focusBias === 'outside' ? 1 : 0,
                  );
                  expect(
                    range
                      .getTextSlices()
                      .filter(slice => slice && slice.distance !== 0),
                  ).toMatchObject(
                    anchorBias === 'outside' && focusBias === 'outside'
                      ? []
                      : (anchorBias === 'inside') === (direction === 'next')
                        ? [{caret: {offset: 0}, distance: size}]
                        : [{caret: {offset: size}, distance: -size}],
                  );
                  const resultRange = $removeTextFromCaretRange(range);
                  $setSelection(null);
                  const remainingNodes = $getRoot().getAllTextNodes();
                  expect(remainingNodes.map(n => n.getTextContent())).toEqual(
                    texts.filter((_v, j) => j !== i),
                  );
                  expect(remainingNodes).toEqual(
                    originalNodes.map(n => n.getLatest()),
                  );
                  expect(resultRange.isCollapsed()).toBe(true);
                  // bias towards the start
                  const adjacentIndex = Math.max(0, i - 1);
                  const newOrigin = remainingNodes[adjacentIndex];
                  const offset = i === 0 ? 0 : newOrigin.getTextContentSize();
                  expect(resultRange).toMatchObject({
                    anchor: {
                      direction,
                      offset,
                      origin: newOrigin,
                      type: 'text',
                    },
                    direction,
                    focus: {
                      direction,
                      offset,
                      origin: newOrigin,
                      type: 'text',
                    },
                    type: 'node-caret-range',
                  });
                });
              });
            });
          }
        });

        const EDGE_OFFSETS = [
          [0, 1],
          [1, 1],
          [1, 0],
        ] as const;
        describe('single text node non-empty partial selection', () => {
          for (const [
            direction,
            [anchorEdgeOffset, focusEdgeOffset],
          ] of combinations(DIRECTIONS, EDGE_OFFSETS)) {
            test(`${direction} ${anchorEdgeOffset}:${-focusEdgeOffset}`, async () => {
              await testEnv.editor.update(() => {
                const originalNodes = $getRoot().getAllTextNodes();
                const i = 0;
                const text = texts[i];
                const node = originalNodes[i];
                invariant($isTextNode(node), `Missing TextNode 0`);
                const size = node.getTextContentSize();
                const anchor = $getTextPointCaret(
                  node,
                  direction,
                  direction === 'next'
                    ? anchorEdgeOffset
                    : size - anchorEdgeOffset,
                );
                const focus = $getTextPointCaret(
                  node,
                  direction,
                  direction === 'next'
                    ? size - focusEdgeOffset
                    : focusEdgeOffset,
                );
                const [offsetStart, offsetEnd] = [
                  anchor.offset,
                  focus.offset,
                ].sort((a, b) => a - b);
                const range = $getCaretRange(anchor, focus);
                const slices = range
                  .getTextSlices()
                  .filter($isTextPointCaretSlice)
                  .filter(slice => slice.distance !== 0);
                expect([...range.iterNodeCarets('root')]).toEqual([]);
                expect(slices.length).toBe(1);
                const [slice] = slices;
                expect(slice.distance).toBe(
                  (direction === 'next' ? 1 : -1) *
                    (size - anchorEdgeOffset - focusEdgeOffset),
                );
                expect(slice.getTextContent()).toBe(
                  text.slice(offsetStart, offsetEnd),
                );
                const resultRange = $removeTextFromCaretRange(range);
                $setSelection(null);
                expect(resultRange.isCollapsed()).toBe(true);
                expect(resultRange.anchor).toMatchObject({
                  direction,
                  offset: offsetStart,
                  origin: node.getLatest(),
                });
                const remainingNodes = $getRoot().getAllTextNodes();
                expect(remainingNodes).toHaveLength(texts.length);
                expect(remainingNodes.map(n => n.getTextContent())).toEqual(
                  texts.map((v, j) =>
                    i === j ? v.slice(0, offsetStart) + v.slice(offsetEnd) : v,
                  ),
                );
              });
            });
          }
        });

        describe('multiple text node selection', () => {
          const OFFSETS = [startOfNode, insideNode, endOfNode];
          const NODE_PAIRS = [
            [0, 1],
            [0, 2],
            [1, 2],
          ] as const;
          for (const [
            direction,
            [[nodeIndexStart, nodeIndexEnd], [startFn, endFn]],
          ] of combinations(
            DIRECTIONS,
            combinations(NODE_PAIRS, combinations(OFFSETS, OFFSETS)),
          )) {
            test(`${direction} ${texts[nodeIndexStart]} ${startFn.name} ${texts[nodeIndexEnd]} ${endFn.name}`, async () => {
              await testEnv.editor.update(() => {
                const originalNodes = $getRoot().getAllTextNodes();
                const startNode = originalNodes[nodeIndexStart];
                const endNode = originalNodes[nodeIndexEnd];
                expect(startNode !== endNode).toBe(true);
                invariant($isTextNode(startNode), 'text node');
                invariant($isTextNode(endNode), 'text node');
                expect(startNode.isBefore(endNode)).toBe(true);
                const startCaret = $getTextPointCaret(
                  startNode,
                  direction,
                  startFn(startNode.getTextContentSize()),
                );
                const endCaret = $getTextPointCaret(
                  endNode,
                  direction,
                  endFn(endNode.getTextContentSize()),
                );
                const [anchor, focus] =
                  direction === 'next'
                    ? [startCaret, endCaret]
                    : [endCaret, startCaret];
                const range = $getCaretRange(anchor, focus);
                expect([...range.iterNodeCarets('root')]).toHaveLength(
                  Math.max(0, nodeIndexEnd - nodeIndexStart - 1),
                );
                const slices = range
                  .getTextSlices()
                  .filter($isTextPointCaretSlice);
                expect(slices).toHaveLength(2);
                expect(slices.map(slice => slice.getTextContent())).toEqual(
                  direction === 'next'
                    ? [
                        startCaret.origin
                          .getTextContent()
                          .slice(startCaret.offset),
                        endCaret.origin
                          .getTextContent()
                          .slice(0, endCaret.offset),
                      ]
                    : [
                        endCaret.origin
                          .getTextContent()
                          .slice(0, endCaret.offset),
                        startCaret.origin
                          .getTextContent()
                          .slice(startCaret.offset),
                      ],
                );
                const resultRange = $removeTextFromCaretRange(range);
                expect(resultRange).toMatchObject({
                  anchor: {direction},
                  direction,
                  focus: {direction},
                });
                if (startCaret.offset !== 0) {
                  // Part of the start remains
                  expect(resultRange).toMatchObject({
                    anchor: {
                      offset: startCaret.offset,
                      origin: startCaret.origin.getLatest(),
                    },
                  });
                } else if (nodeIndexStart > 0) {
                  // The anchor was removed so bias towards the previous node
                  const prevNode =
                    originalNodes[nodeIndexStart - 1].getLatest();
                  expect(resultRange).toMatchObject({
                    anchor: {
                      offset: prevNode.getTextContentSize(),
                      origin: prevNode,
                    },
                  });
                } else if (endCaret.offset !== texts[nodeIndexEnd].length) {
                  // The focus was not deleted and there is no previous node
                  // so the new anchor will be set to the focus origin
                  expect(resultRange).toMatchObject({
                    anchor: {
                      offset: 0,
                      origin: originalNodes[nodeIndexEnd].getLatest(),
                    },
                  });
                } else if (nodeIndexEnd !== texts.length - 1) {
                  // The anchor was at the start and the focus was removed
                  // but there is another text node to use as the anchor caret
                  expect(resultRange).toMatchObject({
                    anchor: {
                      offset: 0,
                      origin: originalNodes[nodeIndexEnd + 1].getLatest(),
                    },
                  });
                } else {
                  // All text has been removed so we have to use a depth caret
                  expect(resultRange).toMatchObject({
                    anchor: {
                      origin: $getRoot().getFirstChild(),
                      type: 'child',
                    },
                  });
                }
                const remainingNodes = $getRoot().getAllTextNodes();
                let newIndex = 0;
                for (
                  let originalIndex = 0;
                  originalIndex < originalNodes.length;
                  originalIndex++
                ) {
                  const originalText = texts[originalIndex];
                  const originalNode = originalNodes[originalIndex];
                  let deleted: boolean;
                  if (originalIndex === nodeIndexStart) {
                    deleted = startCaret.offset === 0;
                    if (!deleted) {
                      expect(originalNode.getTextContent()).toBe(
                        originalText.slice(0, startCaret.offset),
                      );
                    }
                  } else if (
                    originalIndex > nodeIndexStart &&
                    originalIndex < nodeIndexEnd
                  ) {
                    deleted = true;
                  } else if (originalIndex === nodeIndexEnd) {
                    deleted = endCaret.offset === originalText.length;
                    if (!deleted) {
                      expect(originalNode.getTextContent()).toBe(
                        originalText.slice(endCaret.offset),
                      );
                    }
                  } else {
                    deleted = false;
                    expect(originalNode.getTextContent()).toBe(originalText);
                  }
                  expect(originalNode.isAttached()).toBe(!deleted);
                  if (!deleted) {
                    expect(originalNode.is(remainingNodes[newIndex])).toBe(
                      true,
                    );
                  }
                  newIndex += deleted ? 0 : 1;
                }
                expect(remainingNodes).toHaveLength(newIndex);
              });
            });
          }
        });
      });
      describe('multiple blocks', () => {
        beforeEach(async () => {
          await testEnv.editor.update(() => {
            // Ensure that the separate texts don't get merged
            const textNodes = texts.map(text =>
              $createTextNode(text).setStyle(`color: --color-${text}`),
            );
            $getRoot()
              .clear()
              .append(
                ...textNodes.map(node => $createParagraphNode().append(node)),
              );
          });
        });
        describe('multiple text node selection', () => {
          const OFFSETS = [startOfNode, insideNode, endOfNode];
          const NODE_PAIRS = [
            [0, 1],
            [0, 2],
            [1, 2],
          ] as const;
          for (const [
            direction,
            [[nodeIndexStart, nodeIndexEnd], [startFn, endFn]],
          ] of combinations(
            DIRECTIONS,
            combinations(NODE_PAIRS, combinations(OFFSETS, OFFSETS)),
          )) {
            test(`${direction} ${texts[nodeIndexStart]} ${startFn.name} ${texts[nodeIndexEnd]} ${endFn.name}`, async () => {
              await testEnv.editor.update(() => {
                const originalNodes = $getRoot().getAllTextNodes();
                const startNode = originalNodes[nodeIndexStart];
                const endNode = originalNodes[nodeIndexEnd];
                expect(startNode !== endNode).toBe(true);
                invariant($isTextNode(startNode), 'text node');
                invariant($isTextNode(endNode), 'text node');
                expect(startNode.isBefore(endNode)).toBe(true);
                const startCaret = $getTextPointCaret(
                  startNode,
                  direction,
                  startFn(startNode.getTextContentSize()),
                );
                const endCaret = $getTextPointCaret(
                  endNode,
                  direction,
                  endFn(endNode.getTextContentSize()),
                );
                const [anchor, focus] =
                  direction === 'next'
                    ? [startCaret, endCaret]
                    : [endCaret, startCaret];
                const range = $getCaretRange(anchor, focus);
                // TODO check [...range] carets
                const slices = range
                  .getTextSlices()
                  .filter($isTextPointCaretSlice);
                expect(slices).toHaveLength(2);
                expect(slices.map(slice => slice.getTextContent())).toEqual(
                  direction === 'next'
                    ? [
                        startCaret.origin
                          .getTextContent()
                          .slice(startCaret.offset),
                        endCaret.origin
                          .getTextContent()
                          .slice(0, endCaret.offset),
                      ]
                    : [
                        endCaret.origin
                          .getTextContent()
                          .slice(0, endCaret.offset),
                        startCaret.origin
                          .getTextContent()
                          .slice(startCaret.offset),
                      ],
                );
                const originalStartParent = startCaret.getParentAtCaret()!;
                const originalEndParent = endCaret.getParentAtCaret()!;
                const resultRange = $removeTextFromCaretRange(range);
                if (direction === 'next') {
                  if (anchor.offset !== 0) {
                    // Part of the anchor remains
                    expect(resultRange).toMatchObject({
                      anchor: {
                        direction,
                        offset: anchor.offset,
                        origin: anchor.origin.getLatest(),
                      },
                      direction,
                    });
                  } else if (focus.offset !== texts[nodeIndexEnd].length) {
                    // The focus was not deleted and there is no previous node
                    // so the new anchor will be set to the focus origin
                    expect(resultRange).toMatchObject({
                      anchor: {
                        direction,
                        offset: 0,
                        origin: originalNodes[nodeIndexEnd].getLatest(),
                      },
                      direction,
                    });
                  } else {
                    // The anchor and focus were removed
                    // so we have an empty paragraph at the anchor
                    expect(resultRange).toMatchObject({
                      anchor: {
                        direction,
                        origin: originalStartParent.getLatest(),
                        type: 'child',
                      },
                      direction,
                    });
                  }
                }
                // Check that the containing block is always that of the anchor
                expect(resultRange.anchor.getParentAtCaret()!.getLatest()).toBe(
                  originalStartParent.getLatest(),
                );
                // Check that the focus parent has always been removed
                expect(originalEndParent.isAttached()).toBe(false);
                // Check that the focus has been removed or moved to the anchor parent
                expect(
                  !focus.origin.isAttached() ||
                    originalStartParent.is(focus.origin.getParent()),
                ).toBe(true);
                const remainingNodes = $getRoot().getAllTextNodes();
                let newIndex = 0;
                for (
                  let originalIndex = 0;
                  originalIndex < originalNodes.length;
                  originalIndex++
                ) {
                  const originalText = texts[originalIndex];
                  const originalNode = originalNodes[originalIndex];
                  let deleted: boolean;
                  if (originalIndex === nodeIndexStart) {
                    deleted = startCaret.offset === 0;
                    if (!deleted) {
                      expect(originalNode.getTextContent()).toBe(
                        originalText.slice(0, startCaret.offset),
                      );
                    }
                  } else if (
                    originalIndex > nodeIndexStart &&
                    originalIndex < nodeIndexEnd
                  ) {
                    deleted = true;
                  } else if (originalIndex === nodeIndexEnd) {
                    deleted = endCaret.offset === originalText.length;
                    if (!deleted) {
                      expect(originalNode.getTextContent()).toBe(
                        originalText.slice(endCaret.offset),
                      );
                    }
                  } else {
                    deleted = false;
                    expect(originalNode.getTextContent()).toBe(originalText);
                  }
                  expect(originalNode.isAttached()).toBe(!deleted);
                  if (!deleted) {
                    expect(originalNode.is(remainingNodes[newIndex])).toBe(
                      true,
                    );
                  }
                  newIndex += deleted ? 0 : 1;
                }
                expect(remainingNodes).toHaveLength(newIndex);
              });
            });
          }
        });
        test('remove range between list and nested list', () => {
          testEnv.editor.update(
            () => {
              const listTextNode = $createTextNode('list node');
              const listNode = $createListNode().append(
                $createListItemNode().append(listTextNode),
              );

              const nestedTextNode = $createTextNode('be nested');
              const nestedListNode = $createListNode().append(
                $createListItemNode().append(nestedTextNode),
              );
              listNode.append($createListItemNode().append(nestedListNode));

              $getRoot().clear().append(listNode);
              const sel = $createRangeSelection();
              sel.anchor.set(listTextNode.getKey(), 'list'.length, 'text');
              sel.focus.set(nestedTextNode.getKey(), 'be '.length, 'text');
              $setSelection(sel);
              const resultRange = $removeTextFromCaretRange(
                $caretRangeFromSelection(sel),
              );
              $setSelectionFromCaretRange(resultRange);
              expect(
                $getRoot()
                  .getAllTextNodes()
                  .map(node => node.getTextContent()),
              ).toEqual(['list', 'nested']);
              expect(listNode.getLatest().getChildren().length).toEqual(1);
            },
            {discrete: true},
          );
          testEnv.editor.read('latest', () => {
            const allTextNodes = $getRoot().getAllTextNodes();
            // These should get merged in reconciliation
            expect(allTextNodes.map(node => node.getTextContent())).toEqual([
              'listnested',
            ]);
          });
        });
      });
    });
    describe('$extendCaretToRange', () => {
      test('next direction: focus can be flipped and used to delete to end of document (regression for #8927)', () => {
        testEnv.editor.update(
          () => {
            const t1 = $createTextNode('hello');
            const t2 = $createTextNode('world');
            const p1 = $createParagraphNode().append(t1);
            const p2 = $createParagraphNode().append(t2);
            $getRoot().clear().append(p1, p2);
            const range = $extendCaretToRange(
              $getTextPointCaret(t1, 'next', 2),
            );
            expect(range.focus).toEqual($getSiblingCaret(p2, 'next'));
            expect(range.focus.getFlipped()).toEqual(
              $getChildCaret($getRoot(), 'previous'),
            );
            expect(range.focus.getFlipped().getFlipped()).toEqual(range.focus);
            $removeTextFromCaretRange(range);
            expect($getRoot().getChildren()).toEqual([p1]);
            expect($getRoot().getAllTextNodes()).toEqual([t1]);
            expect($getRoot().getTextContent()).toBe('he');
          },
          {discrete: true},
        );
      });

      test('previous direction: focus can be flipped and used to delete to start of document', () => {
        testEnv.editor.update(
          () => {
            const t1 = $createTextNode('hello');
            const t2 = $createTextNode('world');
            const p1 = $createParagraphNode().append(t1);
            const p2 = $createParagraphNode().append(t2);
            $getRoot().clear().append(p1, p2);

            const range = $extendCaretToRange(
              $getTextPointCaret(t2, 'previous', 2),
            );
            expect(range.focus).toEqual($getSiblingCaret(p1, 'previous'));
            expect(range.focus.getFlipped()).toEqual(
              $getChildCaret($getRoot(), 'next'),
            );
            expect(range.focus.getFlipped().getFlipped()).toEqual(range.focus);
            $removeTextFromCaretRange(range);
            expect($getRoot().getChildren()).toEqual([p2]);
            expect($getRoot().getAllTextNodes()).toEqual([t2]);
            expect($getRoot().getTextContent()).toBe('rld');
          },
          {discrete: true},
        );
      });

      test("doesn't change which nodes plain iteration visits", () => {
        testEnv.editor.update(() => {
          const t1 = $createTextNode('hello');
          const t2 = $createTextNode('world');
          const p1 = $createParagraphNode().append(t1);
          const p2 = $createParagraphNode().append(t2);
          $getRoot().clear().append(p1, p2);
          const visited = [
            ...$extendCaretToRange($getTextPointCaret(t1, 'next', 2)),
          ];
          // Same sequence a plain for...of produced before this fix — the fix
          // only changes whether the focus can be flipped, not what iteration visits.
          expect(visited).toEqual([
            $getSiblingCaret(p1, 'next'),
            $getChildCaret(p2, 'next'),
            $getSiblingCaret(t2, 'next'),
            $getSiblingCaret(p2, 'next'),
          ]);
        });
      });

      test('empty document: focus can still be flipped without throwing', () => {
        testEnv.editor.update(() => {
          $getRoot().clear();
          const range = $extendCaretToRange($getChildCaret($getRoot(), 'next'));
          expect(() => range.focus.getFlipped()).not.toThrow();
        });
      });
    });
    describe('Ordering', () => {
      let rootNode: RootNode;
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
        testEnv.editor.update(() => {
          rootNode = $getRoot();
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
      describe('$comparePointCaretNext', () => {
        test('trivial caret checks', () => {
          testEnv.editor.update(
            () => {
              const seenCarets: NodeCaret<'next'>[] = [];
              const range = $getCaretRange(
                $getChildCaret($getRoot(), 'next'),
                $getSiblingCaret($getRoot(), 'next'),
              );
              expect($comparePointCaretNext(range.anchor, range.focus)).toBe(
                -1,
              );
              expect($comparePointCaretNext(range.anchor, range.anchor)).toBe(
                0,
              );
              expect($comparePointCaretNext(range.focus, range.focus)).toBe(0);
              expect($comparePointCaretNext(range.focus, range.anchor)).toBe(1);
              for (const caret of $getCaretRange(
                $getChildCaret($getRoot(), 'next'),
                $getSiblingCaret($getRoot(), 'next'),
              )) {
                expect($comparePointCaretNext(caret, caret)).toBe(0);
                for (const seenCaret of seenCarets) {
                  expect($comparePointCaretNext(caret, seenCaret)).toBe(1);
                  expect($comparePointCaretNext(seenCaret, caret)).toBe(-1);
                }
                seenCarets.push(caret);
              }
            },
            {discrete: true},
          );
        });
        test('TextPointCaret checks single origin', () => {
          testEnv.editor.update(
            () => {
              expect(
                $comparePointCaretNext(
                  $getTextPointCaret(paragraphText, 'next', 0),
                  $getTextPointCaret(paragraphText, 'next', 0),
                ),
              ).toBe(0);
              expect(
                $comparePointCaretNext(
                  $getTextPointCaret(paragraphText, 'next', 0),
                  $getTextPointCaret(paragraphText, 'next', 2),
                ),
              ).toBe(-1);
              expect(
                $comparePointCaretNext(
                  $getTextPointCaret(paragraphText, 'next', 2),
                  $getTextPointCaret(paragraphText, 'next', 0),
                ),
              ).toBe(1);
              // next sibling carets always come after points inside the text
              expect(
                $comparePointCaretNext(
                  $getTextPointCaret(paragraphText, 'next', 2),
                  $getSiblingCaret(paragraphText, 'next'),
                ),
              ).toBe(-1);
              expect(
                $comparePointCaretNext(
                  $getSiblingCaret(paragraphText, 'next'),
                  $getTextPointCaret(paragraphText, 'next', 2),
                ),
              ).toBe(1);
              expect(
                $comparePointCaretNext(
                  $getTextPointCaret(
                    paragraphText,
                    'next',
                    paragraphText.getTextContentSize(),
                  ),
                  $getSiblingCaret(paragraphText, 'next'),
                ),
              ).toBe(-1);
              expect(
                $comparePointCaretNext(
                  $getSiblingCaret(paragraphText, 'next'),
                  $getTextPointCaret(
                    paragraphText,
                    'next',
                    paragraphText.getTextContentSize(),
                  ),
                ),
              ).toBe(1);
            },
            {discrete: true},
          );
        });
        test('TextPointCaret multiple origin', () => {
          testEnv.editor.update(
            () => {
              expect(
                $comparePointCaretNext(
                  $getTextPointCaret(paragraphText, 'next', 0),
                  $getTextPointCaret(linkText, 'next', 0),
                ),
              ).toBe(-1);
              expect(
                $comparePointCaretNext(
                  $getTextPointCaret(paragraphText, 'next', 0),
                  $getSiblingCaret(linkText, 'next'),
                ),
              ).toBe(-1);
              expect(
                $comparePointCaretNext(
                  $getTextPointCaret(linkText, 'next', 0),
                  $getTextPointCaret(paragraphText, 'next', 0),
                ),
              ).toBe(1);
            },
            {discrete: true},
          );
        });
      });
      describe('$getCommonAncestor', () => {
        test('trivial node checks', () => {
          testEnv.editor.update(
            () => {
              expect($getCommonAncestor($getRoot(), $getRoot())).toEqual({
                commonAncestor: $getRoot(),
                type: 'same',
              });
              for (const caret of $getCaretRange(
                $getChildCaret($getRoot(), 'next'),
                $getSiblingCaret($getRoot(), 'next'),
              )) {
                if ($isSiblingCaret(caret)) {
                  expect(
                    $getCommonAncestor(caret.origin, caret.origin),
                  ).toEqual({
                    commonAncestor: caret.origin,
                    type: 'same',
                  });
                  expect($getCommonAncestor($getRoot(), caret.origin)).toEqual({
                    commonAncestor: $getRoot(),
                    type: 'ancestor',
                  });
                  expect($getCommonAncestor(caret.origin, $getRoot())).toEqual({
                    commonAncestor: $getRoot(),
                    type: 'descendant',
                  });
                  const parent = caret.getParentAtCaret()!;
                  expect($getCommonAncestor(parent, caret.origin)).toEqual({
                    commonAncestor: parent,
                    type: 'ancestor',
                  });
                  expect($getCommonAncestor(caret.origin, parent)).toEqual({
                    commonAncestor: parent,
                    type: 'descendant',
                  });
                }
              }
            },
            {discrete: true},
          );
        });
        function testBranch(
          title: string,
          $getTestNodes: () => [LexicalNode, LexicalNode],
          $getTestAncestors: () => [LexicalNode, LexicalNode],
          $getTestCommonAncestor: () => ElementNode,
        ): void {
          test(title, () => {
            testEnv.editor.update(
              () => {
                const nodes = $getTestNodes().map(n => n.getLatest());
                const ancestors = $getTestAncestors().map(n => n.getLatest());
                const commonAncestor = $getTestCommonAncestor().getLatest();
                expect($getCommonAncestor(nodes[0], nodes[1])).toEqual({
                  a: ancestors[0],
                  b: ancestors[1],
                  commonAncestor,
                  type: 'branch',
                });
                expect($getCommonAncestor(nodes[1], nodes[0])).toEqual({
                  a: ancestors[1],
                  b: ancestors[0],
                  commonAncestor,
                  type: 'branch',
                });
              },
              {discrete: true},
            );
          });
        }
        testBranch(
          'paragraphNode and listNode are siblings in root',
          () => [paragraphNode, listNode],
          () => [paragraphNode, listNode],
          () => rootNode,
        );
        testBranch(
          'paragraphText and linkNode->linkText are siblings in paragraphNode',
          () => [paragraphText, linkText],
          () => [paragraphText, linkNode],
          () => paragraphNode,
        );
        testBranch(
          'paragraphNode->linkNode->linkText and listNode->listItem2->listItemText2 are siblings in root',
          () => [linkText, listItemText2],
          () => [paragraphNode, listNode],
          () => rootNode,
        );
        testBranch(
          'listItem1 and listItem2->listItemText2 are siblings in listNode',
          () => [listItem1, listItemText2],
          () => [listItem1, listItem2],
          () => listNode,
        );
        testBranch(
          'listItem1->listItemText1 and listItem2->listItemText2 are siblings in listNode',
          () => [listItemText1, listItemText2],
          () => [listItem1, listItem2],
          () => listNode,
        );
      });
    });
  });
});

describe('LexicalSelectionHelpers', () => {
  initializeUnitTest(testEnv => {
    describe('with a fully-selected text node preceded by an inline element', () => {
      test('a single text node', async () => {
        await testEnv.editor.update(() => {
          const root = $getRoot();

          const paragraph = $createParagraphNode();
          root.append(paragraph);

          const link = $createLinkNode('https://');
          link.append($createTextNode('link'));
          paragraph.append(link);

          const text = $createTextNode('Existing text...');
          paragraph.append(text);

          const range = $getCaretRange(
            $getTextPointCaret(text, 'next', 0),
            $getTextPointCaret(text, 'next', 'next'),
          );
          const newRange = $removeTextFromCaretRange(range);
          expect(newRange).toMatchObject({
            anchor: {
              direction: 'next',
              origin: link.getLatest(),
              type: 'sibling',
            },
          });
          newRange.focus.insert($createTextNode('foo'));
        });

        expect(testEnv.innerHTML).toBe(
          '<p dir="auto"><a href="https://"><span data-lexical-text="true">link</span></a><span data-lexical-text="true">foo</span></p>',
        );
      });
    });

    describe('canBeEmpty()=false parent cleanup', () => {
      test('MarkNode is removed when all children are deleted via element-type range', () => {
        testEnv.editor.update(
          () => {
            const root = $getRoot();
            root.clear();
            const p = $createParagraphNode();
            const before = $createTextNode('before ');
            const mark = $createMarkNode(['test-id']);
            const markText1 = $createTextNode('aaa');
            const markText2 = $createTextNode('bbb');
            const after = $createTextNode(' after');
            mark.append(markText1, markText2);
            p.append(before, mark, after);
            root.append(p);

            const range = $getCaretRange(
              $getChildCaretAtIndex(mark, 0, 'next'),
              $getChildCaretAtIndex(mark, 2, 'next'),
            );
            $removeTextFromCaretRange(range);

            expect(mark.isAttached()).toBe(false);
            expect(before.isAttached()).toBe(true);
            expect(after.isAttached()).toBe(true);
          },
          {discrete: true},
        );
      });

      test('LinkNode is removed when all children are deleted via element-type range', () => {
        testEnv.editor.update(
          () => {
            const root = $getRoot();
            root.clear();
            const p = $createParagraphNode();
            const before = $createTextNode('before ');
            const link = $createLinkNode('https://lexical.dev');
            const linkText = $createTextNode('click');
            const after = $createTextNode(' after');
            link.append(linkText);
            p.append(before, link, after);
            root.append(p);

            const range = $getCaretRange(
              $getChildCaretAtIndex(link, 0, 'next'),
              $getChildCaretAtIndex(link, 1, 'next'),
            );
            $removeTextFromCaretRange(range);

            expect(link.isAttached()).toBe(false);
            expect(before.isAttached()).toBe(true);
            expect(after.isAttached()).toBe(true);
          },
          {discrete: true},
        );
      });

      test('canBeEmpty()=false parent survives when only some children are removed', () => {
        testEnv.editor.update(
          () => {
            const root = $getRoot();
            root.clear();
            const p = $createParagraphNode();
            const mark = $createMarkNode(['test-id']);
            const t1 = $createTextNode('aaa');
            const t2 = $createTextNode('bbb');
            const t3 = $createTextNode('ccc');
            mark.append(t1, t2, t3);
            p.append(mark);
            root.append(p);

            const range = $getCaretRange(
              $getChildCaretAtIndex(mark, 0, 'next'),
              $getSiblingCaret(t2, 'next'),
            );
            $removeTextFromCaretRange(range);

            expect(mark.isAttached()).toBe(true);
            expect(mark.getChildrenSize()).toBeGreaterThan(0);
          },
          {discrete: true},
        );
      });

      test('multiple canBeEmpty()=false parents in same range are cleaned up', () => {
        testEnv.editor.update(
          () => {
            const root = $getRoot();
            root.clear();
            const p = $createParagraphNode();
            const mark1 = $createMarkNode(['id1']);
            const mark2 = $createMarkNode(['id2']);
            const t1 = $createTextNode('aaa');
            const t2 = $createTextNode('bbb');
            const spacer = $createTextNode(' ');
            mark1.append(t1);
            mark2.append(t2);
            p.append(mark1, spacer, mark2);
            root.append(p);

            const range = $getCaretRange(
              $getChildCaretAtIndex(p, 0, 'next'),
              $getChildCaretAtIndex(p, 3, 'next'),
            );
            $removeTextFromCaretRange(range);

            expect(mark1.isAttached()).toBe(false);
            expect(mark2.isAttached()).toBe(false);
          },
          {discrete: true},
        );
      });
    });
  });
});

describe('$splitAtPointCaretNext', () => {
  initializeUnitTest(testEnv => {
    test('Does not split a TextNode at the beginning', () => {
      testEnv.editor.update(
        () => {
          const textNode = $createTextNode('test');
          const paragraphNode = $createParagraphNode();
          $getRoot().clear().append(paragraphNode.append(textNode));
          const caret = $getTextPointCaret(textNode, 'next', 0);
          const after = $splitAtPointCaretNext(caret);
          expect(textNode.getTextContent()).toEqual('test');
          expect(
            $getChildCaret(paragraphNode, 'next').isSamePointCaret(after),
          ).toBe(true);
        },
        {discrete: true},
      );
    });
    test('Splits a TextNode in the middle', () => {
      testEnv.editor.update(
        () => {
          const textNode = $createTextNode('test');
          const paragraphNode = $createParagraphNode();
          $getRoot().clear().append(paragraphNode.append(textNode));
          const caret = $getTextPointCaret(textNode, 'next', 2);
          const after = $splitAtPointCaretNext(caret);
          expect(textNode.getTextContent()).toEqual('te');
          const nextCaret = $getSiblingCaret(textNode, 'next');
          expect(nextCaret.isSamePointCaret(after)).toBe(true);
          const splitNode = nextCaret.getNodeAtCaret();
          expect(
            $isTextNode(splitNode) ? splitNode.getTextContent() : null,
          ).toEqual('st');
        },
        {discrete: true},
      );
    });
    test('Splits a ParagraphNode', () => {
      testEnv.editor.update(
        () => {
          const beforeTextNode = $createTextNode('before');
          const afterTextNode = $createTextNode('after');
          const paragraphNode = $createParagraphNode();
          $getRoot()
            .clear()
            .append(paragraphNode.append(beforeTextNode, afterTextNode));
          const caret = $getSiblingCaret(beforeTextNode, 'next');
          const after = $splitAtPointCaretNext(caret);
          expect(paragraphNode.getAllTextNodes()).toEqual([beforeTextNode]);
          const nextCaret = $getSiblingCaret(paragraphNode, 'next');
          expect(nextCaret.isSamePointCaret(after)).toBe(true);
          const splitNode = nextCaret.getNodeAtCaret();
          expect(
            $isParagraphNode(splitNode) ? splitNode.getAllTextNodes() : null,
          ).toEqual([afterTextNode]);
        },
        {discrete: true},
      );
    });
  });
});
