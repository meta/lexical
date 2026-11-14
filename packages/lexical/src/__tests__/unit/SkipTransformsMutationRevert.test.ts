/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * A commit first reverts the DOM changes the mutation observer recorded but
 * had not reported, in an update that joins the pending state. After an
 * update made with `skipTransforms`, that revert runs no node transforms
 * either; before, it ran every transform over what the skipping update had
 * changed. Every other update that joins such a state (one queued after it
 * in the same task, `registerNodeTransform`'s pass over existing nodes,
 * edits a `SELECTION_CHANGE_COMMAND` handler makes as it commits) runs
 * transforms as before.
 */

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isParagraphNode,
  COMMAND_PRIORITY_EDITOR,
  createEditor,
  type LexicalEditor,
  ParagraphNode,
  SELECTION_CHANGE_COMMAND,
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
    namespace: 'skip-transforms-mutation-revert',
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

describe('the revert of recorded DOM changes in a commit', () => {
  test('runs no transforms when the update skipped them', () => {
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

  test('runs them when the update did not skip them', () => {
    const {editor, seen} = mount();
    changeDOM(editor);
    editor.update(() => $setText('local'), {discrete: true});
    expect(seen).toContain('local');
  });
});

describe('other updates that join a pending state made with skipTransforms run transforms', () => {
  test('an update queued after it in the same task', async () => {
    const {editor, seen} = mount();
    editor.update(() => $setText('remote'), {skipTransforms: true});
    editor.update(() => {
      $getRoot().append($createParagraphNode().append($createTextNode('mine')));
    });
    await Promise.resolve();
    expect(editor.read(() => $getRoot().getTextContent())).toBe(
      'remote\n\nmine',
    );
    expect(seen).toContain('mine');
  });

  test("registerNodeTransform's pass over the existing nodes", async () => {
    const {editor} = mount();
    editor.update(() => $setText('remote'), {skipTransforms: true});
    const registered: string[] = [];
    cleanup.push(
      editor.registerNodeTransform(TextNode, node => {
        registered.push(node.getTextContent());
      }),
    );
    await Promise.resolve();
    expect(registered).toContain('remote');
  });

  test('edits a SELECTION_CHANGE_COMMAND handler makes as it commits', () => {
    const {editor, seen} = mount();
    let handled = false;
    cleanup.push(
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          if (!handled) {
            handled = true;
            $getRoot().append(
              $createParagraphNode().append($createTextNode('handler')),
            );
          }
          return false;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
    );
    editor.update(
      () => {
        $setText('remote');
        const paragraph = $getRoot().getFirstChild();
        if ($isParagraphNode(paragraph)) {
          paragraph.selectEnd();
        }
      },
      {discrete: true, skipTransforms: true},
    );
    expect(handled).toBe(true);
    expect(editor.read(() => $getRoot().getTextContent())).toContain('handler');
    expect(seen).toContain('handler');
  });
});

test('the next update cycle runs transforms', () => {
  const {editor, seen} = mount();
  editor.update(() => $setText('remote'), {
    discrete: true,
    skipTransforms: true,
  });
  editor.update(() => $setText('local'), {discrete: true});
  expect(seen).toEqual(['local']);
});
