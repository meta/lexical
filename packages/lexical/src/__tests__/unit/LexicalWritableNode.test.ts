/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {describe, expect, test, vi} from 'vitest';

import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  createEditor,
  type TextNode,
} from '../..';

function createHeadlessEditor() {
  return createEditor({
    onError: error => {
      throw error;
    },
  });
}

describe('writable node reuse', () => {
  test('returns cached writable nodes without looking them up in the node map', () => {
    const editor = createHeadlessEditor();
    editor.update(
      () => {
        const text = $createTextNode('text');
        $getRoot().append($createParagraphNode().append(text));
        const writable = text.getWritable();
        const pendingState = editor._pendingEditorState;
        if (pendingState === null) {
          throw new Error('Expected a pending editor state');
        }
        const get = vi.spyOn(pendingState._nodeMap, 'get');
        try {
          expect(text.getWritable()).toBe(writable);
          expect(get).not.toHaveBeenCalledWith(text.getKey());
        } finally {
          get.mockRestore();
        }
      },
      {discrete: true},
    );
  });

  test('reuses new nodes and clones committed nodes once per update', () => {
    const editor = createHeadlessEditor();
    let original!: TextNode;
    editor.update(
      () => {
        original = $createTextNode('original');
        expect(original.getWritable()).toBe(original);
        $getRoot().append($createParagraphNode().append(original));
      },
      {discrete: true},
    );
    const originalState = editor.getEditorState();
    let firstClone!: TextNode;
    editor.update(
      () => {
        firstClone = original.setTextContent('first');
        expect(firstClone).not.toBe(original);
        expect(original.getWritable()).toBe(firstClone);
        expect(firstClone.getWritable()).toBe(firstClone);
        originalState.read(() => {
          expect(original.getLatest()).toBe(original);
          expect(original.getTextContent()).toBe('original');
          expect(() => original.getWritable()).toThrow();
        });
        expect(original.getWritable()).toBe(firstClone);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const secondClone = original.setTextContent('second');
        expect(secondClone).not.toBe(firstClone);
        expect(secondClone).not.toBe(original);
        expect(firstClone.__text).toBe('first');
        expect(original.__text).toBe('original');
        expect(original.getWritable()).toBe(secondClone);
      },
      {discrete: true},
    );
  });

  test('reuses live writable nodes across batched updates until commit', () => {
    const editor = createHeadlessEditor();
    let original!: TextNode;
    editor.update(
      () => {
        original = $createTextNode('original');
        $getRoot().append($createParagraphNode().append(original));
      },
      {discrete: true},
    );
    let writable!: TextNode;
    editor.update(() => {
      writable = original.setTextContent('first');
      expect(writable).not.toBe(original);
    });
    expect(editor._pendingEditorState).not.toBeNull();
    editor.update(
      () => {
        expect(original.getWritable()).toBe(writable);
        expect(original.setTextContent('second')).toBe(writable);
        expect(original.__text).toBe('original');
      },
      {discrete: true},
    );
    editor.update(() => expect(original.getWritable()).not.toBe(writable), {
      discrete: true,
    });
  });

  test('marks the current parent dirty when writing through a stale reference', () => {
    const editor = createHeadlessEditor();
    let original!: TextNode;
    let oldParentKey!: string;
    let currentParentKey!: string;
    editor.update(
      () => {
        original = $createTextNode('original');
        const paragraph = $createParagraphNode().append(original);
        oldParentKey = paragraph.getKey();
        $getRoot().append(paragraph);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        currentParentKey = paragraph.getKey();
        $getRoot().append(paragraph);
        paragraph.append(original);
      },
      {discrete: true},
    );
    expect(original.__parent).toBe(oldParentKey);
    editor.update(
      () => {
        original.setTextContent('changed');
        expect(editor._dirtyElements.has(currentParentKey)).toBe(true);
        expect(editor._dirtyElements.has(oldParentKey)).toBe(false);
      },
      {discrete: true},
    );
  });

  test('does not reuse a collected subtree in a subsequent batched update', () => {
    const editor = createHeadlessEditor();
    let text!: TextNode;
    editor.update(() => {
      text = $createTextNode('detached');
      const paragraph = $createParagraphNode().append(text);
      $getRoot().append(paragraph);
      paragraph.remove();
    });
    // GC has run, but the pending state has not committed yet.
    expect(editor._pendingEditorState).not.toBeNull();
    editor.update(
      () => {
        expect($getNodeByKey(text.getKey())).toBeNull();
        expect(() => text.getWritable()).toThrow(
          'Lexical node does not exist in active editor state',
        );
      },
      {discrete: true},
    );
  });

  test('does not reuse a text node collected by normalization', () => {
    const editor = createHeadlessEditor();
    let merged!: TextNode;
    editor.update(() => {
      merged = $createTextNode('second');
      $getRoot().append(
        $createParagraphNode().append($createTextNode('first'), merged),
      );
    });
    editor.update(
      () => {
        expect($getRoot().getTextContent()).toBe('firstsecond');
        expect($getNodeByKey(merged.getKey())).toBeNull();
        expect(() => merged.getWritable()).toThrow(
          'Lexical node does not exist in active editor state',
        );
      },
      {discrete: true},
    );
  });

  test('restores writable nodes after parsing a separate editor state', () => {
    const editor = createHeadlessEditor();
    editor.update(
      () =>
        $getRoot().append($createParagraphNode().append($createTextNode('a'))),
      {discrete: true},
    );
    const serialized = editor.getEditorState().toJSON();
    editor.update(
      () => {
        const root = $getRoot().getWritable();
        const parsed = editor.parseEditorState(serialized, () => {
          expect($getRoot().getWritable()).not.toBe(root);
          $getRoot().append(
            $createParagraphNode().append($createTextNode('b')),
          );
        });
        expect($getRoot().getWritable()).toBe(root);
        expect(root.getChildrenSize()).toBe(1);
        parsed.read(() => {
          expect($getRoot()).not.toBe(root);
          expect($getRoot().getChildrenSize()).toBe(2);
        });
      },
      {discrete: true},
    );
  });

  test('invalidates selection caches even when reusing a writable node', () => {
    const editor = createHeadlessEditor();
    editor.update(
      () => {
        const text = $createTextNode('text');
        $getRoot().append($createParagraphNode().append(text));
        text.select(0, 4);
        const selection = $getSelection();
        expect($isRangeSelection(selection)).toBe(true);
        if (!$isRangeSelection(selection)) {
          throw new Error('Expected a range selection');
        }
        selection.getNodes();
        expect(selection.getCachedNodes()).not.toBeNull();
        expect(text.getWritable()).toBe(text);
        expect(selection.getCachedNodes()).toBeNull();
      },
      {discrete: true},
    );
  });
});

