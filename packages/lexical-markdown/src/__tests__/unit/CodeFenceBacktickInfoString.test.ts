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
import {$createParagraphNode, $createTextNode, $getRoot} from 'lexical';
import {describe, expect, it} from 'vitest';

import {normalizeMarkdown} from '../../MarkdownTransformers';
import {MarkdownTestExtension} from '../utils';

function importBlocks(markdown: string): string[] {
  using editor = buildEditorFromExtensions([MarkdownTestExtension]);
  let blocks: string[] = [];
  editor.update(
    () => {
      $convertFromMarkdownString(markdown, TRANSFORMERS);
      blocks = $getRoot()
        .getChildren()
        .map(
          block =>
            ($isCodeNode(block) ? 'code: ' : 'paragraph: ') +
            block.getTextContent(),
        );
    },
    {discrete: true},
  );
  return blocks;
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

// Exports a paragraph that starts with inline code, then imports the result.
function exportAndImportInlineCode(code: string, after: string): string[] {
  using editor = buildEditorFromExtensions([MarkdownTestExtension]);
  let markdown = '';
  editor.update(
    () => {
      const paragraph = $createParagraphNode().append(
        $createTextNode(code).toggleFormat('code'),
      );
      if (after) {
        paragraph.append($createTextNode(after));
      }
      $getRoot().clear().append(paragraph);
      markdown = $convertToMarkdownString(TRANSFORMERS);
    },
    {discrete: true},
  );
  return importBlocks(markdown);
}

// The info string of a backtick fence cannot contain a backtick, so such a
// line is not a fence. https://spec.commonmark.org/0.31.2/#fenced-code-blocks
describe('a line that starts with backticks and has more later (#9404)', () => {
  it('reads it as a paragraph that starts with a code span', () => {
    expect(importBlocks('``` a``b ``` x')).toEqual(['paragraph: a``b x']);
    expect(importBlocks('``` a``b ```')).toEqual(['paragraph: a``b']);
    expect(importBlocks('```` ``` ```` x\n\nnext')).toEqual([
      'paragraph: ``` x',
      'paragraph: next',
    ]);
  });

  it("re-imports the editor's own export of inline code", () => {
    expect(exportAndImportInlineCode('a``b', ' x')).toEqual([
      'paragraph: a``b x',
    ]);
    expect(exportAndImportInlineCode('```', ' x')).toEqual([
      'paragraph: ``` x',
    ]);
    expect(exportAndImportInlineCode('a``b', '')).toEqual(['paragraph: a``b']);
  });

  it('round trips such a line unchanged', () => {
    expect(roundTrip('``` a``b ``` x')).toBe('``` a``b ``` x');
    expect(roundTrip('```` ``` ```` x\n\nnext')).toBe(
      '```` ``` ```` x\n\nnext',
    );
  });

  it('does not take a shorter closing run as the end of a single-line block', () => {
    expect(importBlocks('````a```')).toEqual(['paragraph: ````a```']);
  });

  it('does not stop merging the lines that follow', () => {
    expect(normalizeMarkdown('```` ``` ```` x\nnext', true)).toBe(
      '```` ``` ```` x next',
    );
  });

  it('still imports fences whose info string has no backtick', () => {
    expect(importBlocks('```Single line Code```')).toEqual([
      'code: Single line Code',
    ]);
    expect(importBlocks('```a```')).toEqual(['code: a']);
    expect(importBlocks('```js\ncode\n```')).toEqual(['code: code']);
    expect(importBlocks('```js title="x"\ncode\n```')).toEqual(['code: code']);
    expect(importBlocks('````\n```\nin\n```\n````')).toEqual([
      'code: ```\nin\n```',
    ]);
    expect(importBlocks('```javascript\nIncomplete')).toEqual([
      'code: Incomplete',
    ]);
  });
});
