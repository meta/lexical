/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Two updates batched into one commit (two editor.update() calls in one
// task), or one update whose text transform edits after the normalization
// merged: update 1 removes a format, so the bold node merges into the plain
// one before it; update 2 deletes that merged text again. Lexical's record
// of merges spans the whole commit, so the deleted node is still in it: the
// writer credited it with characters it never held, kept its deleted space
// and deleted the survivor's, or kept its deleted `la ` and deleted another
// node's equal `la ` that merged in later (R14-A F1). It now takes a split
// of the text only at the caret, or where the node's own old text does not
// explain what is left, and counts a merge only when every node the record
// merged into it is in its text.
//
//  S1  "x " | **"la "** | _"end"_ . u1 unbold "la " (merges: "x la ");
//      u2 delete "la " again. Survivor: the plain "x ".
//  S2  "x " | **"la "** | _"zz"_ | "la " | _"end"_ . u1 unbold the bold
//      "la " (merges: "x la "); u2 delete "la zz" (the plain "la " after it
//      merges in). Survivor: the last "la ".
// The delete as a caret range or as node edits; a peer's concurrent edit.
// S2 deleted by a caret range in one commit, or by node edits in two
// commits, deletes one of two equal runs with nothing in the text to tell
// them apart: Lexical's record of text edits does (see ExactTextEdits).

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  configExtension,
  defineExtension,
  type ElementNode,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../..';

function peer(id: number) {
  const doc = createYDoc(null, {gc: false});
  doc.clientID = id;
  const errors: unknown[] = [];
  const warnings: string[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          selfCheck: true,
        }),
      ],
      name: 'batched-merge/' + id,
      onError: e => {
        errors.push(e);
        throw e;
      },
      onWarn: e => {
        warnings.push(String(e && (e as Error).message));
      },
    }),
  );
  const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
    .output.binding;
  const written = {deleted: '', inserted: ''};
  let commits = 0;
  editor.registerUpdateListener(({dirtyLeaves}) => {
    if (dirtyLeaves.size > 0) {
      commits++;
    }
  });
  doc.on('afterTransaction', (tr: Y.Transaction) => {
    if (!tr.local) {
      return;
    }
    Y.iterateStructsByIdSet(tr, tr.insertSet, s => {
      if (s instanceof Y.Item && s.content instanceof Y.ContentString) {
        written.inserted += s.content.str;
      }
    });
    Y.iterateStructsByIdSet(tr, tr.deleteSet, s => {
      if (s instanceof Y.Item && s.content instanceof Y.ContentString) {
        written.deleted += s.content.str;
      }
    });
  });
  return {
    binding,
    commits: () => commits,
    doc,
    editor,
    errors,
    warnings,
    written,
  };
}
type Peer = ReturnType<typeof peer>;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
async function sync(peers: Peer[]) {
  for (let round = 0; round < 2; round++) {
    for (const from of peers) {
      for (const to of peers) {
        if (from !== to) {
          Y.applyUpdate(
            to.doc,
            Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)),
            'net',
          );
        }
      }
    }
    await flush();
  }
}
async function fresh(from: Peer): Promise<Peer> {
  const f = peer(99);
  Y.applyUpdate(f.doc, Y.encodeStateAsUpdate(from.doc), 'load');
  f.binding.initialize();
  await flush();
  return f;
}
const $line = () => $getRoot().getChildAtIndex(1) as ElementNode;
const $texts = () => $line().getAllTextNodes();
function lineOf(p: Peer): string {
  return p.editor.getEditorState().read(() =>
    $texts()
      .map(t => {
        const s = t.getTextContent();
        return t.hasFormat('bold')
          ? `**${s}**`
          : t.hasFormat('italic')
            ? `_${s}_`
            : s;
      })
      .join('|'),
  );
}
function textOf(p: Peer): string {
  return p.editor.getEditorState().read(() => $line().getTextContent());
}
type Seg = [string, '' | 'bold' | 'italic'];
async function start(segs: Seg[]) {
  const a = peer(1);
  const b = peer(2);
  a.editor.update(
    () => {
      const p = $createParagraphNode();
      for (const [s, f] of segs) {
        const t = $createTextNode(s);
        if (f !== '') {
          t.toggleFormat(f);
        }
        p.append(t);
      }
      $getRoot()
        .clear()
        .append($createParagraphNode().append($createTextNode('Title')), p);
      $setSelection(null);
    },
    {discrete: true},
  );
  a.binding.initialize();
  await flush();
  await sync([a, b]);
  b.binding.initialize();
  await flush();
  return {a, b};
}
function $select(t: TextNode, from: number, to: number) {
  const sel = $createRangeSelection();
  sel.anchor.set(t.getKey(), from, 'text');
  sel.focus.set(t.getKey(), to, 'text');
  $setSelection(sel);
  return sel;
}
function $selectAcross(t1: TextNode, o1: number, t2: TextNode, o2: number) {
  const sel = $createRangeSelection();
  sel.anchor.set(t1.getKey(), o1, 'text');
  sel.focus.set(t2.getKey(), o2, 'text');
  $setSelection(sel);
  return sel;
}

