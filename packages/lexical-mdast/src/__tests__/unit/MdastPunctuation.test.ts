/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {MdastPunctuationMode} from '../../index';

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  configExtension,
  defineExtension,
  type LexicalEditor,
  TEXT_TYPE_TO_FORMAT,
} from 'lexical';
import {describe, expect, it, onTestFinished} from 'vitest';

import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  MdastExtension,
  MdastGfmExtension,
} from '../../index';

const {bold, italic, strikethrough} = TEXT_TYPE_TO_FORMAT;

type Runs = [text: string, format: number][];

function createEditor(exportPunctuation?: MdastPunctuationMode): LexicalEditor {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        MdastGfmExtension,
        configExtension(MdastExtension, {exportPunctuation}),
      ],
      name: '[root]',
    }),
  );
  onTestFinished(() => editor.dispose());
  return editor;
}

function roundTrip(
  runs: Runs,
  exportPunctuation?: MdastPunctuationMode,
): [markdown: string, runs: Runs] {
  const editor = createEditor(exportPunctuation);
  editor.update(
    () =>
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append(
            ...runs.map(([text, format]) =>
              $createTextNode(text).setFormat(format),
            ),
          ),
        ),
    {discrete: true},
  );
  const markdown = editor.read('latest', () => $convertToMarkdownString());
  editor.update(() => $convertFromMarkdownString(markdown), {discrete: true});
  return [
    markdown,
    editor.read('latest', () =>
      $getRoot()
        .getAllTextNodes()
        .map(node => [node.getTextContent(), node.getFormat()]),
    ),
  ];
}

describe('Mdast punctuation modes', () => {
  // runs, export for strict readers, export for CJK-friendly readers.
  it.each<[runs: Runs, strict: string, cjkFriendly: string]>([
    [
      [
        ['你好。', bold],
        ['世界', 0],
      ],
      '**你好。**&#x4E16;界',
      '**你好。**世界',
    ],
    // Strikethrough writes references as emphasis does.
    [
      [
        ['世', 0],
        ['「x」', strikethrough],
        ['界', 0],
      ],
      '&#x4E16;~~「x」~~&#x754C;',
      '世~~「x」~~界',
    ],
    // A reference to whitespace inside a run stays.
    [
      [
        ['世', 0],
        [' a', bold],
      ],
      '&#x4E16;**&#x20;a**',
      '世**&#x20;a**',
    ],
    // `_` does not open between two letters for any reader.
    [
      [
        ['世', italic],
        ['「a」', bold],
      ],
      '*世*__「a」__',
      '*世*__「a」__',
    ],
    // Text that is not CJK keeps its references.
    [
      [
        ['a', 0],
        ['“b”', bold],
      ],
      '&#x61;**“b”**',
      '&#x61;**“b”**',
    ],
    // A reference that is not beside a marker stays.
    [[['&世', 0]], '&世', '&世'],
  ])('exports %j', (runs, strict, cjkFriendly) => {
    expect(roundTrip(runs)).toEqual([strict, runs]);
    expect(roundTrip(runs, 'strict-commonmark')).toEqual([strict, runs]);
    expect(roundTrip(runs, 'cjk-friendly')).toEqual([cjkFriendly, runs]);
  });

  it('keeps references in code and escaped ones', () => {
    const editor = createEditor('cjk-friendly');
    const markdown = '`**&#x4E16;`\n\n\\&#x4E16;**a**';
    editor.update(() => $convertFromMarkdownString(markdown), {
      discrete: true,
    });
    expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
      markdown,
    );
  });
});
