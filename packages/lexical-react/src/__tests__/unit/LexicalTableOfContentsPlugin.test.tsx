/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {
  type TableOfContentsEntry,
  TableOfContentsPlugin,
} from '@lexical/react/LexicalTableOfContentsPlugin';
import {$createHeadingNode, RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $getDocument,
  $getEditor,
  $getRoot,
  defineExtension,
  ElementNode,
  type LexicalEditor,
  TextNode,
} from 'lexical';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, assert, beforeEach, describe, expect, test} from 'vitest';

// getTextContent can depend on the editor, e.g. to read an extension's config
// (https://github.com/meta/lexical/issues/9934).
class EditorReadingTextNode extends TextNode {
  $config() {
    return this.config('editor-reading-text', {extends: TextNode});
  }

  getTextContent(): string {
    $getEditor();
    return super.getTextContent();
  }
}

// A block container, so that a heading is inside a dirty top-level element.
class SectionNode extends ElementNode {
  $config() {
    return this.config('section', {extends: ElementNode});
  }

  createDOM(): HTMLElement {
    return $getDocument().createElement('section');
  }

  updateDOM(): boolean {
    return false;
  }
}

const TestExtension = defineExtension({
  dependencies: [RichTextExtension],
  name: 'TableOfContentsTest',
  nodes: [EditorReadingTextNode, SectionNode],
});

describe('TableOfContentsPlugin', () => {
  let container: HTMLDivElement;
  let reactRoot: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    reactRoot = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      reactRoot.unmount();
    });
    container.remove();
  });

  function renderPlugin() {
    let editor: LexicalEditor | undefined;
    const renders: TableOfContentsEntry[][] = [];

    function CaptureEditor() {
      [editor] = useLexicalComposerContext();
      return null;
    }

    act(() => {
      reactRoot.render(
        <LexicalExtensionComposer extension={TestExtension}>
          <CaptureEditor />
          <TableOfContentsPlugin>
            {tableOfContents => {
              renders.push(tableOfContents);
              return <></>;
            }}
          </TableOfContentsPlugin>
        </LexicalExtensionComposer>,
      );
    });
    assert(editor !== undefined);
    return {editor, renders};
  }

  test('reads headings of an update with the active editor', () => {
    const {editor: activeEditor, renders} = renderPlugin();

    act(() => {
      activeEditor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $create(SectionNode).append(
                $createHeadingNode('h1').append(
                  $create(EditorReadingTextNode).setTextContent('Title'),
                ),
              ),
            );
        },
        {discrete: true},
      );
    });
    expect(renders.at(-1)?.map(([, text, tag]) => [text, tag])).toEqual([
      ['Title', 'h1'],
    ]);
  });
});
