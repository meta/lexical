/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  TRANSFORMERS,
} from '@lexical/markdown';
import {
  $getRoot,
  $getState,
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  type LexicalNode,
} from 'lexical';
import {describe, expect, it} from 'vitest';

import {hardLineBreakState} from '../../MarkdownTransformers';
import {MarkdownTestExtension} from '../utils';

// Describes the inline content of the first block: text as it is, code as
// `code(...)`, and each line break as `<soft>` or `<hard \>` / `<hard   >`.
function $describeNode(node: LexicalNode): string {
  if ($isLineBreakNode(node)) {
    const marker = $getState(node, hardLineBreakState);
    return marker ? `<hard ${marker}>` : '<soft>';
  }
  if ($isTextNode(node)) {
    const text = node.getTextContent();
    return node.hasFormat('code') ? `code(${text})` : text;
  }
  if ($isElementNode(node)) {
    return node.getChildren().map($describeNode).join('');
  }
  return node.getTextContent();
}

function importFirstBlock(markdown: string): string {
  using editor = buildEditorFromExtensions([MarkdownTestExtension]);
  let result = '';
  editor.update(
    () => {
      $convertFromMarkdownString(markdown, TRANSFORMERS);
      const first = $getRoot().getFirstChild();
      result = first ? $describeNode(first) : '';
    },
    {discrete: true},
  );
  return result;
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

// In single-quoted TS strings, '\\' is one backslash.
// https://spec.commonmark.org/0.31.2/#hard-line-breaks
describe('hard line breaks are read from the Markdown (#9408)', () => {
  it('reads an escaped backslash at the end of a line as a literal backslash', () => {
    expect(importFirstBlock('a\\\\\nb')).toBe('a\\<soft>b');
    expect(importFirstBlock('_a\\\\_\nb')).toBe('a\\<soft>b');
    expect(importFirstBlock('**a\\\\**\nb')).toBe('a\\<soft>b');
    expect(importFirstBlock('> a\\\\\n> b')).toBe('a\\<soft>b');
    // The continuation line keeps its indent, as it already did.
    expect(importFirstBlock('- a\\\\\n  b')).toBe('a\\<soft>  b');
  });

  it('reads an escaped backslash followed by a hard break', () => {
    expect(importFirstBlock('a\\\\\\\nb')).toBe('a\\<hard \\>b');
  });

  it('keeps backslashes and spaces at the end of inline code', () => {
    expect(importFirstBlock('`a\\`\nb')).toBe('code(a\\)<soft>b');
    expect(importFirstBlock('`a  `\nb')).toBe('code(a  )<soft>b');
  });

  it('round trips these lines unchanged', () => {
    for (const markdown of [
      'a\\\\\nb',
      'a\\\\\\\nb',
      '`a\\`\nb',
      '`a  `\nb',
      '**a\\\\**\nb',
      '> a\\\\\n> b',
      '- a\\\\\n  b',
    ]) {
      expect(roundTrip(markdown)).toBe(markdown);
    }
    // Italic is exported with `*`.
    expect(roundTrip('_a\\\\_\nb')).toBe('*a\\\\*\nb');
  });

  it('still reads real hard breaks', () => {
    expect(importFirstBlock('a\\\nb')).toBe('a<hard \\>b');
    expect(importFirstBlock('a  \nb')).toBe('a<hard   >b');
    expect(importFirstBlock('a\\\\\\\\\nb')).toBe('a\\\\<soft>b');
    expect(importFirstBlock('**a**\\\nb')).toBe('a<hard \\>b');
    expect(importFirstBlock('> a\\\n> b')).toBe('a<hard \\>b');
    expect(importFirstBlock('a\\\nb\\\nc')).toBe('a<hard \\>b<hard \\>c');
    expect(importFirstBlock('[a](https://lexical.dev)\\\nc')).toBe(
      'a<hard \\>c',
    );
    for (const markdown of ['a\\\nb', 'a  \nb', 'a\\\\\\\\\nb', '**a**\\\nb']) {
      expect(roundTrip(markdown)).toBe(markdown);
    }
  });

  it('keeps a backslash at the end of a block as text', () => {
    expect(importFirstBlock('a\\')).toBe('a\\');
    expect(importFirstBlock('# h\\')).toBe('h\\');
  });
});