describe('stale node references', () => {
  function $staleMessage(node: TextNode) {
    return (
      `Lexical node does not exist in active editor state (key ${node.getKey()}, type text). ` +
      'The reference was probably kept from another read or update, for example in a closure, event handler or component state, ' +
      'and the node has since been removed or is not part of this editor state. ' +
      'Before using a node reference that may be stale, check node.isAttached() or look the node up again with ' +
      '$getNodeByKey(node.getKey()), inside the read or update where it is used.'
    );
  }

  function createRemovedTextNode() {
    const editor = createHeadlessEditor();
    let text!: TextNode;
    editor.update(
      () => {
        text = $createTextNode('removed');
        $getRoot().append($createParagraphNode().append(text));
      },
      {discrete: true},
    );
    editor.update(() => text.getParentOrThrow().remove(), {discrete: true});
    return {editor, text};
  }

  test('explains how to guard a stale reference when reading', () => {
    const {editor, text} = createRemovedTextNode();
    editor.read(() => {
      expect(() => text.getTextContent()).toThrow($staleMessage(text));
    });
  });

  test('explains how to guard a stale reference when writing', () => {
    const {editor, text} = createRemovedTextNode();
    editor.update(
      () => {
        expect(() => text.setTextContent('changed')).toThrow(
          $staleMessage(text),
        );
      },
      {discrete: true},
    );
  });

  test('the suggested guards do not throw for a stale reference', () => {
    const {editor, text} = createRemovedTextNode();
    editor.update(
      () => {
        expect(text.isAttached()).toBe(false);
        expect($getNodeByKey(text.getKey())).toBeNull();
      },
      {discrete: true},
    );
  });
});
