/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $getBlockId,
  BlockIdExtension,
  buildEditorFromExtensions,
  configExtension,
  defineExtension,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$insertList, $isListItemNode, type ListItemNode} from '@lexical/list';
import * as Y from '@y/y';
import {
  $createRangeSelection,
  $getRoot,
  $isElementNode,
  $setSelection,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../..';
import {mulberry32} from '../utils/fuzz';
import {$p, NODES} from '../utils/harness';

// Only users' own edits write: a client applying a collaborator's change
// (and the refresh of list numbering after it) writes nothing back, and a
// nested list never takes the block id of a list it is inside. Two peers
// turn paragraphs into lists, indent and outdent items, type, press Enter
// and remove blocks, with updates delivered in random order.

const SEEDS = Number(process.env.REMOTE_APPLY_SEEDS || 60);
const STEPS = 40;

const all = (n: LexicalNode): LexicalNode[] => [
  n,
  ...($isElementNode(n) ? n.getChildren().flatMap(all) : []),
];

const tick = async () => {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
};

function peer(id: number, state: Uint8Array, blockIds: boolean) {
  const doc = createYDoc();
  doc.clientID = id;
  Y.applyUpdate(doc, state);
  let n = 0;
  const warnings: string[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        ...(blockIds
          ? [
              configExtension(BlockIdExtension, {
                generateId: () => `p${id}_${n++}`,
              }),
            ]
          : []),
        configExtension(YCollabExtension, {
          clientIDRange: 'uint32',
          doc,
          schemaVersion: 1,
          selfCheck: true,
          synced: true,
        }),
      ],
      name: `remote-apply-${id}`,
      nodes: () => NODES,
      onError: (e: Error) => {
        throw e;
      },
      onWarn: (w: Error) => {
        warnings.push(w.message);
      },
    }),
  );
  getExtensionDependencyFromEditor(editor, YCollabExtension);
  const out: Uint8Array[] = [];
  let applying = false;
  let writesOnApply = 0;
  doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'relay') {
      out.push(u);
      if (applying) {
        writesOnApply++;
      }
    }
  });
  return {
    apply(u: Uint8Array) {
      applying = true;
      try {
        Y.applyUpdate(doc, u, 'relay');
      } finally {
        applying = false;
      }
    },
    doc,
    editor,
    ids: () =>
      editor.read(
        () =>
          all($getRoot())
            .map(x => $getBlockId(x))
            .filter(Boolean) as string[],
      ),
    json: () => JSON.stringify(editor.getEditorState().toJSON()),
    out,
    warnings,
    writes: () => writesOnApply,
  };
}

async function run(seed: number, blockIds: boolean) {
  const rnd = mulberry32(seed);
  const s0 = peer(1, new Uint8Array([0, 0]), blockIds);
  s0.editor.update(
    () => {
      $getRoot().clear();
      for (let i = 0; i < 5; i++) {
        $getRoot().append($p(`para ${i} `));
      }
    },
    {discrete: true},
  );
  await tick();
  const state = Y.encodeStateAsUpdate(s0.doc);
  const peers = [peer(2, state, blockIds), peer(3, state, blockIds)];
  await tick();
  for (const p of peers) {
    p.out.length = 0;
  }
  const queue: {to: number; u: Uint8Array}[] = [];
  const dups: string[] = [];
  for (let step = 0; step < STEPS; step++) {
    const i = Math.floor(rnd() * 2);
    const p = peers[i];
    const k = Math.floor(rnd() * 6);
    p.editor.update(
      () => {
        const leaves = all($getRoot()).filter(
          x =>
            $isElementNode(x) &&
            !x.getChildren().some($isElementNode) &&
            ['paragraph', 'listitem'].includes(x.getType()),
        ) as ElementNode[];
        const b = leaves[Math.floor(rnd() * leaves.length)];
        if (b === undefined) {
          return;
        }
        const select = () => {
          const t = b.getAllTextNodes().at(-1);
          const s = $createRangeSelection();
          if (t !== undefined) {
            s.anchor.set(t.getKey(), t.getTextContentSize(), 'text');
            s.focus.set(t.getKey(), t.getTextContentSize(), 'text');
          } else {
            s.anchor.set(b.getKey(), 0, 'element');
            s.focus.set(b.getKey(), 0, 'element');
          }
          $setSelection(s);
          return s;
        };
        if (k === 0 && b.getType() === 'paragraph') {
          select();
          $insertList(rnd() < 0.5 ? 'bullet' : 'number');
        } else if (k === 1 && $isListItemNode(b)) {
          const d = (b as ListItemNode).getIndent();
          (b as ListItemNode).setIndent(
            rnd() < 0.6 ? Math.min(d + 1, 2) : Math.max(0, d - 1),
          );
        } else if (k === 2) {
          select().insertText(`w${step} `);
        } else if (k === 3) {
          select().insertParagraph();
        } else if (k === 4 && leaves.length > 3) {
          b.remove();
        } else {
          select().insertText('x');
        }
      },
      {discrete: true},
    );
    await tick();
    for (const u of p.out.splice(0)) {
      queue.push({to: 1 - i, u});
    }
    while (queue.length > 0 && rnd() < 0.5) {
      const m = queue.splice(Math.floor(rnd() * queue.length), 1)[0];
      peers[m.to].apply(m.u);
      await tick();
      for (const u of peers[m.to].out.splice(0)) {
        queue.push({to: 1 - m.to, u});
      }
    }
    for (const pp of peers) {
      const ids = pp.ids();
      dups.push(...ids.filter((x, j) => ids.indexOf(x) !== j));
    }
  }
  for (let round = 0; queue.length > 0 && round < 20; round++) {
    for (const m of queue.splice(0)) {
      peers[m.to].apply(m.u);
      await tick();
      for (const u of peers[m.to].out.splice(0)) {
        queue.push({to: 1 - m.to, u});
      }
    }
  }
  return {
    converged: peers[0].json() === peers[1].json(),
    dups: [...new Set(dups)],
    warnings: [...peers[0].warnings, ...peers[1].warnings],
    writes: peers[0].writes() + peers[1].writes(),
  };
}

describe('applying a remote change writes nothing', () => {
  test('list edits from two peers: no writes on apply, converged, no warnings', async () => {
    const bad: unknown[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = await run(seed, false);
      if (r.writes > 0 || !r.converged || r.warnings.length > 0) {
        bad.push({seed, ...r, warnings: r.warnings.slice(0, 2)});
      }
    }
    expect(bad).toEqual([]);
  }, 120000);

  test('with block ids: no list takes the block id of a list it is inside', async () => {
    const bad: unknown[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = await run(seed, true);
      if (r.dups.length > 0 || !r.converged || r.warnings.length > 0) {
        bad.push({seed, ...r, warnings: r.warnings.slice(0, 2)});
      }
    }
    expect(bad).toEqual([]);
  }, 120000);
});
