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

function importCodeBlock(markdown: string): {
  language: string | null | undefined;
  text: string | null;
} {
  using editor = buildEditorFromExtensions([MarkdownTestExtension]);
  let result: {language: string | null | undefined; text: string | null} = {
    language: undefined,
    text: null,
  };
  editor.update(
    () => {
      $convertFromMarkdownString(markdown, TRANSFORMERS);
      const first = $getRoot().getFirstChild();
      result = $isCodeNode(first)
        ? {language: first.getLanguage(), text: first.getTextContent()}
        : {language: undefined, text: null};
    },
    {discrete: true},
  );
  return result;
}

describe('fenced code block info string', () => {
  it('does not put a title attribute into the code content', () => {
    expect(importCodeBlock('```js title="x"\ncode\n```')).toEqual({
      language: 'js',
      text: 'code',
    });
  });

  it('does not put a line-highlight range into the code content', () => {
    expect(importCodeBlock('```ts {1,3}\ncode\n```')).toEqual({
      language: 'ts',
      text: 'code',
    });
  });

  it('does not put a bare info-string word into the code content', () => {
    expect(importCodeBlock('```js showLineNumbers\na\nb\n```')).toEqual({
      language: 'js',
      text: 'a\nb',
    });
  });

  it('keeps content that follows a fence with no language', () => {
    expect(importCodeBlock('``` code\nmore\n```')).toEqual({
      language: undefined,
      text: 'code\nmore',
    });
  });

  it('leaves a plain language fence unchanged', () => {
    expect(importCodeBlock('```javascript\nCode\n```')).toEqual({
      language: 'javascript',
      text: 'Code',
    });
  });

  it('round trips the info string of a closed fence', () => {
    expect(roundTrip('```js title="x"\ncode\n```')).toBe(
      '```js title="x"\ncode\n```',
    );
    expect(roundTrip('```ts {1,3}\ncode\n```')).toBe('```ts {1,3}\ncode\n```');
    expect(roundTrip('```js showLineNumbers\na\nb\n```')).toBe(
      '```js showLineNumbers\na\nb\n```',
    );
  });

  it('adds nothing to a fence that has no info string tail', () => {
    expect(roundTrip('```js\ncode\n```')).toBe('```js\ncode\n```');
    expect(roundTrip('```\ncode\n```')).toBe('```\ncode\n```');
  });

  it('leaves an unterminated fence unchanged', () => {
    expect(importCodeBlock('```javascript Incomplete tag')).toEqual({
      language: 'javascript',
      text: 'Incomplete tag',
    });
  });
});
