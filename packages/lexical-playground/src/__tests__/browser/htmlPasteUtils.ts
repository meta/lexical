/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import '../../themes/PlaygroundEditorTheme.css';

import {HorizontalRuleExtension} from '@lexical/extension';
import {LinkExtension} from '@lexical/link';
import {CheckListExtension, ListExtension} from '@lexical/list';
import {registerMarkdownShortcuts, UNORDERED_LIST} from '@lexical/markdown';
import {
  createLexicalComposerContext,
  LexicalComposerContext,
} from '@lexical/react/LexicalComposerContext';
import {RichTextExtension} from '@lexical/rich-text';
import {TableExtension} from '@lexical/table';
import {configExtension, defineExtension} from 'lexical';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {expect, onTestFinished} from 'vitest';

import {PlaygroundImportExtension} from '../../nodes/PlaygroundImportExtension';
import {CodeHighlightExtension} from '../../plugins/CodeHighlightExtension';
import TableCellResizerPlugin from '../../plugins/TableCellResizer';
import {validateUrl} from '../../utils/url';
import {normalizeHTML, setupEditor} from './utils';

const pasteExtension = defineExtension({
  dependencies: [
    RichTextExtension,
    PlaygroundImportExtension,
    configExtension(LinkExtension, {validateUrl}),
    configExtension(CodeHighlightExtension, {mode: 'prism'}),
    configExtension(ListExtension, {shouldPreserveNumbering: false}),
    CheckListExtension,
    configExtension(TableExtension, {hasStickyScrollbar: true}),
    HorizontalRuleExtension,
  ],
  name: '[html-paste-test]',
  register: editor => registerMarkdownShortcuts(editor, [UNORDERED_LIST]),
});

export function setupPasteEditor() {
  return setupEditor([pasteExtension]);
}

function clipboardEvent(type: 'copy' | 'paste', clipboardData: DataTransfer) {
  const event = new ClipboardEvent(type, {bubbles: true, cancelable: true});
  // Firefox creates its own clipboardData instead of using the constructor
  // argument. Define the payload on the event, as the E2E helper does.
  Object.defineProperty(event, 'clipboardData', {value: clipboardData});
  return event;
}

// Exercise the registered DOM clipboard handler with the same in-memory
// payloads used by the playground E2E tests, without the system clipboard.
export async function pasteFromClipboard(
  root: HTMLElement,
  payload: Record<string, string>,
) {
  const clipboardData = new DataTransfer();
  for (const [type, value] of Object.entries(payload)) {
    clipboardData.setData(type, value);
  }
  await act(async () => {
    root.dispatchEvent(clipboardEvent('paste', clipboardData));
  });
}

export async function copyToClipboard(root: HTMLElement) {
  const clipboardData = new DataTransfer();
  root.dispatchEvent(clipboardEvent('copy', clipboardData));
  return Object.fromEntries(
    clipboardData.types.map(type => [type, clipboardData.getData(type)]),
  );
}

export async function setupTablePasteEditor() {
  const fixture = setupPasteEditor();
  const container = document.createElement('div');
  document.body.append(container);
  const reactRoot = createRoot(container);
  await act(async () => {
    reactRoot.render(
      createElement(
        LexicalComposerContext.Provider,
        {
          value: [
            fixture.editor,
            createLexicalComposerContext(null, fixture.editor._config.theme),
          ],
        },
        createElement(TableCellResizerPlugin),
      ),
    );
  });
  onTestFinished(async () => {
    await act(async () => reactRoot.unmount());
    container.remove();
  });
  return fixture;
}

// Compare imported table content and column widths, as the E2E helper does,
// independently of the scroll wrapper and its dynamically measured scrollbar.
export async function assertHTML(root: HTMLElement, expected: string) {
  await expect
    .poll(() => {
      const content = document.createElement('template');
      content.innerHTML = root.innerHTML;
      for (const wrapper of content.content.querySelectorAll(
        '[data-lexical-sticky-scrollbar]',
      )) {
        const table = wrapper.querySelector('table')!;
        const dir = wrapper.getAttribute('dir');
        if (dir !== null) {
          table.setAttribute('dir', dir);
        }
        wrapper.replaceWith(table);
      }
      return normalizeHTML(content.innerHTML);
    })
    .toBe(normalizeHTML(expected));
}
