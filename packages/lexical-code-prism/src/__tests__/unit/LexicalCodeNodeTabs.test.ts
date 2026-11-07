/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$createCodeNode, $isCodeNode, type CodeNode} from '@lexical/code';
import {CodeIndentExtension} from '@lexical/code-core';
import {
  CodePrismExtension,
  registerCodeHighlighting,
} from '@lexical/code-prism';
import {
  buildEditorFromExtensions,
  TabIndentationExtension,
} from '@lexical/extension';
import {registerTabIndentation} from '@lexical/react/LexicalTabIndentationPlugin';
import {registerRichText, RichTextExtension} from '@lexical/rich-text';
import {
  $caretRangeFromSelection,
  $createRangeSelection,
  $getCaretRangeInDirection,
  $getRoot,
  $getSelection,
  $isLineBreakNode,
  $setSelectionFromCaretRange,
  type AnyLexicalCommand,
  configExtension,
  INDENT_CONTENT_COMMAND,
  KEY_TAB_COMMAND,
  OUTDENT_CONTENT_COMMAND,
} from 'lexical';
import {
  initializeUnitTest,
  tabKeyboardEvent,
} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

import {
  OUTDENT_SCENARIOS,
  runOutdentScenario,
} from '../../../../lexical-code-core/src/__tests__/outdentTestUtils';

