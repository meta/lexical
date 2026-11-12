/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Replays reduced runs of the property suite's op lists (two peers on a
// seeded line: B formats ranges and inserts "Z", A types plain digits, B
// undoes) through the binding, and checks the outcome: letters keep their
// formats, digits stay plain, no "Z" is left, the peers converge.

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  defineExtension,
  type TextFormatType,
  type TextNode,
  UNDO_COMMAND,
} from 'lexical';

import {createYDoc, YCollabExtension} from '../..';
import {seedYState} from '../../headless';
import {createYCollabConfig} from '../../internal/YExtension';

const CONFIG = {extensions: [RichTextExtension], schemaVersion: 1};
export const KEYS = ['b', 'i', 's'] as const;
export type Key = (typeof KEYS)[number];
const FMT: Record<Key, TextFormatType> = {
  b: 'bold',
  i: 'italic',
  s: 'strikethrough',
};

export type Op =
  | 'sync'
  | 'undo'
  | ['type', number, string]
  | ['insZ', number]
  | ['format' | 'unformat', number, number, Key];
export type Run = {
  ids: [number, number];
  key: string;
  ops: Op[];
  words: [string, string][];
};

function $texts(): TextNode[] {
  const line = $getRoot().getFirstChildOrThrow();
  return $isElementNode(line) ? line.getChildren().filter($isTextNode) : [];
}
function $len(): number {
  return $texts().reduce((n, t) => n + t.getTextContentSize(), 0);
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
function $setRange(i: number, j: number, key: Key, on: boolean) {
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
function $typePlain(i: number, s: string) {
  const ts = $texts();
  let acc = 0;
  let node = ts[ts.length - 1];
  let off = node.getTextContentSize();
  for (const t of ts) {
    const n = t.getTextContentSize();
    if (i <= acc + n) {
      node = t;
      off = i - acc;
      break;
    }
    acc += n;
  }
  const sel = $createRangeSelection();
  sel.anchor.set(node.getKey(), off, 'text');
  sel.focus.set(node.getKey(), off, 'text');
  $setSelection(sel);
  sel.format = 0;
  sel.insertText(s);
  $setSelection(null);
}
function $chars(): [string, Key[]][] {
  const out: [string, Key[]][] = [];
  for (const t of $texts()) {
    const keys = KEYS.filter(k => t.hasFormat(FMT[k]));
    for (const c of t.getTextContent()) {
      out.push([c, keys]);
    }
  }
  return out;
}

/** What went wrong: E extra format, L lost format, A a digit formatted, Z a "Z" left, D divergence. */
export function oracle(
  a: [string, Key[]][],
  b: [string, Key[]][],
  words: [string, string][],
): string {
  const orig = new Map<string, string>();
  for (const [w, f] of words) {
    for (const c of w) {
      orig.set(c, f);
    }
  }
  let flags = '';
  for (const [c, keys] of a) {
    if (c === 'Z') {
      flags += 'Z';
    } else if (/[0-9]/.test(c)) {
      flags += keys.length > 0 ? 'A' : '';
    } else {
      const o = orig.get(c) ?? '';
      flags += keys.some(k => !o.includes(k)) ? 'E' : '';
      flags += [...o].some(k => !keys.includes(k as Key)) ? 'L' : '';
    }
  }
  return flags + (JSON.stringify(a) === JSON.stringify(b) ? '' : 'D');
}

export function run(spec: Run, gc: boolean): string {
  const seeded = seedYState(CONFIG, () => {
    const p = $createParagraphNode();
    for (const [w, f] of spec.words) {
      const t = $createTextNode(w);
      for (const k of KEYS) {
        if (f.includes(k)) {
          t.toggleFormat(FMT[k]);
        }
      }
      p.append(t);
    }
    $getRoot().clear().append(p);
  });
  const peers = spec.ids.map((id, n) => {
    const doc = createYDoc(seeded, {gc});
    doc.clientID = id;
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
        name: `edge-${n}`,
        onError: e => {
          throw e;
        },
      }),
    );
    const {binding} = getExtensionDependencyFromEditor(
      editor,
      YCollabExtension,
    ).output;
    return {binding, doc, editor};
  });
  const [A, B] = peers;
  const sync = () => {
    for (let q = 0; q < 2; q++) {
      Y.applyUpdate(
        B.doc,
        Y.encodeStateAsUpdate(A.doc, Y.encodeStateVector(B.doc)),
      );
      Y.applyUpdate(
        A.doc,
        Y.encodeStateAsUpdate(B.doc, Y.encodeStateVector(A.doc)),
      );
    }
  };
  const clamp = (i: number, len: number) => Math.max(0, Math.min(i, len));
  try {
    for (const op of spec.ops) {
      if (op === 'sync') {
        sync();
      } else if (op === 'undo') {
        B.editor.dispatchCommand(UNDO_COMMAND, undefined);
      } else if (op[0] === 'type') {
        const [, i, ch] = op;
        const len = A.editor.read(() => $len());
        A.editor.update(() => $typePlain(clamp(i, len), ch), {discrete: true});
      } else if (op[0] === 'insZ') {
        const len = B.editor.read(() => $len());
        B.editor.update(() => $typePlain(clamp(op[1], len), 'Z'), {
          discrete: true,
        });
        B.binding.undoManager?.stopCapturing();
      } else {
        const [kind, from, to, key] = op;
        const len = B.editor.read(() => $len());
        const i = clamp(from, len - 1);
        const j = clamp(to, len);
        if (len > 0 && j > i) {
          B.editor.update(() => $setRange(i, j, key, kind === 'format'), {
            discrete: true,
          });
          B.binding.undoManager?.stopCapturing();
        }
      }
    }
    sync();
    return oracle(
      A.editor.read(() => $chars()),
      B.editor.read(() => $chars()),
      spec.words,
    );
  } finally {
    for (const p of peers) {
      p.editor.dispose();
    }
  }
}
