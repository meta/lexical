/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

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

function importCodeText(markdown: string): string | null {
  using editor = buildEditorFromExtensions([MarkdownTestExtension]);
  let text: string | null = null;
  editor.update(
    () => {
      $convertFromMarkdownString(markdown, TRANSFORMERS);
      const first = $getRoot().getFirstChild();
      text = $isCodeNode(first) ? first.getTextContent() : null;
    },
    {discrete: true},
  );
  return text;
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

describe('code block leading blank lines', () => {
  it('keeps a blank first line of a fenced code block', () => {
    expect(importCodeText('```js\n\ncode\n```')).toBe('\ncode');
  });

  it('keeps several blank first lines', () => {
    expect(importCodeText('```js\n\n\na\nb\n```')).toBe('\n\na\nb');
  });

  it('round trips a code block that starts with a blank line', () => {
    const markdown = '```js\n\ncode\n```';
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('still drops nothing from a code block without leading blank lines', () => {
    expect(importCodeText('```js\ncode\n```')).toBe('code');
    expect(roundTrip('```js\ncode\n```')).toBe('```js\ncode\n```');
  });

  it('still treats text after the opening fence as content', () => {
    expect(importCodeText('``` code\nmore\n```')).toBe('code\nmore');
    expect(importCodeText('```javascript Incomplete tag')).toBe(
      'Incomplete tag',
    );
  });
});
