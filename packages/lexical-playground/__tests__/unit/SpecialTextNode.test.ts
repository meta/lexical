/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createParagraphNode,
  $getRoot,
  $isTextNode,
  isHTMLElement,
  type LexicalEditor,
} from 'lexical';
import {assert, describe, expect, it} from 'vitest';

import {
  $createSpecialTextNode,
  SpecialTextNode,
} from '../../src/nodes/SpecialTextNode';

function buildEditor() {
  return buildEditorFromExtensions({
    afterRegistration: editor => {
      editor.setRootElement(document.createElement('div'));
      return () => editor.setRootElement(null);
    },
    name: 'test',
    nodes: [SpecialTextNode],
    theme: {specialText: 'PlaygroundSpecialText'},
  });
}

describe('SpecialTextNode', () => {
  function $appendSpecialText(text: string): void {
    $getRoot()
      .clear()
      .append($createParagraphNode().append($createSpecialTextNode(text)));
  }

  function $getSpecialText(): SpecialTextNode {
    const node = $getRoot().getLastDescendant();
    assert(
      $isTextNode(node) && node instanceof SpecialTextNode,
      'SpecialTextNode',
    );
    return node;
  }

  function getRenderedText(editor: LexicalEditor): string {
    const rootElement = editor.getRootElement();
    assert(isHTMLElement(rootElement), 'editor must have a rootElement');
    const dom = rootElement.querySelector('.PlaygroundSpecialText');
    assert(
      isHTMLElement(dom),
      'rootElement must have a .PlaygroundSpecialText descendant',
    );
    return dom.textContent;
  }

  it('re-renders the text when it changes', () => {
    using editor = buildEditor();
    editor.update(() => $appendSpecialText('foo'), {discrete: true});
    expect(getRenderedText(editor)).toBe('foo');

    editor.update(() => void $getSpecialText().setTextContent('bar'), {
      discrete: true,
    });
    expect(getRenderedText(editor)).toBe('bar');
  });

  it('renders the text verbatim when it is bracketed', () => {
    using editor = buildEditor();
    editor.update(() => $appendSpecialText('[foo]'), {
      discrete: true,
    });
    expect(getRenderedText(editor)).toBe('[foo]');

    editor.update(() => void $getSpecialText().setTextContent('[bar]'), {
      discrete: true,
    });
    expect(getRenderedText(editor)).toBe('[bar]');
  });
});
