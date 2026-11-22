/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A small seeded soak over the node catalog: 2-3 peers bound to a document
// seeded with catalog shapes (always a list and a named-slot host, in either
// order), random edits with partial delivery, then full delivery. Checked right
// after every bind (nothing awaited), and after the edits: list numbering is
// what @lexical/list derives from the structure, every editor equals a fresh
// readYState of its own document (a nested editor's own state aside: y.md, nested
// editors are not synchronized), the peers agree, nothing throws.
//
// Default seeds run in seconds; CATALOG_SOAK_SEEDS / CATALOG_SOAK_FIRST run more.

import {$isListItemNode, $isListNode, type ListNode} from '@lexical/list';
import * as Y from '@y/y';
import {
  $getEditor,
  $getRoot,
  $getSlot,
  $getSlotNames,
  $isElementNode,
  $isTextNode,
  $setSelection,
  INDENT_CONTENT_COMMAND,
  type LexicalNode,
  OUTDENT_CONTENT_COMMAND,
} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {readYState} from '../../../headless';
import {
  bindFresh,
  type BindMode,
  type BoundEditor,
  catalogHeadlessConfig,
  NODE_SHAPES,
  type NodeShape,
  prng,
  seedShapes,
  shapesWith,
} from '../../catalog';

const SEEDS = Number(process.env.CATALOG_SOAK_SEEDS || 24);
const FIRST = Number(process.env.CATALOG_SOAK_FIRST || 1);
const REMOTE = 'catalog-soak-remote';

const bound: BoundEditor[] = [];
afterEach(() => {
  for (const b of bound.splice(0)) {
    b.dispose();
  }
});

function $all(): LexicalNode[] {
  const out: LexicalNode[] = [];
  const visit = (n: LexicalNode) => {
    out.push(n);
    for (const name of $getSlotNames(n)) {
      const slot = $getSlot(n, name);
      if (slot !== null) {
        visit(slot);
      }
    }
    if ($isElementNode(n)) {
      n.getChildren().forEach(visit);
    }
  };
  visit($getRoot());
  return out;
}

/** List items whose value differs from what @lexical/list derives (updateChildrenListItemValue). */
function $wrongNumbers(): string[] {
  const out: string[] = [];
  for (const n of $all()) {
    if (!$isListNode(n)) {
      continue;
    }
    const list: ListNode = n;
    let value = list.getStart();
    const got: number[] = [];
    const want: number[] = [];
    for (const child of list.getChildren()) {
      if ($isListItemNode(child)) {
        got.push(child.getValue());
        want.push(value);
        if (!$isListNode(child.getFirstChild())) {
          value++;
        }
      }
    }
    if (got.join() !== want.join()) {
      out.push(
        `${list.getListType()} start ${list.getStart()}: [${got}] want [${want}]`,
      );
    }
  }
  return out;
}

/** JSON without block ids and without nested editors' own state. */
function canon(json: unknown): string {
  return JSON.stringify(json, (key, value) => {
    if (
      key === 'editorState' &&
      value &&
      typeof value === 'object' &&
      'root' in value
    ) {
      return '<nested editor>';
    }
    if (key === '$' && value && typeof value === 'object') {
      const {blockId, ...rest} = value as Record<string, unknown>;
      void blockId;
      return Object.keys(rest).length ? rest : undefined;
    }
    return value;
  });
}

const config = {
  blockIds: 'absent',
  doc: 'createYDoc',
  dom: 'headless',
  onError: 'log',
} as const;

function freshJSON(doc: Y.Doc): string {
  return canon(
    readYState(
      Y.encodeStateAsUpdate(doc),
      catalogHeadlessConfig(config as never),
      () => $getEditor().getEditorState().toJSON(),
    ),
  );
}

