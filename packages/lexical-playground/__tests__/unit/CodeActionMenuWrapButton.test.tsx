/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createCodeHighlightNode,
  $createCodeNode,
  $isCodeNode,
  CodeExtension,
  CodeLineNumbersExtension,
} from '@lexical/code-core';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $getRoot,
  configExtension,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, assert, beforeEach, describe, expect, it} from 'vitest';

import CodeActionMenuPlugin from '../../src/plugins/CodeActionMenuPlugin';

// The first code block is unwrapped and the second is wrapped. Line numbers
// are only on wrapped blocks, as in the playground, so a toggle recreates the
// code element.
const CodeMenuTestExtension = defineExtension({
  $initialEditorState: () => {
    $getRoot()
      .clear()
      .append(
        $createCodeNode('javascript').append(
          $createCodeHighlightNode('a'),
          $createLineBreakNode(),
          $createCodeHighlightNode('b'),
        ),
        $createCodeNode('javascript')
          .setWordWrap(true)
          .append($createCodeHighlightNode('c')),
      );
  },
  dependencies: [
    RichTextExtension,
    CodeExtension,
    configExtension(CodeLineNumbersExtension, {onlyWordWrapped: true}),
  ],
  name: '[test-code-action-menu-wrap]',
  theme: {code: 'PlaygroundEditorTheme__code'},
});

describe('CodeActionMenuPlugin wrap button', () => {
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
        <LexicalExtensionComposer extension={CodeMenuTestExtension}>
          <Capture />
          <CodeActionMenuPlugin anchorElem={anchorElem} />
        </LexicalExtensionComposer>,
      );
    });
  });

  afterEach(async () => {
    await act(async () => {
      reactRoot.unmount();
    });
    container.remove();
    anchorElem.remove();
  });

  function getCodeElements(): HTMLElement[] {
    const rootElement = editor.getRootElement();
    assert(rootElement !== null);
    return Array.from(rootElement.querySelectorAll<HTMLElement>('code'));
  }

  function getWordWraps(): boolean[] {
    return editor.read(() =>
      $getRoot()
        .getChildren()
        .map(node => $isCodeNode(node) && node.getWordWrap()),
    );
  }

  function getWrapButton(): HTMLButtonElement {
    const button = anchorElem.querySelector<HTMLButtonElement>(
      'button[aria-label="wrap"]',
    );
    assert(button !== null, 'expected the menu to have a wrap button');
    return button;
  }

  async function hover(code: HTMLElement): Promise<void> {
    // The menu reads the hovered block after a 50ms debounce.
    await act(async () => {
      code.dispatchEvent(new MouseEvent('mousemove', {bubbles: true}));
      await new Promise(resolve => setTimeout(resolve, 100));
    });
  }

  async function clickWrapButton(): Promise<void> {
    await act(async () => {
      getWrapButton().click();
      // Commit the update, so the mutation listener sees it.
      editor.read(() => {});
    });
  }

  it('shows the word wrap of the hovered code block', async () => {
    const [first, second] = getCodeElements();
    await hover(first);
    expect(getWrapButton().getAttribute('aria-pressed')).toBe('false');
    await hover(second);
    expect(getWrapButton().getAttribute('aria-pressed')).toBe('true');
    await hover(first);
    expect(getWrapButton().getAttribute('aria-pressed')).toBe('false');

    // An edit in the other block, which is wrapped, leaves the button alone.
    await act(async () => {
      editor.update(
        () => {
          const code = $getRoot().getLastChildOrThrow();
          assert($isCodeNode(code));
          code.append($createCodeHighlightNode('d'));
        },
        {discrete: true},
      );
    });
    expect(getWrapButton().getAttribute('aria-pressed')).toBe('false');
  });

  it('toggles word wrap on the hovered code block', async () => {
    const [first, second] = getCodeElements();
    expect(first.hasAttribute('data-lexical-code-line-numbers')).toBe(false);
    await hover(first);

    await clickWrapButton();
    expect(getWordWraps()).toEqual([true, true]);
    const [wrapped] = getCodeElements();
    expect(wrapped).not.toBe(first);
    expect(wrapped.getAttribute('data-lexical-code-word-wrap')).toBe('true');
    expect(wrapped.hasAttribute('data-lexical-code-line-numbers')).toBe(true);
    expect(getWrapButton().getAttribute('aria-pressed')).toBe('true');

    // No hover in between, so the menu still holds the code element that
    // was replaced.
    await clickWrapButton();
    expect(getWordWraps()).toEqual([false, true]);
    expect(
      getCodeElements()[0].hasAttribute('data-lexical-code-word-wrap'),
    ).toBe(false);
    expect(getWrapButton().getAttribute('aria-pressed')).toBe('false');
    expect(getCodeElements()[1]).toBe(second);
  });

  it('follows changes to the hovered code block', async () => {
    const [first] = getCodeElements();
    await hover(first);
    const label = anchorElem.querySelector('.code-highlight-language');
    assert(label !== null, 'expected the menu to show the language');
    expect(label.textContent).toBe('JavaScript');

    await act(async () => {
      editor.update(
        () => {
          const code = $getRoot().getFirstChildOrThrow();
          assert($isCodeNode(code));
          code.setLanguage('python').setWordWrap(true);
        },
        {discrete: true},
      );
    });
    expect(label.textContent).toBe('Python');
    expect(getWrapButton().getAttribute('aria-pressed')).toBe('true');
  });

  it('hides the menu when the hovered code block is removed', async () => {
    const [first] = getCodeElements();
    await hover(first);
    getWrapButton();

    await act(async () => {
      editor.update(() => $getRoot().getFirstChildOrThrow().remove(), {
        discrete: true,
      });
    });
    expect(anchorElem.querySelector('button[aria-label="wrap"]')).toBeNull();
    expect(getWordWraps()).toEqual([true]);
  });
});
