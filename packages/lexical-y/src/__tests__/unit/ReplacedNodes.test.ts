/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// The nodes of a state set whole (see $replacedNodes): the nodes a commit
// changed without marking them dirty. They are looked for only at the keys
// where the two node maps can differ, which must find what a walk of the
// whole node map finds, in documents small and large (above the size at
// which Lexical's node map becomes copy-on-write), with and without a root
// element (whose reconciler replaces the root in every commit that changes
// text), when states saved earlier are set again, from the same editor and
// from another. And a keystroke in a large document with a root element
// does not walk the node map.

import {
  BlockIdExtension,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  configExtension,
  createEditor,
  defineExtension,
  type EditorState,
  type ElementNode,
  type LexicalEditor,
  type NodeKey,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../..';
import {$replacedNodes} from '../../internal/Binding';

type Found = [Map<NodeKey, boolean>, Set<NodeKey>] | null;

/** Every node that differs from the previous state unmarked, by a walk. */
function wholeWalk(
  dirtyElements: Map<NodeKey, boolean>,
  dirtyLeaves: Set<NodeKey>,
  prev: EditorState,
  next: EditorState,
): Found {
  let elements: Map<NodeKey, boolean> | null = null;
  let leaves: Set<NodeKey> | null = null;
  for (const [key, node] of next._nodeMap) {
    if (
      prev._nodeMap.get(key) !== node &&
      !dirtyElements.has(key) &&
      !dirtyLeaves.has(key)
    ) {
      elements = elements ?? new Map(dirtyElements);
      leaves = leaves ?? new Set(dirtyLeaves);
      if ($isElementNode(node)) {
        elements.set(key, true);
      } else {
        leaves.add(key);
      }
    }
  }
  return elements === null || leaves === null ? null : [elements, leaves];
}

const show = (found: Found) =>
  found === null ? 'null' : JSON.stringify([[...found[0]], [...found[1]]]);

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mkEditor(dom: boolean): LexicalEditor {
  const editor = createEditor({
    onError: e => {
      throw e;
    },
  });
  if (dom) {
    const el = document.createElement('div');
    el.contentEditable = 'true';
    document.body.appendChild(el);
    editor.setRootElement(el);
  }
  return editor;
}

const $paragraphs = () => $getRoot().getChildren() as ElementNode[];

/** A random edit of the document, from `pick` (a random number). */
function $edit(op: number, pick: () => number): void {
  const ps = $paragraphs();
  const p = ps[Math.floor(pick() * ps.length)];
  const t = p.getFirstChild() as TextNode | null;
  if (op < 0.4 || t === null || !$isTextNode(t)) {
    // Typing (or a paragraph emptied by an earlier remove).
    if (t !== null && $isTextNode(t)) {
      t.spliceText(t.getTextContentSize(), 0, 'x', false);
    } else {
      p.append($createTextNode('y'));
    }
  } else if (op < 0.55) {
    p.insertAfter($createParagraphNode().append($createTextNode('new ')));
  } else if (op < 0.65 && ps.length > 2) {
    p.remove();
  } else if (op < 0.8 && t.getTextContentSize() > 2) {
    t.splitText(1)[1].toggleFormat('bold');
  } else {
    t.setTextContent(t.getTextContent() + 'z');
  }
}

function session(seed: number, size: number, dom: boolean) {
  const editor = mkEditor(dom);
  const pick = random(seed);
  const mismatches: string[] = [];
  let found = 0;
  editor.registerUpdateListener(
    ({dirtyElements, dirtyLeaves, prevEditorState, editorState}) => {
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) {
        return;
      }
      const want = wholeWalk(
        dirtyElements,
        dirtyLeaves,
        prevEditorState,
        editorState,
      );
      const got = $replacedNodes(
        dirtyElements,
        dirtyLeaves,
        prevEditorState,
        editorState,
      );
      if (show(got) !== show(want)) {
        mismatches.push(`${show(got)} !== ${show(want)}`);
      }
      if (want !== null) {
        found++;
      }
    },
  );
  editor.update(
    () => {
      const root = $getRoot().clear();
      for (let i = 0; i < size; i++) {
        root.append(
          $createParagraphNode().append($createTextNode(`para ${i} `)),
        );
      }
    },
    {discrete: true},
  );
  const saved: EditorState[] = [editor.getEditorState()];
  for (let step = 0; step < 120; step++) {
    const op = pick();
    if (op < 0.08) {
      saved.push(editor.getEditorState());
    } else if (op < 0.14) {
      // A state saved earlier, set again.
      editor.setEditorState(saved[Math.floor(pick() * saved.length)]);
    } else if (op < 0.18) {
      // A state built in another editor from a saved one: the objects of
      // the nodes it did not change are the saved state's.
      const fork = mkEditor(false);
      fork.setEditorState(saved[Math.floor(pick() * saved.length)]);
      fork.update(() => $edit(pick(), pick), {discrete: true});
      editor.setEditorState(fork.getEditorState());
    } else {
      editor.update(() => $edit(op, pick), {discrete: true});
    }
  }
  return {found, mismatches};
}

describe('the nodes of a state set whole', () => {
  for (const size of [40, 1200]) {
    for (const dom of [false, true]) {
      test(`are those a walk of the whole node map finds (${size} paragraphs, ${
        dom ? 'a root element' : 'headless'
      })`, () => {
        for (const seed of [1, 2, 3]) {
          const {found, mismatches} = session(seed, size, dom);
          expect(mismatches).toEqual([]);
          expect(found).toBeGreaterThan(0);
        }
      }, 60_000);
    }
  }
});

test('a keystroke in a large document with a root element does not walk the node map', () => {
  const N = 1500;
  let k = 0;
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        configExtension(YCollabExtension, {
          doc: createYDoc(),
          schemaVersion: 1,
        }),
        configExtension(BlockIdExtension, {generateId: () => `b${++k}`}),
      ],
      name: 'replaced-nodes/keystroke',
      onError: (e: Error) => {
        throw e;
      },
    }),
  );
  const el = document.createElement('div');
  el.contentEditable = 'true';
  document.body.appendChild(el);
  editor.setRootElement(el);
  editor.update(
    () => {
      const root = $getRoot().clear();
      for (let i = 0; i < N; i++) {
        root.append(
          $createParagraphNode().append($createTextNode(`para ${i} `)),
        );
      }
    },
    {discrete: true},
  );
  getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output.binding.initialize();
  const type = () =>
    editor.update(
      () => {
        const t = $paragraphs()[N >> 1].getFirstDescendant();
        if ($isTextNode(t)) {
          t.selectEnd().insertText('x');
        }
      },
      {discrete: true},
    );
  // The first keystroke makes the node map copy-on-write.
  type();
  // Count the entries any walk of a node map yields (a walk of the whole map
  // yields every node).
  const proto = Object.getPrototypeOf(editor.getEditorState()._nodeMap);
  const entries = proto.entries;
  const iterate = proto[Symbol.iterator];
  let walked = 0;
  function* counted(it: Iterator<unknown>): Generator<unknown> {
    for (let r = it.next(); !r.done; r = it.next()) {
      walked++;
      yield r.value;
    }
  }
  proto.entries = function (this: unknown) {
    return counted(entries.call(this));
  };
  proto[Symbol.iterator] = function (this: unknown) {
    return counted(iterate.call(this));
  };
  try {
    for (let i = 0; i < 10; i++) {
      type();
    }
  } finally {
    proto.entries = entries;
    proto[Symbol.iterator] = iterate;
  }
  // Before: 10 keystrokes walked all of the 3,000 nodes twice each.
  expect(walked).toBeLessThan(N);
}, 60_000);
