/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {expect} from '@playwright/test';

import {
  assertHTML,
  assertSelection,
  evaluate,
  focusEditor,
  html,
  initialize,
  sleep,
  test,
} from '../utils/index.mjs';

test.describe('Mutations', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test(`Text mutation observers also manage the selection`, async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('Hello world.');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello world.</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 12,
      anchorPath: [0, 0, 0],
      focusOffset: 12,
      focusPath: [0, 0, 0],
    });
    // We need to wait at least 100msec (TEXT_MUTATION_VARIANCE) after typing,
    // otherwise the mutation will be applied to the DOM but not synchronized
    // with the lexical state (see shouldFlushTextMutations in flushMutations).
    // TODO: It might be worth tracking ignored mutations with a timeout to reconcile this edge case
    await sleep(100);
    await evaluate(page, () => {
      const rootElement = document.querySelector('div[contenteditable="true"]');
      const textNode = rootElement.querySelector('span').firstChild;
      textNode.nodeValue = 'Hello.';
      const domSelection = window.getSelection();
      const range = document.createRange();
      range.setStart(textNode, textNode.nodeValue.length);
      range.setEnd(textNode, textNode.nodeValue.length);
      domSelection.removeAllRanges();
      domSelection.addRange(range);
    });
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello.</span>
        </p>
      `,
    );
    let editorStateJSON = await evaluate(page, () => {
      const rootElement = document.querySelector('div[contenteditable="true"]');
      return rootElement.__lexicalEditor.getEditorState().toJSON();
    });
    expect(editorStateJSON).toMatchObject({
      root: {
        children: [
          {children: [{text: 'Hello.', type: 'text'}], type: 'paragraph'},
        ],
        type: 'root',
      },
    });
    await assertSelection(page, {
      anchorOffset: 6,
      anchorPath: [0, 0, 0],
      focusOffset: 6,
      focusPath: [0, 0, 0],
    });

    await evaluate(page, () => {
      const rootElement = document.querySelector('div[contenteditable="true"]');
      const textNode = rootElement.querySelector('span').firstChild;
      textNode.nodeValue = 'Hi!';
      const domSelection = window.getSelection();
      const range = document.createRange();
      const uiElement = document.querySelector('i.lock');
      range.setStart(uiElement, 0);
      range.setEnd(uiElement, 0);
      domSelection.removeAllRanges();
      domSelection.addRange(range);
    });

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hi!</span>
        </p>
      `,
    );
    editorStateJSON = await evaluate(page, () => {
      const rootElement = document.querySelector('div[contenteditable="true"]');
      return rootElement.__lexicalEditor.getEditorState().toJSON();
    });
    expect(editorStateJSON).toMatchObject({
      root: {
        children: [
          {children: [{text: 'Hi!', type: 'text'}], type: 'paragraph'},
        ],
        type: 'root',
      },
    });
    // This does "steal" the focus which might be unexpected? The key here
    // is that the lexical selection is modified accordingly (offset clamp)
    // even though the DOM selection was elsewhere at the time of mutation
    await assertSelection(page, {
      anchorOffset: 3,
      anchorPath: [0, 0, 0],
      focusOffset: 3,
      focusPath: [0, 0, 0],
    });
  });
});
