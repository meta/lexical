/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$isCodeNode} from '@lexical/code-core';
import {buildEditorFromExtensions} from '@lexical/extension';
import {$convertFromMarkdownString, TRANSFORMERS} from '@lexical/markdown';
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

describe('indented code fences', () => {
  it('removes the fence indentation from the content', () => {
    expect(importCodeText('  ```js\n  code\n  ```')).toBe('code');
  });

  it('preserves indentation relative to the fence', () => {
    expect(importCodeText('   ```\n   a\n     b\n   ```')).toBe('a\n  b');
  });

  it('removes at most the fence indentation', () => {
    expect(importCodeText('  ```\ncode\n  ```')).toBe('code');
    expect(importCodeText('  ```\n a\n  b\n  ```')).toBe('a\nb');
  });

  it('handles a tab-indented fence', () => {
    expect(importCodeText('\t```\n\tcode\n\t```')).toBe('code');
  });

  it('keeps content indentation when the fence is not indented', () => {
    expect(importCodeText('```js\n  code\n```')).toBe('  code');
    expect(importCodeText('```js\ncode\n```')).toBe('code');
  });
});
