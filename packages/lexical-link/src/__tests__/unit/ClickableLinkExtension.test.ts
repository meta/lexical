/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {$createLinkNode, ClickableLinkExtension} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import {$createParagraphNode, $createTextNode, $getRoot} from 'lexical';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type Mock,
  test,
  vi,
} from 'vitest';

const URL = 'https://lexical.dev/';

const extension = defineExtension({
  $initialEditorState: () => {
    const paragraph = $createParagraphNode();
    const link = $createLinkNode(URL);
    link.append($createTextNode('Hello'));
    $getRoot().append(paragraph.append(link));
  },
  dependencies: [ClickableLinkExtension, RichTextExtension],
  name: '[root]',
});

/**
 * The button-to-event mapping these tests encode is verified against real
 * browsers by `ClickableLinks.spec.mjs` in the playground e2e suite: the
 * primary button produces `click`, and every other button (middle, right,
 * and the history buttons) produces `auxclick`.
 */
function dispatch(
  anchor: HTMLAnchorElement,
  type: 'auxclick' | 'click',
  button: number,
): void {
  anchor.dispatchEvent(
    new MouseEvent(type, {bubbles: true, button, cancelable: true}),
  );
}

describe('ClickableLinkExtension', () => {
  let windowOpen: Mock<(typeof window)['open']>;

  beforeEach(() => {
    windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    windowOpen.mockRestore();
  });

  function withEditor(fn: (anchor: HTMLAnchorElement) => void): void {
    using editor = buildEditorFromExtensions(extension);
    const rootElement = document.createElement('div');
    rootElement.contentEditable = 'true';
    document.body.appendChild(rootElement);
    editor.setRootElement(rootElement);
    editor.update(() => {}, {discrete: true});
    try {
      fn(rootElement.querySelector('a')!);
    } finally {
      editor.setRootElement(null);
      rootElement.remove();
    }
  }

  test('a left click opens the link in the same tab', () => {
    withEditor(anchor => {
      dispatch(anchor, 'click', 0);

      expect(windowOpen).toHaveBeenCalledTimes(1);
      expect(windowOpen).toHaveBeenCalledWith(URL, '_self');
    });
  });

  test('a middle click opens the link in a new tab', () => {
    withEditor(anchor => {
      dispatch(anchor, 'auxclick', 1);

      expect(windowOpen).toHaveBeenCalledTimes(1);
      expect(windowOpen).toHaveBeenCalledWith(URL, '_blank');
    });
  });

  test('a middle click cancels the browser opening the link itself', () => {
    withEditor(anchor => {
      const event = new MouseEvent('auxclick', {
        bubbles: true,
        button: 1,
        cancelable: true,
      });
      anchor.dispatchEvent(event);

      // Only `auxclick` can be canceled to suppress the browser's own
      // middle-click navigation; canceling `mouseup` does not, which is why
      // handling the middle button there opened the URL twice.
      expect(event.defaultPrevented).toBe(true);
    });
  });

  test.each([
    ['right', 2],
    ['back', 3],
    ['forward', 4],
  ])('a %s click does not open the link', (_name, button) => {
    withEditor(anchor => {
      const event = new MouseEvent('auxclick', {
        bubbles: true,
        button,
        cancelable: true,
      });
      anchor.dispatchEvent(event);

      // `auxclick` fires for every non-primary button. A right click belongs
      // to the context menu and the history buttons belong to the browser, so
      // neither may be mistaken for a middle click.
      expect(windowOpen).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });
  });
});