describe('catalog soak', () => {
  for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
    // Every document holds a list next to a named-slot host.
    test(`seed ${seed}`, async () => {
      const rand = prng(seed * 7919 + 1);
      const pick = <T>(xs: readonly T[]): T =>
        xs[Math.floor(rand() * xs.length)];
      const shapes: NodeShape[] = [];
      for (let i = 0; i < 3 + Math.floor(rand() * 3); i++) {
        shapes.push(pick(NODE_SHAPES));
      }
      const pair = [pick(shapesWith('list')), pick(shapesWith('slots'))];
      shapes.splice(
        Math.floor(rand() * (shapes.length + 1)),
        0,
        ...(rand() < 0.5 ? pair : pair.reverse()),
      );
      const state = seedShapes(shapes, config as never);
      const n = 2 + Math.floor(rand() * 2);
      const peers: BoundEditor[] = [];
      const inbox: Uint8Array[][] = [];
      for (let i = 0; i < n; i++) {
        const mode: BindMode = pick(['binding', 'extension'] as const);
        const b = bindFresh(state, config as never, mode);
        bound.push(b);
        // right after the bind, nothing awaited
        expect(
          b.editor.getEditorState().read($wrongNumbers),
          `peer ${i} first read (${mode})`,
        ).toEqual([]);
        peers.push(b);
        inbox.push([]);
      }
      peers.forEach((b, i) =>
        b.doc.on('update', (u: Uint8Array, origin: unknown) => {
          if (origin !== REMOTE) {
            inbox.forEach((q, j) => j !== i && q.push(u));
          }
        }),
      );
      const deliver = (frac: number) => {
        peers.forEach((b, i) => {
          const take = inbox[i].filter(() => rand() < frac);
          inbox[i] = inbox[i].filter(u => !take.includes(u));
          for (const u of take) {
            Y.applyUpdate(b.doc, u, REMOTE);
          }
        });
      };
      for (let step = 0; step < 12; step++) {
        const b = pick(peers);
        const kind = Math.floor(rand() * 4);
        b.editor.update(
          () => {
            const texts = $getRoot()
              .getAllTextNodes()
              .filter(t => $isTextNode(t) && t.isSimpleText());
            const items = $all().filter($isListItemNode);
            if (kind === 0 && texts.length) {
              const t = pick(texts);
              const at = Math.floor(rand() * (t.getTextContentSize() + 1));
              t.select(at, at).insertText(' w' + step);
            } else if (kind === 1 && texts.length) {
              const t = pick(texts);
              t.select(
                t.getTextContentSize(),
                t.getTextContentSize(),
              ).insertParagraph();
            } else if (kind === 2 && items.length) {
              pick(items).selectStart();
              b.editor.dispatchCommand(
                rand() < 0.6 ? INDENT_CONTENT_COMMAND : OUTDENT_CONTENT_COMMAND,
                undefined,
              );
            } else if ($getRoot().getChildrenSize() > 2) {
              // a delete moves the selection away first, as the editor's own commands do
              $setSelection(null);
              pick($getRoot().getChildren()).remove();
            }
          },
          {discrete: true},
        );
        await Promise.resolve();
        if (rand() < 0.5) {
          deliver(rand());
        }
      }
      for (let round = 0; round < 4; round++) {
        deliver(1);
        peers.forEach((a, i) =>
          peers.forEach(
            (b, j) =>
              i !== j &&
              Y.applyUpdate(
                b.doc,
                Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)),
                REMOTE,
              ),
          ),
        );
        await new Promise(r => setTimeout(r, 0));
      }
      const views = peers.map(b => canon(b.editor.getEditorState().toJSON()));
      peers.forEach((b, i) => {
        expect(b.errors.map(String), `peer ${i} errors`).toEqual([]);
        expect(
          b.editor.getEditorState().read($wrongNumbers),
          `peer ${i} numbering`,
        ).toEqual([]);
        expect(views[i], `peer ${i} equals peer 0`).toBe(views[0]);
        expect(views[i], `peer ${i} equals a fresh read of its doc`).toBe(
          freshJSON(b.doc),
        );
      });
    });
  }
});
