/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {RovingTabIndexExtension} from '@lexical/a11y';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {assert, expect, onTestFinished, test, vi} from 'vitest';

import FloatingTextFormatToolbarPlugin from '../../plugins/FloatingTextFormatToolbarPlugin';

test('floating toolbar measures only reconciled DOM after programmatic selection and text changes', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  let editor: LexicalEditor | undefined;
  const extension = defineExtension({
    dependencies: [RichTextExtension, RovingTabIndexExtension],
    name: 'test/selection-toolbar-timing',
    register: instance => {
      editor = instance;
      return () => {};
    },
  });
  onTestFinished(() => {
    act(() => reactRoot.unmount());
    container.remove();
  });
  await act(async () => {
    reactRoot.render(
      <LexicalExtensionComposer extension={extension}>
        <FloatingTextFormatToolbarPlugin
          anchorElem={container}
          setIsLinkEditMode={() => {}}
        />
      </LexicalExtensionComposer>,
    );
  });
  assert(editor !== undefined);
  const lexicalEditor = editor;
  await act(async () => {
    lexicalEditor.update(
      () => {
        $getRoot().clear();
        for (const text of ['line one', 'line two', 'line three']) {
          $getRoot().append(
            $createParagraphNode().append($createTextNode(text)),
          );
        }
        $getRoot().getAllTextNodes()[0].select(0, 4);
      },
      {discrete: true},
    );
    await new Promise(resolve => setTimeout(resolve, 75));
  });
  expect(container.querySelector('.floating-text-format-popup')).not.toBeNull();
  const measuredTexts: (string | null)[] = [];
  const measuredTops: number[] = [];
  const original = Range.prototype.getBoundingClientRect;
  const spy = vi
    .spyOn(Range.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: Range) {
      const rect = original.call(this);
      measuredTexts.push(lexicalEditor.getRootElement()!.textContent);
      measuredTops.push(rect.top);
      return rect;
    });
  onTestFinished(() => spy.mockRestore());
  act(() => {
    lexicalEditor.update(
      () => {
        const texts = $getRoot().getAllTextNodes();
        texts[0].setTextContent('CHANGED');
        texts[2].select(0, 4);
      },
      {discrete: true},
    );
  });
  expect(measuredTexts.length).toBeGreaterThan(0);
  expect(new Set(measuredTexts)).toEqual(
    new Set(['CHANGEDline twoline three']),
  );
  const expectedTop = window
    .getSelection()!
    .getRangeAt(0)
    .getBoundingClientRect().top;
  expect(measuredTops.every(top => top === expectedTop)).toBe(true);
});
