/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {RovingTabIndexExtension} from '@lexical/a11y';
import {
  buildEditorFromExtensions,
  defineExtension,
  getExtensionDependencyFromEditor,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {getActiveElementDeep} from 'lexical';
import {afterEach, describe, expect, onTestFinished, test} from 'vitest';

function createToolbar(): HTMLDivElement {
  const toolbar = document.createElement('div');
  const a = document.createElement('button');
  a.textContent = 'a';
  const b = document.createElement('button');
  b.textContent = 'b';
  const c = document.createElement('button');
  c.textContent = 'c';
  toolbar.append(a, b, c);
  document.body.appendChild(toolbar);
  return toolbar;
}

// A roving item that is a wrapper rather than the focus target itself, which is
// what `itemSelector: '[data-roving-item]'` documents as supported. The element
// that holds focus is the inner button, not the item.
function createNestedFocusToolbar(): {
  innerButtons: HTMLButtonElement[];
  items: HTMLElement[];
  toolbar: HTMLDivElement;
} {
  const toolbar = document.createElement('div');
  const innerButtons: HTMLButtonElement[] = [];
  const items: HTMLElement[] = [];
  for (const label of ['a', 'b', 'c']) {
    const item = document.createElement('div');
    item.setAttribute('data-roving-item', '');
    const button = document.createElement('button');
    button.textContent = label;
    item.appendChild(button);
    toolbar.appendChild(item);
    innerButtons.push(button);
    items.push(item);
  }
  document.body.appendChild(toolbar);
  return {innerButtons, items, toolbar};
}

function getRegistry(editor: LexicalEditorWithDispose) {
  return getExtensionDependencyFromEditor(editor, RovingTabIndexExtension)
    .output;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('RovingTabIndexExtension', () => {
  test('no registered container leaves item tab indices untouched', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RovingTabIndexExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    void editor;
    const toolbar = createToolbar();
    const buttons = Array.from(toolbar.querySelectorAll('button'));
    for (const btn of buttons) {
      expect(btn.tabIndex).toBe(0);
    }
  });

  test('applies tabindex=0 on the first item and -1 on the rest when container is registered', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RovingTabIndexExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    const toolbar = createToolbar();
    onTestFinished(getRegistry(editor).register(toolbar));

    const buttons = Array.from(toolbar.querySelectorAll('button'));
    expect(buttons[0].tabIndex).toBe(0);
    expect(buttons[1].tabIndex).toBe(-1);
    expect(buttons[2].tabIndex).toBe(-1);
  });

  test('disposing the registration restores the natural tab order', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RovingTabIndexExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    const toolbar = createToolbar();
    const dispose = getRegistry(editor).register(toolbar);
    const buttons = Array.from(toolbar.querySelectorAll('button'));
    expect(buttons.map(b => b.tabIndex)).toEqual([0, -1, -1]);

    dispose();
    expect(buttons.map(b => b.tabIndex)).toEqual([0, 0, 0]);
  });

  test('ArrowRight moves focus to the next button (horizontal default)', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RovingTabIndexExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    const toolbar = createToolbar();
    onTestFinished(getRegistry(editor).register(toolbar));

    const [a, b] = Array.from(
      toolbar.querySelectorAll<HTMLButtonElement>('button'),
    );
    a.focus();
    a.dispatchEvent(
      new KeyboardEvent('keydown', {bubbles: true, key: 'ArrowRight'}),
    );
    expect(document.activeElement).toBe(b);
    expect(b.tabIndex).toBe(0);
    expect(a.tabIndex).toBe(-1);
  });

  test('Home jumps to the first item from the middle', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RovingTabIndexExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    const toolbar = createToolbar();
    onTestFinished(getRegistry(editor).register(toolbar));

    const [a, b] = Array.from(
      toolbar.querySelectorAll<HTMLButtonElement>('button'),
    );
    b.focus();
    b.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key: 'Home'}));
    expect(document.activeElement).toBe(a);
  });

  test('vertical orientation responds to ArrowDown, not ArrowRight', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RovingTabIndexExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    const toolbar = createToolbar();
    onTestFinished(
      getRegistry(editor).register(toolbar, {orientation: 'vertical'}),
    );

    const [a, b] = Array.from(
      toolbar.querySelectorAll<HTMLButtonElement>('button'),
    );
    a.focus();
    a.dispatchEvent(
      new KeyboardEvent('keydown', {bubbles: true, key: 'ArrowRight'}),
    );
    expect(document.activeElement).toBe(a);
    a.dispatchEvent(
      new KeyboardEvent('keydown', {bubbles: true, key: 'ArrowDown'}),
    );
    expect(document.activeElement).toBe(b);
  });

  test('ArrowRight advances from the item that holds focus through a descendant', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RovingTabIndexExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    const {innerButtons, items, toolbar} = createNestedFocusToolbar();
    onTestFinished(
      getRegistry(editor).register(toolbar, {
        itemSelector: '[data-roving-item]',
      }),
    );

    // Focus is inside the second item, so ArrowRight must go to the third.
    innerButtons[1].focus();
    innerButtons[1].dispatchEvent(
      new KeyboardEvent('keydown', {bubbles: true, key: 'ArrowRight'}),
    );

    expect(getActiveElementDeep(document)).toBe(items[2]);
    expect(items.map(item => item.tabIndex)).toEqual([-1, -1, 0]);
  });

  test('ArrowLeft from the first item wraps to the last when focus is on a descendant', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RovingTabIndexExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    const {innerButtons, items, toolbar} = createNestedFocusToolbar();
    onTestFinished(
      getRegistry(editor).register(toolbar, {
        itemSelector: '[data-roving-item]',
      }),
    );

    innerButtons[0].focus();
    innerButtons[0].dispatchEvent(
      new KeyboardEvent('keydown', {bubbles: true, key: 'ArrowLeft'}),
    );

    expect(getActiveElementDeep(document)).toBe(items[2]);
  });

  test('the roving tabindex is placed on the item that already holds focus', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RovingTabIndexExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    const {innerButtons, items, toolbar} = createNestedFocusToolbar();
    innerButtons[1].focus();
    onTestFinished(
      getRegistry(editor).register(toolbar, {
        itemSelector: '[data-roving-item]',
      }),
    );

    expect(items.map(item => item.tabIndex)).toEqual([-1, 0, -1]);
  });

  // The composed-match must not swallow the case the fallback exists for: when
  // focus is on the container rather than on an item, no item contains the
  // active element, so the group is entered at its first item.
  test('focus on the container still enters the group at the first item', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RovingTabIndexExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    const {items, toolbar} = createNestedFocusToolbar();
    onTestFinished(
      getRegistry(editor).register(toolbar, {
        itemSelector: '[data-roving-item]',
      }),
    );

    toolbar.tabIndex = -1;
    toolbar.focus();
    expect(document.activeElement).toBe(toolbar);
    toolbar.dispatchEvent(
      new KeyboardEvent('keydown', {bubbles: true, key: 'ArrowRight'}),
    );

    expect(getActiveElementDeep(document)).toBe(items[0]);
  });
});
