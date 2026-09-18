/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  buildEditorFromExtensions,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
} from 'lexical';
import {assert, describe, expect, it} from 'vitest';

import {$createKeywordNode, KeywordNode} from '../../src/nodes/KeywordNode';

const KeywordThemeTestExtension = defineExtension({
  $initialEditorState: null,
  dependencies: [RichTextExtension],
  name: '[test-keyword-theme]',
  nodes: [KeywordNode],
  theme: {text: {bold: 'theme-bold', underline: 'theme-underline'}},
});

function makeEditor(): LexicalEditorWithDispose {
  const editor = buildEditorFromExtensions(KeywordThemeTestExtension);
  editor.setRootElement(document.createElement('div'));
  return editor;
}

function $appendKeyword(format: 'bold' | 'underline'): void {
  $getRoot()
    .clear()
    .append(
      $createParagraphNode().append(
        $createTextNode('hey '),
        $createKeywordNode('congrats').setFormat(format),
      ),
    );
}

function keywordClasses(editor: LexicalEditorWithDispose): string[] {
  const dom = editor.getRootElement()?.querySelector<HTMLElement>('.keyword');
  assert(dom != null, 'keyword DOM');
  return Array.from(dom.classList).sort();
}

describe('KeywordNode', () => {
  it('keeps the theme class of the text format it was created with', () => {
    using editor = makeEditor();
    editor.update(() => $appendKeyword('underline'), {discrete: true});

    expect(keywordClasses(editor)).toEqual(['keyword', 'theme-underline']);
  });

  it('keeps the theme class across a re-render of the keyword', () => {
    using editor = makeEditor();
    editor.update(() => $appendKeyword('bold'), {discrete: true});
    // Re-create the node so createDOM() runs again, which is what a paste, an
    // undo/redo across the node, or a reload does.
    editor.update(() => $appendKeyword('bold'), {discrete: true});

    expect(keywordClasses(editor)).toEqual(['keyword', 'theme-bold']);
  });
});
