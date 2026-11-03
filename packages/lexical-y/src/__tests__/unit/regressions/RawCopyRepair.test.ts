/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */

// A raw Yjs writer's copy of a seed's end (prop's raw-writer lane, seed
// 9001291): a plain Y.Doc peer (createYDoc, so copy repair is installed)
// removes italic over part of the seed's paired italic run; Yjs's format()
// restores the previous value after its range by copying the seed's relative
// end into a new item of its own client, in a local transaction. Copy repair
// rewrites that copy to name the seed's opener, so "d" and "e" keep their
// italic, as on main (gc off and on).

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  defineExtension,
  type TextFormatType,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYCollabConfig, createYDoc, YCollabExtension} from '../../..';
import {seedYState} from '../../../headless';

const CONFIG = {extensions: [RichTextExtension], schemaVersion: 1};
const KEYS = ['b', 'i', 's'] as const;
const FMT: Record<string, TextFormatType> = {
  b: 'bold',
  i: 'italic',
  s: 'strikethrough',
};

function $texts(): TextNode[] {
  return ($getRoot().getFirstChildOrThrow() as any)
    .getChildren()
    .filter($isTextNode);
}
function $splitAt(off: number) {
  let acc = 0;
  for (const t of $texts()) {
    const n = t.getTextContentSize();
    if (off > acc && off < acc + n) {
      t.splitText(off - acc);
      return;
    }
    acc += n;
  }
}
function $setRange(i: number, j: number, key: string, on: boolean) {
  $splitAt(i);
  $splitAt(j);
  let acc = 0;
  for (const t of $texts()) {
    const n = t.getTextContentSize();
    if (acc >= i && acc + n <= j && t.hasFormat(FMT[key]) !== on) {
      t.toggleFormat(FMT[key]);
    }
    acc += n;
  }
}
function $chars(): [string, string[]][] {
  const out: [string, string[]][] = [];
  for (const t of $texts()) {
    const keys = KEYS.filter(k => t.hasFormat(FMT[k]));
    for (const c of t.getTextContent()) {
      out.push([c, [...keys]]);
    }
  }
  return out;
}

// prop id1102 raw writer (GPT C1 class): a legacy-seeded document; 1-2 binding peers and one RAW peer R (a plain Y.Doc,
// no binding) that writes plain values with Yjs format() on covered keys. Phase 1: binding peers format (concurrent);
// full sync (R sees the layout 3 record and the runs in mixed mode). Phase 2: R writes 1-2 raw formats while each
// binding peer makes 0-1 more change; full sync. UW_MODE=legacy: binding peers legacy (main's path); mixed: identity.
// Output ops: binding peers' ops (both phases) then R's ops last. Env as PropUpgradeWindow (UW_START, UW_N, UW_OUT,
// UW_MODE, PROP_GC, UW_SPECS).
function prng(seed: number) {
  let x = (seed * 2654435761 + 11) >>> 0;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}
const LET = 'abcdefghijklmnopqrstuvwxyz';
const FKEY: Record<string, string> = {
  b: 'f:bold',
  i: 'f:italic',
  s: 'f:strikethrough',
};
function gen(seed: number) {
  const r = prng(seed);
  const ri = (k: number) => Math.floor(r() * k);
  const nw = 3 + ri(3);
  const words: any[] = [];
  for (let w = 0; w < nw; w++) {
    const f: any = {};
    for (const k of KEYS) f[k] = r() < 0.4;
    words.push([LET[w * 3] + LET[w * 3 + 1] + LET[w * 3 + 2], f]);
  }
  const len = nw * 3;
  const nb = r() < 0.5 ? 2 : 1;
  const ids = [1, 2, 3].slice(0, nb + 1);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = ri(i + 1);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const op = () => {
    const i = ri(len);
    const j = i + 1 + ri(Math.min(6, len - i));
    return {i, j, key: KEYS[ri(3)], v: r() < 0.5};
  };
  const p1: any[][] = [];
  const p2: any[][] = [];
  for (let p = 0; p < nb; p++) {
    p1.push(Array.from({length: 1 + ri(2)}, op));
    p2.push(r() < 0.5 ? [op()] : []);
  }
  const raw = Array.from({length: 1 + ri(2)}, op);
  return {
    ids,
    nb,
    ops: [...p1.map((o, i) => [...o, ...p2[i]]), raw],
    p1,
    p2,
    raw,
    seed,
    words,
  };
}

