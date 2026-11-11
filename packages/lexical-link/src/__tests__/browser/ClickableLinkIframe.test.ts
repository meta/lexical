/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  buildEditorFromExtensions,
  configExtension,
  getExtensionDependencyFromEditor,
  namedSignals,
} from '@lexical/extension';
import {
  $createLinkNode,
  ClickableLinkExtension,
  LinkExtension,
  registerClickableLink,
} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
} from 'lexical';
import {expect, onTestFinished, test, vi} from 'vitest';

const url = 'https://lexical.dev/';

test.each([
  ...['default', 'owner', 'none'].flatMap(windowChoice => [
    {button: 0, newTab: false, target: '_self', windowChoice},
    {button: 1, newTab: false, target: '_blank', windowChoice},
    {button: 0, newTab: true, target: '_blank', windowChoice},
  ]),
])(
  'iframe link click: $button, newTab: $newTab, window: $windowChoice',
  ({button, newTab, target, windowChoice}) => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const frameDocument = iframe.contentDocument!;
    const frameWindow = iframe.contentWindow!;
    const parentOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    const frameOpen = vi
      .spyOn(frameWindow, 'open')
      .mockImplementation(() => null);
    const root = frameDocument.createElement('div');
    root.contentEditable = 'true';
    frameDocument.body.append(root);
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          RichTextExtension,
          configExtension(ClickableLinkExtension, {
            ...(windowChoice === 'owner'
              ? {
                  getWindow: linkEditor =>
                    linkEditor.getRootElement()!.ownerDocument.defaultView,
                }
              : windowChoice === 'none'
                ? {getWindow: () => null}
                : {}),
            newTab,
          }),
        ],
        name: 'ClickableLinkIframe',
      }),
    );
    onTestFinished(() => {
      editor.dispose();
      parentOpen.mockRestore();
      frameOpen.mockRestore();
      iframe.remove();
    });
    editor.setRootElement(root);
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createLinkNode(url).append($createTextNode('Link')),
          ),
        );
      },
      {discrete: true},
    );

    const event = new MouseEvent(button === 0 ? 'click' : 'auxclick', {
      bubbles: true,
      button,
      cancelable: true,
    });
    root.querySelector('a')!.dispatchEvent(event);

    if (windowChoice === 'none') {
      expect(frameOpen).not.toHaveBeenCalled();
      expect(parentOpen).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    } else {
      const expectedOpen = windowChoice === 'owner' ? frameOpen : parentOpen;
      const otherOpen = windowChoice === 'owner' ? parentOpen : frameOpen;
      expect(expectedOpen).toHaveBeenCalledExactlyOnceWith(
        url,
        target,
        ...(target === '_blank' ? ['noopener'] : []),
      );
      expect(otherOpen).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
    }

    if (windowChoice === 'default' && button === 0 && !newTab) {
      parentOpen.mockClear();
      const getWindow = getExtensionDependencyFromEditor(
        editor,
        ClickableLinkExtension,
      ).output.getWindow;
      const defaultGetWindow = getWindow.peek();
      expect(defaultGetWindow).toEqual(expect.any(Function));
      getWindow.value = () => frameWindow;
      root
        .querySelector('a')!
        .dispatchEvent(
          new MouseEvent('click', {bubbles: true, cancelable: true}),
        );
      expect(frameOpen).toHaveBeenCalledExactlyOnceWith(url, '_self');
      expect(parentOpen).not.toHaveBeenCalled();

      getWindow.value = defaultGetWindow;
      root
        .querySelector('a')!
        .dispatchEvent(
          new MouseEvent('click', {bubbles: true, cancelable: true}),
        );
      expect(parentOpen).toHaveBeenCalledExactlyOnceWith(url, '_self');
      expect(frameOpen).toHaveBeenCalledTimes(1);
    }
  },
);

test('registerClickableLink keeps the default for callers without a getWindow signal', () => {
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [RichTextExtension, LinkExtension],
      name: 'LegacyClickableLink',
    }),
  );
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.append(root);
  const unregister = registerClickableLink(
    editor,
    namedSignals({disabled: false, newTab: false}),
  );
  onTestFinished(() => {
    unregister();
    editor.dispose();
    open.mockRestore();
    root.remove();
  });
  editor.setRootElement(root);
  editor.update(
    () => {
      $getRoot().append(
        $createParagraphNode().append(
          $createLinkNode(url).append($createTextNode('Link')),
        ),
      );
    },
    {discrete: true},
  );

  const event = new MouseEvent('click', {bubbles: true, cancelable: true});
  root.querySelector('a')!.dispatchEvent(event);
  expect(open).toHaveBeenCalledExactlyOnceWith(url, '_self');
  expect(event.defaultPrevented).toBe(true);
});
