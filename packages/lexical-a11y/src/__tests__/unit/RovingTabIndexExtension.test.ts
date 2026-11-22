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

  test('arrow, Home and End keys in an input inside the group stay in the input', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RovingTabIndexExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    const toolbar = createToolbar();
    const input = document.createElement('input');
    toolbar.insertBefore(input, toolbar.lastChild);
    onTestFinished(getRegistry(editor).register(toolbar));

    input.focus();
    for (const key of [
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'Home',
      'End',
    ]) {
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key,
      });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(input);
    }
  });

  test('an arrow key on the focused container enters the group at the first item', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RovingTabIndexExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    const toolbar = createToolbar();
    toolbar.tabIndex = -1;
    onTestFinished(getRegistry(editor).register(toolbar));

    toolbar.focus();
    toolbar.dispatchEvent(
      new KeyboardEvent('keydown', {bubbles: true, key: 'ArrowRight'}),
    );
    expect(document.activeElement).toBe(toolbar.querySelector('button'));
  });
});
