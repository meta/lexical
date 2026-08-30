/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$createCodeNode, type CodeNode} from '@lexical/code-core';
import {
  $getChildCaret,
  $getCollapsedCaretRange,
  $getRoot,
  $getSelection,
  $getSiblingCaret,
  $getTextPointCaret,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setSelectionFromCaretRange,
  type LexicalEditor,
  OUTDENT_CONTENT_COMMAND,
  type PointCaret,
} from 'lexical';
import {assert} from 'vitest';

/**
 * Shared test helper for the OUTDENT_CONTENT_COMMAND space-stripping
 * behavior in `@lexical/code-shiki` and `@lexical/code-prism`.
 *
 * Sets up a single CodeNode containing `rawText`, places a collapsed
 * cursor at `cursorOffset`, dispatches OUTDENT, and reads back the
 * resulting text and cursor offset (relative to the code node).
 *
 * Each highlighter test passes its own `register` callback so it can
 * call its own `registerCodeHighlighting(editor, ..., tabSize)` and any
 * async language/theme loading the highlighter requires.
 */
export function runOutdentScenario(
  editor: LexicalEditor,
  rawText: string,
  cursorOffset: number,
): {cursor: number; text: string} {
  let codeNode: CodeNode;
  editor.update(
    () => {
      codeNode = $createCodeNode();
      $getRoot().clear().append(codeNode);
      codeNode.selectStart().insertRawText(rawText);
    },
    {discrete: true},
  );

  editor.update(() => {
    let matching = codeNode.getFirstChild();
    let offset = 0;
    while (matching && offset + matching.getTextContentSize() < cursorOffset) {
      offset += matching.getTextContentSize();
      matching = matching.getNextSibling();
    }
    assert(
      matching === null || $isLineBreakNode(matching) || $isTextNode(matching),
    );
    let point: PointCaret<'next'>;
    if (matching === null) {
      point = $getChildCaret(codeNode, 'next');
    } else if (!$isLineBreakNode(matching)) {
      point = $getTextPointCaret(matching, 'next', cursorOffset - offset);
    } else {
      point = $getSiblingCaret(matching, 'next');
    }
    $setSelectionFromCaretRange($getCollapsedCaretRange(point));
    editor.dispatchCommand(OUTDENT_CONTENT_COMMAND);
  });

  return editor.read(() => {
    const sel = $getSelection();
    assert($isRangeSelection(sel) && sel.focus.type === 'text');
    let cursor = 0;
    let node = codeNode.getFirstChild();
    while ($isTextNode(node) || $isLineBreakNode(node)) {
      if (sel.focus.key === node.getKey()) {
        cursor += sel.focus.offset;
        break;
      }
      cursor += node.getTextContentSize();
      node = node.getNextSibling();
    }
    return {cursor, text: codeNode.getTextContent()};
  });
}

/**
 * Shared `test.for` row shape and standard test cases for the
 * OUTDENT_CONTENT_COMMAND space-stripping behavior. Used by both the
 * Shiki and Prism unit test suites.
 */
export interface OutdentScenario {
  name: string;
  rawText: string;
  cursorOffset: number;
  tabSize: number | undefined;
  expectedText: string;
  expectedCursor?: number;
}

export const OUTDENT_SCENARIOS: OutdentScenario[] = [
  {
    cursorOffset: 2,
    expectedText: 'hello',
    name: 'tabSize=2 strips two leading spaces',
    rawText: '  hello',
    tabSize: 2,
  },
  {
    cursorOffset: 4,
    expectedCursor: 2,
    expectedText: '  hello',
    name: 'tabSize=2 strips one indent level from four leading spaces',
    rawText: '    hello',
    tabSize: 2,
  },
  {
    cursorOffset: 1,
    expectedText: 'hello',
    name: 'tabSize=2 best-effort: line with one leading space is fully stripped',
    rawText: ' hello',
    tabSize: 2,
  },
  {
    cursorOffset: 4,
    expectedText: 'hello',
    name: 'tabSize=4 strips four leading spaces',
    rawText: '    hello',
    tabSize: 4,
  },
  {
    cursorOffset: 2,
    expectedText: 'hello',
    name: 'tabSize=4 best-effort: two leading spaces are fully stripped',
    rawText: '  hello',
    tabSize: 4,
  },
  {
    cursorOffset: 0,
    expectedText: 'hello',
    name: 'no-op when line has no leading whitespace',
    rawText: 'hello',
    tabSize: 2,
  },
  {
    cursorOffset: 1,
    expectedText: '  hello',
    name: 'TabNode at the start takes precedence over space stripping',
    rawText: '\t  hello',
    tabSize: 2,
  },
  {
    cursorOffset: 2,
    expectedText: '  hello',
    name: 'tabSize=undefined preserves existing TabNode-only behavior',
    rawText: '  hello',
    tabSize: undefined,
  },
  {
    cursorOffset: 4,
    expectedText: '    hello',
    name: 'tabSize=0 is rejected by the guard (non-positive)',
    rawText: '    hello',
    tabSize: 0,
  },
  {
    cursorOffset: 4,
    expectedText: '    hello',
    name: 'tabSize=2.5 is rejected by the guard (non-integer)',
    rawText: '    hello',
    tabSize: 2.5,
  },
];
