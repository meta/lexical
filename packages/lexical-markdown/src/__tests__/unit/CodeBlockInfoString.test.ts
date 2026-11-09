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
  CODE,
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

  it('reads a language that follows whitespace after the fence', () => {
    expect(importCodeBlock('``` js\ncode\n```')).toEqual({
      language: 'js',
      text: 'code',
    });
    expect(importCodeBlock('``` code\nmore\n```')).toEqual({
      language: 'code',
      text: 'more',
    });
  });

  it('keeps the metadata of a fence with whitespace before the language', () => {
    expect(importCodeBlock('``` js title=x\ncode\n```')).toEqual({
      language: 'js',
      text: 'code',
    });
    expect(roundTrip('``` js title=x\ncode\n```')).toBe(
      '```js title=x\ncode\n```',
    );
  });

  it('keeps content that follows a fence with no language', () => {
    expect(importCodeBlock('``` {1,3}\nmore\n```')).toEqual({
      language: undefined,
      text: '{1,3}\nmore',
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

  it('reads the info string of an unterminated fence', () => {
    expect(importCodeBlock('```javascript Incomplete tag')).toEqual({
      language: 'javascript',
      text: '',
    });
    expect(importCodeBlock('```js title=x\ncode')).toEqual({
      language: 'js',
      text: 'code',
    });
    expect(roundTrip('```js title=x\ncode')).toBe('```js title=x\ncode\n```');
  });

  it('keeps the match of a regExpStart composed from CODE', () => {
    const CPP_CODE = {
      ...CODE,
      regExpStart: /^([ \t]*`{3,})([\w+#.-]+)?[ \t]?/,
    };
    const transformers = [
      CPP_CODE,
      ...TRANSFORMERS.filter(transformer => transformer !== CODE),
    ];
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    editor.update(
      () => {
        $convertFromMarkdownString('```c++\ncode\n```', transformers);
      },
      {discrete: true},
    );
    expect(
      editor.read(() => {
        const first = $getRoot().getFirstChild();
        return $isCodeNode(first)
          ? {language: first.getLanguage(), text: first.getTextContent()}
          : null;
      }),
    ).toEqual({language: 'c++', text: 'code'});
    expect(editor.read(() => $convertToMarkdownString(transformers))).toBe(
      '```c++\ncode\n```',
    );
  });

  it('keeps a fence-like line whose info string has a backtick as content', () => {
    // A backtick fence's info string can't contain backticks. Export writes
    // this line for a paragraph that starts with inline code holding ``.
    expect(importCodeBlock('``` a``b ``` tail')).toEqual({
      language: undefined,
      text: 'a``b ``` tail',
    });
  });

  it('reads the language of an unterminated fence after whitespace', () => {
    expect(importCodeBlock('``` js\ncode')).toEqual({
      language: 'js',
      text: 'code',
    });
  });
});
