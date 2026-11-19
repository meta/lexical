/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  FORMAT_TEXT_COMMAND,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test, vi} from 'vitest';

// Replays the events Mobile Safari (iOS 26.2) sends for the Japanese Kana
// keyboard, in CI's Chromium as well as WebKit. These are synthetic event
// replays, not a substitute for a system IME test.
vi.mock('lexical/src/environment', async importOriginal => ({
  ...(await importOriginal<typeof import('lexical/src/environment')>()),
  IS_APPLE: true,
  IS_APPLE_WEBKIT: true,
  IS_CHROME: false,
  IS_FIREFOX: false,
  IS_IOS: true,
  IS_SAFARI: true,
}));

function mount(text: string) {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.append(root);
  const editor = buildEditorFromExtensions({
    dependencies: [RichTextExtension],
    name: 'ios-composition-test',
  });
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
  });
  root.focus();
  editor.update(
    () => {
      const node = $createTextNode(text);
      $getRoot().clear().append($createParagraphNode().append(node));
      node.select();
    },
    {discrete: true},
  );
  const keyDown = (key: string) =>
    root.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key,
        keyCode: 229,
      }),
    );
  const composition = (type: string, data = '') =>
    root.dispatchEvent(new CompositionEvent(type, {bubbles: true, data}));
  const dispatchInput = (
    type: 'input' | 'beforeinput',
    inputType: string,
    data: string | null,
  ) => {
    const event = new InputEvent(type, {
      bubbles: true,
      cancelable: type === 'beforeinput',
      data,
      inputType,
      isComposing: true,
    });
    // Chromium normalizes Safari-only input types to the empty string.
    Object.defineProperty(event, 'inputType', {value: inputType});
    root.dispatchEvent(event);
  };
  const setDOMText = (domText: string, offset: number) => {
    const domSelection = document.getSelection();
    assert(domSelection);
    const textDOM = domSelection.anchorNode;
    assert(textDOM instanceof Text && root.contains(textDOM));
    textDOM.data = domText;
    domSelection.setBaseAndExtent(textDOM, offset, textDOM, offset);
  };
  const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  // iOS sends the keydown first, then the composition update and its input.
  const compose = async (key: string, data: string, domText: string) => {
    keyDown(key);
    composition('compositionupdate', data);
    dispatchInput('beforeinput', 'insertCompositionText', data);
    setDOMText(domText, text.length + data.length);
    dispatchInput('input', 'insertCompositionText', data);
    await flush();
  };
  // The confirm key repeats the update, then (iOS 26) deletes the composed
  // text and commits it again with insertFromComposition before
  // compositionend. Earlier versions committed without the deletion.
  const confirm = async (data: string, deletesFirst: boolean) => {
    composition('compositionupdate', data);
    dispatchInput('beforeinput', 'insertCompositionText', data);
    dispatchInput('input', 'insertCompositionText', data);
    if (deletesFirst) {
      dispatchInput('beforeinput', 'deleteCompositionText', null);
      setDOMText(text, text.length);
      dispatchInput('input', 'deleteCompositionText', null);
    }
    dispatchInput('beforeinput', 'insertFromComposition', data);
    // A browser runs microtasks between the two events, so the commit has
    // reached the DOM when compositionend reads it.
    await flush();
    composition('compositionend', data);
    await flush();
  };
  return {compose, composition, confirm, editor, flush, keyDown, root};
}

describe('iOS composition', () => {
  test.each([
    ['without a format change', false, true],
    ['with Bold tapped while composing', true, true],
    // The sequence the orphaned composition guard was written for: the
    // word is already in the DOM, so committing it must not insert it twice.
    ['once with Bold tapped and no deletion before the commit', true, false],
  ])('confirming a Kana word keeps it %s', async (_, tapBold, deletesFirst) => {
    const text = 'Second paragraph.';
    const t = mount(text);
    t.keyDown('た');
    t.composition('compositionstart');
    await t.flush();
    await t.compose('た', 'た', `${text}た\u00a0`);
    await t.compose('か', 'たか', `${text}たか\u00a0`);
    await t.compose('ら', 'たから', `${text}たから\u00a0`);
    if (tapBold) {
      // The toolbar button sends no key, composition or input event.
      t.editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold');
      await t.flush();
    }
    await t.compose('な', 'たからな', `${text}たからな`);
    await t.confirm('たからな', deletesFirst);

    expect(t.editor.read(() => $getRoot().getTextContent())).toBe(
      `${text}たからな`,
    );
    expect(t.root.textContent).toBe(`${text}たからな`);
    expect(t.editor.isComposing()).toBe(false);
    // The caret ends after the word.
    t.editor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'Expected a RangeSelection');
      expect(selection.isCollapsed()).toBe(true);
      const last = $getRoot().getLastDescendant();
      assert($isTextNode(last), 'Expected a TextNode');
      expect([selection.anchor.key, selection.anchor.offset]).toEqual([
        last.getKey(),
        last.getTextContentSize(),
      ]);
    });
  });
});
