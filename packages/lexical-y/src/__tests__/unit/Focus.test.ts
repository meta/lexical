/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A remote change must not set the DOM selection of an editor that is not
// focused: in a browser, setting it moves the focus into that editor (two
// collaborative editors on one page, a comment box next to the editor). A
// focused editor must keep its DOM caret when the list refresh after a remote
// change reshapes the DOM under it.
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  registerListStrictIndentTransform,
} from '@lexical/list';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COLLABORATION_TAG,
  createEditor,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {afterEach, describe, expect, test, vi} from 'vitest';

import {
  $block,
  expectConverged,
  flush,
  NODES,
  Peer,
  setup,
} from '../utils/harness';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('@lexical/y and the focus', () => {
  test.each([
    [
      'replaces the selected text and selects the end of the new text',
      'replace',
      'paragraph("replacement")',
      'replacement',
      11,
    ],
    ['moves the caret', 'move', 'paragraph("hello")', 'hello', 5],
    [
      'adds a paragraph, the caret of the initial content staying',
      'append',
      'paragraph("hello") / paragraph("more")',
      'hello',
      2,
    ],
  ] as const)(
    'R3-2: an app update queued in reply to the read that %s keeps its selection',
    async (_name, reply, shown, caretText, caretOffset) => {
      const root = document.createElement('div');
      root.contentEditable = 'true';
      document.body.appendChild(root);
      let replied = false;
      const peer = new Peer(
        1,
        {delivery: 'causal', peers: [], pumping: false, queue: []},
        undefined,
        editor => {
          editor.setRootElement(root);
          editor.registerUpdateListener(({tags}) => {
            if (replied || !tags.has(COLLABORATION_TAG)) {
              return;
            }
            replied = true;
            editor.update(
              () => {
                if (reply === 'replace') {
                  const text = $createTextNode('replacement');
                  $getRoot()
                    .clear()
                    .append($createParagraphNode().append(text));
                  text.selectEnd();
                } else if (reply === 'move') {
                  $assertNodeType(
                    $block([0]).getFirstChild(),
                    $isTextNode,
                  ).select(5, 5);
                } else {
                  $getRoot().append(
                    $createParagraphNode().append($createTextNode('more')),
                  );
                }
              },
              {discrete: true},
            );
          });
        },
      );
      root.focus();
      peer.update(() => {
        const text = $createTextNode('hello');
        $getRoot().clear().append($createParagraphNode().append(text));
        text.select(2, 2);
      });
      peer.binding.initialize();
      await flush();
      expect(replied).toBe(true);
      expect(peer.errors).toEqual([]);
      expect(peer.binding.status).toBe('active');
      expect(peer.describe()).toBe(shown);
      const selection = document.getSelection()!;
      expect(selection.anchorNode?.textContent).toBe(caretText);
      expect(selection.anchorOffset).toBe(caretOffset);
      const fresh = new Peer(2, {
        delivery: 'causal',
        peers: [],
        pumping: false,
        queue: [],
      });
      Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(peer.doc));
      fresh.binding.initialize();
      await flush();
      expect(fresh.describe()).toBe(peer.describe());
      peer.editor.setRootElement(null);
    },
  );

  test('R4-1: an editor state an app sets in reply to the read stands, with its selection', async () => {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    let replied = false;
    const peer = new Peer(
      1,
      {delivery: 'causal', peers: [], pumping: false, queue: []},
      undefined,
      editor => {
        editor.setRootElement(root);
        editor.registerUpdateListener(({tags}) => {
          if (replied || !tags.has(COLLABORATION_TAG)) {
            return;
          }
          replied = true;
          const source = createEditor({
            nodes: NODES,
            onError: e => {
              throw e;
            },
          });
          source.update(
            () => {
              $getRoot()
                .clear()
                .append(
                  $createParagraphNode().append($createTextNode('replacement')),
                );
            },
            {discrete: true},
          );
          editor.setEditorState(
            editor.parseEditorState(source.getEditorState().toJSON(), () => {
              $getRoot().selectEnd();
            }),
          );
          editor.update(() => {}, {discrete: true});
        });
      },
    );
    root.focus();
    peer.update(() => {
      const text = $createTextNode('hello');
      $getRoot().clear().append($createParagraphNode().append(text));
      text.select(2, 2);
    });
    peer.binding.initialize();
    await flush();
    expect(replied).toBe(true);
    expect(peer.errors).toEqual([]);
    expect(peer.binding.status).toBe('active');
    expect(peer.describe()).toBe('paragraph("replacement")');
    const selection = document.getSelection()!;
    expect(selection.anchorNode?.textContent).toBe('replacement');
    expect(selection.anchorOffset).toBe(11);
    const fresh = new Peer(2, {
      delivery: 'causal',
      peers: [],
      pumping: false,
      queue: [],
    });
    Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(peer.doc));
    fresh.binding.initialize();
    await flush();
    expect(fresh.describe()).toBe(peer.describe());
    peer.editor.setRootElement(null);
  });

  test('R2-2: a focused editor gets the caret of its initial content on the DOM once the binding is active', async () => {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    const peer = new Peer(
      1,
      {delivery: 'causal', peers: [], pumping: false, queue: []},
      undefined,
      editor => editor.setRootElement(root),
    );
    root.focus();
    peer.update(() => {
      const text = $createTextNode('hello');
      $getRoot().clear().append($createParagraphNode().append(text));
      text.select(2, 2);
    });
    peer.binding.initialize();
    await flush();
    expect(peer.binding.status).toBe('active');
    expect(peer.editor.isEditable()).toBe(true);
    const selection = document.getSelection()!;
    expect(selection.anchorNode?.textContent).toBe('hello');
    expect(selection.anchorOffset).toBe(2);
    peer.editor.setRootElement(null);
  });

  test('a remote list change does not set the DOM selection of an unfocused editor', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('a')),
        ),
      ),
    );
    const roots = t.peers.map(() => {
      const el = document.createElement('div');
      el.contentEditable = 'true';
      document.body.appendChild(el);
      return el;
    });
    t.peers.forEach((p, i) => p.editor.setRootElement(roots[i]));
    // B has a selection but is not focused (the focus is on the page).
    t.b.update(() => {
      $assertNodeType($block([0, 0]).getFirstChild(), $isTextNode).select(1, 1);
    });
    expect(document.activeElement).not.toBe(roots[1]);
    const setBaseAndExtent = vi.spyOn(Selection.prototype, 'setBaseAndExtent');
    // A adds an item: B reads it, then renumbers the list.
    t.a.update(() => {
      $block([0]).append($createListItemNode().append($createTextNode('b')));
    });
    await t.sync();
    await expectConverged(t.peers, 'list[bullet](listitem("a") listitem("b"))');
    expect(setBaseAndExtent).not.toHaveBeenCalled();
    t.peers.forEach(p => p.editor.setRootElement(null));
  });

  test('a focused editor keeps its DOM caret when a remote change reshapes its list', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('a')),
          $createListItemNode().append($createTextNode('bbb')),
        ),
      ),
    );
    // B runs the strict indent transform (an app list transform); A does not.
    const unregister = registerListStrictIndentTransform(t.b.editor);
    const roots = t.peers.map(() => {
      const el = document.createElement('div');
      el.contentEditable = 'true';
      el.tabIndex = 0;
      document.body.appendChild(el);
      return el;
    });
    t.peers.forEach((p, i) => p.editor.setRootElement(roots[i]));
    roots[1].focus();
    expect(document.activeElement).toBe(roots[1]);
    t.b.update(() => {
      $assertNodeType($block([0, 1]).getFirstChild(), $isTextNode).select(2, 2);
    });
    const domCaret = () => {
      const s = window.getSelection()!;
      return {
        inRoot: s.anchorNode !== null && roots[1].contains(s.anchorNode),
        offset: s.anchorOffset,
        text: s.anchorNode ? s.anchorNode.textContent : null,
      };
    };
    expect(domCaret()).toEqual({inRoot: true, offset: 2, text: 'bbb'});
    // A removes "a" and indents "bbb", which gives the item new DOM on B.
    // B's app transform (strict indent) applies to B's own edits only: B
    // shows the document as stored, as A and any fresh reader do.
    t.a.update(() => {
      const list = $block([0]);
      list.getFirstChild()!.remove();
      $assertNodeType(list.getFirstChild(), $isListItemNode).setIndent(1);
    });
    await t.sync();
    const indent = t.b.read(() => {
      const li = $getRoot().getFirstDescendant()?.getParent();
      return $isListItemNode(li) ? li.getIndent() : -1;
    });
    const caret = t.b.read(() => {
      const s = $getSelection();
      return $isRangeSelection(s)
        ? [s.anchor.getNode().getTextContent(), s.anchor.offset]
        : null;
    });
    const dom = domCaret();
    unregister();
    t.peers.forEach(p => p.editor.setRootElement(null));
    expect(indent).toBe(1);
    expect(caret).toEqual(['bbb', 2]);
    expect(dom).toEqual({inRoot: true, offset: 2, text: 'bbb'});
  });
});
