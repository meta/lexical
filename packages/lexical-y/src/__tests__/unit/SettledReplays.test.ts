/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Random histories (2-4 peers, partial and reordered delivery, undo, raw
// writes) whose settled peers disagreed with each other or with a fresh
// reader: a numbered list's id (80222), list numbering after text was
// typed before a nested list (81134) or a link put around one (81124), and
// a link an author held inside another link, which the document stores as
// one (81817).

import {
  $defaultIsIdentifiedBlock,
  $getBlockId,
  BlockIdExtension,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$toggleLink} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $insertList,
  $isListItemNode,
  $isListNode,
} from '@lexical/list';
import {$addMarkID, MarkStateExtension} from '@lexical/mark';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $createTableNodeWithDimensions,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  registerTablePlugin,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  configExtension,
  defineExtension,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../..';
import {$createBoxNode, NODES} from '../utils/harness';

const NET = Symbol('net');

const idle = async () => {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
};

const rng = (seed: number) => {
  let s = (seed ^ 0x7b9400) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

function peer(
  id: number,
  gc: boolean,
  ids: boolean,
  marks: boolean,
  doc = createYDoc(null, {gc}),
) {
  doc.clientID = id;
  let next = 0;
  const errors: string[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        defineExtension({
          name: 'replay/table',
          register: e => registerTablePlugin(e),
        }),
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          selfCheck: false,
        }),
        ...(ids
          ? [
              configExtension(BlockIdExtension, {
                generateId: () => `r6_${id}_${next++}`,
              }),
            ]
          : []),
        ...(marks ? [MarkStateExtension] : []),
      ],
      name: 'replay/' + id,
      nodes: NODES,
      onError: e => {
        errors.push(String(e));
        throw e;
      },
      onWarn: () => {},
    }),
  );
  const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
    .output.binding;
  return {
    binding,
    dispose() {
      editor.dispose();
      doc.destroy();
    },
    doc,
    editor,
    errors,
  };
}
type P = ReturnType<typeof peer>;

const view = (p: P) => p.editor.getEditorState().toJSON();

function idsOf(p: P): string[] {
  return p.editor.getEditorState().read(() => {
    const out: string[] = [];
    const visit = (n: LexicalNode) => {
      if ($defaultIsIdentifiedBlock(n)) {
        out.push(String($getBlockId(n)));
      }
      if ($isElementNode(n)) {
        n.getChildren().forEach(visit);
      }
    };
    $getRoot().getChildren().forEach(visit);
    return out;
  });
}

function $listItemOf(t: LexicalNode | undefined): LexicalNode | null {
  let a: LexicalNode | null = t ?? null;
  while (a !== null && !$isListItemNode(a)) {
    a = a.getParent();
  }
  return a;
}

