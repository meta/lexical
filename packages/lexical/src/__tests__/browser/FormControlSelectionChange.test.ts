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
} from 'lexical';
import {assert, describe, expect, onTestFinished, test} from 'vitest';

function settle(ms = 50): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('form-control selectionchange (#9471)', () => {
  test.each(['input', 'textarea'] as const)(
    'preserves pending formatting after a native event from an unfocused %s',
    async tagName => {
      const container = document.createElement('div');
      const contentEditable = document.createElement('div');
      contentEditable.contentEditable = 'true';
      const control = document.createElement(tagName);
      control.value = 'initial';
      container.append(contentEditable, control);
      document.body.appendChild(container);

      const editor = buildEditorFromExtensions({
        dependencies: [RichTextExtension],
        name: 'form-control-selectionchange',
      });
      editor.setRootElement(contentEditable);
      const readSelection = () =>
        editor.read(() => {
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          return {format: selection.format, offset: selection.anchor.offset};
        });
      onTestFinished(() => {
        editor.setRootElement(null);
        editor.dispose();
        container.remove();
      });

      editor.update(
        () => {
          const text = $createTextNode('hello');
          $getRoot().clear().append($createParagraphNode().append(text));
          text.selectEnd();
        },
        {discrete: true},
      );
      await settle();
      editor.update(
        () => {
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          selection.formatText('bold');
        },
        {discrete: true},
      );
      // Outlast the collapsed-format grace period, so it cannot mask a
      // spurious refresh from the unformatted text under the caret.
      await settle(250);
      expect(readSelection()).toEqual({format: 1, offset: 5});
      expect(document.activeElement).toBe(contentEditable);

      const controlEvents: Event[] = [];
      const onSelectionChange = (event: Event) => {
        if (event.target === control) {
          controlEvents.push(event);
        }
      };
      document.addEventListener('selectionchange', onSelectionChange);
      onTestFinished(() =>
        document.removeEventListener('selectionchange', onSelectionChange),
      );

      // Move the control's own selection. Every engine fires this at the
      // control and lets it bubble to the document listener (Firefox and
      // WebKit fire nothing for a value change alone).
      control.setSelectionRange(1, 3);
      await expect.poll(() => controlEvents.length).toBeGreaterThan(0);
      expect(controlEvents[0].isTrusted).toBe(true);
      expect(controlEvents[0].bubbles).toBe(true);
      expect(document.activeElement).toBe(contentEditable);
      expect(readSelection()).toEqual({format: 1, offset: 5});

      editor.update(
        () => {
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          selection.insertText('B');
        },
        {discrete: true},
      );
      expect(contentEditable.textContent).toBe('helloB');
      expect(contentEditable.querySelector('strong')?.textContent).toBe('B');
      await settle();

      // A real document selection change must still refresh both the caret
      // position and its format from the unformatted text.
      const textNode = contentEditable.querySelector('span')?.firstChild;
      assert(textNode);
      document.getSelection()!.setBaseAndExtent(textNode, 2, textNode, 2);
      await expect.poll(readSelection).toEqual({format: 0, offset: 2});
    },
  );
});
