/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Randomized shapes concurrent edits leave: peers add lists to one list item
// and insert table rows and columns concurrently, while one peer is
// composing (IME) and others undo and redo (which leaves their own items
// split differently from everyone else's), with partial delivery. Every seed
// checks that all peers and fresh readers show the same document, with no
// warning. Not checked: duplicates. Two clients whose edits merge the same
// lists at once (each a move) both write it, so the moved list's items can
// show twice (documented).

import {$createListItemNode, $createListNode} from '@lexical/list';
import {
  $createTableNodeWithDimensions,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  $isTableNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setCompositionKey,
  createEditor,
  type ElementNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YBinding} from '../..';
import {describeNode, NODES} from '../utils/harness';

const SEEDS = Number(process.env.SHAPE_FUZZ_SEEDS ?? 60);

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type P = {
  doc: Y.Doc;
  editor: ReturnType<typeof createEditor>;
  binding: YBinding;
  warnings: string[];
  composing: boolean;
};

function peer(id: number, state?: Uint8Array): P {
  const doc = createYDoc(null, {gc: false});
  doc.clientID = id;
  if (state !== undefined) {
    Y.applyUpdate(doc, state, 'load');
  }
  const warnings: string[] = [];
  const editor = createEditor({
    namespace: 'shape-fuzz',
    nodes: NODES,
    onError: e => {
      throw e;
    },
    onWarn: e => warnings.push(String(e)),
  });
  const binding = new YBinding(editor, doc, {
    schemaVersion: 1,
    selfCheck: true,
  });
  binding.start();
  return {binding, composing: false, doc, editor, warnings};
}

const describeP = (p: P) =>
  p.editor
    .getEditorState()
    .read(() => $getRoot().getChildren().map(describeNode).join(' / '));

const send = (a: P, b: P) =>
  Y.applyUpdate(
    b.doc,
    Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)),
    'net',
  );

const $li = (text: string) =>
  $createListItemNode().append($createTextNode(text));

function $textNodes(node: LexicalNode, out: TextNode[] = []): TextNode[] {
  if ($isTextNode(node)) {
    out.push(node);
  } else if ($isElementNode(node)) {
    for (const c of node.getChildren()) {
      $textNodes(c, out);
    }
  }
  return out;
}

function $item(): ElementNode | null {
  const list = $getRoot().getFirstChild();
  return $isElementNode(list) ? (list.getFirstChild() as ElementNode) : null;
}

function $table(): ElementNode | null {
  return (
    ($getRoot().getChildren().find($isTableNode) as ElementNode | undefined) ??
    null
  );
}

