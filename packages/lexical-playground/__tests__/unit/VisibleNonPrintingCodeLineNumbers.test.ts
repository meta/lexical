/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createCodeHighlightNode,
  $createCodeNode,
  $isCodeNode,
  CodeLineNumbersExtension,
} from '@lexical/code-core';
import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {ListExtension} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {afterEach, assert, describe, expect, test} from 'vitest';

import {VisibleNonPrintingExtension} from '../../src/plugins/VisibleNonPrintingExtension';

const CODE_LINE_BREAK_ATTR = 'data-lexical-code-line-break';
const VISIBLE_LINE_BREAK_ATTR = 'data-lexical-visible-non-printing-linebreak';

const mountedRoots: HTMLElement[] = [];
afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    root.remove();
  }
});

function createEditor(): LexicalEditorWithDispose {
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('p'),
              $createLineBreakNode(),
              $createTextNode('q'),
            ),
            $createCodeNode('javascript').append(
              $createCodeHighlightNode('a'),
              $createLineBreakNode(),
              $createCodeHighlightNode('b'),
            ),
          );
      },
      dependencies: [
        RichTextExtension,
        ListExtension,
        CodeLineNumbersExtension,
        VisibleNonPrintingExtension,
      ],
      name: '[visible-non-printing-code-line-numbers]',
    }),
  );
  const root = document.createElement('div');
  document.body.appendChild(root);
  mountedRoots.push(root);
  editor.setRootElement(root);
  return editor;
}

/**
 * Every LineBreakNode renders as exactly one wrapper around its <br>: the
 * line number wrapper inside a code block and the visible line break wrapper
 * everywhere else. Returns how many line breaks are in each.
 */
function expectOneWrapperEach(editor: LexicalEditor): {
  inCode: number;
  outside: number;
} {
  const counts = {inCode: 0, outside: 0};
  editor.read(() => {
    for (const block of $getRoot().getChildren()) {
      assert($isElementNode(block));
      const isCode = $isCodeNode(block);
      for (const child of block.getChildren()) {
        if (!$isLineBreakNode(child)) {
          continue;
        }
        const dom = editor.getElementByKey(child.getKey());
        assert(dom !== null, 'expected every line break to be rendered');
        expect(dom.parentElement).toBe(editor.getElementByKey(block.getKey()));
        expect(dom.tagName).toBe('SPAN');
        expect(dom.childNodes).toHaveLength(1);
        expect(dom.firstChild?.nodeName).toBe('BR');
        expect(dom.hasAttribute(CODE_LINE_BREAK_ATTR)).toBe(isCode);
        expect(dom.hasAttribute(VISIBLE_LINE_BREAK_ATTR)).toBe(!isCode);
        counts[isCode ? 'inCode' : 'outside']++;
      }
    }
  });
  const root = editor.getRootElement();
  assert(root !== null);
  expect(root.querySelectorAll(`[${CODE_LINE_BREAK_ATTR}]`)).toHaveLength(
    counts.inCode,
  );
  expect(root.querySelectorAll(`[${VISIBLE_LINE_BREAK_ATTR}]`)).toHaveLength(
    counts.outside,
  );
  return counts;
}

describe('VisibleNonPrintingExtension with CodeLineNumbersExtension', () => {
  test('wraps each line break once, by its parent', () => {
    using editor = createEditor();
    expect(expectOneWrapperEach(editor)).toEqual({inCode: 1, outside: 1});
  });

  test('a code line break is bare while line numbers are off', () => {
    using editor = createEditor();
    const {disabled} = getExtensionDependencyFromEditor(
      editor,
      CodeLineNumbersExtension,
    ).output;
    disabled.value = true;
    const codeLineBreak = editor.read(() => {
      const code = $getRoot().getLastChildOrThrow();
      assert($isCodeNode(code));
      const lineBreak = code.getChildren().find($isLineBreakNode);
      assert(lineBreak !== undefined);
      return editor.getElementByKey(lineBreak.getKey());
    });
    expect(codeLineBreak?.nodeName).toBe('BR');
    expect(codeLineBreak?.parentElement?.nodeName).toBe('CODE');
    disabled.value = false;
    expect(expectOneWrapperEach(editor)).toEqual({inCode: 1, outside: 1});
  });

  test('swaps wrappers when a code block collapses into a paragraph', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const code = $getRoot().getLastChildOrThrow();
        assert($isCodeNode(code));
        code.collapseAtStart();
      },
      {discrete: true},
    );
    expect(expectOneWrapperEach(editor)).toEqual({inCode: 0, outside: 2});
  });
});
