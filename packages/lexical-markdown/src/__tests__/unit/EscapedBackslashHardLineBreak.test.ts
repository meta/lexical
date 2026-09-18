/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {$convertFromMarkdownString, TRANSFORMERS} from '@lexical/markdown';
import {$getRoot} from 'lexical';
import {describe, expect, it} from 'vitest';

import {
  normalizeMarkdown,
  parseMarkdownHardLineBreak,
} from '../../MarkdownTransformers';
import {MarkdownTestExtension} from '../utils';

// Single-quoted TS strings: '\\' is one literal backslash.
const ONE = 'foo\\';
const TWO = 'foo\\\\';
const THREE = 'foo\\\\\\';

function importText(markdown: string): string {
  using editor = buildEditorFromExtensions([MarkdownTestExtension]);
  let text = '';
  editor.update(
    () => {
      $convertFromMarkdownString(
        markdown,
        TRANSFORMERS,
        undefined,
        false,
        true,
      );
      text = $getRoot().getTextContent();
    },
    {discrete: true},
  );
  return text;
}

describe('escaped backslash at end of line', () => {
  it('treats a lone trailing backslash as a hard line break', () => {
    expect(parseMarkdownHardLineBreak(ONE)).toEqual(['foo', '\\']);
  });

  it('does not treat an escaped backslash as a hard line break', () => {
    expect(parseMarkdownHardLineBreak(TWO)).toBe(null);
  });

  it('treats an odd run of backslashes as a hard line break', () => {
    expect(parseMarkdownHardLineBreak(THREE)).toEqual(['foo\\\\', '\\']);
  });

  it('still recognises the two-space hard line break', () => {
    expect(parseMarkdownHardLineBreak('foo  ')).toEqual(['foo', '  ']);
  });

  it('merges a line ending in an escaped backslash with the next line', () => {
    expect(normalizeMarkdown(TWO + '\nbar', true)).toBe(TWO + ' bar');
  });

  it('keeps a real hard line break unmerged', () => {
    expect(normalizeMarkdown(ONE + '\nbar', true)).toBe(ONE + '\nbar');
  });

  it('keeps the literal backslash in the imported text', () => {
    // `foo\\` is an escaped backslash, so the paragraph text is `foo\ bar`.
    expect(importText(TWO + '\nbar')).toBe('foo\\ bar');
  });
});
