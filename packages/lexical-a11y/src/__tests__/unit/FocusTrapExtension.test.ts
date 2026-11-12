/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {FocusTrapExtension} from '@lexical/a11y';
import {
  buildEditorFromExtensions,
  defineExtension,
  getExtensionDependencyFromEditor,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {afterEach, describe, expect, onTestFinished, test} from 'vitest';

function createContainer(): HTMLDivElement {
  const container = document.createElement('div');
  container.tabIndex = -1;
  const first = document.createElement('button');
  first.textContent = 'first';
  const second = document.createElement('button');
  second.textContent = 'second';
  container.append(first, second);
  document.body.appendChild(container);
  return container;
}

function getRegistry(editor: LexicalEditorWithDispose) {
  return getExtensionDependencyFromEditor(editor, FocusTrapExtension).output;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('FocusTrapExtension', () => {
  test('no registered container keeps the trap inert', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [FocusTrapExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    void editor;
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  test('activates when a container is registered', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [FocusTrapExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    const container = createContainer();
    onTestFinished(getRegistry(editor).register(container));
    expect(document.activeElement).toBe(container.querySelector('button'));
  });

  test('initialFocus="container" lands focus on the container itself', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [FocusTrapExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    const container = createContainer();
    onTestFinished(
      getRegistry(editor).register(container, {initialFocus: 'container'}),
    );
    expect(document.activeElement).toBe(container);
  });

  test('deactivates when the registration is disposed', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [FocusTrapExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    const container = createContainer();
    const dispose = getRegistry(editor).register(container);
    expect(document.activeElement).toBe(container.querySelector('button'));

    dispose();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  test('reference counting keeps the trap active until the last disposer runs', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [FocusTrapExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    const container = createContainer();
    const registry = getRegistry(editor);
    const disposeA = registry.register(container);
    const disposeB = registry.register(container);
    expect(document.activeElement).toBe(container.querySelector('button'));

    // First release keeps the trap active (one outstanding reference remains).
    disposeA();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    // The focusin safety net pulls focus back inside the still-active trap.
    expect(document.activeElement).toBe(container.querySelector('button'));

    // Last release tears it down.
    disposeB();
    outside.focus();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  test('Tab inside the container cycles to the next focusable', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [FocusTrapExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    const container = createContainer();
    const [first, second] = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    );
    onTestFinished(getRegistry(editor).register(container));

    first.focus();
    first.dispatchEvent(
      new KeyboardEvent('keydown', {bubbles: true, key: 'Tab'}),
    );
    expect(document.activeElement).toBe(second);
  });

  test('Tab passes over a button in a disabled fieldset', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [FocusTrapExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    const container = createContainer();
    const [first, second] = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    );
    // The selector matches the button, but it can't take focus.
    const fieldset = document.createElement('fieldset');
    fieldset.disabled = true;
    fieldset.append(document.createElement('button'));
    second.before(fieldset);
    onTestFinished(getRegistry(editor).register(container));

    first.focus();
    first.dispatchEvent(
      new KeyboardEvent('keydown', {bubbles: true, key: 'Tab'}),
    );
    expect(document.activeElement).toBe(second);
  });

  test('Tab and Shift+Tab in a container with no candidates are prevented', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [FocusTrapExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    const container = document.createElement('div');
    container.tabIndex = -1;
    document.body.appendChild(container);
    onTestFinished(getRegistry(editor).register(container));
    expect(document.activeElement).toBe(container);

    for (const shiftKey of [false, true]) {
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Tab',
        shiftKey,
      });
      container.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(container);
    }
  });
});