type PeerOp = {
  name: string;
  at: number;
  del: number;
  ins: string;
  want: string;
};
type Shape = {
  name: string;
  segs: Seg[];
  /** Update 1 (the format change that merges). */
  u1: () => void;
  /** Update 2 (the delete), by caret range or by node edits. */
  u2: (how: 'caret' | 'nodes') => void;
  /** Line text after the author's two updates. */
  after: string;
  /** Concurrent peer edits (offsets in the line before the author's commit). */
  ops: PeerOp[];
};

const SHAPES: Shape[] = [
  {
    after: 'x end',
    name: 'S1 merge then delete the merged text',
    ops: [
      {at: 0, del: 0, ins: '', name: 'none', want: 'x end'},
      {
        at: 2,
        del: 0,
        ins: 'Q',
        name: 'types Q after the survivor "x "',
        want: 'x Qend',
      },
      {
        at: 1,
        del: 1,
        ins: '',
        name: "deletes the survivor's space",
        want: 'xend',
      },
      {
        at: 2,
        del: 3,
        ins: '',
        name: 'deletes the merged "la " too',
        want: 'x end',
      },
    ],
    segs: [
      ['x ', ''],
      ['la ', 'bold'],
      ['end', 'italic'],
    ],
    u1: () => {
      $texts()[1].toggleFormat('bold');
      $setSelection(null);
    },
    u2: how => {
      // "x la " | _end_ after update 1.
      const n = $texts()[0];
      if (how === 'caret') {
        $select(n, 2, 5).removeText();
      } else {
        $setSelection(null);
        n.spliceText(2, 3, '');
      }
    },
  },
  {
    after: 'x la end',
    name: 'S2 merge, delete it, equal text merges in',
    ops: [
      {at: 0, del: 0, ins: '', name: 'none', want: 'x la end'},
      {
        at: 7,
        del: 0,
        ins: 'Q',
        name: 'types Q in front of the surviving "la "',
        want: 'x Qla end',
      },
      {
        at: 7,
        del: 1,
        ins: '',
        name: 'deletes the surviving "la "\'s l',
        want: 'x a end',
      },
      {
        at: 2,
        del: 3,
        ins: '',
        name: 'deletes the merged (deleted) "la " too',
        want: 'x la end',
      },
    ],
    segs: [
      ['x ', ''],
      ['la ', 'bold'],
      ['zz', 'italic'],
      ['la ', ''],
      ['end', 'italic'],
    ],
    u1: () => {
      $texts()[1].toggleFormat('bold');
      $setSelection(null);
    },
    u2: how => {
      // "x la " | _zz_ | "la " | _end_ after update 1.
      const [n, zz, la] = $texts();
      if (how === 'caret') {
        $selectAcross(n, 2, la, 0).removeText();
      } else {
        $setSelection(null);
        n.spliceText(2, 3, '');
        zz.remove();
      }
    },
  },
];

