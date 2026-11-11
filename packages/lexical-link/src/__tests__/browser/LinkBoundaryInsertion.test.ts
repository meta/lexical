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
  $isElementNode,
  $isRangeSelection,
  defineExtension,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

import {$createLinkNode, $isLinkNode, LinkExtension} from '../../index';

const extension = defineExtension({
  dependencies: [RichTextExtension, LinkExtension],
  name: 'LinkBoundaryInsertion',
  namespace: 'Playground',
});

const clipboardData = {
  html: {'text/html': 'x'},
  lexical: {
    'application/x-lexical-editor': JSON.stringify({
      namespace: 'Playground',
      nodes: [
        {
          detail: 0,
          format: 0,
          mode: 'normal',
          style: '',
          text: 'x',
          type: 'text',
          version: 1,
        },
      ],
    }),
  },
  plain: {'text/plain': 'x'},
};

function paste(root: HTMLElement, data: Record<string, string>) {
  const clipboard = new DataTransfer();
  for (const [type, value] of Object.entries(data))
    clipboard.setData(type, value);
  // Match the e2e clipboard helper: Firefox does not expose the payload passed
  // to the ClipboardEvent constructor, so define it on the event itself.
  const event = new ClipboardEvent('paste', {bubbles: true, cancelable: true});
  Object.defineProperty(event, 'clipboardData', {value: clipboard});
  root.dispatchEvent(event);
  if (!event.defaultPrevented) {
    const input = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertFromPaste',
    });
    Object.defineProperty(input, 'dataTransfer', {value: clipboard});
    root.dispatchEvent(input);
  }
}

describe.each([
  {label: 'start', prefix: '', suffix: 'b', text: 'a'},
  {label: 'middle', prefix: 'a', suffix: 'c', text: 'b'},
  {label: 'end', prefix: 'a', suffix: '', text: 'b'},
])('link at paragraph $label', ({prefix, text, suffix}) => {
  describe.each(['before', 'after'] as const)('insert %s the link', side => {
    test.each(['type', 'plain', 'html', 'lexical'] as const)(
      'via %s',
      async method => {
        const root = document.createElement('div');
        root.contentEditable = 'true';
        root.style.whiteSpace = 'pre-wrap';
        document.body.append(root);
        const editor = buildEditorFromExtensions(extension);
        editor.setRootElement(root);
        onTestFinished(() => {
          editor.dispose();
          root.remove();
          window.getSelection()?.removeAllRanges();
        });
        editor.update(
          () => {
            const paragraph = $createParagraphNode();
            if (prefix) paragraph.append($createTextNode(prefix));
            const linkedText = $createTextNode(text);
            paragraph.append(
              $createLinkNode('https://', {rel: 'noreferrer'}).append(
                linkedText,
              ),
            );
            if (suffix) paragraph.append($createTextNode(suffix));
            $getRoot().clear().append(paragraph);
            // The playground selects the character backwards before wrapping it.
            linkedText.select(1, 0);
          },
          {discrete: true},
        );
        window.focus();
        root.focus();
        const linkText = root.querySelector('a')!.firstChild!.firstChild!;
        await expect
          .poll(() => {
            const selection = window.getSelection()!;
            return [
              selection.anchorNode,
              selection.anchorOffset,
              selection.focusNode,
              selection.focusOffset,
            ];
          })
          .toEqual([linkText, 1, linkText, 0]);
        // Preserve native collapse-at-boundary behavior, rather than setting a
        // model selection directly at the desired insertion point.
        await userEvent.keyboard(
          side === 'before' ? '{ArrowLeft}' : '{ArrowRight}',
        );
        // Synthetic paste must wait for the native selectionchange to reach
        // the editor, just as a subsequent user input event would.
        await expect
          .poll(() =>
            editor.read('latest', () => {
              const selection = $getSelection();
              return $isRangeSelection(selection) && selection.isCollapsed();
            }),
          )
          .toBe(true);
        if (method === 'type') await userEvent.keyboard('x');
        else paste(root, clipboardData[method]);

        const before = prefix + (side === 'before' ? 'x' : '');
        const after = (side === 'after' ? 'x' : '') + suffix;
        const expected = [
          ...(before ? [{text: before, type: 'text'}] : []),
          {text, type: 'link'},
          ...(after ? [{text: after, type: 'text'}] : []),
        ];
        await expect
          .poll(() =>
            editor.read('latest', () => {
              const paragraph = $getRoot().getFirstChildOrThrow();
              assert($isElementNode(paragraph));
              return paragraph.getChildren().map(node => ({
                text: node.getTextContent(),
                type: node.getType(),
              }));
            }),
          )
          .toEqual(expected);
        await expect
          .poll(() =>
            [...root.firstElementChild!.children].map(node => ({
              tag: node.tagName,
              text: node.textContent,
            })),
          )
          .toEqual(
            expected.map(node => ({
              tag: node.type === 'link' ? 'A' : 'SPAN',
              text: node.text,
            })),
          );
        expect(root.querySelector('a')!.getAttribute('href')).toBe('https://');
        expect(root.querySelector('a')!.getAttribute('rel')).toBe('noreferrer');
        editor.read('latest', () => {
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          expect(selection.isCollapsed()).toBe(true);
          expect($isLinkNode(selection.anchor.getNode().getParent())).toBe(
            false,
          );
        });
      },
    );
  });
});