describe('LexicalCodeNode tests', () => {
  initializeUnitTest(testEnv => {
    describe('Tabs', () => {
      // Tests are described using the following convention
      // > is the beginning of a line
      // - is a Tab
      // | is the selection anchor and focus (they may be collapsed)
      // in the format [before, after, operation]
      const suite = [
        ['>|', '>-|', 'tab'],
        ['>|', '>-|', 'indent'],
        ['>|', '>|', 'outdent'],
        ['>|line1', '>-|line1', 'tab'],
        ['>|line1', '>-|line1', 'indent'],
        ['>|line1', '>|line1', 'outdent'],
        ['>-li|ne1', '>-li-|ne1', 'tab'],
        ['>-li|ne1', '>--li|ne1', 'indent'],
        ['>-li|ne1', '>li|ne1', 'outdent'],
        ['>|-line1|', '>|--line1|', 'tab'],
        ['>|-line1|', '>|--line1|', 'indent'],
        ['>|-line1|', '>|line1|', 'outdent'],
        ['>-li|ne1|', '>-li-|', 'tab'],
        ['>-li|ne1|', '>--li|ne1|', 'indent'],
        ['>-li|ne1|', '>li|ne1|', 'outdent'],
        ['>|word1| word2', '>-| word2', 'tab'],
        ['>|line1>|', '>|-line1>|', 'tab'],
        ['>|line1>|', '>|-line1>|', 'indent'],
        ['>|line1>|line2', '>|-line1>|line2', 'tab'],
        ['>|line1>|line2', '>|-line1>|line2', 'indent'],
        ['>line1|>line2|', '>-line1|>-line2|', 'tab'],
        ['>line1|>line2|', '>-line1|>-line2|', 'indent'],
        ['>|>li|ne1', '>|>-li|ne1', 'tab'],
        ['>|>li|ne1', '>|>-li|ne1', 'indent'],
        ['>|>|line1', '>|->|line1', 'tab'],
        ['>|>|line1', '>|->|line1', 'indent'],
        ['>|>>|line1', '>|>>|line1', 'tab'],
        ['>|>>|line1', '>|>>|line1', 'indent'],
        ['>|line1>li|ne2', '>|-line1>-li|ne2', 'tab'],
        ['>|line1>li|ne2', '>|-line1>-li|ne2', 'indent'],
        ['>|-line1>li|ne2', '>|line1>li|ne2', 'outdent'],
        ['>li|ne1>li|ne2', '>-li|ne1>-li|ne2', 'tab'],
        ['>li|ne1>li|ne2', '>-li|ne1>-li|ne2', 'indent'],
        ['>-li|ne1>>-li|ne2', '>--li|ne1>>--li|ne2', 'tab'],
        ['>-li|ne1>>-li|ne2', '>--li|ne1>>--li|ne2', 'indent'],
        ['>-li|ne1>>-li|ne2', '>li|ne1>>li|ne2', 'outdent'],
        ['>|-line1>->-line2|', '>|--line1>-->--line2|', 'tab'],
      ];
      suite.forEach(scenario => {
        ['forwards', 'backwards'].forEach(direction => {
          test(`testing ${scenario[2]}: ${scenario[0]} => ${scenario[1]} (${direction})`, async () => {
            const {editor} = testEnv;

            const getDispatchArgs = (type: string) => {
              switch (type) {
                case 'indent':
                  return [INDENT_CONTENT_COMMAND, undefined]; // : [LexicalCommand<void>, void];
                case 'outdent':
                  return [OUTDENT_CONTENT_COMMAND, undefined]; // : [LexicalCommand<void>, void];
                case 'tabs':
                default:
                  return [KEY_TAB_COMMAND, tabKeyboardEvent()]; // : [LexicalCommand<KeyboardEvent>, KeyboardEvent];
              }
            };

            const getRawTextWithSelection = (input: string) => {
              return input
                .replace(/^>/, '')
                .replaceAll('>', '\n')
                .replaceAll('-', '\t');
            };
            const getRawText = (input: string) => {
              return getRawTextWithSelection(input).replaceAll('|', '');
            };

            registerRichText(editor);
            registerTabIndentation(editor);
            registerCodeHighlighting(editor);

            // fill editor with scenario input text
            let codeNode: CodeNode;
            await editor.update(() => {
              const root = $getRoot();
              codeNode = $createCodeNode();
              root.append(codeNode);
              codeNode.selectStart();
              $getSelection()!.insertRawText(getRawText(scenario[0]));
            });

            // Create a RangeSelection that matches the selection
            // described in the scenario input via the | convention
            await editor.update(() => {
              const selection = $createRangeSelection();
              if ($isCodeNode(codeNode) && codeNode.isEmpty()) {
                selection.anchor.set(codeNode.getKey(), 0, 'element');
                selection.focus.set(codeNode.getKey(), 0, 'element');
              } else {
                const rawText = getRawTextWithSelection(scenario[0]);
                const selFirst = rawText.indexOf('|');
                let selLast = rawText.lastIndexOf('|');

                // if selection is not collapsed, we need to adjust
                // the last index to take account of the first |
                if (selLast !== selFirst) {
                  selLast -= 1;
                }

                let matching = codeNode.getFirstChild();
                let parentIndex = 0;
                let offset = 0;
                while (
                  matching !== null &&
                  offset + matching.getTextContentSize() < selFirst
                ) {
                  offset += matching.getTextContentSize();
                  matching = matching.getNextSibling();
                  parentIndex++;
                }
                if (matching === null) {
                  selection.anchor.set(codeNode.getKey(), 0, 'element');
                } else if (!$isLineBreakNode(matching)) {
                  selection.anchor.set(
                    matching.getKey(),
                    selFirst - offset,
                    'text',
                  );
                } else {
                  selection.anchor.set(
                    codeNode.getKey(),
                    parentIndex,
                    'element',
                  );
                }
                while (
                  matching !== null &&
                  offset + matching.getTextContentSize() < selLast
                ) {
                  offset += matching.getTextContentSize();
                  matching = matching.getNextSibling();
                  parentIndex++;
                }
                if (matching === null) {
                  selection.focus.set(codeNode.getKey(), 0, 'element');
                } else if (!$isLineBreakNode(matching)) {
                  selection.focus.set(
                    matching.getKey(),
                    selLast - offset,
                    'text',
                  );
                } else {
                  selection.focus.set(
                    codeNode.getKey(),
                    parentIndex + 1,
                    'element',
                  );
                }
              }
              $setSelectionFromCaretRange(
                $getCaretRangeInDirection(
                  $caretRangeFromSelection(selection),
                  direction === 'forwards' ? 'next' : 'previous',
                ),
              );

              // dispatch command from the current context to avoid
              // selectionTarget.getBoundingClientRect is not a function Error
              editor.dispatchCommand(
                ...(getDispatchArgs(scenario[2]) as [
                  AnyLexicalCommand,
                  unknown,
                ]),
              );
            });

            editor.read(() => {
              const output = scenario[1].replaceAll('|', '');
              const selectedOutput = scenario[1]
                .replace(/^[^|]*/, '')
                .replace(/[^|]*$/, '')
                .replaceAll('|', '');
              expect(
                '>' +
                  codeNode
                    .getTextContent()
                    .replaceAll('\t', '-')
                    .replaceAll('\n', '>'),
              ).toBe(output);
              expect(
                $getSelection()!
                  .getTextContent()
                  .replaceAll('\t', '-')
                  .replaceAll('\n', '>'),
              ).toBe(selectedOutput);
              const isBackward = $getSelection()!.isBackward();
              if (direction === 'forwards') {
                expect(isBackward).toBe(false);
              } else {
                if (scenario[1].split('|').length === 3) {
                  expect(isBackward).toBe(true);
                }
              }
            });
          });
        });
      });
    });
  });
  describe('tabSize (#8410): outdent space-indented lines', () => {
    test.for(OUTDENT_SCENARIOS)(
      '$name',
      ({rawText, cursorOffset, tabSize, expectedText, expectedCursor}) => {
        using editor = buildEditorFromExtensions({
          dependencies: [
            RichTextExtension,
            TabIndentationExtension,
            CodePrismExtension,
            configExtension(CodeIndentExtension, {tabSize}),
          ],
          name: 'prism-outdent',
        });
        const {text, cursor} = runOutdentScenario(
          editor,
          rawText,
          cursorOffset,
        );
        expect(text).toBe(expectedText);
        if (expectedCursor !== undefined) {
          expect(cursor).toBe(expectedCursor);
        }
      },
    );
  });
});
