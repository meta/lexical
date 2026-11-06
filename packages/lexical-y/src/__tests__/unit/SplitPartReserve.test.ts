/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A part Lexical split off a node whose text equals the node's old text does
// not, by that alone, hold the node's characters (R16A-1). Line 2: "c " |
// **"ab"** | " d". u1 types "ab" at the end of the bold run (it is "abab");
// u2 unbolds its first two characters, the original "ab": Lexical splits the
// node at 2, its first part (the original "ab", the node's own key) is plain
// and merges into "c ", and the part split off (the typed "ab", bold) equals
// the node's old text. After: "c ab" | **"ab"** | " d". The record of text
// edits says which characters are which, so the typed part is new text and
// the original characters keep their items: a peer's concurrent delete of
// an original character, or typing between them, stays where it was made.
// In one commit (two updates), one update (app code), u2 by an app
// transform inside u1, and two commits.
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
      name: 'reserve/' + id,
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
        return t.hasFormat('bold') ? `**${s}**` : s;
      })
      .join('|'),
  );
}
/** The line with bold marked per character run, node boundaries dropped. */
function styled(p: Peer): string {
  return p.editor.getEditorState().read(() => {
    let out = '';
    let bold = false;
    for (const t of $texts()) {
      const b = t.hasFormat('bold');
      if (b !== bold) {
        out += '**';
        bold = b;
      }
      out += t.getTextContent();
    }
    return bold ? out + '**' : out;
  });
}
async function start() {
  const a = peer(1);
  const b = peer(2);
  a.editor.update(
    () => {
      const p = $createParagraphNode();
      const bold = $createTextNode('ab');
      bold.toggleFormat('bold');
      p.append($createTextNode('c '), bold, $createTextNode(' d'));
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
  // As a selection made in the editor: it carries the format of its text.
  sel.format = t.getFormat();
  $setSelection(sel);
  return sel;
}
/** u1: type "ab" at the end of the bold node (caret typing). */
function $u1() {
  const x = $texts().find(t => t.hasFormat('bold'))!;
  $select(x, 2, 2).insertText('ab');
}
/** u2: unbold the first two characters of the bold node (the original "ab"). */
function $u2() {
  const x = $texts().find(t => t.hasFormat('bold'))!;
  $select(x, 0, 2).formatText('bold');
  $setSelection(null);
}
/** u2 by node edits (what an app transform does). */
function $u2Nodes(x: TextNode) {
  const [first] = x.splitText(2);
  first.toggleFormat('bold');
}

type PeerOp = {
  name: string;
  at: number;
  del: number;
  ins: string;
  text: string;
  styled: string | null;
};
// Old line 2: "c ab d": "c " [0,2), bold "ab" [2,4), " d" [4,6).
const OPS: PeerOp[] = [
  {
    at: 0,
    del: 0,
    ins: '',
    name: 'none',
    styled: 'c ab**ab** d',
    text: 'c abab d',
  },
  {
    at: 3,
    del: 1,
    ins: '',
    name: 'deletes the original b',
    styled: 'c a**ab** d',
    text: 'c aab d',
  },
  // Q's format depends on Y's format ranges; its place does not.
  {
    at: 3,
    del: 0,
    ins: 'Q',
    name: 'types Q between the original a and b',
    styled: null,
    text: 'c aQbab d',
  },
  // The text only: every client and a fresh reader end with " d" bold too
  // (Yjs format items; also with two commits).
  {
    at: 2,
    del: 2,
    ins: '',
    name: 'deletes the original ab',
    styled: null,
    text: 'c ab d',
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
    if (op.at < n + size) {
      node.spliceText(op.at - n, op.del, op.ins, false);
      break;
    }
    n += size;
  }
  $setSelection(null);
}
describe('a split part equal to the old text of the node it was split from', () => {
  for (const mode of ['batched', 'single', 'transform', 'separate'] as const) {
    for (const op of OPS) {
      for (const ids of [
        [1, 2],
        [2, 1],
      ] as const) {
        test(`${mode}; peer ${op.name}; ids ${ids}`, async () => {
          const {a, b} = await start();
          const author = ids[0] === 1 ? a : b;
          const other = ids[0] === 1 ? b : a;
          let armed = false;
          const stops = [a, b].map(p =>
            p.editor.registerNodeTransform(TextNode, node => {
              if (
                armed &&
                p === author &&
                node.hasFormat('bold') &&
                node.getTextContent() === 'abab'
              ) {
                armed = false;
                $u2Nodes(node);
              }
            }),
          );
          await flush();
          await flush();
          await sync([a, b]);
          author.written.inserted = author.written.deleted = '';
          const c0 = author.commits();
          if (mode === 'batched') {
            author.editor.update($u1);
            author.editor.update($u2);
          } else if (mode === 'single') {
            author.editor.update(() => {
              $u1();
              $u2();
            });
          } else if (mode === 'transform') {
            armed = true;
            author.editor.update($u1, {discrete: true});
          } else {
            author.editor.update($u1, {discrete: true});
            author.editor.update($u2, {discrete: true});
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
            author: styled(author),
            authorLine,
            commits,
            fresh: styled(f),
            other: styled(other),
            want: op.styled ?? op.text,
            warnings: [...a.warnings, ...b.warnings].slice(0, 3),
            wrote,
          };
          expect(commits).toBe(mode === 'separate' ? 2 : 1);
          expect(authorLine).toBe('c ab|**ab**| d');
          expect(result.author).toBe(result.other);
          expect(result.fresh).toBe(result.author);
          expect(a.errors).toEqual([]);
          expect(b.errors).toEqual([]);
          const plain = (x: string) => x.replace(/\*\*/g, '');
          expect(plain(result.author)).toBe(op.text);
          if (op.styled !== null) {
            expect(result.author).toBe(op.styled);
          }
        });
      }
    }
  }
});
