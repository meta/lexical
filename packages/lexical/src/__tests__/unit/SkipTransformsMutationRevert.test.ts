/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * The revert of DOM changes the mutation observer recorded runs in an update
 * that joins the pending state, when there is one: a commit starts it first,
 * the observer's own callback can run before a queued commit, and
 * setEditorState starts one. After an update made with `skipTransforms`,
 * that revert runs no node transforms either; before, it ran every transform
 * over what the skipping update had changed. It still runs them when it
 * brings text typed in the DOM into the editor state, which they would
 * otherwise never see. Every other update that joins such a state (one
 * queued after it in the same task, `registerNodeTransform`'s pass over
 * existing nodes, edits a `SELECTION_CHANGE_COMMAND` handler makes as it
 * commits) runs transforms as before.
 */

import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isParagraphNode,
  COMMAND_PRIORITY_EDITOR,
  createEditor,
  DecoratorNode,
  type LexicalEditor,
  ParagraphNode,
  SELECTION_CHANGE_COMMAND,
  TextNode,
} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

class BadgeNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_skip_transforms_badge', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('span');
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

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
    nodes: [ParagraphNode, TextNode, BadgeNode],
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

  test("started by the observer's callback before the update commits, runs no transforms", async () => {
    const {editor, seen} = mount();
    // Recorded first: the observer's callback runs before the commit the
    // update queues, and its revert joins the pending state.
    changeDOM(editor);
    editor.update(() => $setText('remote'), {skipTransforms: true});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(editor.getRootElement()!.querySelector('.stray')).toBe(null);
    expect(editor.read(() => $getRoot().getTextContent())).toBe('remote');
    expect(seen).toEqual([]);
  });

  test('started by setEditorState while the update is pending, runs no transforms', async () => {
    const {editor, seen} = mount();
    const saved = editor.getEditorState();
    editor.update(() => $setText('remote'), {skipTransforms: true});
    editor.setEditorState(saved);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(seen).toEqual([]);
  });

  test("runs no transforms for a text change in a decorator's DOM", async () => {
    const {editor, seen} = mount();
    let badge = '';
    editor.update(
      () => {
        const node = $create(BadgeNode);
        badge = node.getKey();
        $getRoot().append($createParagraphNode().append(node));
      },
      {discrete: true},
    );
    // The decorator renders (a childList change), which is processed.
    editor.getElementByKey(badge)!.textContent = 'render 1';
    await new Promise(resolve => setTimeout(resolve, 0));
    seen.length = 0;
    // It renders again, changing its text node's value (a characterData
    // change), as React does, just before the update.
    (editor.getElementByKey(badge)!.firstChild as Text).nodeValue = 'render 2';
    editor.update(() => $setText('remote'), {
      discrete: true,
      skipTransforms: true,
    });
    expect(editor.read(() => $getRoot().getTextContent())).toContain('remote');
    expect(seen).toEqual([]);
  });

  test("runs them when it applies a change to the text of a TextNode's DOM", () => {
    const {editor, seen} = mount();
    editor.update(
      () => {
        $getRoot().append($createParagraphNode().append($createTextNode('b')));
      },
      {discrete: true},
    );
    seen.length = 0;
    // An autocorrect or spellcheck replaced the first text in the DOM.
    const key = editor.read(() => $getRoot().getFirstDescendant()!.getKey());
    (editor.getElementByKey(key)!.firstChild as Text).data = 'start typed';
    editor.update(
      () =>
        ($getRoot().getLastDescendant() as TextNode).setTextContent('remote'),
      {discrete: true, skipTransforms: true},
    );
    expect(editor.read(() => $getRoot().getTextContent())).toBe(
      'start typed\n\nremote',
    );
    expect(seen).toContain('start typed');
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
