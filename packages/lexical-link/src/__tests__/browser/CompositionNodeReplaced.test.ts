/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// An app's update during an IME composition that moves or recreates the DOM
// of the composing text (unwrapping the link it is in, moving its paragraph)
// makes Chromium end the composition without a compositionend event; the
// commit then arrives as plain input. The editor ends its composition too
// (it kept `_compositionKey` set:
// https://github.com/meta/lexical/issues/9801).

import {
  buildEditorFromExtensions,
  defineExtension,
  getExtensionDependencyFromEditor,
  IMEExtension,
} from '@lexical/extension';
import {$createLinkNode, $isLinkNode, LinkExtension} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  COMMAND_PRIORITY_CRITICAL,
  COMPOSITION_START_COMMAND,
  type ElementNode,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';
import {cdp, server, userEvent} from 'vitest/browser';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Change = 'none' | 'unwrap the link' | 'move the paragraph';

/**
 * An editor with `Before.` and `See the ` + link `Meta wiki` + `.`, an IME
 * composition of `か` at `Me|ta`, then `change` in an app's update.
 */
async function composeThenChange(change: Change): Promise<{
  contentEditable: HTMLElement;
  editor: LexicalEditor;
  session: ReturnType<typeof cdp>;
}> {
  const contentEditable = document.createElement('div');
  contentEditable.contentEditable = 'true';
  document.body.appendChild(contentEditable);
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [RichTextExtension, LinkExtension, IMEExtension],
      name: '[composition-node-replaced]',
    }),
  );
  editor.setRootElement(contentEditable);
  onTestFinished(() => {
    editor.setRootElement(null);
    contentEditable.remove();
    editor.dispose();
  });
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append($createTextNode('Before.')),
          $createParagraphNode().append(
            $createTextNode('See the '),
            $createLinkNode('https://example.com').append(
              $createTextNode('Meta wiki'),
            ),
            $createTextNode('.'),
          ),
        );
    },
    {discrete: true},
  );
  contentEditable.focus();
  const text = contentEditable.querySelector('a span')!.firstChild!;
  window.getSelection()!.setBaseAndExtent(text, 2, text, 2);
  await wait(100);
  const session = cdp();
  await session.send('Input.imeSetComposition', {
    selectionEnd: 1,
    selectionStart: 1,
    text: 'か',
  });
  await wait(100);
  expect(editor._compositionKey).not.toBe(null);
  editor.update(
    () => {
      const block = $getRoot().getLastChildOrThrow() as ElementNode;
      const link = block.getChildren().find($isLinkNode)!;
      if (change === 'unwrap the link') {
        for (const child of link.getChildren()) {
          link.insertBefore(child);
        }
        link.remove();
      } else if (change === 'move the paragraph') {
        block.getPreviousSibling()!.insertBefore(block);
      }
    },
    {discrete: true},
  );
  await wait(100);
  return {contentEditable, editor, session};
}

const $blocks = () =>
  $getRoot()
    .getChildren()
    .map(n => n.getTextContent());

describe.runIf(server.browser === 'chromium')(
  'an app update that moves the composing text',
  () => {
    for (const change of [
      'none',
      'unwrap the link',
      'move the paragraph',
    ] as const) {
      test(`${change}: the editor's composition ends with the browser's`, async () => {
        const {contentEditable, editor, session} =
          await composeThenChange(change);
        await session.send('Input.insertText', {text: '漢'});
        await wait(100);
        expect(editor._compositionKey).toBe(null);
        expect(
          getExtensionDependencyFromEditor(editor, IMEExtension).output
            .compositionKey.value,
        ).toBe(null);
        expect(editor.read(() => $blocks().join('|'))).toBe(
          contentEditable.innerText.replace(/\n+/g, '|'),
        );
        if (change === 'none') {
          expect(contentEditable.innerText).toContain('Me漢ta');
        }
        // Key commands dispatch again.
        let enters = 0;
        editor.registerCommand(
          KEY_ENTER_COMMAND,
          () => {
            enters++;
            return false;
          },
          COMMAND_PRIORITY_CRITICAL,
        );
        await userEvent.keyboard('{Enter}');
        await wait(50);
        expect(enters).toBe(1);
      });
    }

    test('the first key after the browser ended the composition reaches its command', async () => {
      // No commit in between: the key's own keydown ends the editor's
      // composition (Enter, arrows, Tab, Escape dispatch from keydown).
      const {editor} = await composeThenChange('unwrap the link');
      let enters = 0;
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        () => {
          enters++;
          return false;
        },
        COMMAND_PRIORITY_CRITICAL,
      );
      await userEvent.keyboard('{Enter}');
      await wait(50);
      expect(enters).toBe(1);
      expect(editor._compositionKey).toBe(null);
    });

    test('a selection made after the browser ended the composition is deleted as made', async () => {
      const {contentEditable, editor} =
        await composeThenChange('unwrap the link');
      const [first, second] = contentEditable.querySelectorAll('p');
      const from = first.querySelector('span')!.firstChild!;
      const to = second.querySelector('span')!.firstChild!;
      window.getSelection()!.setBaseAndExtent(from, 3, to, 5);
      await wait(50);
      await userEvent.keyboard('{Backspace}');
      await wait(100);
      expect(editor._compositionKey).toBe(null);
      expect(editor.read(() => $blocks())).toEqual(['Befhe Meかta wiki.']);
    });

    test('a new composition after the browser ended one is composed', async () => {
      const {editor, session} = await composeThenChange('unwrap the link');
      // The new composition starts as one: the ended one is not open then.
      let openAtStart: string | null | undefined;
      editor.registerCommand(
        COMPOSITION_START_COMMAND,
        () => {
          openAtStart = editor._compositionKey;
          return false;
        },
        COMMAND_PRIORITY_CRITICAL,
      );
      await session.send('Input.imeSetComposition', {
        selectionEnd: 1,
        selectionStart: 1,
        text: 'さ',
      });
      await wait(100);
      expect(openAtStart).toBe(null);
      expect(editor._compositionKey).not.toBe(null);
      await session.send('Input.insertText', {text: '佐'});
      await wait(100);
      expect(editor._compositionKey).toBe(null);
      const text = editor.read(() => $blocks().join('|'));
      expect(text.split('佐')).toHaveLength(2);
      expect(text).not.toContain('さ');
    });
  },
);
