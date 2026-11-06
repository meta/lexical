/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {HeadlessExtension} from '@lexical/headless';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  defineExtension,
} from 'lexical';
import {describe, expect, it, vi} from 'vitest';

function buildHeadlessEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [HeadlessExtension, RichTextExtension],
      name: '[root]',
    }),
  );
}

describe('HeadlessExtension', () => {
  it('marks the editor headless and still runs updates and listeners', () => {
    using editor = buildHeadlessEditor();
    expect(editor._headless).toBe(true);
    const listener = vi.fn();
    editor.registerUpdateListener(({editorState}) =>
      listener(editorState.read(() => $getRoot().getTextContent())),
    );
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('Hello')));
      },
      {discrete: true},
    );
    expect(listener).toHaveBeenLastCalledWith('Hello');
    expect(editor.read(() => $getRoot().getTextContent())).toBe('Hello');
  });

  it('refuses a root element but allows setting it to null', () => {
    using editor = buildHeadlessEditor();
    expect(() => editor.setRootElement(document.createElement('div'))).toThrow(
      'HeadlessExtension: setRootElement is not supported in headless mode',
    );
    expect(editor.getRootElement()).toBe(null);
    expect(() => editor.setRootElement(null)).not.toThrow();
  });

  it('keeps listener registration working for other extensions', () => {
    using editor = buildHeadlessEditor();
    const rootListener = vi.fn();
    const unregister = editor.registerRootListener(rootListener);
    expect(rootListener).toHaveBeenCalledWith(null, null);
    unregister();
  });

  it('makes nested editors headless', () => {
    using editor = buildHeadlessEditor();
    const nested = createEditor({parentEditor: editor});
    expect(nested._headless).toBe(true);
  });
});