function runSeed(seed: number): string[] {
  const rnd = mulberry32(seed * 7919 + 3);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const p1 = peer(1);
  p1.editor.update(
    () =>
      $getRoot().append(
        $createListNode('bullet').append($li('item'), $li('next')),
        $createTableNodeWithDimensions(3, 3, false),
      ),
    {discrete: true},
  );
  p1.binding.initialize();
  const base = Y.encodeStateAsUpdate(p1.doc);
  const peers = [p1];
  for (const id of [2, 3, 4]) {
    const p = peer(id, base);
    p.binding.initialize();
    peers.push(p);
  }
  let tok = 0;
  const update = (p: P, fn: () => void) => {
    p.binding.undoManager?.stopCapturing();
    p.editor.update(fn, {discrete: true});
  };
  const $nestedTexts = (): TextNode[] => {
    const item = $item();
    if (item === null) {
      return [];
    }
    return item
      .getChildren()
      .filter($isElementNode)
      .flatMap(list => $textNodes(list));
  };
  for (let step = 0; step < 18; step++) {
    const p = pick(peers);
    const r = rnd();
    if (r < 0.14) {
      if (!p.composing) {
        update(p, () => {
          const item = $item();
          if (item !== null) {
            item.append(
              $createListNode('check').append($li(`<${seed}.${tok++}>`)),
            );
          }
        });
        if (rnd() < 0.6) {
          // Every other peer receives it before any other change reaches it.
          for (const b of peers) {
            if (b !== p) {
              send(p, b);
            }
          }
        }
      }
    } else if (r < 0.26) {
      if (!p.composing) {
        update(p, () => {
          const texts = $nestedTexts();
          if (texts.length > 0) {
            pick(texts).selectEnd().insertText(`<${seed}.${tok++}>`);
          }
        });
      }
    } else if (r < 0.36) {
      if (!p.composing) {
        // Undo, undo, redo: the author's own items stay split.
        p.binding.undoManager?.stopCapturing();
        p.binding.undo();
        p.binding.undoManager?.stopCapturing();
        p.binding.undo();
        p.binding.undoManager?.stopCapturing();
        p.binding.redo();
      }
    } else if (r < 0.44) {
      if (!p.composing) {
        update(p, () => {
          const table = $table();
          const row = table?.getChildAtIndex(Math.floor(rnd() * 3));
          const cell = $isElementNode(row) ? row.getFirstChild() : null;
          if ($isElementNode(cell)) {
            (cell.getFirstChild() as ElementNode).selectEnd();
            if (rnd() < 0.5) {
              $insertTableRowAtSelection(true);
            } else {
              $insertTableColumnAtSelection(true);
            }
          }
        });
      }
    } else if (r < 0.54) {
      // Composition in a nested list's item, and a peer typing into that
      // same text right away (hidden on the composing peer until the
      // composition ends).
      if (p.composing) {
        update(p, () => $setCompositionKey(null));
        p.composing = false;
        continue;
      }
      let text = '';
      update(p, () => {
        const texts = $nestedTexts();
        if (texts.length > 0) {
          const t = pick(texts);
          text = t.getTextContent();
          $setCompositionKey(t.getKey());
          t.select(0, 0);
          p.composing = true;
        }
      });
      const q = pick(peers.filter(x => x !== p && !x.composing));
      if (p.composing && q !== undefined) {
        update(q, () => {
          const t = $nestedTexts().find(n => n.getTextContent() === text);
          if (t !== undefined) {
            t.select(0, 0).insertText('Z');
          }
        });
        for (const b of peers) {
          if (b !== q) {
            send(q, b);
          }
        }
      }
    } else if (r < 0.64) {
      // Two peers add a list to the item at once; a third composes in one
      // of them while a fourth types into that line (hidden on the
      // composing peer); then the other list reaches the rest.
      const free = peers.filter(x => !x.composing);
      if (free.length < 4) {
        continue;
      }
      const order = [...free].sort(() => rnd() - 0.5);
      const [a1, a2, c, typist] = order;
      const text = `<${seed}.${tok++}>`;
      update(a1, () => {
        $item()?.append($createListNode('check').append($li(text)));
      });
      update(a2, () => {
        $item()?.append(
          $createListNode('check').append($li(`<${seed}.${tok++}>`)),
        );
      });
      send(a1, c);
      send(a1, typist);
      update(c, () => {
        const t = $nestedTexts().find(n => n.getTextContent() === text);
        if (t !== undefined) {
          $setCompositionKey(t.getKey());
          t.select(0, 0);
          c.composing = true;
        }
      });
      update(typist, () => {
        const t = $nestedTexts().find(n => n.getTextContent() === text);
        if (t !== undefined) {
          t.select(0, 0).insertText('Z');
        }
      });
      send(typist, c);
      send(typist, a1);
      for (const b of [c, typist, a1]) {
        send(a2, b);
      }
    } else if (r < 0.8) {
      // One update to everyone but one peer.
      const skip = pick(peers);
      for (const b of peers) {
        if (b !== p && b !== skip) {
          send(p, b);
        }
      }
    } else {
      const b = pick(peers);
      if (b !== p) {
        send(p, b);
      }
    }
  }
  for (const p of peers) {
    if (p.composing) {
      update(p, () => $setCompositionKey(null));
      p.composing = false;
    }
  }
  for (let round = 0; round < 4; round++) {
    for (const a of peers) {
      for (const b of peers) {
        if (a !== b) {
          send(a, b);
        }
      }
    }
  }
  const problems: string[] = [];
  const first = describeP(p1);
  for (const p of peers) {
    if (describeP(p) !== first) {
      problems.push(`seed ${seed}: peers differ`);
    }
    if (p.warnings.length > 0) {
      problems.push(`seed ${seed}: ${p.warnings[0].slice(0, 200)}`);
    }
  }
  for (const p of peers) {
    const fresh = peer(99, Y.encodeStateAsUpdate(p.doc));
    fresh.binding.initialize();
    if (describeP(fresh) !== first) {
      problems.push(`seed ${seed}: a fresh reader differs`);
    }
  }
  return problems;
}

describe('@lexical/y shapes concurrent edits leave, randomized', () => {
  test(`${SEEDS} seeds with composition, undo/redo splits and partial delivery`, () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      problems.push(...runSeed(seed));
    }
    expect(problems).toEqual([]);
  }, 600_000);
});
