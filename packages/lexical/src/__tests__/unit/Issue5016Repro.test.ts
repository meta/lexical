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
  getDOMSelection,
  HISTORY_MERGE_TAG,
  isDOMTextNode,
  type LexicalEditor,
  TextNode,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test} from 'vitest';

// Registering a transform marks the existing nodes of that type dirty so the
// transform runs on them (#5016). That update must not move focus or the DOM
// selection into the editor, e.g. when a plugin re-registers its transforms
// while the user is typing in another input.
describe('registerNodeTransform focus (#5016)', () => {
  function setup(): {editor: LexicalEditor; input: HTMLInputElement} {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    const input = document.createElement('input');
    document.body.append(input, root);
    const editor = buildEditorFromExtensions({
      dependencies: [RichTextExtension],
      name: '[issue-5016]',
    });
    editor.setRootElement(root);
    onTestFinished(() => {
      editor.dispose();
      root.remove();
      input.remove();
    });
    root.focus();
    editor.update(
      () => {
        const text = $createTextNode('hello');
        $getRoot().clear().append($createParagraphNode().append(text));
        text.select(5, 5);
      },
      {discrete: true},
    );
    return {editor, input};
  }

  function registerTextTransform(editor: LexicalEditor): {
    tags: Set<string>[];
    transformed: string[];
  } {
    const tags: Set<string>[] = [];
    const transformed: string[] = [];
    onTestFinished(
      editor.registerUpdateListener(({tags: updateTags, dirtyLeaves}) => {
        if (dirtyLeaves.size > 0) {
          tags.push(updateTags);
        }
      }),
    );
    onTestFinished(
      editor.registerNodeTransform(TextNode, node => {
        transformed.push(node.getTextContent());
      }),
    );
    // Commit the update scheduled by registerNodeTransform
    editor.read(() => {});
    return {tags, transformed};
  }

  test('keeps focus in an input outside the editor', () => {
    const {editor, input} = setup();
    const textDOM = editor
      .getRootElement()
      ?.querySelector('[data-lexical-text]')?.firstChild;
    assert(isDOMTextNode(textDOM), 'Expected the text node of "hello"');
    input.focus();
    // jsdom moves the selection to the focused input; browsers leave it in the
    // contenteditable, which is what this restores.
    const domSelection = getDOMSelection(window);
    assert(domSelection !== null, 'Expected a DOM selection');
    domSelection.setBaseAndExtent(textDOM, 5, textDOM, 5);

    const {tags, transformed} = registerTextTransform(editor);

    expect(transformed).toEqual(['hello']);
    expect(tags.length).toBe(1);
    expect(tags[0].has(HISTORY_MERGE_TAG)).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  test('does not move the DOM selection out of an input outside the editor', () => {
    const {editor, input} = setup();
    input.value = 'outside';
    input.focus();
    input.setSelectionRange(3, 3);
    const domSelection = getDOMSelection(window);
    assert(domSelection !== null, 'Expected a DOM selection');
    const anchorBefore = domSelection.anchorNode;

    const {transformed} = registerTextTransform(editor);

    expect(transformed).toEqual(['hello']);
    expect(document.activeElement).toBe(input);
    expect(domSelection.anchorNode).toBe(anchorBefore);
    expect(input.selectionStart).toBe(3);
  });

  test('keeps focus and the caret when the editor has focus', () => {
    const {editor} = setup();
    const root = editor.getRootElement();
    assert(root !== null, 'Expected a root element');
    expect(document.activeElement).toBe(root);

    const {tags, transformed} = registerTextTransform(editor);

    expect(transformed).toEqual(['hello']);
    expect(tags[0].has(HISTORY_MERGE_TAG)).toBe(true);
    expect(document.activeElement).toBe(root);
    const domSelection = getDOMSelection(window);
    assert(domSelection !== null, 'Expected a DOM selection');
    expect(domSelection.anchorNode?.textContent).toBe('hello');
    expect(domSelection.anchorOffset).toBe(5);
  });
});
