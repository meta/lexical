/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {buildEditorFromExtensions} from '@lexical/extension';
import {domOverride, DOMRenderExtension} from '@lexical/html';
import {
  $createAutoLinkNode,
  AutoLinkExtension,
  createLinkMatcherWithRegExp,
} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSlot,
  configExtension,
} from 'lexical';
import {assert, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

for (const slotted of [false, true]) {
  for (const elementPoint of [false, true]) {
    for (const backward of [true, false]) {
      test(`${backward ? 'Backspace' : 'Delete'} removes a character beside an autolink in ${slotted ? 'slot' : 'body'} ${elementPoint ? 'element' : 'text'} point`, async () => {
        const root = document.createElement('div');
        root.contentEditable = 'true';
        document.body.append(root);
        const editor = buildEditorFromExtensions({
          dependencies: [
            RichTextExtension,
            configExtension(DOMRenderExtension, {
              overrides: [
                domOverride('*', {
                  $getSlotTargetElement: (_node, _slotName, hostDOM) => hostDOM,
                }),
              ],
            }),
            configExtension(AutoLinkExtension, {
              matchers: [
                createLinkMatcherWithRegExp(
                  /https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
                ),
              ],
            }),
          ],
          name: 'autolink-slot-repro',
        });
        editor.setRootElement(root);
        onTestFinished(() => {
          editor.dispose();
          root.remove();
        });
        let paragraphKey = '';
        editor.update(
          () => {
            const paragraph = $createParagraphNode().append(
              $createTextNode('hello, '),
              $createAutoLinkNode('https://example.com').append(
                $createTextNode('https://example.comworld'),
              ),
              $createTextNode(' !!!'),
            );
            paragraphKey = paragraph.getKey();
            if (slotted) {
              const host = $createParagraphNode().append(
                $createTextNode('Body'),
              );
              $getRoot().clear().append(host);
              $setSlot(host, 'author', paragraph);
            } else {
              $getRoot().clear().append(paragraph);
            }
          },
          {discrete: true},
        );
        editor.update(
          () => {
            const paragraph = $getNodeByKey(paragraphKey);
            assert($isElementNode(paragraph));
            const link = paragraph.getChildren()[1];
            assert($isElementNode(link));
            const text = link.getFirstChildOrThrow();
            assert($isTextNode(text));
            if (elementPoint) {
              paragraph.select(backward ? 2 : 1, backward ? 2 : 1);
            } else if (backward) {
              text.selectEnd();
            } else {
              text.selectStart();
            }
          },
          {discrete: true},
        );
        root.focus();
        await userEvent.keyboard(backward ? '{Backspace}' : '{Delete}');
        expect(
          editor.read(() => $getNodeByKey(paragraphKey)?.getTextContent()),
        ).toBe(
          backward
            ? 'hello, https://example.comworl !!!'
            : 'hello, ttps://example.comworld !!!',
        );
      });
    }
  }
}
