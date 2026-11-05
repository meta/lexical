/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Bindings that stop, and new ones that start on the same document while a
 * raw peer writes: caches tied to a binding's lifetime must not outlive it.
 *
 * Per session: one document (createYDoc) and a bound editor that makes
 * random local edits, then stops. A raw remote peer (plain @y/y, no
 * @lexical/y code, its own client id) makes random structural and format
 * changes to the layout root (deletes that may cross line ends, text
 * inserts with or without formats, covered and uncovered format writes),
 * applied to the unbound document; then a new binding starts on it and
 * edits. After every author edit, and right after each rebind, the author's
 * editor equals a fresh reader of the encoded document and nothing threw.
 * gc from LEXICAL_Y_GC; RB_CYCLES (default 8) and RB_OPS (author edits per
 * bound phase, default 5) size a session.
 */
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getState,
  $isTextNode,
  $setSelection,
  $setState,
  createState,
  type LexicalEditor,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, type YDoc} from '../../..';
import {createBoundEditor, NODES} from '../../utils/harness';

// Sessions of the rebind generator that an earlier revision of layout 3 got
// wrong with gc off and on (text shown twice, or typed text in another
// paragraph) after a binding stopped while a raw peer wrote and a new
// binding started on the same document. The cause was a per-item memo of
// prevLiveEnd that outlived the binding; it is removed. Main and layout 3:
// none wrong.
const SESSIONS = [
  100014, 100017, 100035, 100044, 100059, 100080, 100081, 100093,
];
const CYCLES = Number(process.env.RB_CYCLES ?? 8);
const OPS = Number(process.env.RB_OPS ?? 5);
const GC = process.env.LEXICAL_Y_GC === '1';

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}
const anchor = createState('anchor', {
  parse: (v: unknown) => (typeof v === 'string' ? v : ''),
});
const WORDS =
  'one two three four five six seven eight nine ten red blue lime teal'.split(
    ' ',
  );

type Bound = ReturnType<typeof createBoundEditor> & {
  stop: () => void;
  warns: string[];
  errors: string[];
};
function bind(doc: YDoc): Bound {
  const warns: string[] = [];
  const errors: string[] = [];
  const b = createBoundEditor(doc, {
    namespace: 'rb',
    nodes: NODES,
    onError: e => {
      errors.push(String((e as Error)?.message ?? e));
      throw e;
    },
    onWarn: e => {
      warns.push(String((e as Error)?.message ?? e));
    },
    selfCheck: true,
  });
  const {sharedConfigMap} = (b.editor as any)._nodes.get(
    'text',
  )!.sharedNodeState;
  if (!sharedConfigMap.has(anchor.key)) sharedConfigMap.set(anchor.key, anchor);
  const stop = b.start();
  return Object.assign(b, {errors, stop, warns});
}
const json = (e: LexicalEditor) => {
  const j = e.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .map(
        p =>
          (p as any)
            .getChildren?.()
            .map((n: any) =>
              $isTextNode(n)
                ? `${n.getTextContent()}{${n.getFormat()}|${n.getStyle()}|${$getState(n, anchor)}}`
                : n.getType(),
            )
            .join('') ?? p.getType(),
      ),
  );
  return j.join(' / ');
};
const tick = () => new Promise<void>(r => setTimeout(r, 0));

function freshOf(doc: YDoc): string {
  const d = createYDoc(null, {gc: GC});
  Y.applyUpdate(d as never, Y.encodeStateAsUpdate(doc as never));
  const f = bind(d);
  f.binding.initialize();
  const s = json(f.editor);
  f.stop();
  return s;
}

function $texts(): TextNode[] {
  return $getRoot().getAllTextNodes().filter($isTextNode) as TextNode[];
}

function $authorOp(r: () => number): string {
  const ts = $texts();
  const kind = Math.floor(r() * 7);
  if (ts.length === 0 || kind === 6) {
    const p = $createParagraphNode().append(
      $createTextNode(WORDS[Math.floor(r() * WORDS.length)]),
    );
    const kids = $getRoot().getChildren();
    if (kids.length > 0 && r() < 0.5)
      kids[Math.floor(r() * kids.length)].insertAfter(p);
    else $getRoot().append(p);
    return 'new paragraph';
  }
  const t = ts[Math.floor(r() * ts.length)];
  const len = t.getTextContentSize();
  const at = Math.floor(r() * (len + 1));
  switch (kind) {
    case 0:
      t.spliceText(at, 0, 'q');
      return `type q in "${t.getTextContent()}"@${at}`;
    case 1: {
      if (len === 0) return 'noop';
      const a = Math.floor(r() * len);
      const b = Math.min(len, a + 1 + Math.floor(r() * 3));
      const parts = t.splitText(a, b);
      const mid = a === 0 ? parts[0] : parts[1];
      mid.toggleFormat(r() < 0.5 ? 'bold' : 'italic');
      return `format [${a},${b}) of "${t.getTextContent()}"`;
    }
    case 2:
      t.setStyle(r() < 0.5 ? 'color: red' : '');
      return `style "${t.getTextContent()}"`;
    case 3: {
      if (len === 0) return 'noop';
      const a = Math.floor(r() * len);
      t.spliceText(a, Math.min(2, len - a), '');
      return `delete@${a} in "${t.getTextContent()}"`;
    }
    case 4:
      $setState(t, anchor, r() < 0.5 ? 'w' : '');
      return `anchor on "${t.getTextContent()}"`;
    default: {
      const sel = $createRangeSelection();
      sel.anchor.set(t.getKey(), at, 'text');
      sel.focus.set(t.getKey(), at, 'text');
      $setSelection(sel);
      sel.insertParagraph();
      $setSelection(null);
      return `split "${t.getTextContent()}"@${at}`;
    }
  }
}

