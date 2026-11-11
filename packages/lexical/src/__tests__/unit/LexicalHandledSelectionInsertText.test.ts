/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {afterEach, assert, describe, expect, test, vi} from 'vitest';

afterEach(() => {
  vi.doUnmock('lexical/src/environment');
  vi.resetModules();
  vi.useRealTimers();
});

describe.each([
  {apple: false, chrome: true, ios: false, name: 'Android Chrome'},
  {apple: false, chrome: true, ios: false, name: 'Windows/Linux Chrome'},
  {apple: true, chrome: false, ios: false, name: 'macOS Safari'},
  {apple: true, chrome: false, ios: false, name: 'macOS Firefox'},
  {apple: true, chrome: false, ios: true, name: 'iOS WebKit'},
  {apple: true, chrome: true, ios: true, name: 'iPadOS Chromium profile'},
  {apple: true, chrome: true, ios: false, name: 'macOS Chrome'},
])('$name: insertText after a handled selection command', platform => {
  test.each(['Backspace', 'select-all'] as const)('%s', async command => {
    vi.resetModules();
    vi.doMock('lexical/src/environment', () => ({
      CAN_USE_BEFORE_INPUT: true,
      CAN_USE_DOM: true,
      IS_ANDROID: platform.name === 'Android Chrome',
      IS_ANDROID_CHROME: platform.name === 'Android Chrome',
      IS_APPLE: platform.apple,
      IS_APPLE_WEBKIT:
        platform.apple && !platform.chrome && platform.name !== 'macOS Firefox',
      IS_CHROME: platform.chrome,
      IS_FIREFOX: platform.name === 'macOS Firefox',
      IS_IOS: platform.ios,
      IS_SAFARI:
        platform.name === 'macOS Safari' || platform.name === 'iOS WebKit',
    }));
    const {
      $createParagraphNode,
      $createTextNode,
      $getRoot,
      $getSelection,
      $isRangeSelection,
      isDOMTextNode,
    } = await import('lexical');
    const {buildEditorFromExtensions} = await import('@lexical/extension');
    const {RichTextExtension} = await import('@lexical/rich-text');
    using editor = buildEditorFromExtensions({
      $initialEditorState: () => {
        const text = $createTextNode('draft');
        $getRoot().append($createParagraphNode().append(text));
        // Select the last character so deletion needs no native Selection.modify
        // implementation in jsdom. The handled-command suppression is the same.
        text.select(command === 'Backspace' ? 4 : 5, 5);
      },
      afterRegistration: ed => {
        const root = document.createElement('div');
        root.contentEditable = 'true';
        document.body.appendChild(root);
        ed.setRootElement(root);
        return () => {
          ed.setRootElement(null);
          root.remove();
        };
      },
      dependencies: [RichTextExtension],
      name: '[test]',
    });
    const root = editor.getRootElement()!;
    const beforeInput = (inputType: string, data: string | null = null) => {
      const event = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data,
        inputType,
      });
      const range = window.getSelection()!.getRangeAt(0);
      Object.defineProperty(event, 'getTargetRanges', {
        value: () => [new StaticRange(range)],
      });
      root.dispatchEvent(event);
      return event;
    };

    // Keep the zero-delay suppression timer pending while allowing the editor's
    // microtask commit between keydown and beforeinput, as in #9250.
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    const keydown = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ...(command === 'Backspace'
        ? {code: 'Backspace', key: 'Backspace'}
        : {
            code: 'KeyA',
            ctrlKey: !platform.apple,
            key: 'a',
            metaKey: platform.apple,
          }),
    });
    root.dispatchEvent(keydown);
    if (command === 'Backspace' && platform.ios) {
      // iOS leaves Backspace to beforeinput to preserve keyboard suggestions.
      expect(keydown.defaultPrevented).toBe(false);
      beforeInput('deleteContentBackward');
    } else {
      expect(keydown.defaultPrevented).toBe(true);
    }
    await Promise.resolve();
    expect(root.textContent).toBe(command === 'Backspace' ? 'draf' : 'draft');

    const input = beforeInput('insertText', 'swift');
    if (!input.defaultPrevented) {
      // Synthetic beforeinput has no native edit. Apply its default action and
      // emit input so Lexical reconciles the same DOM mutation a browser makes.
      const selection = window.getSelection()!;
      const range = selection.getRangeAt(0);
      assert(range.collapsed);
      assert(isDOMTextNode(range.startContainer));
      const text = range.startContainer;
      const offset = range.startOffset;
      text.insertData(offset, 'swift');
      selection.collapse(text, offset + 'swift'.length);
      root.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: 'swift',
          inputType: 'insertText',
        }),
      );
    }

    const suppress = platform.name === 'macOS Chrome';
    const expected = suppress
      ? command === 'Backspace'
        ? 'draf'
        : 'draft'
      : command === 'Backspace'
        ? 'drafswift'
        : 'swift';
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe(expected);
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      expect(selection.isCollapsed()).toBe(true);
      expect(selection.anchor.offset).toBe(expected.length);
    });
    expect(root.textContent).toBe(expected);
    await vi.runAllTimersAsync();
  });
});
