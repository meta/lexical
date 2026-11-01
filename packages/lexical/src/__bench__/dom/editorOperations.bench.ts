/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import invariant from '@lexical/internal/invariant';
import {test} from 'vitest';

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $selectAll,
  type EditorState,
  type LexicalEditor,
} from '../../';
import {createTestEditor} from '../../__tests__/utils';
import {attachToDOM, buildLargeDoc} from './_utils';

const SPLIT_TEXT = 'paragraph with some text content for splitting';
const MIN_SPLIT_TEXT_LENGTH = 2;

const SIZES = [100, 1000] as const;

for (const size of SIZES) {
  // Splits last child at midpoint. Resets text when exhausted (~every
  // 5 iters) to avoid O(n) backward walk that would dominate timing.
  test(`size=${size} :: split paragraph (Enter)`, async ({bench}) => {
    let editor: LexicalEditor;

    await bench(
      'insertParagraph',
      {
        beforeAll: () => {
          editor = createTestEditor();
          attachToDOM(editor);
          buildLargeDoc(editor, size);
        },
      },
      () => {
        editor.update(
          () => {
            const last = $getRoot().getLastChild();
            invariant(
              last !== null && $isParagraphNode(last),
              'Expected ParagraphNode',
            );
            const textNode = last.getFirstChild();
            invariant($isTextNode(textNode), 'Expected TextNode');
            if (textNode.getTextContentSize() <= MIN_SPLIT_TEXT_LENGTH) {
              textNode.setTextContent(SPLIT_TEXT);
            }
            const splitOffset = Math.floor(textNode.getTextContentSize() / 2);
            textNode.select(splitOffset, splitOffset);
            const selection = $getSelection();
            invariant($isRangeSelection(selection), 'Expected RangeSelection');
            selection.insertParagraph();
          },
          {discrete: true},
        );
      },
    ).run();
  });

  // Non-destructive: bold toggles on the same paragraph each iteration.
  // Selection + format in one discrete update so reconcile is measured.
  test(`size=${size} :: format text (bold on selection)`, async ({bench}) => {
    let editor: LexicalEditor;

    await bench(
      'formatText bold',
      {
        beforeAll: () => {
          editor = createTestEditor();
          attachToDOM(editor);
          buildLargeDoc(editor, size);
        },
      },
      () => {
        editor.update(
          () => {
            const last = $getRoot().getLastChild();
            invariant(
              last !== null && $isParagraphNode(last),
              'Expected ParagraphNode',
            );
            const textNode = last.getFirstChild();
            invariant($isTextNode(textNode), 'Expected TextNode');
            textNode.select(0, textNode.getTextContentSize());
            const selection = $getSelection();
            invariant($isRangeSelection(selection), 'Expected RangeSelection');
            selection.formatText('bold');
          },
          {discrete: true},
        );
      },
    ).run();
  });

  // Destructive: selects the last 10 paragraphs and deletes via
  // removeText — the same code path as a user pressing Delete.
  // Anchors at the end of the paragraph before the range so that
  // after deletion the anchor paragraph keeps its text, avoiding
  // the empty-paragraph artifact that a start-of-range anchor causes.
  test(`size=${size} :: delete range (10 paragraphs)`, async ({bench}) => {
    let editor: LexicalEditor;

    await bench(
      'removeText across 10 paragraphs',
      {
        beforeAll: () => {
          editor = createTestEditor();
          attachToDOM(editor);
          buildLargeDoc(editor, size * 16);
        },
      },
      () => {
        editor.update(
          () => {
            const root = $getRoot();
            invariant(
              root.getChildrenSize() > 10,
              'Document exhausted (%s children remain)',
              String(root.getChildrenSize()),
            );
            const lastNode = root.getLastChild();
            invariant(
              lastNode !== null && $isParagraphNode(lastNode),
              'Expected last ParagraphNode',
            );
            let firstToDelete = lastNode;
            for (let i = 0; i < 9; i++) {
              const prev = firstToDelete.getPreviousSibling();
              invariant(
                $isParagraphNode(prev),
                'Expected previous ParagraphNode',
              );
              firstToDelete = prev;
            }
            const anchorNode = firstToDelete.getPreviousSibling();
            invariant(
              anchorNode !== null && $isParagraphNode(anchorNode),
              'Expected anchor ParagraphNode',
            );
            const anchorText = anchorNode.getLastChild();
            invariant($isTextNode(anchorText), 'Expected anchor TextNode');
            const focusText = lastNode.getLastChild();
            invariant($isTextNode(focusText), 'Expected focus TextNode');
            anchorText.select(
              anchorText.getTextContentSize(),
              anchorText.getTextContentSize(),
            );
            const selection = $getSelection();
            invariant($isRangeSelection(selection), 'Expected RangeSelection');
            selection.focus.set(
              focusText.getKey(),
              focusText.getTextContentSize(),
              'text',
            );
            selection.removeText();
          },
          {discrete: true},
        );
      },
    ).run({iterations: size, time: 0, warmupIterations: 5, warmupTime: 0});
  });

  // Insert 10 paragraphs into the same initial document each iteration.
  // Tinybench runs task hooks outside the timed body, so restoring the state
  // keeps the paste workload at the requested size throughout the run.
  test(`size=${size} :: paste 10 paragraphs`, async ({bench}) => {
    let editor: LexicalEditor;
    let initialState: EditorState;
    let cycle = 0;
    let pasted = 0;
    let checked = 0;

    await bench(
      '$insertNodes at end',
      {
        afterAll: () => {
          invariant(
            pasted === checked && cycle === 1,
            'Paste benchmark hooks did not run on every iteration',
          );
        },
        afterEach: () => {
          checked++;
          editor.read(() => {
            const actual = $getRoot().getChildrenSize();
            invariant(
              // The first pasted paragraph merges into the original last
              // paragraph because the caret is at the end of its text.
              actual === size + 9,
              'Paste should leave %s paragraphs, got %s',
              String(size + 9),
              String(actual),
            );
          });
        },
        beforeAll: () => {
          editor = createTestEditor();
          attachToDOM(editor);
          buildLargeDoc(editor, size);
          initialState = editor.getEditorState();
          cycle = 0;
          pasted = 0;
          checked = 0;
        },
        beforeEach: () => {
          editor.setEditorState(initialState);
          cycle = 0;
        },
      },
      () => {
        editor.update(
          () => {
            const last = $getRoot().getLastChild();
            invariant(
              last !== null && $isParagraphNode(last),
              'Expected ParagraphNode',
            );
            const textNode = last.getFirstChild();
            invariant($isTextNode(textNode), 'Expected TextNode');
            textNode.select(
              textNode.getTextContentSize(),
              textNode.getTextContentSize(),
            );
            const nodes = [];
            for (let i = 0; i < 10; i++) {
              nodes.push(
                $createParagraphNode().append(
                  $createTextNode(`paste-${cycle}-${i}`),
                ),
              );
            }
            $insertNodes(nodes);
            cycle++;
            pasted++;
          },
          {discrete: true},
        );
      },
    ).run({throws: true});
  });

  // Non-destructive: select all + italic toggle.
  test(`size=${size} :: select all + format`, async ({bench}) => {
    let editor: LexicalEditor;

    await bench(
      '$selectAll + formatText italic',
      {
        beforeAll: () => {
          editor = createTestEditor();
          attachToDOM(editor);
          buildLargeDoc(editor, size);
        },
      },
      () => {
        editor.update(
          () => {
            $selectAll();
            const selection = $getSelection();
            invariant($isRangeSelection(selection), 'Expected RangeSelection');
            selection.formatText('italic');
          },
          {discrete: true},
        );
      },
    ).run();
  });
}
