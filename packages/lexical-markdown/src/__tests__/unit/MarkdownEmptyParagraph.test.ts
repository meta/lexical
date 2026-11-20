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
} from '@lexical/markdown';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type LexicalNode,
  TEXT_TYPE_TO_FORMAT,
} from 'lexical';
import {describe, expect, it} from 'vitest';

import {MarkdownTestExtension} from '../utils';

function exportBlocks($blocks: () => LexicalNode[]): string {
  using editor = buildEditorFromExtensions([MarkdownTestExtension]);
  editor.update(
    () =>
      $getRoot()
        .clear()
        .append(...$blocks()),
    {discrete: true},
  );
  return editor.read(() => $convertToMarkdownString());
}

function importBlockCount(markdown: string): number {
  using editor = buildEditorFromExtensions([MarkdownTestExtension]);
  editor.update(() => $convertFromMarkdownString(markdown), {discrete: true});
  return editor.read(() => $getRoot().getChildrenSize());
}

const $paragraph = (...texts: string[]) =>
  $createParagraphNode().append(...texts.map(text => $createTextNode(text)));

describe('Markdown export of empty paragraphs', () => {
  it('writes an empty paragraph between paragraphs as their blank line', () => {
    expect(
      exportBlocks(() => [$paragraph('a'), $paragraph(), $paragraph('b')]),
    ).toBe(exportBlocks(() => [$paragraph('a'), $paragraph('b')]));
  });

  it('keeps a paragraph of whitespace and formatted text apart', () => {
    const markdown = exportBlocks(() => [
      $paragraph('a'),
      $createParagraphNode().append(
        $createTextNode(' '),
        $createTextNode('x').setFormat(TEXT_TYPE_TO_FORMAT.bold),
      ),
      $paragraph('b'),
    ]);
    expect(importBlockCount(markdown)).toBe(3);
  });
});
