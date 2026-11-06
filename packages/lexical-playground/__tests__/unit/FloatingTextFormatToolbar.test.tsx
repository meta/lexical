/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {RovingTabIndexExtension} from '@lexical/a11y';
import {$createLinkNode, LinkExtension} from '@lexical/link';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $selectAll,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import FloatingTextFormatToolbarPlugin from '../../src/plugins/FloatingTextFormatToolbarPlugin';

const ToolbarTestExtension = defineExtension({
  $initialEditorState: () => {
    $getRoot()
      .clear()
      .append($createParagraphNode().append($createTextNode('hello')));
  },
  dependencies: [RichTextExtension, RovingTabIndexExtension, LinkExtension],
  name: '[test-floating-toolbar]',
});

describe('FloatingTextFormatToolbarPlugin', () => {
  let container: HTMLDivElement;
  let anchorElem: HTMLDivElement;
  let reactRoot: Root;
  let editor: LexicalEditor;

  function Capture() {
    const [contextEditor] = useLexicalComposerContext();
    editor = contextEditor;
    return null;
  }

  beforeEach(async () => {
    container = document.createElement('div');
    anchorElem = document.createElement('div');
    document.body.append(container, anchorElem);
    reactRoot = createRoot(container);

    await act(async () => {
      reactRoot.render(
        <LexicalExtensionComposer extension={ToolbarTestExtension}>
          <Capture />
          <FloatingTextFormatToolbarPlugin
            anchorElem={anchorElem}
            setIsLinkEditMode={vi.fn()}
          />
        </LexicalExtensionComposer>,
      );
    });

    // The popup only opens for a non-collapsed selection whose DOM anchor is
    // inside the root element, so set both.
    await act(async () => {
      editor.update(() => void $selectAll(), {discrete: true});
      const textDOM = editor.getRootElement()!.querySelector('p')!.firstChild!
        .firstChild!;
      document
        .getSelection()!
        .setBaseAndExtent(textDOM, 0, textDOM, 'hello'.length);
      document.dispatchEvent(new Event('selectionchange'));
    });
  });

  afterEach(async () => {
    await act(async () => {
      reactRoot.unmount();
    });
    container.remove();
    anchorElem.remove();
  });

  function formatButtonCount(): number {
    return anchorElem.querySelectorAll(
      '.floating-text-format-popup button[aria-label^="Format text"]',
    ).length;
  }

  it('hides the text toolbar when an entire linked paragraph is selected', async () => {
    await act(async () => {
      editor.update(
        () => {
          const paragraph = $getRoot().getFirstChildOrThrow();
          if (!$isElementNode(paragraph)) {
            throw new Error('Expected paragraph');
          }
          paragraph
            .clear()
            .append(
              $createLinkNode('https://lexical.dev').append(
                $createTextNode('hello'),
              ),
            );
          paragraph.select(0, 1);
        },
        {discrete: true},
      );
    });
    expect(anchorElem.querySelector('.floating-text-format-popup')).toBe(null);
  });

  it('hides its format buttons when the editor becomes read-only', async () => {
    expect(anchorElem.querySelector('.floating-text-format-popup')).not.toBe(
      null,
    );
    expect(formatButtonCount()).toBeGreaterThan(0);

    await act(async () => {
      editor.setEditable(false);
    });
    expect(formatButtonCount()).toBe(0);

    await act(async () => {
      editor.setEditable(true);
    });
    expect(formatButtonCount()).toBeGreaterThan(0);
  });
});