function $peerOp(op: PeerOp) {
  if (op.del === 0 && op.ins === '') {
    return;
  }
  const t = $line().getAllTextNodes();
  let n = 0;
  for (const node of t) {
    const size = node.getTextContentSize();
    if (
      op.at < n + size ||
      (op.ins !== '' && op.at === n + size && node === t[t.length - 1])
    ) {
      node.spliceText(op.at - n, op.del, op.ins, false);
      break;
    }
    n += size;
  }
  $setSelection(null);
}

describe('batched updates: a merge, then a delete of the merged text, in one commit', () => {
  for (const shape of SHAPES) {
    for (const how of ['caret', 'nodes'] as const) {
      for (const batched of [true, false]) {
        for (const op of shape.ops) {
          for (const ids of [
            [1, 2],
            [2, 1],
          ] as const) {
            test(`${shape.name}; delete by ${how}; ${batched ? 'one commit' : 'two commits (control)'}; peer ${op.name}; ids ${ids}`, async () => {
              const {a, b} = await start(shape.segs);
              const author = ids[0] === 1 ? a : b;
              const other = ids[0] === 1 ? b : a;
              const before = textOf(author);
              author.written.inserted = author.written.deleted = '';
              const c0 = author.commits();
              if (batched) {
                // Two updates, one commit (Lexical batches them).
                author.editor.update(shape.u1);
                author.editor.update(() => shape.u2(how));
              } else {
                author.editor.update(shape.u1, {discrete: true});
                author.editor.update(() => shape.u2(how), {discrete: true});
              }
              await flush();
              const commits = author.commits() - c0;
              const authorLine = lineOf(author);
              const wrote = {...author.written};
              other.editor.update(() => $peerOp(op), {discrete: true});
              await sync([a, b]);
              const f = await fresh(author);
              const result = {
                author: textOf(author),
                authorLine,
                before,
                commits,
                fresh: textOf(f),
                other: textOf(other),
                want: op.want,
                wrote,
              };
              expect(commits).toBe(batched ? 1 : 2);
              expect(authorLine.replace(/\*|_|\|/g, '')).toBe(shape.after);
              expect(result.author).toBe(result.other);
              expect(result.fresh).toBe(result.author);
              expect(a.errors).toEqual([]);
              expect(b.errors).toEqual([]);
              expect(result.author).toBe(op.want);
            });
          }
        }
      }
    }
  }
});

describe('one update: a transform deletes text the normalization merged', () => {
  for (const op of SHAPES[0].ops) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ] as const) {
      test(`S1 by a TextNode transform; peer ${op.name}; ids ${ids}`, async () => {
        const {a, b} = await start(SHAPES[0].segs);
        const author = ids[0] === 1 ? a : b;
        const other = ids[0] === 1 ? b : a;
        let armed = true;
        // An app transform: drops a trailing "la " from plain text.
        const off = author.editor.registerNodeTransform(TextNode, node => {
          if (
            armed &&
            node.getFormat() === 0 &&
            node.getTextContent() === 'x la '
          ) {
            armed = false;
            node.spliceText(2, 3, '');
          }
        });
        author.written.inserted = author.written.deleted = '';
        const c0 = author.commits();
        author.editor.update(SHAPES[0].u1, {discrete: true});
        off();
        const commits = author.commits() - c0;
        const authorLine = lineOf(author);
        const wrote = {...author.written};
        other.editor.update(() => $peerOp(op), {discrete: true});
        await sync([a, b]);
        const f = await fresh(author);
        const result = {
          author: textOf(author),
          authorLine,
          commits,
          fresh: textOf(f),
          other: textOf(other),
          want: op.want,
          wrote,
        };
        expect(commits).toBe(1);
        expect(authorLine.replace(/\*|_|\|/g, '')).toBe(SHAPES[0].after);
        expect(result.author).toBe(result.other);
        expect(result.fresh).toBe(result.author);
        expect(result.author).toBe(op.want);
      });
    }
  }
});
