/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {ListItemNode, ListNode} from '@lexical/list';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {LexicalErrorBoundary} from '@lexical/react/LexicalErrorBoundary';
import {ListPlugin} from '@lexical/react/LexicalListPlugin';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {$setBlocksType} from '@lexical/selection';
import {
  $createParagraphNode,
  $createTextNode,
  $getSelection,
  $insertNodes,
  INDENT_CONTENT_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
  OUTDENT_CONTENT_COMMAND,
} from 'lexical';
import {
  expectHtmlToBeEqual,
  html,
  TestComposer,
} from 'lexical/src/__tests__/utils';
import {act, type JSX} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, test, vi} from 'vitest';

import {
  INSERT_UNORDERED_LIST_COMMAND,
  REMOVE_LIST_COMMAND,
} from '../../../../lexical-list/src/index';

describe('@lexical/list tests', () => {
  let container: HTMLDivElement;
  let reactRoot: Root;

  beforeEach(() => {
    container = document.createElement('div');
    reactRoot = createRoot(container);
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    // @ts-ignore
    container = null;

    vi.restoreAllMocks();
  });

  // Shared instance across tests
  let editor: LexicalEditor;

  function Test(): JSX.Element {
    function TestPlugin() {
      // Plugin used just to get our hands on the Editor object
      [editor] = useLexicalComposerContext();
      return null;
    }

    return (
      <TestComposer config={{nodes: [ListNode, ListItemNode], theme: {}}}>
        <RichTextPlugin
          contentEditable={<ContentEditable />}
          placeholder={
            <div className="editor-placeholder">Enter some text...</div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <TestPlugin />
        <ListPlugin />
      </TestComposer>
    );
  }

  test('Toggle an empty list on/off', async () => {
    act(() => {
      reactRoot.render(<Test key="MegaSeeds, Morty!" />);
    });

    await act(async () => {
      await editor.update(() => {
        editor.focus();
        editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND);
      });
    });

    expectHtmlToBeEqual(
      container.innerHTML,
      html`
        <div
          contenteditable="true"
          role="textbox"
          spellcheck="true"
          style="user-select: text; white-space: pre-wrap; word-break: break-word;"
          data-lexical-editor="true">
          <ul dir="auto">
            <li>
              <br data-lexical-managed-linebreak="true" />
            </li>
          </ul>
        </div>
      `,
    );

    await act(async () => {
      await editor.update(() => {
        editor.focus();
        editor.dispatchCommand(REMOVE_LIST_COMMAND);
      });
    });

    expectHtmlToBeEqual(
      container.innerHTML,
      html`
        <div
          contenteditable="true"
          role="textbox"
          spellcheck="true"
          style="user-select: text; white-space: pre-wrap; word-break: break-word;"
          data-lexical-editor="true">
          <p dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
        </div>
        <div class="editor-placeholder">Enter some text...</div>
      `,
    );
  });

  test('Can create a list and indent/outdent it', async () => {
    act(() => {
      reactRoot.render(<Test key="MegaSeeds, Morty!" />);
    });

    await act(async () => {
      await editor.update(() => {
        editor.focus();
        editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND);
      });
    });

    expectHtmlToBeEqual(
      container.innerHTML,
      html`
        <div
          contenteditable="true"
          role="textbox"
          spellcheck="true"
          style="user-select: text; white-space: pre-wrap; word-break: break-word;"
          data-lexical-editor="true">
          <ul dir="auto">
            <li>
              <br data-lexical-managed-linebreak="true" />
            </li>
          </ul>
        </div>
      `,
    );

    await act(async () => {
      await editor.update(() => {
        editor.focus();
        editor.dispatchCommand(INDENT_CONTENT_COMMAND);
      });
    });

    expectHtmlToBeEqual(
      container.innerHTML,
      html`
        <div
          contenteditable="true"
          role="textbox"
          spellcheck="true"
          style="user-select: text; white-space: pre-wrap; word-break: break-word;"
          data-lexical-editor="true">
          <ul dir="auto">
            <li>
              <ul>
                <li><br data-lexical-managed-linebreak="true" /></li>
              </ul>
            </li>
          </ul>
        </div>
      `,
    );

    await act(async () => {
      await editor.update(() => {
        editor.focus();
        editor.dispatchCommand(OUTDENT_CONTENT_COMMAND);
      });
    });

    expectHtmlToBeEqual(
      container.innerHTML,
      html`
        <div
          contenteditable="true"
          role="textbox"
          spellcheck="true"
          style="user-select: text; white-space: pre-wrap; word-break: break-word;"
          data-lexical-editor="true">
          <ul dir="auto">
            <li>
              <br data-lexical-managed-linebreak="true" />
            </li>
          </ul>
        </div>
      `,
    );
  });

  test('$setBlocksType does not cause invalid ListItemNode children - regression #7036', async () => {
    act(() => {
      reactRoot.render(<Test key="MegaSeeds, Morty!" />);
    });

    await act(async () => {
      await editor.update(() => {
        editor.focus();
        editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND);
        $insertNodes([$createTextNode('First item')]);
        editor.dispatchCommand(KEY_ENTER_COMMAND, null);
        editor.dispatchCommand(INDENT_CONTENT_COMMAND);
        $insertNodes([$createTextNode('Nested item')]);
        editor.dispatchCommand(KEY_ENTER_COMMAND, null);
        $setBlocksType($getSelection(), $createParagraphNode);
      });
    });
    expectHtmlToBeEqual(
      container.innerHTML,
      html`
        <div
          contenteditable="true"
          role="textbox"
          spellcheck="true"
          style="user-select: text; white-space: pre-wrap; word-break: break-word;"
          data-lexical-editor="true">
          <ul dir="auto">
            <li>
              <span data-lexical-text="true">First item</span>
            </li>
            <li>
              <ul>
                <li>
                  <span data-lexical-text="true">Nested item</span>
                </li>
              </ul>
            </li>
          </ul>
          <p
            dir="auto"
            style="padding-inline-start: calc(1 * var(--lexical-indent-base-value, 40px))">
            <br data-lexical-managed-linebreak="true" />
          </p>
        </div>
      `,
    );
    await act(async () => {
      await editor.update(() => {
        $insertNodes([$createTextNode('more text')]);
        editor.dispatchCommand(KEY_ENTER_COMMAND, null);
        $insertNodes([$createTextNode('even more text')]);
      });
    });
    expectHtmlToBeEqual(
      container.innerHTML,
      html`
        <div
          contenteditable="true"
          role="textbox"
          spellcheck="true"
          style="user-select: text; white-space: pre-wrap; word-break: break-word;"
          data-lexical-editor="true">
          <ul dir="auto">
            <li>
              <span data-lexical-text="true">First item</span>
            </li>
            <li>
              <ul>
                <li>
                  <span data-lexical-text="true">Nested item</span>
                </li>
              </ul>
            </li>
          </ul>
          <p
            dir="auto"
            style="padding-inline-start: calc(1 * var(--lexical-indent-base-value, 40px))">
            <span data-lexical-text="true">more text</span>
          </p>
          <p dir="auto"><span data-lexical-text="true">even more text</span></p>
        </div>
      `,
    );
  });
});
