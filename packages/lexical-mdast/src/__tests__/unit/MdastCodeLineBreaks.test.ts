/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$isCodeNode} from '@lexical/code-core';
import {buildEditorFromExtensions} from '@lexical/extension';
import {$getRoot, defineExtension} from 'lexical';
import {describe, expect, it} from 'vitest';

import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  MdastCommonMarkExtension,
  MdastExtension,
} from '../../index';

const TestExtension = defineExtension({
  dependencies: [MdastCommonMarkExtension, MdastExtension],
  name: '[root]',
});

/** The code block's children as `[type, text]`, and its text content. */
function importCode(markdown: string): {
  children: [string, string][];
  exported: string;
  text: string;
} {
  using editor = buildEditorFromExtensions(TestExtension);
  editor.update(
    () => {
      $convertFromMarkdownString(markdown);
    },
    {discrete: true},
  );
  return editor.read(() => {
    const code = $getRoot().getFirstChildOrThrow();
    if (!$isCodeNode(code)) {
      throw new Error('Expected a code block');
    }
    return {
      children: code
        .getChildren()
        .map(child => [child.getType(), child.getTextContent()]),
      exported: $convertToMarkdownString(),
      text: code.getTextContent(),
    };
  });
}

describe('mdast code block line breaks on import', () => {
  it('imports a line feed as a LineBreakNode and a tab as a TabNode', () => {
    const markdown = '```js\nif (a) {\n\treturn;\n\n}\n```';
    expect(importCode(markdown)).toEqual({
      children: [
        ['text', 'if (a) {'],
        ['linebreak', '\n'],
        ['tab', '\t'],
        ['text', 'return;'],
        ['linebreak', '\n'],
        ['linebreak', '\n'],
        ['text', '}'],
      ],
      exported: markdown,
      text: 'if (a) {\n\treturn;\n\n}',
    });
  });

  it('keeps a single line as one TextNode', () => {
    expect(importCode('```js\ncode\n```').children).toEqual([['text', 'code']]);
  });

  it('gives an empty block no children', () => {
    expect(importCode('```js\n```').children).toEqual([]);
  });

  it('imports a CRLF line ending as a LineBreakNode, dropping the "\\r"', () => {
    const {children, exported} = importCode('```js\r\na\r\nb\r\n```');
    expect(children).toEqual([
      ['text', 'a'],
      ['linebreak', '\n'],
      ['text', 'b'],
    ]);
    expect(exported).toBe('```js\na\nb\n```');
  });
});
