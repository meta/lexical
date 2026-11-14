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
import {$getRoot, $isElementNode, $isTabNode, $isTextNode} from 'lexical';
import {describe, expect, it} from 'vitest';

import {MarkdownTestExtension} from '../utils';

type Inline = {code: boolean; tab: boolean; text: string};

function importParagraphs(markdown: string): Inline[][] {
  using editor = buildEditorFromExtensions([MarkdownTestExtension]);
  let paragraphs: Inline[][] = [];
  editor.update(
    () => {
      $convertFromMarkdownString(markdown, TRANSFORMERS);
      paragraphs = $getRoot()
        .getChildren()
        .map(block =>
          $isElementNode(block)
            ? block.getChildren().map(child => ({
                code: $isTextNode(child) && child.hasFormat('code'),
                tab: $isTabNode(child),
                text: child.getTextContent(),
              }))
            : [],
        );
    },
    {discrete: true},
  );
  return paragraphs;
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

const code = (text: string): Inline => ({code: true, tab: false, text});
const text = (value: string): Inline => ({
  code: false,
  tab: false,
  text: value,
});
const tab: Inline = {code: false, tab: true, text: '\t'};

describe('whitespace inside inline code (#9409)', () => {
  it('keeps a tab inside a code span as part of the code', () => {
    expect(importParagraphs('`a\tb`')).toEqual([[code('a\tb')]]);
    expect(importParagraphs('a `\t` b')).toEqual([
      [text('a '), code('\t'), text(' b')],
    ]);
    expect(importParagraphs('`\t`')).toEqual([[code('\t')]]);
  });

  it('round trips a code span that holds a tab', () => {
    expect(roundTrip('`a\tb`')).toBe('`a\tb`');
    // A span that starts and ends with whitespace is padded, and a reader
    // strips that padding back to the tab.
    expect(roundTrip('`\t`')).toBe('` \t `');
    expect(roundTrip('` \t `')).toBe('` \t `');
    expect(roundTrip('a `\t` b')).toBe('a ` \t ` b');
    expect(roundTrip('a ` \t ` b')).toBe('a ` \t ` b');
  });

  it('keeps a paragraph whose only content is whitespace code', () => {
    expect(importParagraphs('x\n\n` `\n\ny')).toEqual([
      [text('x')],
      [code(' ')],
      [text('y')],
    ]);
    expect(importParagraphs('x\n\n`\t`\n\ny')).toEqual([
      [text('x')],
      [code('\t')],
      [text('y')],
    ]);
  });

  it('still turns tabs outside code into tab nodes', () => {
    expect(importParagraphs('a\tb')).toEqual([[text('a'), tab, text('b')]]);
    expect(importParagraphs('a\t`b`')).toEqual([[text('a'), tab, code('b')]]);
  });

  it('still drops empty paragraphs', () => {
    expect(importParagraphs('x\n\n\n\ny')).toEqual([[text('x')], [text('y')]]);
  });
});
