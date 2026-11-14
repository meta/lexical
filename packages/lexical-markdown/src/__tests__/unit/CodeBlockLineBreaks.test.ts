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
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  TRANSFORMERS,
} from '@lexical/markdown';
import {$getRoot} from 'lexical';
import {describe, expect, it} from 'vitest';

import {MarkdownTestExtension} from '../utils';

/** The code block's children as `[type, text]`, and its text content. */
function importCode(markdown: string): {
  children: [string, string][];
  text: string;
} {
  using editor = buildEditorFromExtensions([MarkdownTestExtension]);
  editor.update(
    () => {
      $convertFromMarkdownString(markdown, TRANSFORMERS);
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
      text: code.getTextContent(),
    };
  });
}

function roundTrip(markdown: string): string {
  using editor = buildEditorFromExtensions([MarkdownTestExtension]);
  editor.update(
    () => {
      $convertFromMarkdownString(markdown, TRANSFORMERS);
    },
    {discrete: true},
  );
  return editor.read(() => $convertToMarkdownString(TRANSFORMERS));
}

describe('code block line breaks on import', () => {
  it('imports a line feed as a LineBreakNode, not as text', () => {
    expect(importCode('```js\nconst a = 1;\n\nconst b = 2;\n```')).toEqual({
      children: [
        ['text', 'const a = 1;'],
        ['linebreak', '\n'],
        ['linebreak', '\n'],
        ['text', 'const b = 2;'],
      ],
      text: 'const a = 1;\n\nconst b = 2;',
    });
  });

  it('imports a tab as a TabNode', () => {
    expect(importCode('```\nif (a) {\n\treturn;\n}\n```')).toEqual({
      children: [
        ['text', 'if (a) {'],
        ['linebreak', '\n'],
        ['tab', '\t'],
        ['text', 'return;'],
        ['linebreak', '\n'],
        ['text', '}'],
      ],
      text: 'if (a) {\n\treturn;\n}',
    });
  });

  it('imports an unclosed fence the same way', () => {
    expect(importCode('```js\na\nb').children).toEqual([
      ['text', 'a'],
      ['linebreak', '\n'],
      ['text', 'b'],
    ]);
  });

  it('keeps a single line as one TextNode', () => {
    expect(importCode('```js\ncode\n```').children).toEqual([['text', 'code']]);
  });

  it('gives an empty block no children', () => {
    expect(importCode('```js\n```')).toEqual({children: [], text: ''});
  });

  it('exports the same Markdown as before', () => {
    for (const markdown of [
      '```js\nconst a = 1;\n\nconst b = 2;\n```',
      '```\nif (a) {\n\treturn;\n}\n```',
      '```js\n\ncode\n```',
    ]) {
      expect(roundTrip(markdown)).toBe(markdown);
    }
  });

  it('imports a CRLF line ending as a LineBreakNode, dropping its "\\r"; the last line keeps its own, as before', () => {
    // @lexical/markdown splits its input on a line feed only: each line but
    // the block's last joins the next with its carriage return, as one CRLF.
    expect(importCode('```js\r\na\r\nb\r\n```').children).toEqual([
      ['text', 'a'],
      ['linebreak', '\n'],
      ['text', 'b\r'],
    ]);
  });
});