async function replay(seed: number, ids: boolean, raw: boolean) {
  const random = rng(seed);
  const n = 2 + (seed % 3);
  const gc = seed % 2 === 0;
  const marks = seed % 4 < 2;
  const ps: P[] = [];
  const messages: {to: number; bytes: Uint8Array}[] = [];
  const choose = <T>(xs: T[]) =>
    xs.length ? xs[Math.floor(random() * xs.length)] : undefined;
  const deliver = () => {
    const at = Math.floor(random() * messages.length);
    const m = messages.splice(at, 1)[0];
    Y.applyUpdate(ps[m.to].doc, m.bytes, NET);
  };
  const settle = async () => {
    for (let r = 0; r < 40; r++) {
      while (messages.length) {
        deliver();
      }
      await idle();
      if (messages.length === 0) {
        return;
      }
    }
    throw new Error('nonquiescent');
  };
  try {
    for (let i = 0; i < n; i++) {
      ps.push(peer(700 + i, gc, ids, marks));
    }
    ps.forEach((p, i) =>
      p.doc.on('update', (bytes: Uint8Array, origin: unknown) => {
        if (origin !== NET) {
          for (let j = 0; j < n; j++) {
            if (j !== i) {
              messages.push({bytes: new Uint8Array(bytes), to: j});
            }
          }
        }
      }),
    );
    ps[0].editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('north south')),
          $createListNode('number').append(
            $createListItemNode().append($createTextNode('first')),
            $createListItemNode().append($createTextNode('second')),
          ),
          $createTableNodeWithDimensions(2, 2, false),
          $createBoxNode().append(
            $createParagraphNode().append($createTextNode('inside')),
          ),
        );
      },
      {discrete: true},
    );
    ps[0].binding.initialize();
    await settle();
    ps.forEach(p => p.binding.undoManager?.clear());
    for (let step = 0; step < 45; step++) {
      const who = Math.floor(random() * n);
      const p = ps[who];
      const op = Math.floor(random() * (raw ? 17 : 15));
      const token = `[r${seed}_${who}_${step}]`;
      p.binding.undoManager?.stopCapturing();
      if (op === 11) {
        p.binding.undo();
      } else if (op === 12) {
        p.binding.redo();
      } else {
        p.editor.update(
          () => {
            const t = choose($getRoot().getAllTextNodes());
            const size = t?.getTextContentSize() ?? 0;
            const pos = Math.floor(random() * (size + 1));
            if (t) {
              t.select(pos, pos);
            }
            if (op === 0 || op === 1) {
              if (t && $getSelection()) {
                t.select(pos, pos).insertText(token);
              }
            } else if (op === 2) {
              if (t && size) {
                const backward = random() < 0.5;
                const lo = backward ? Math.max(0, pos - 1) : pos;
                const hi = backward ? pos : Math.min(size, pos + 1);
                t.select(lo, hi).insertText('');
              }
            } else if (op === 3) {
              if (t) {
                t.select(pos, pos).insertParagraph();
              }
            } else if (op === 4) {
              if (t && size) {
                t.select(0, size).formatText(step % 2 ? 'bold' : 'italic');
              }
            } else if (op === 5) {
              if (t && size) {
                t.select(0, size);
                $toggleLink('https://example.test/' + (step % 3));
              }
            } else if (op === 6) {
              if (t && size && marks) {
                $addMarkID(
                  'comment_' + who + '_' + (step % 4),
                  t.select(0, size),
                );
              }
            } else if (op === 7) {
              if (t) {
                $insertList(step % 2 ? 'bullet' : 'number');
              }
            } else if (op === 8 || op === 9) {
              const a = $listItemOf(t);
              if ($isListItemNode(a)) {
                a.setIndent(
                  op === 8
                    ? Math.min(2, a.getIndent() + 1)
                    : Math.max(0, a.getIndent() - 1),
                );
              }
            } else if (op === 10) {
              const cell = $getRoot()
                .getAllTextNodes()
                .find(x =>
                  x.getParents().some(a => a.getType() === 'tablecell'),
                );
              let target: ElementNode | null = null;
              if (cell) {
                target = cell.getParent();
              } else {
                const table = $getRoot()
                  .getChildren()
                  .find(x => x.getType() === 'table') as
                  | ElementNode
                  | undefined;
                const row = table?.getFirstChild();
                const tableCell = $isElementNode(row)
                  ? row.getFirstChild()
                  : null;
                const block = $isElementNode(tableCell)
                  ? tableCell.getFirstChild()
                  : null;
                target = $isElementNode(block) ? block : null;
              }
              if (target) {
                target.selectEnd();
                if (step % 2) {
                  $insertTableRowAtSelection(true);
                } else {
                  $insertTableColumnAtSelection(true);
                }
              }
            } else if (op === 13) {
              $getRoot().append(
                $createParagraphNode().append($createTextNode(token)),
              );
            } else if (op === 14) {
              if (t) {
                $setBlocksType(t.select(0, 0), () =>
                  step % 2 ? $createHeadingNode('h2') : $createQuoteNode(),
                );
              }
            } else if (op === 15) {
              if (t) {
                let line = t.getParent();
                while (line?.isInline()) {
                  line = line.getParent();
                }
                line?.append(
                  $createHeadingNode('h2').append($createTextNode(token)),
                );
              }
            } else if (op === 16) {
              const list = $getRoot().getChildren().find($isListNode);
              if (list) {
                const item = list.getFirstChild();
                if ($isElementNode(item)) {
                  item.append(
                    $createListNode('bullet').append(
                      $createListItemNode().append($createTextNode(token)),
                    ),
                  );
                }
              }
            }
          },
          raw && op >= 15
            ? {discrete: true, skipTransforms: true}
            : {discrete: true},
        );
      }
      await idle();
      for (let k = Math.floor(random() * 5); k > 0 && messages.length; k--) {
        deliver();
      }
      await idle();
    }
    await settle();
    for (const p of ps) {
      for (const q of ps) {
        if (p !== q) {
          Y.applyUpdate(p.doc, Y.encodeStateAsUpdate(q.doc), NET);
        }
      }
    }
    await settle();
    for (const p of ps) {
      expect(p.errors).toEqual([]);
      expect(view(p), 'peers differ').toEqual(view(ps[0]));
      if (ids) {
        const all = idsOf(p);
        expect(new Set(all).size, 'repeated ids').toBe(all.length);
      }
      const doc = createYDoc(null, {gc});
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(p.doc), NET);
      const fresh = peer(999, gc, ids, marks, doc);
      try {
        await idle();
        expect(view(fresh), 'a fresh reader differs').toEqual(view(p));
      } finally {
        fresh.dispose();
      }
    }
  } finally {
    ps.forEach(p => p.dispose());
  }
}

test.each([
  [80222, true, true],
  [81124, true, true],
  [81134, true, true],
  [81817, false, true],
])(
  'seed %i (block ids %s, raw writes %s): settled peers and fresh readers agree',
  async (seed, ids, raw) => {
    await replay(seed, ids, raw);
  },
  30_000,
);
