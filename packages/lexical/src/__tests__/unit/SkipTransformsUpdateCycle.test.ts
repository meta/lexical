/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * `skipTransforms` suppresses node transforms for the update cycle, until
 * the pending state commits. An update that joins that pending state runs
 * none either, as an update nested in it does not: one queued after it in
 * the same task, and the revert of DOM changes the mutation observer
 * recorded but had not reported, which runs as the state commits. Before,
 * those ran every transform over what the skipping update changed.
 */

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type LexicalEditor,
  ParagraphNode,
  TextNode,
} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) {
    fn();
  }
  cleanup = [];
});

/** A mounted editor with one paragraph, and the texts its transform saw. */
function mount(): {editor: LexicalEditor; seen: string[]} {
  const editor = createEditor({
    namespace: 'skip-transforms-cycle',
    nodes: [ParagraphNode, TextNode],
    onError: e => {
      throw e;
    },
  });
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  editor.setRootElement(root);
  const seen: string[] = [];
  const unregister = editor.registerNodeTransform(TextNode, node => {
    seen.push(node.getTextContent());
  });
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append($createParagraphNode().append($createTextNode('start')));
    },
    {discrete: true},
  );
  seen.length = 0;
  cleanup.push(() => {
    unregister();
    editor.setRootElement(null);
    root.remove();
  });
  return {editor, seen};
}

const $setText = (text: string) =>
  ($getRoot().getFirstDescendant() as TextNode).setTextContent(text);

/** A DOM change the observer records, not yet reported to the editor. */
function changeDOM(editor: LexicalEditor) {
  const stray = document.createElement('span');
  stray.className = 'stray';
  editor.getRootElement()!.appendChild(stray);
}

describe('skipTransforms holds for the update cycle', () => {
  test('a commit that first reverts recorded DOM changes runs no transforms', () => {
    const {editor, seen} = mount();
    changeDOM(editor);
    editor.update(() => $setText('remote'), {
      discrete: true,
      skipTransforms: true,
    });
    expect(seen).toEqual([]);
    expect(editor.read(() => $getRoot().getTextContent())).toBe('remote');
    // The DOM change was reverted.
    expect(editor.getRootElement()!.querySelector('.stray')).toBe(null);
  });

  test('without skipTransforms, the same commit runs them', () => {
    const {editor, seen} = mount();
    changeDOM(editor);
    editor.update(() => $setText('local'), {discrete: true});
    expect(seen).toContain('local');
  });

  test('an update queued after it in the same task runs no transforms', async () => {
    const {editor, seen} = mount();
    editor.update(() => $setText('remote'), {skipTransforms: true});
    editor.update(() => {});
    await Promise.resolve();
    expect(editor.read(() => $getRoot().getTextContent())).toBe('remote');
    expect(seen).toEqual([]);
  });

  test('the next update cycle runs transforms again', () => {
    const {editor, seen} = mount();
    editor.update(() => $setText('remote'), {
      discrete: true,
      skipTransforms: true,
    });
    editor.update(() => $setText('local'), {discrete: true});
    expect(seen).toEqual(['local']);
  });
});