function runRW(spec: any, mode: string, gcOn: boolean) {
  const seeded = seedYState(CONFIG, () => {
    const p = $createParagraphNode();
    for (const [w, f] of spec.words) {
      const t = $createTextNode(w);
      for (const k of KEYS) if (f[k]) t.toggleFormat(FMT[k]);
      p.append(t);
    }
    $getRoot().clear().append(p);
  });
  const peers = spec.ids.slice(0, spec.nb).map((id: number, n: number) => {
    const doc = createYDoc(seeded, {gc: gcOn});
    doc.clientID = id;
    if (mode === 'mixed') throw new Error('l3only: no switch');
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          RichTextExtension,
          createYCollabConfig({
            captureTimeout: 2 ** 30,
            doc,
            layoutUpgrade: null,
            schemaVersion: 1,
            synced: true,
          }),
        ],
        name: `rw-${n}`,
        onError: e => {
          throw e;
        },
      }),
    );
    getExtensionDependencyFromEditor(editor, YCollabExtension);
    return {doc, editor};
  });
  const raw = createYDoc(seeded, {gc: gcOn});
  raw.clientID = spec.ids[spec.nb];
  const docs = [...peers.map((p: any) => p.doc), raw];
  const syncAll = () => {
    for (let round = 0; round < 2; round++)
      for (const a of docs)
        for (const b of docs)
          if (a !== b)
            Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  };
  try {
    peers.forEach((p: any, n: number) => {
      for (const o of spec.p1[n])
        p.editor.update(() => $setRange(o.i, o.j, o.key, o.v), {
          discrete: true,
        });
    });
    syncAll();
    const root: any = (raw as any).share.get('lexical-y');
    for (const o of spec.raw)
      raw.transact(() =>
        root.format(o.i, o.j - o.i, {[FKEY[o.key]]: o.v ? true : null}),
      );
    peers.forEach((p: any, n: number) => {
      for (const o of spec.p2[n])
        p.editor.update(() => $setRange(o.i, o.j, o.key, o.v), {
          discrete: true,
        });
    });
    syncAll();
    const chars = peers.map((p: any) =>
      JSON.stringify(p.editor.read(() => $chars())),
    );
    return {
      L: -1,
      chars: chars[0],
      conv: chars.every((c: string) => c === chars[0]),
      ids: spec.ids,
      nb: spec.nb,
      ops: spec.ops,
      seed: spec.seed,
      words: spec.words,
    };
  } finally {
    for (const p of peers) p.editor.dispose();
  }
}
/**
 * prop id1102 guard (raw writer's Yjs-level copy of a seed end): seed 9001291 of the raw-writer family. The plain Y.Doc
 * peer R (createYDoc, so copy repair is installed) unitalicizes "f..i" over the seed's paired italic run of "def"; Yjs's
 * format() restores the previous value after its range by COPYING the seed's relative end [5] into a new item of R's
 * client. Copy repair must rewrite that copy to name the seed opener absolutely ([seedClient, 10]); 15b69da6 does,
 * 6954dfe7 / 180c7224 (perf (a): holders noted only where a local transaction deletes an end) leave it relative, so it
 * names nothing and "de" lose their italic. Expected (15b69da6, main): d and e bold+italic.
 */
test('raw writer copy of a seed end is repaired (seed 9001291, gc off and on)', () => {
  for (const gc of [false, true]) {
    const r: any = runRW(gen(9001291), 'legacy', gc);
    const chars = JSON.parse(r.chars)
      .map(([c, f]: any) => c + (f.length ? '[' + f.join('') + ']' : ''))
      .join('');
    expect(chars).toBe('a[s]b[s]c[is]d[bi]e[bi]f[bs]g[s]h[s]i[s]');
  }
});
