/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

/**
 * $splitTailOrigins (the extract() fix) reads the same commit-wide merge
 * record (`normalizedNodes`) as $mergedOrigins, but had no F1 check: a node merged in update 1 and deleted
 * in update 2 of the same commit (or by a transform after the merge) can be
 * credited with an equal later node's characters.
 *
 * Line 2 (line 1 is "Title"):
 *  T1  "ab " | _"t7z "_ | "t8z " | **"la "** | _"zz"_ | "la " | _"end"_
 *      u1: extract() from the start of "t7z " to "t8|z ", remove the
 *          extracted nodes (the tail "z " merges into "ab "), and unbold
 *          "la " (merges too): "ab z la " | _zz_ | "la " | _end_.
 *      u2: delete that "la " again and "zz" (the plain "la " merges in).
 *      Survivors: "ab ", the tail "z " of "t8z ", the LAST "la ", "end".
 *  T2  "ab " | _"t7z "_ | "t8z " | **"z "** | _"end"_
 *      u1: the same extract + remove ("ab z ").
 *      u2: delete the tail "z " again, unbold "z " (it merges in).
 *      Survivors: "ab ", the bold "z " (now plain), "end".
 *  Each: u2 by node edits (no selection) or by a caret range; u1 and u2 in
 *  one commit (two editor.update() calls), in two commits (control), or u2
 *  done by an app TextNode transform inside u1 (one update).
 */
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
      name: 'r15a/' + id,
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
  const log: string[] = [];
  editor.registerUpdateListener(({dirtyLeaves, tags, normalizedNodes}) => {
    if (dirtyLeaves.size > 0) {
      commits++;
      log.push(
        `[${[...tags].join(',')}] leaves=${dirtyLeaves.size} norm=${normalizedNodes.size}`,
      );
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
    log,
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
/** extract() from the start of node 1 to offset 2 of node 2, then remove what it returns. */
function $extractRemove() {
  const [, b, s] = $texts();
  const sel = $selectAcross(b, 0, s, 2);
  const extracted = sel.extract();
  $setSelection(null);
  for (const x of extracted) {
    x.remove();
  }
  $setSelection(null);
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
  u1: () => void;
  u2: (how: 'caret' | 'nodes') => void;
  /** The node text the transform variant acts on after u1's merge. */
  armedText: string;
  after: string;
  ops: PeerOp[];
};

const SHAPES: Shape[] = [
  {
    after: 'ab z la end',
    armedText: 'ab z la ',
    name: 'T1 extract tail + unbold merge, then that merged text deleted, equal text merges in',
    ops: [
      {at: 0, del: 0, ins: '', name: 'none', want: 'ab z la end'},
      {
        at: 16,
        del: 0,
        ins: 'Q',
        name: 'types Q in front of the surviving "la "',
        want: 'ab z Qla end',
      },
      {
        at: 16,
        del: 1,
        ins: '',
        name: 'deletes the surviving "la "\'s l',
        want: 'ab z a end',
      },
      {
        at: 11,
        del: 3,
        ins: '',
        name: 'deletes the deleted (bold) "la " too',
        want: 'ab z la end',
      },
    ],
    segs: [
      ['ab ', ''],
      ['t7z ', 'italic'],
      ['t8z ', ''],
      ['la ', 'bold'],
      ['zz', 'italic'],
      ['la ', ''],
      ['end', 'italic'],
    ],
    u1: () => {
      $extractRemove();
      const j = $texts().find(t => t.hasFormat('bold'))!;
      j.toggleFormat('bold');
      $setSelection(null);
    },
    u2: how => {
      // "ab z la " | _zz_ | "la " | _end_ after u1.
      const [n, zz, la] = $texts();
      if (how === 'caret') {
        $selectAcross(n, 5, la, 0).removeText();
      } else {
        $setSelection(null);
        n.spliceText(5, 3, '');
        zz.remove();
      }
    },
  },
  {
    after: 'ab z end',
    armedText: 'ab z ',
    name: 'T2 extract tail merged, then deleted, equal text merges in',
    ops: [
      {at: 0, del: 0, ins: '', name: 'none', want: 'ab z end'},
      {
        at: 11,
        del: 0,
        ins: 'Q',
        name: 'types Q in front of the surviving (bold) "z "',
        want: 'ab Qz end',
      },
      {
        at: 11,
        del: 1,
        ins: '',
        name: 'deletes the surviving "z "\'s z',
        want: 'ab  end',
      },
      {
        at: 9,
        del: 2,
        ins: '',
        name: 'deletes the deleted tail "z " too',
        want: 'ab z end',
      },
    ],
    segs: [
      ['ab ', ''],
      ['t7z ', 'italic'],
      ['t8z ', ''],
      ['z ', 'bold'],
      ['end', 'italic'],
    ],
    u1: () => {
      $extractRemove();
      $setSelection(null);
    },
    u2: how => {
      // "ab z " | **z ** | _end_ after u1.
      const [n, z] = $texts();
      if (how === 'caret') {
        $select(n, 3, 5).removeText();
      } else {
        $setSelection(null);
        n.spliceText(3, 2, '');
      }
      z.toggleFormat('bold');
    },
  },
  {
    after: 'x end',
    armedText: 'x  ',
    name: 'T3 extract tail " " merged, then deleted again (shared trailing space)',
    ops: [
      {at: 0, del: 0, ins: '', name: 'none', want: 'x end'},
      {
        at: 1,
        del: 1,
        ins: '',
        name: 'deletes the survivor "x "\'s space',
        want: 'xend',
      },
      {
        at: 2,
        del: 0,
        ins: 'Q',
        name: 'types Q after the survivor "x "',
        want: 'x Qend',
      },
      {
        at: 8,
        del: 1,
        ins: '',
        name: 'deletes the deleted tail " " too',
        want: 'x end',
      },
    ],
    segs: [
      ['x ', ''],
      ['t7z ', 'italic'],
      ['t8 ', ''],
      ['end', 'italic'],
    ],
    u1: () => {
      $extractRemove();
      $setSelection(null);
    },
    u2: how => {
      // "x  " | _end_ after u1.
      const [n] = $texts();
      if (how === 'caret') {
        $select(n, 2, 3).removeText();
      } else {
        $setSelection(null);
        n.spliceText(2, 1, '');
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

describe('round 14 split-tail attribution with the commit-wide merge record', () => {
  for (const shape of SHAPES) {
    for (const how of ['caret', 'nodes'] as const) {
      for (const mode of ['batched', 'separate', 'transform'] as const) {
        if (mode === 'transform' && how === 'caret') {
          continue;
        }
        for (const op of shape.ops) {
          for (const ids of [
            [1, 2],
            [2, 1],
          ] as const) {
            test(`${shape.name}; u2 by ${how}; ${mode}; peer ${op.name}; ids ${ids}`, async () => {
              const {a, b} = await start(shape.segs);
              const author = ids[0] === 1 ? a : b;
              const other = ids[0] === 1 ? b : a;
              const before = textOf(author);
              let armed = false;
              const stops = [a, b].map(p =>
                p.editor.registerNodeTransform(TextNode, node => {
                  if (
                    armed &&
                    p === author &&
                    node.getTextContent() === shape.armedText &&
                    node.getFormat() === 0
                  ) {
                    armed = false;
                    // The app's transform does u2's work on the merged node.
                    shape.u2('nodes');
                  }
                }),
              );
              // Let the update that runs the newly registered transform commit first.
              await flush();
              await flush();
              await sync([a, b]);
              author.written.inserted = author.written.deleted = '';
              const c0 = author.commits();
              if (mode === 'batched') {
                author.editor.update(shape.u1);
                author.editor.update(() => shape.u2(how));
              } else if (mode === 'separate') {
                author.editor.update(shape.u1, {discrete: true});
                author.editor.update(() => shape.u2(how), {discrete: true});
              } else {
                armed = true;
                author.editor.update(shape.u1, {discrete: true});
              }
              await flush();
              const commits = author.commits() - c0;
              const authorLine = lineOf(author);
              const wrote = {...author.written};
              other.editor.update(() => $peerOp(op), {discrete: true});
              await sync([a, b]);
              const f = await fresh(author);
              stops.forEach(s => s());
              const result = {
                author: textOf(author),
                authorLine,
                before,
                commits,
                fresh: textOf(f),
                log: author.log.slice(-4),
                other: textOf(other),
                want: op.want,
                warnings: [...a.warnings, ...b.warnings].slice(0, 3),
                wrote,
              };
              // eslint-disable-next-line no-console
              console.log(
                `[R15A ${shape.name.slice(0, 2)} | ${how} | ${mode} | ${op.name} | ${ids}] ${JSON.stringify(result)}`,
              );
              expect(commits).toBe(mode === 'separate' ? 2 : 1);
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
