/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {afterEach, assert, expect, test, vi} from 'vitest';

afterEach(() => {
  vi.doUnmock('lexical/src/environment');
  vi.resetModules();
});

// A forward deletion's beforeinput dispatches DELETE_LINE_COMMAND with its
// target range, even one that reaches before the caret, as long as the caret
// is outside every slot. In a slot such a range is the shape of a plain Delete
// (#9363): it is ignored and one character after the caret is deleted.
test.each([
  {caret: 'no slots', end: 3, expected: ['line', 2, 3], start: 2},
  {caret: 'no slots', end: 2, expected: ['line', 0, 2], start: 0},
  {caret: 'beside a slot', end: 2, expected: ['line', 0, 2], start: 0},
  {caret: 'in a slot', end: 3, expected: ['line', 2, 3], start: 2},
  {caret: 'in a slot', end: 2, expected: ['character', 2, 2], start: 0},
] as const)(
  'deleteContentForward from $start to $end with the caret $caret deletes $expected',
  async ({caret, end, expected, start}) => {
    vi.doMock('lexical/src/environment', async importOriginal => ({
      ...(await importOriginal<object>()),
      CAN_USE_BEFORE_INPUT: true,
    }));
    const {
      $createParagraphNode,
      $createTextNode,
      $getRoot,
      $getSelection,
      $isRangeSelection,
      $setSlot,
      COMMAND_PRIORITY_CRITICAL,
      DELETE_CHARACTER_COMMAND,
      DELETE_LINE_COMMAND,
    } = await import('lexical');
    const {buildEditorFromExtensions} = await import('@lexical/extension');
    const {RichTextExtension} = await import('@lexical/rich-text');
    using editor = buildEditorFromExtensions({
      $initialEditorState: () => {
        const text = $createTextNode('draft');
        const paragraph = $createParagraphNode().append(text);
        const host = $createParagraphNode();
        if (caret === 'in a slot') {
          $getRoot().append(host);
          $setSlot(host, 'note', paragraph);
        } else {
          $getRoot().append(paragraph);
        }
        if (caret === 'beside a slot') {
          $getRoot().append(host);
          $setSlot(
            host,
            'note',
            $createParagraphNode().append($createTextNode('note')),
          );
        }
        text.select(2, 2);
      },
      afterRegistration: ed => {
        const root = document.createElement('div');
        root.contentEditable = 'true';
        document.body.appendChild(root);
        ed.setRootElement(root);
        return () => {
          ed.setRootElement(null);
          root.remove();
        };
      },
      dependencies: [RichTextExtension],
      name: '[test]',
    });
    const calls: [string, number, number][] = [];
    for (const [name, command] of [
      ['line', DELETE_LINE_COMMAND],
      ['character', DELETE_CHARACTER_COMMAND],
    ] as const) {
      editor.registerCommand(
        command,
        isBackward => {
          const selection = $getSelection();
          assert($isRangeSelection(selection) && !isBackward);
          const [first, last] = selection.getStartEndPoints();
          calls.push([
            name,
            Math.min(first.offset, last.offset),
            Math.max(first.offset, last.offset),
          ]);
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      );
    }
    const rootElement = editor.getRootElement();
    const textDOM =
      rootElement && rootElement.querySelector('span')?.firstChild;
    assert(rootElement && textDOM);
    const event = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'deleteContentForward',
    });
    Object.defineProperty(event, 'getTargetRanges', {
      value: () => [
        new StaticRange({
          endContainer: textDOM,
          endOffset: end,
          startContainer: textDOM,
          startOffset: start,
        }),
      ],
    });
    rootElement.dispatchEvent(event);
    expect(calls).toEqual([expected]);
  },
);