function remoteOps(doc: YDoc, r: () => number, client: number): string[] {
  const remote = new Y.Doc({gc: GC});
  remote.clientID = client;
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc as never));
  const sv = Y.encodeStateVector(remote);
  const root = remote.get('lexical-y') as any;
  const log: string[] = [];
  const n = 1 + Math.floor(r() * 3);
  remote.transact(() => {
    for (let i = 0; i < n; i++) {
      const L = root.length;
      if (L < 2) break;
      const at = Math.floor(r() * (L - 1));
      const k = Math.floor(r() * 5);
      if (k === 0) {
        const m = Math.min(1 + Math.floor(r() * 4), L - 1 - at);
        if (m > 0) {
          root.delete(at, m);
          log.push(`del ${at}+${m}`);
        }
      } else if (k === 1) {
        const attrs =
          r() < 0.4
            ? {
                [r() < 0.5 ? 'f:bold' : 's:anchor']:
                  r() < 0.5 ? (r() < 0.5 ? true : 'r') : null,
              }
            : undefined;
        root.insert(at, 'zq', attrs as any);
        log.push(`ins ${at} ${JSON.stringify(attrs ?? {})}`);
      } else {
        const m = Math.min(1 + Math.floor(r() * 5), L - 1 - at);
        if (m <= 0) continue;
        const key = k === 2 ? 's:anchor' : k === 3 ? 'f:bold' : 'f:italic';
        const v = r() < 0.6 ? (key === 's:anchor' ? 'r' : true) : null;
        root.format(at, m, {[key]: v});
        log.push(`fmt ${at}+${m} ${key}=${JSON.stringify(v)}`);
      }
    }
  });
  Y.applyUpdate(doc as never, Y.encodeStateAsUpdate(remote, sv), 'remote');
  return log;
}

for (const seed of SESSIONS) {
  test(
    `rebind session ${seed}: the author equals a fresh reader after every op and rebind`,
    {timeout: 60_000},
    async () => {
      const r = rng(seed);
      const doc = createYDoc(null, {gc: GC});
      doc.clientID = 1000 + (seed % 1000);
      let b = bind(doc);
      const words = 3 + Math.floor(r() * 4);
      b.editor.update(
        () => {
          $getRoot().clear();
          for (let i = 0; i < words; i++)
            $getRoot().append(
              $createParagraphNode().append(
                $createTextNode(
                  `${WORDS[i % WORDS.length]} ${WORDS[(i + 3) % WORDS.length]}`,
                ),
              ),
            );
        },
        {discrete: true},
      );
      b.binding.initialize();
      await tick();
      // an uncovered value across the whole content (written raw, as an app would), then a first format
      const root = doc.get('lexical-y') as any;
      doc.transact(
        () => root.format(0, root.length - 1, {'s:anchor': 'v'}),
        'raw',
      );
      await tick();
      let first: unknown = null;
      let scFirst: unknown = null;
      const ops: string[] = [];
      let warnsAll = 0;
      let errorsAll = 0;
      const check = (cycle: number, phase: string, op: string) => {
        if (first !== null) return;
        const author = json(b.editor);
        const fresh = freshOf(doc);
        const sc = b.warns.filter(w => w.includes('self-check'));
        if (author !== fresh || b.errors.length > 0)
          first = {
            author,
            cycle,
            errors: b.errors.slice(0, 2),
            fresh,
            op,
            phase,
            selfCheck: sc.slice(0, 2),
          };
        else if (sc.length > 0 && scFirst === null)
          scFirst = {cycle, op, phase, selfCheck: sc.slice(0, 2)};
      };
      try {
        for (let c = 0; c < CYCLES && first === null; c++) {
          for (let i = 0; i < OPS && first === null; i++) {
            let op = '';
            b.editor.update(
              () => {
                op = $authorOp(r);
              },
              {discrete: true},
            );
            await tick();
            ops.push(`c${c} A ${op}`);
            check(c, 'bound', op);
          }
          warnsAll += b.warns.length;
          errorsAll += b.errors.length;
          b.stop();
          const log = remoteOps(doc, r, 77 + c);
          ops.push(`c${c} R ${log.join('; ')}`);
          b = bind(doc);
          b.binding.initialize();
          await tick();
          check(c, 'rebind', log.join('; '));
        }
      } catch (e) {
        if (first === null)
          first = {error: String((e as Error)?.stack ?? e).slice(0, 500)};
      }
      warnsAll += b.warns.length;
      errorsAll += b.errors.length;
      b.stop();
      void warnsAll;
      void errorsAll;
      void scFirst;
      expect(first).toBeNull();
    },
  );
}
