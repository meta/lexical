/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Randomized 3-peer fuzz. A seed generates a script (rounds of ops and
// delivery modes); runScript executes it on one binding (@lexical/y, or for
// comparison the default v2 layout of @lexical/yjs on Yjs 13) and
// returns failure signatures and outcome counts. Ops are described by
// relative random numbers, so any subset of ops still replays (the
// minimizer relies on it).

import {$isLinkNode, $toggleLink} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $insertList,
  $isListItemNode,
  $isListNode,
  type ListItemNode,
  type ListNode,
  type ListType,
} from '@lexical/list';
import {
  $createHeadingNode,
  $createQuoteNode,
  $isHeadingNode,
  $isQuoteNode,
} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  registerTablePlugin,
  type TableNode,
} from '@lexical/table';
import {
  createBindingV2__EXPERIMENTAL,
  createUndoManager,
  type Provider,
  syncLexicalUpdateToYjsV2__EXPERIMENTAL,
  syncYjsChangesToLexicalV2__EXPERIMENTAL,
  syncYjsStateToLexicalV2__EXPERIMENTAL,
} from '@lexical/yjs';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getState,
  $isDecoratorNode,
  $isElementNode,
  $isParagraphNode,
  $isRootNode,
  $isTextNode,
  $setSelection,
  $setState,
  arraySetValue,
  createEditor,
  createState,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type PointType,
  stringValue,
  type TextNode,
} from 'lexical';
import * as Y13 from 'yjs';

import {createYDoc, type YBinding, type YDoc} from '../..';
import {
  $createBoxNode,
  BoxNode,
  ColContainerNode,
  ColContentNode,
  ColTitleNode,
  createBoundEditor,
  describeNode,
  NODES,
} from './harness';

// ---------------------------------------------------------------------------
// Script

export type Mode = 'live' | 'causal' | 'sender' | 'partial' | 'bulk';
export type Op = {id: number; p: number; k: string; r: number[]};
export type Round = {mode: Mode; ops: Op[]; d: number};
export type Script = {
  seed: number;
  ids: number[];
  rounds: Round[];
  final: 'causal' | 'sender' | 'bulk';
  fd: number;
};

export function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS: [string, number][] = [
  ['type', 18],
  ['enter', 8],
  ['del', 7],
  ['bksp', 5],
  ['delfwd', 4],
  ['block', 5],
  ['list', 5],
  ['unlist', 2],
  ['indent', 4],
  ['outdent', 3],
  ['ltype', 3],
  ['check', 3],
  ['link', 4],
  ['fmt', 5],
  ['cAdd', 4],
  ['cRem', 2],
  ['table', 2],
  ['rowIns', 3],
  ['rowDel', 2],
  ['colIns', 2],
  ['colDel', 2],
  ['cont', 2],
  ['move', 4],
  ['moveli', 2],
  ['rm', 2],
  ['undo', 5],
  ['redo', 3],
];
const KIND_TOTAL = KINDS.reduce((a, [, w]) => a + w, 0);
/** Without moves (a move is a delete and a reinsert: a documented limit). */
const KINDS_NO_MOVE: [string, number][] = KINDS.map(([k, w]) => [
  k,
  k === 'move' || k === 'moveli' ? 0 : w,
]);
const KIND_TOTAL_NO_MOVE = KINDS_NO_MOVE.reduce((a, [, w]) => a + w, 0);

export type GenOptions = {
  /** Longer scripts (more rounds and ops). */
  long?: boolean;
  /** Include block moves (default true). */
  moves?: boolean;
};

function weighted<T>(table: [T, number][], total: number, x: number): T {
  let acc = x * total;
  for (const [v, w] of table) {
    if (acc < w) {
      return v;
    }
    acc -= w;
  }
  return table[table.length - 1][0];
}

const PERMS = [
  [1, 2, 3],
  [1, 3, 2],
  [2, 1, 3],
  [2, 3, 1],
  [3, 1, 2],
  [3, 2, 1],
];

export function genScript(
  seed: number,
  {
    long = process.env.FUZZ_LONG === '1',
    moves = process.env.FUZZ_NO_MOVE !== '1',
  }: GenOptions = {},
): Script {
  const rnd = mulberry32(seed * 7919 + 13 + (long ? 1000003 : 0));
  const ids = PERMS[seed % 6];
  const nRounds = long ? 6 + Math.floor(rnd() * 6) : 2 + Math.floor(rnd() * 4);
  let id = 1;
  const rounds: Round[] = [];
  for (let i = 0; i < nRounds; i++) {
    const mode = weighted<Mode>(
      [
        ['live', 25],
        ['causal', 25],
        ['sender', 25],
        ['partial', 13],
        ['bulk', 12],
      ],
      100,
      rnd(),
    );
    const n = long ? 10 + Math.floor(rnd() * 20) : 4 + Math.floor(rnd() * 11);
    const ops: Op[] = [];
    for (let j = 0; j < n; j++) {
      ops.push({
        id: id++,
        k: moves
          ? weighted(KINDS, KIND_TOTAL, rnd())
          : weighted(KINDS_NO_MOVE, KIND_TOTAL_NO_MOVE, rnd()),
        p: Math.floor(rnd() * 3),
        r: [rnd(), rnd(), rnd(), rnd(), rnd(), rnd()],
      });
    }
    rounds.push({d: rnd(), mode, ops});
  }
  return {
    fd: rnd(),
    final: ((x: number) => (x < 0.4 ? 'causal' : x < 0.8 ? 'sender' : 'bulk'))(
      rnd(),
    ),
    ids,
    rounds,
    seed,
  };
}

// ---------------------------------------------------------------------------
// Peers and network

const NET = {net: true};
const HEADLESS_ONLY = 'window object not found';

/**
 * Which binding a fuzz peer runs: @lexical/y, or @lexical/yjs's default v2
 * layout (the differential mode runs both).
 */
export type Layout = 'y' | 'v2';

let LAYOUT: Layout = 'y';
export function setLayout(layout: Layout): void {
  LAYOUT = layout;
}

type YModule = {
  applyUpdate: (doc: never, update: Uint8Array, origin?: unknown) => void;
  encodeStateAsUpdate: (doc: never) => Uint8Array;
  encodeStateVector: (doc: never) => Uint8Array;
  mergeUpdates: (updates: Uint8Array[]) => Uint8Array;
};

/** The binding side of a peer, the same for every layout. */
type Side = {
  initialize(): void;
  status(): string;
  undo(): boolean;
  redo(): boolean;
  stopCapturing(): void;
  clearUndo(): void;
  /** Undo and redo stack sizes. */
  depth(): [number, number];
  dump(): string;
};

function fakeProvider(): Provider {
  const awareness = {
    getLocalState: () => awareness.state,
    getStates: () => new Map(),
    off: () => {},
    on: () => {},
    setLocalState: (state: unknown) => {
      awareness.state = state;
    },
    setLocalStateField: () => {},
    state: null as unknown,
  };
  return {
    awareness,
    connect: () => {},
    disconnect: () => {},
    off: () => {},
    on: () => {},
  } as unknown as Provider;
}

export class FPeer {
  readonly doc: {
    clientID: number;
    on: (event: 'update', fn: (u: Uint8Array, origin: unknown) => void) => void;
  };
  readonly Y: YModule;
  readonly layout: Layout;
  readonly editor: LexicalEditor;
  readonly side: Side;
  /** The @lexical/y binding (layout 'y' only). */
  readonly binding: YBinding | null = null;
  errors: string[] = [];
  warnings: string[] = [];
  sent: Uint8Array[] = [];
  sentSeq: number[] = [];
  cursor = new Map<FPeer, number>();
  constructor(
    readonly name: string,
    clientID: number,
    readonly world: World | null,
    layout: Layout = LAYOUT,
  ) {
    this.layout = layout;
    const gc = process.env.FUZZ_GC === '1';
    const onError = (e: Error) => {
      const message = String((e && (e as Error).message) || e);
      // Headless: Lexical asks the DOM selection to extend over some
      // characters (an op the fuzz then skips); not a binding error.
      if (!message.includes(HEADLESS_ONLY)) {
        this.errors.push(message);
      }
      throw e;
    };
    const onWarn = (e: Error) => {
      this.warnings.push(String(e && (e as Error).message));
    };
    let bound: ReturnType<typeof createBoundEditor> | null = null;
    let yDoc: YDoc | null = null;
    if (layout === 'y') {
      yDoc = createYDoc(null, {gc});
      yDoc.clientID = clientID;
      // Warnings go to the editor's onWarn (above); a self-check finding
      // fails the seed.
      bound = createBoundEditor(yDoc, {
        namespace: 'fuzz',
        nodes: NODES,
        onError,
        onWarn,
        selfCheck: true,
      });
    }
    this.editor =
      bound !== null
        ? bound.editor
        : createEditor({namespace: 'fuzz', nodes: NODES, onError, onWarn});
    registerCommentState(this.editor);
    // Lexical's table plugin, as an app with tables registers it: a table
    // command, or a local edit that marks a table dirty, pads a table that a
    // race left ragged, under the editing client's own id.
    registerTablePlugin(this.editor);
    if (layout === 'y') {
      this.doc = yDoc!;
      this.Y = Y as unknown as YModule;
      const binding = bound!.binding;
      this.binding = binding;
      bound!.start();
      this.side = {
        clearUndo: () => binding.undoManager?.clear(),
        depth: () => [
          binding.undoManager?.undoStack.length ?? 0,
          binding.undoManager?.redoStack.length ?? 0,
        ],
        dump: () => binding.root.toString(),
        initialize: () => binding.initialize(),
        redo: () => binding.redo(),
        status: () => binding.status,
        stopCapturing: () => binding.undoManager?.stopCapturing(),
        undo: () => binding.undo(),
      };
    } else {
      const doc = new Y13.Doc({gc});
      doc.clientID = clientID;
      this.doc = doc;
      this.Y = Y13 as unknown as YModule;
      const provider = fakeProvider();
      const binding = createBindingV2__EXPERIMENTAL(
        this.editor,
        'main',
        doc,
        new Map([['main', doc]]),
      );
      const um = createUndoManager(binding, binding.root);
      binding.root.observeDeep((events, transaction) => {
        if (transaction.origin !== binding) {
          syncYjsChangesToLexicalV2__EXPERIMENTAL(
            binding,
            provider,
            events as never,
            transaction,
            transaction.origin instanceof Y13.UndoManager,
          );
        }
      });
      this.editor.registerUpdateListener(
        ({
          prevEditorState,
          editorState,
          dirtyElements,
          dirtyLeaves,
          normalizedNodes,
          tags,
        }) => {
          syncLexicalUpdateToYjsV2__EXPERIMENTAL(
            binding,
            provider,
            prevEditorState,
            editorState,
            dirtyElements,
            dirtyLeaves,
            normalizedNodes,
            tags,
          );
        },
      );
      this.side = {
        clearUndo: () => um.clear(),
        depth: () => [um.undoStack.length, um.redoStack.length],
        dump: () => binding.root.toString(),
        initialize: () => {
          // A fresh reader loads the state that was applied to its doc.
          syncYjsStateToLexicalV2__EXPERIMENTAL(binding, provider);
        },
        redo: () => um.redo() !== null,
        status: () => 'active',
        stopCapturing: () => um.stopCapturing(),
        undo: () => um.undo() !== null,
      };
    }
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === NET || this.world === null) {
        return;
      }
      this.sent.push(update);
      this.sentSeq.push(this.world.seq++);
    });
  }
  json(): string {
    return JSON.stringify(this.editor.getEditorState().toJSON());
  }
  describe(): string {
    return this.editor
      .getEditorState()
      .read(() => $getRoot().getChildren().map(describeNode).join(' / '));
  }
}

const TOKEN_RE = /<\d+(?:\.\d+)?>/g;
const VALID_TEXT = /^(?:<\d+(?:\.\d+)?>)*$/;

type TokInfo = {op: number; peer: number; round: number; inCont: boolean};

export type Failure = {sig: string; detail: string};

export class World {
  seq = 0;
  peers: FPeer[] = [];
  tokens = new Map<string, TokInfo>();
  deleted = new Set<string>();
  removals: {round: number; peer: number; k: string}[] = [];
  failures: Failure[] = [];
  trace: string[] | null = null;
  fragTainted = false;
  deliveries = 0;
  round = 0;
  /** Outcome counts, for comparing layouts on the same script. */
  metrics = {
    containerLost: 0,
    diverged: false,
    dup: 0,
    dups: [] as string[],
    fragment: false,

    lineLost: 0,

    /** Unique tokens lost / duplicated, sorted. */
    lost: [] as string[],
    /** Lost tokens typed inside a container some other peer removed. */
    lostInContainer: [] as string[],

    /** Deleted tokens present at the end (restored by an undo, or not). */
    resurrected: [] as string[],

    threw: false,
  };
  fail(sig: string, detail: string) {
    if (!this.failures.some(f => f.sig === sig)) {
      this.failures.push({detail: detail.slice(0, 4000), sig});
    }
  }
  log(s: string) {
    if (this.trace) {
      this.trace.push(s);
    }
  }
}

function applyTo(world: World, receiver: FPeer, updates: Uint8Array[]) {
  const u =
    updates.length === 1 ? updates[0] : receiver.Y.mergeUpdates(updates);
  world.deliveries++;
  try {
    receiver.Y.applyUpdate(receiver.doc as never, u, NET);
  } catch (e) {
    world.fail(
      'apply-throw:' + norm(String((e as Error).message || e)),
      String((e as Error).stack || e),
    );
  }
}

const MAX_DELIVERIES = 2000;

/** Deliver everything in global emit order (causal). */
function deliverCausal(world: World, rnd: () => number) {
  const merge = rnd() < 0.5;
  for (let guard = 0; guard < MAX_DELIVERIES; guard++) {
    let best: [FPeer, FPeer, number] | null = null;
    for (const r of world.peers) {
      for (const s of world.peers) {
        if (r === s) {
          continue;
        }
        const c = r.cursor.get(s) ?? 0;
        if (c < s.sent.length) {
          const seq = s.sentSeq[c];
          if (best === null || seq < best[2]) {
            best = [r, s, seq];
          }
        }
      }
    }
    if (best === null) {
      return;
    }
    const [r, s] = best;
    const c = r.cursor.get(s) ?? 0;
    // Merge a run of consecutive updates of s that precede any other
    // sender's next update for r (still causal).
    let end = c + 1;
    if (merge) {
      let otherMin = Infinity;
      for (const o of world.peers) {
        if (o !== r && o !== s) {
          const oc = r.cursor.get(o) ?? 0;
          if (oc < o.sent.length) {
            otherMin = Math.min(otherMin, o.sentSeq[oc]);
          }
        }
      }
      while (end < s.sent.length && s.sentSeq[end] < otherMin) {
        end++;
      }
    }
    r.cursor.set(s, end);
    applyTo(world, r, s.sent.slice(c, end));
  }
  world.fail('no-quiescence', 'causal delivery did not settle');
}

/** Per-sender in-order, random interleaving across senders/receivers. */
function deliverSender(world: World, rnd: () => number, subset?: FPeer[]) {
  const peers = subset ?? world.peers;
  // Within a partition, a peer relays what it has received (as a sync
  // protocol does): r can get x's updates up to what another member holds.
  const available = (r: FPeer, x: FPeer): number => {
    let n = 0;
    for (const p of peers) {
      if (p !== r) {
        n = Math.max(n, p === x ? x.sent.length : (p.cursor.get(x) ?? 0));
      }
    }
    return n;
  };
  for (let guard = 0; guard < MAX_DELIVERIES; guard++) {
    const pairs: [FPeer, FPeer][] = [];
    for (const r of peers) {
      for (const s of world.peers) {
        if (r !== s && available(r, s) > (r.cursor.get(s) ?? 0)) {
          pairs.push([r, s]);
        }
      }
    }
    if (pairs.length === 0) {
      return;
    }
    const [r, s] = pairs[Math.floor(rnd() * pairs.length)];
    const c = r.cursor.get(s) ?? 0;
    const n = Math.min(available(r, s) - c, 1 + Math.floor(rnd() * 3));
    r.cursor.set(s, c + n);
    applyTo(world, r, s.sent.slice(c, c + n));
  }
  world.fail('no-quiescence', 'sender delivery did not settle');
}

/**
 * Provider-style catch-up: each receiver gets one Y.mergeUpdates of each
 * sender's pending updates (senders in random order; not causal).
 */
function deliverBulk(world: World, rnd: () => number) {
  for (let guard = 0; guard < 100; guard++) {
    let any = false;
    const receivers = [...world.peers].sort(() => rnd() - 0.5);
    for (const r of receivers) {
      const senders = world.peers.filter(s => s !== r).sort(() => rnd() - 0.5);
      for (const s of senders) {
        const c = r.cursor.get(s) ?? 0;
        if (c < s.sent.length) {
          any = true;
          r.cursor.set(s, s.sent.length);
          applyTo(world, r, s.sent.slice(c));
        }
      }
    }
    if (!any) {
      return;
    }
  }
  world.fail('no-quiescence', 'bulk delivery did not settle');
}

// ---------------------------------------------------------------------------
// Document helpers

// Comments are one set-valued NodeState (`arraySetValue`), as MarkStateExtension
// stores them: each id is its own format. FUZZ_COMMENTS=keys uses one boolean
// state per id instead.
const COMMENT_COUNT = 6;
const COMMENTS_AS_KEYS = process.env.FUZZ_COMMENTS === 'keys';
const COMMENT_KEYS = Array.from({length: COMMENT_COUNT}, (_, i) =>
  createState(`mark:c${i}`, {parse: (v: unknown) => v === true}),
);
const commentSetState = createState('comments', {
  parse: arraySetValue(stringValue()),
});

function $getComments(node: LexicalNode): number[] {
  if (COMMENTS_AS_KEYS) {
    return COMMENT_KEYS.flatMap((c, i) => ($getState(node, c) ? [i] : []));
  }
  return $getState(node, commentSetState).map(id => Number(id.slice(1)));
}

function $setComment(node: LexicalNode, i: number, on: boolean): void {
  if (COMMENTS_AS_KEYS) {
    $setState(node, COMMENT_KEYS[i], on);
    return;
  }
  const id = `c${i}`;
  $setState(node, commentSetState, prev =>
    prev.includes(id) === on
      ? prev
      : on
        ? [...prev, id]
        : prev.filter(other => other !== id),
  );
}

/**
 * Make the comment state known to TextNode on this editor, as
 * MarkStateExtension registers its state when the editor is built (in the
 * node type's shared state config, with no update), so that every peer (and
 * a fresh reader) joins the per-id formats it reads back into one set. An
 * update here would commit before the peers' seed, and BlockIdExtension
 * would then not name the seed as a load: each peer would give its blocks
 * other ids and write the initial content once more.
 */
function registerCommentState(editor: LexicalEditor): void {
  if (COMMENTS_AS_KEYS) {
    return;
  }
  const {sharedConfigMap} = editor._nodes.get('text')!.sharedNodeState;
  if (!sharedConfigMap.has(commentSetState.key)) {
    sharedConfigMap.set(commentSetState.key, commentSetState);
  }
}
const URLS = ['https://a.x', 'https://b.x', 'https://c.x'];
const LIST_TYPES: ListType[] = ['bullet', 'number', 'check'];

function atLinkEdge(point: PointType): boolean {
  const node = point.getNode();
  if (!$isTextNode(node) || !$isLinkNode(node.getParent())) {
    return false;
  }
  return point.offset === 0 || point.offset === node.getTextContentSize();
}

function pick<T>(arr: T[], x: number): T {
  return arr[Math.min(arr.length - 1, Math.floor(x * arr.length))];
}

function isWrapperItem(n: LexicalNode): boolean {
  return $isListItemNode(n) && $isListNode(n.getFirstChild());
}

function isLine(n: LexicalNode): n is ElementNode {
  return (
    ($isParagraphNode(n) ||
      $isHeadingNode(n) ||
      $isQuoteNode(n) ||
      ($isListItemNode(n) && !isWrapperItem(n)) ||
      n instanceof ColTitleNode) &&
    !n.isInline()
  );
}

function isContainer(n: LexicalNode): n is ElementNode {
  return (
    $isRootNode(n) ||
    $isTableCellNode(n) ||
    n instanceof ColContentNode ||
    n instanceof BoxNode
  );
}

function $all(): LexicalNode[] {
  const out: LexicalNode[] = [];
  const visit = (n: LexicalNode) => {
    out.push(n);
    if ($isElementNode(n)) {
      n.getChildren().forEach(visit);
    }
  };
  visit($getRoot());
  return out;
}

function $lines(): ElementNode[] {
  return $all().filter(isLine);
}

function containerOf(n: LexicalNode): ElementNode {
  let p = n.getParent();
  while (p !== null && ($isListNode(p) || $isListItemNode(p))) {
    p = p.getParent();
  }
  return p!;
}

function inNestedContainer(n: LexicalNode): boolean {
  for (let p = n.getParent(); p !== null; p = p.getParent()) {
    if (
      $isTableNode(p) ||
      p instanceof BoxNode ||
      p instanceof ColContainerNode
    ) {
      return true;
    }
  }
  return false;
}

type Pos = {line: ElementNode; text: TextNode | null; off: number};

function positions(line: ElementNode): Pos[] {
  const texts = line.getAllTextNodes();
  if (texts.length === 0) {
    return [{line, off: 0, text: null}];
  }
  const out: Pos[] = [];
  for (const t of texts) {
    const s = t.getTextContent();
    out.push({line, off: 0, text: t});
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '>') {
        out.push({line, off: i + 1, text: t});
      }
    }
  }
  return out;
}

function setPoint(pt: PointType, pos: Pos) {
  if (pos.text) {
    pt.set(pos.text.getKey(), pos.off, 'text');
  } else {
    pt.set(pos.line.getKey(), 0, 'element');
  }
}

function $select(a: Pos, b: Pos = a) {
  const sel = $createRangeSelection();
  setPoint(sel.anchor, a);
  setPoint(sel.focus, b);
  $setSelection(sel);
  return sel;
}

function $tokensOf(): {counts: Map<string, number>; frags: string[]} {
  const counts = new Map<string, number>();
  const frags: string[] = [];
  for (const t of $getRoot().getAllTextNodes()) {
    const s = t.getTextContent();
    if (!VALID_TEXT.test(s)) {
      frags.push(s);
    }
    for (const m of s.match(TOKEN_RE) || []) {
      counts.set(m, (counts.get(m) || 0) + 1);
    }
  }
  return {counts, frags};
}

function $para(tok: string) {
  return $createParagraphNode().append($createTextNode(tok));
}

// ---------------------------------------------------------------------------
// Ops

type Ctx = {
  world: World;
  peer: number;
  op: Op;
  newTok: (sub?: number) => string;
};

/** Returns a description, or null when not applicable. */
function $op(ctx: Ctx): string | null {
  const {op} = ctx;
  const r = op.r;
  $setSelection(null);
  const lines = $lines();
  const lineIn = (pred: (l: ElementNode) => boolean) => lines.filter(pred);
  const descLine = (l: LexicalNode) => describeNode(l).slice(0, 80);
  switch (op.k) {
    case 'type':
    case 'enter': {
      if (lines.length === 0) {
        return null;
      }
      const line = pick(lines, r[0]);
      const pos = pick(positions(line), r[1]);
      const sel = $select(pos);
      if (op.k === 'type') {
        const tok = ctx.newTok();
        sel.insertText(tok);
        return `type ${tok} in ${descLine(line)} @${pos.off}`;
      }
      sel.insertParagraph();
      return `enter in ${descLine(line)} @${pos.off}`;
    }
    case 'del':
    case 'fmt': {
      if (lines.length === 0) {
        return null;
      }
      const line = pick(lines, r[0]);
      const cont = containerOf(line);
      const same = lines.filter(l => containerOf(l).is(cont));
      const all = same.flatMap(positions);
      let i = Math.floor(r[1] * all.length);
      let j = Math.floor(r[2] * all.length);
      if (i > j) {
        [i, j] = [j, i];
      }
      // keep ranges small-ish
      j = Math.min(j, i + 1 + Math.floor(r[3] * 6));
      j = Math.min(j, all.length - 1);
      if (i >= j) {
        return null;
      }
      const sel = $select(all[i], all[j]);
      const txt = sel.getTextContent();
      if (op.k === 'del') {
        sel.removeText();
        return `del ${JSON.stringify(txt)}`;
      }
      const f = r[4] < 0.5 ? 'bold' : 'italic';
      sel.formatText(f);
      return `${f} ${JSON.stringify(txt)}`;
    }
    case 'link':
    case 'cAdd': {
      const cands = lineIn(l => l.getTextContentSize() > 0);
      if (cands.length === 0) {
        return null;
      }
      const line = pick(cands, r[0]);
      const ps = positions(line);
      let i = Math.floor(r[1] * ps.length);
      let j = Math.floor(r[2] * ps.length);
      if (i > j) {
        [i, j] = [j, i];
      }
      if (i >= j) {
        j = Math.min(ps.length - 1, i + 1);
      }
      if (i >= j) {
        return null;
      }
      const sel = $select(ps[i], ps[j]);
      const txt = sel.getTextContent();
      if (txt === '') {
        return null;
      }
      if (op.k === 'link') {
        const url = r[3] < 0.3 ? null : pick(URLS, r[4]);
        // @lexical/link bug (also on main, any editor): unlinking a range
        // that ends at the edge of a link's text throws in
        // $splitLinkAtSelection. Not generated.
        if (url === null && [sel.anchor, sel.focus].some(atLinkEdge)) {
          return null;
        }
        $toggleLink(url);
        return `link ${url} ${JSON.stringify(txt)}`;
      }
      const c = Math.floor(r[3] * COMMENT_COUNT);
      for (const n of sel.extract()) {
        if ($isTextNode(n)) {
          $setComment(n, c, true);
        }
      }
      return `comment c${c} ${JSON.stringify(txt)}`;
    }
    case 'cRem': {
      const texts = $getRoot()
        .getAllTextNodes()
        .filter(t => $getComments(t).length > 0);
      if (texts.length === 0) {
        return null;
      }
      const t = pick(texts, r[0]);
      const i = pick($getComments(t), r[1]);
      $setComment(t, i, false);
      return `uncomment c${i} ${t.getTextContent()}`;
    }
    case 'bksp': {
      const cands = lineIn(l => {
        const prev = l.getPreviousSibling();
        if (prev !== null) {
          return isLine(prev);
        }
        const parent = l.getParent();
        if ($isListItemNode(l) && $isListNode(parent)) {
          const pp = parent.getPreviousSibling();
          return pp !== null && isLine(pp) && $isRootNode(parent.getParent());
        }
        return false;
      });
      if (cands.length === 0) {
        return null;
      }
      const line = pick(cands, r[0]);
      const sel = $select(positions(line)[0]);
      sel.deleteCharacter(true);
      return `bksp@start ${descLine(line)}`;
    }
    case 'delfwd': {
      const cands = lineIn(l => {
        const next = l.getNextSibling();
        return next !== null && isLine(next);
      });
      if (cands.length === 0) {
        return null;
      }
      const line = pick(cands, r[0]);
      const ps = positions(line);
      const sel = $select(ps[ps.length - 1]);
      sel.deleteCharacter(false);
      return `del@end ${descLine(line)}`;
    }
    case 'block': {
      const cands = lineIn(
        l => $isParagraphNode(l) || $isHeadingNode(l) || $isQuoteNode(l),
      );
      if (cands.length === 0) {
        return null;
      }
      const line = pick(cands, r[0]);
      const sel = $select(pick(positions(line), r[1]));
      const t = Math.floor(r[2] * 4);
      $setBlocksType(sel, () =>
        t === 0
          ? $createHeadingNode('h1')
          : t === 1
            ? $createHeadingNode('h2')
            : t === 2
              ? $createQuoteNode()
              : $createParagraphNode(),
      );
      return `block ${['h1', 'h2', 'quote', 'p'][t]} ${descLine(line)}`;
    }
    case 'list': {
      const cands = lineIn(
        l => $isParagraphNode(l) || $isHeadingNode(l) || $isQuoteNode(l),
      );
      if (cands.length === 0) {
        return null;
      }
      const line = pick(cands, r[0]);
      $select(pick(positions(line), r[1]));
      const lt = pick(LIST_TYPES, r[2]);
      $insertList(lt);
      return `list ${lt} ${descLine(line)}`;
    }
    case 'unlist': {
      const cands = lineIn(l => $isListItemNode(l));
      if (cands.length === 0) {
        return null;
      }
      const line = pick(cands, r[0]);
      const sel = $select(pick(positions(line), r[1]));
      $setBlocksType(sel, () => $createParagraphNode());
      return `unlist ${descLine(line)}`;
    }
    case 'indent':
    case 'outdent': {
      const cands = lineIn(
        l =>
          $isListItemNode(l) &&
          (op.k === 'indent' ? l.getIndent() < 4 : l.getIndent() > 0),
      ) as ListItemNode[];
      if (cands.length === 0) {
        return null;
      }
      const li = pick(cands, r[0]);
      const ind = li.getIndent();
      li.setIndent(op.k === 'indent' ? ind + 1 : ind - 1);
      return `${op.k} ${descLine(li)} from ${ind}`;
    }
    case 'ltype': {
      const lists = $all().filter($isListNode) as ListNode[];
      if (lists.length === 0) {
        return null;
      }
      const l = pick(lists, r[0]);
      const lt = pick(LIST_TYPES, r[1]);
      l.setListType(lt);
      return `ltype ${lt} ${descLine(l)}`;
    }
    case 'check': {
      const cands = lineIn(
        l =>
          $isListItemNode(l) &&
          $isListNode(l.getParent()) &&
          (l.getParent() as ListNode).getListType() === 'check',
      ) as ListItemNode[];
      if (cands.length === 0) {
        return null;
      }
      const li = pick(cands, r[0]);
      li.setChecked(!li.getChecked());
      return `check ${descLine(li)}`;
    }
    case 'table':
    case 'cont': {
      const containers = $all().filter(isContainer);
      const cont = r[0] < 0.6 ? $getRoot() : pick(containers, r[1]);
      let node: ElementNode;
      if (op.k === 'table') {
        const rows = 1 + Math.floor(r[2] * 2);
        const cols = 1 + Math.floor(r[3] * 3);
        const table = $createTableNode();
        let k = 0;
        for (let i = 0; i < rows; i++) {
          const row = $createTableRowNode();
          for (let j = 0; j < cols; j++) {
            row.append($createTableCellNode().append($para(ctx.newTok(k++))));
          }
          table.append(row);
        }
        node = table;
      } else {
        const t = Math.floor(r[2] * 3);
        if (t === 0) {
          node = $create(ColContainerNode).append(
            $create(ColTitleNode).append($createTextNode(ctx.newTok(0))),
            $create(ColContentNode).append($para(ctx.newTok(1))),
          );
        } else if (t === 1) {
          node = $createBoxNode('b').append($para(ctx.newTok(0)));
        } else {
          node = $createBoxNode('o').append(
            $createBoxNode('i').append($para(ctx.newTok(0))),
          );
        }
      }
      const kids = cont.getChildren();
      if (kids.length === 0) {
        cont.append(node);
      } else {
        const target = pick(kids, r[4]);
        if (r[5] < 0.5) {
          target.insertAfter(node);
        } else {
          target.insertBefore(node);
        }
      }
      return `${op.k} ${describeNode(node).slice(0, 80)} in ${cont.getType()}`;
    }
    case 'rowIns':
    case 'rowDel':
    case 'colIns':
    case 'colDel': {
      const tables = $all().filter($isTableNode) as TableNode[];
      if (tables.length === 0) {
        return null;
      }
      const table = pick(tables, r[0]);
      const rows = table.getChildren().filter($isTableRowNode) as ElementNode[];
      if (rows.length === 0) {
        return null;
      }
      const widths = rows.map(row => row.getChildrenSize());
      if (op.k === 'rowIns') {
        const ref = pick(rows, r[1]);
        const row = $createTableRowNode();
        const w = Math.max(1, ref.getChildrenSize());
        for (let j = 0; j < w; j++) {
          row.append($createTableCellNode().append($para(ctx.newTok(j))));
        }
        if (r[2] < 0.5) {
          ref.insertAfter(row);
        } else {
          ref.insertBefore(row);
        }
        return `rowIns w=${w}`;
      }
      if (op.k === 'rowDel') {
        if (rows.length < 2) {
          return null;
        }
        const row = pick(rows, r[1]);
        const d = describeNode(row).slice(0, 80);
        row.remove();
        return `rowDel ${d}`;
      }
      const maxW = Math.max(...widths);
      const minW = Math.min(...widths);
      if (op.k === 'colIns') {
        const c = Math.floor(r[1] * (maxW + 1));
        rows.forEach((row, ri) => {
          const cell = $createTableCellNode().append($para(ctx.newTok(ri)));
          const kids = row.getChildren();
          if (c < kids.length) {
            kids[c].insertBefore(cell);
          } else {
            row.append(cell);
          }
        });
        return `colIns @${c}`;
      }
      if (minW < 2) {
        return null;
      }
      const c = Math.floor(r[1] * minW);
      for (const row of rows) {
        row.getChildren()[c].remove();
      }
      return `colDel @${c}`;
    }
    case 'move':
    case 'rm': {
      const blocks = $all().filter(n => {
        const p = n.getParent();
        return (
          p !== null &&
          isContainer(p) &&
          ($isElementNode(n) || $isDecoratorNode(n))
        );
      });
      if (blocks.length === 0) {
        return null;
      }
      const node = pick(blocks, r[0]);
      if ($isRootNode(node.getParent()) && $getRoot().getChildrenSize() < 2) {
        return null;
      }
      const d = describeNode(node).slice(0, 80);
      if (op.k === 'rm') {
        node.remove();
        return `rm ${d}`;
      }
      const targets = blocks.filter(
        b => !b.is(node) && !($isElementNode(node) && node.isParentOf(b)),
      );
      if (targets.length === 0) {
        return null;
      }
      const target = pick(targets, r[1]);
      if ($isElementNode(node) && node.isParentOf(target)) {
        return null;
      }
      if (r[2] < 0.5) {
        target.insertAfter(node);
      } else {
        target.insertBefore(node);
      }
      return `move ${d} ${r[2] < 0.5 ? 'after' : 'before'} ${describeNode(target).slice(0, 60)}`;
    }
    case 'moveli': {
      const items = lineIn(l => $isListItemNode(l));
      if (items.length < 2) {
        return null;
      }
      const li = pick(items, r[0]);
      // Never into its own subtree (Lexical would build a cycle).
      const others = items.filter(x => !x.is(li) && !li.isParentOf(x));
      if (others.length === 0) {
        return null;
      }
      const target = pick(others, r[1]);
      if (r[2] < 0.5) {
        target.insertAfter(li);
      } else {
        target.insertBefore(li);
      }
      return `moveli ${descLine(li)} near ${descLine(target)}`;
    }
  }
  return null;
}

const REMOVAL_KINDS = new Set([
  'rm',
  'move',
  'rowDel',
  'colDel',
  'undo',
  'redo',
  'del',
]);

function runOp(world: World, round: number, op: Op) {
  const peer = world.peers[op.p];
  const name = peer.name;
  const before = peer.editor.getEditorState().read($tokensOf);
  const newToks: string[] = [];
  const ctx: Ctx = {
    newTok: sub => {
      const t = sub === undefined ? `<${op.id}>` : `<${op.id}.${sub}>`;
      newToks.push(t);
      return t;
    },
    op,
    peer: op.p,
    world,
  };
  let desc: string | null = null;
  peer.side.stopCapturing();
  try {
    if (op.k === 'undo' || op.k === 'redo') {
      const depth = peer.side.depth();
      const did = op.k === 'undo' ? peer.side.undo() : peer.side.redo();
      // Yjs skips stack items that no longer change anything: how many are
      // popped depends on the layout (part of how the op resolved).
      const popped =
        op.k === 'undo'
          ? depth[0] - peer.side.depth()[0]
          : depth[1] - peer.side.depth()[1];
      desc = did ? (popped > 1 ? `${op.k} x${popped}` : op.k) : null;
    } else {
      peer.editor.update(
        () => {
          desc = $op(ctx);
        },
        {discrete: true},
      );
    }
  } catch (e) {
    if (String((e as Error).message).includes(HEADLESS_ONLY)) {
      desc = null;
    } else {
      world.fail(
        `op-throw:${op.k}:` + norm(String((e as Error).message || e)),
        `op ${op.id} ${op.k} on ${name}: ${(e as Error).stack || e}`,
      );
    }
  }
  peer.side.stopCapturing();
  const after = peer.editor.getEditorState().read(() => {
    const t = $tokensOf();
    // nested-container flags for the new tokens
    const flags = new Map<string, boolean>();
    for (const tn of $getRoot().getAllTextNodes()) {
      for (const m of tn.getTextContent().match(TOKEN_RE) || []) {
        if (newToks.includes(m)) {
          flags.set(m, inNestedContainer(tn));
        }
      }
    }
    return {...t, flags};
  });
  for (const tok of newToks) {
    if (after.counts.has(tok) && !world.tokens.has(tok)) {
      world.tokens.set(tok, {
        inCont: after.flags.get(tok) ?? false,
        op: op.id,
        peer: op.p,
        round,
      });
    }
  }
  for (const [tok, n] of before.counts) {
    if ((after.counts.get(tok) ?? 0) < n) {
      world.deleted.add(tok);
    }
  }
  const newFrags = after.frags;
  if (before.frags.length === 0 && newFrags.length > 0) {
    world.fragTainted = true;
    world.fail(
      `local-fragment:${op.k}`,
      `op ${op.id} ${op.k} on ${name}: ${desc} -> ${JSON.stringify(newFrags)}`,
    );
  }
  if (desc !== null && REMOVAL_KINDS.has(op.k)) {
    world.removals.push({k: op.k, peer: op.p, round});
  }
  world.log(`[r${round}] ${name} #${op.id} ${desc ?? `(${op.k} n/a)`}`);
}

// ---------------------------------------------------------------------------
// Checks

export function norm(s: string): string {
  return s
    .split('\n')[0]
    .replace(/<\d+(?:\.\d+)?>/g, 'T')
    .replace(/\d+/g, 'N')
    .slice(0, 120);
}

function canonical(json: unknown): string[] {
  const out = new Set<string>();
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const visit = (node: any) => {
    const kids: any[] = node.children || [];
    kids.forEach((c, i) => {
      if (c.type === 'list' && (c.children || []).length === 0) {
        out.add('empty-list');
      }
      if (c.type === 'listitem' && node.type !== 'list') {
        out.add('orphan-listitem');
      }
      if (node.type === 'list' && c.type !== 'listitem') {
        out.add('list-nonitem-child');
      }
      if (
        c.type === 'list' &&
        i > 0 &&
        kids[i - 1].type === 'list' &&
        kids[i - 1].listType === c.listType
      ) {
        out.add('adjacent-equal-lists');
      }
      if (c.type === 'tablerow' && node.type !== 'table') {
        out.add('orphan-row');
      }
      if (c.type === 'tablecell' && node.type !== 'tablerow') {
        out.add('orphan-cell');
      }
      if (node.type === 'table' && c.type !== 'tablerow') {
        out.add('table-nonrow-child');
      }
      if (node.type === 'tablerow' && c.type !== 'tablecell') {
        out.add('row-noncell-child');
      }
      if (c.type === 'text' && /[\u2029\u2028\u00b6\u00a6]/.test(c.text)) {
        out.add('marker-text');
      }
      visit(c);
    });
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  visit((json as any).root);
  return [...out];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function jsonDiff(a: any, b: any, path = ''): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) {
    return null;
  }
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  ) {
    return `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (k === 'children' && Array.isArray(a[k]) && Array.isArray(b[k])) {
      if (a[k].length !== b[k].length) {
        return `${path}.children: length ${a[k].length} != ${b[k].length}`;
      }
    }
    const d = jsonDiff(a[k], b[k], `${path}.${k}`);
    if (d !== null) {
      const t = a.type ? `(${a.type})` : '';
      return t + d;
    }
  }
  return null;
}

/**
 * Documented limit: group (ListNode) non-key fields are not synchronized.
 * Strip them for the comparison and record a 'limit:' signature instead.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripLimits(node: any, strip = true): any {
  if (node && typeof node === 'object') {
    if (Array.isArray(node)) {
      return node.map(n => stripLimits(n, strip));
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(node).sort()) {
      if (
        strip &&
        (node.type === 'list' ||
          (node.type === 'listitem' &&
            node.children &&
            node.children.length > 0 &&
            node.children[0].type === 'list')) &&
        (k === 'textFormat' || k === 'textStyle')
      ) {
        continue;
      }
      out[k] = stripLimits(node[k], strip);
    }
    return out;
  }
  return node;
}

/** A coarse key for a JSON diff: node type chain tail + field. */
function diffKey(d: string | null): string {
  if (d === null) {
    return '?';
  }
  const types = d.match(/^(\([^)]*\))*/)![0].match(/\(([^)]*)\)/g) || [];
  const tail = types.slice(-2).join('');
  const m = d.replace(/^(\([^)]*\))*/, '').match(/\.([A-Za-z]+)(?::|$)/);
  const field = d.includes('length') ? 'children-length' : m ? m[1] : '?';
  return `${tail}.${field}`;
}

function normJson(p: FPeer): string {
  return JSON.stringify(stripLimits(JSON.parse(p.json())));
}

function checkPeers(world: World, phase: string) {
  const [a] = world.peers;
  const raw = a.json();
  for (const p of world.peers.slice(1)) {
    if (p.json() !== raw && normJson(p) === normJson(a)) {
      const sorted = (x: string) =>
        JSON.stringify(stripLimits(JSON.parse(x), false));
      if (sorted(raw) === sorted(p.json())) {
        world.fail('nit:json-key-order', `${a.describe()}`);
      } else {
        world.fail(
          'limit:group-textFormat/textStyle',
          String(jsonDiff(JSON.parse(raw), JSON.parse(p.json()))),
        );
      }
    }
  }
  const ja = normJson(a);
  for (const p of world.peers.slice(1)) {
    if (normJson(p) !== ja) {
      const sva = a.Y.encodeStateVector(a.doc as never).toString();
      const svp = p.Y.encodeStateVector(p.doc as never).toString();
      const dk = diffKey(jsonDiff(JSON.parse(ja), JSON.parse(normJson(p))));
      world.fail(
        `diverge${phase === 'final' ? '' : '-mid'}${sva === svp ? '' : '(yjs-sv-differs)'}:${dk}`,
        `${jsonDiff(JSON.parse(ja), JSON.parse(normJson(p)))}\n${a.name}: ${a.describe()}\n${p.name}: ${p.describe()}`,
      );
      return false;
    }
  }
  return true;
}

/**
 * What a client id wrote, one entry per clock (item boundaries differ between
 * peers that split or merged items differently): a live unit's origins,
 * parent and content; a deleted one only as gone (garbage collection drops
 * the rest at different times on different peers).
 */
function writtenBy(doc: FPeer['doc'], id: number): string {
  const store = (doc as unknown as Y.Doc).store;
  const out: unknown[] = [];
  for (const s of store.clients.get(id) ?? []) {
    for (let i = 0; i < s.length; i++) {
      const clock = s.id.clock + i;
      if (!(s instanceof Y.Item) || s.deleted) {
        out.push([clock, 'gone']);
        continue;
      }
      const c = s.content;
      out.push([
        clock,
        i === 0 ? s.origin : {client: id, clock: clock - 1},
        s.rightOrigin,
        s.parentSub,
        c instanceof Y.ContentType
          ? ['node', (c.type as Y.Node).name]
          : c instanceof Y.ContentFormat
            ? ['format', c.key, c.value]
            : c.getContent()[i],
      ]);
    }
  }
  return JSON.stringify(out);
}

function checkFinal(world: World) {
  if (world.peers[0].layout === 'y') {
    // The initial content: the same items under its derived client id on
    // every peer (and no peer wrote it twice under different ids).
    const own = new Set(world.peers.map(p => p.doc.clientID));
    const ids = [
      ...(world.peers[0].doc as unknown as Y.Doc).store.clients.keys(),
    ].filter(id => !own.has(id));
    for (const id of ids) {
      const first = writtenBy(world.peers[0].doc, id);
      for (const p of world.peers.slice(1)) {
        if (writtenBy(p.doc, id) !== first) {
          world.fail('seed-payload', `${p.name}: client ${id} differs`);
        }
      }
    }
  }
  for (const p of world.peers) {
    for (const e of p.errors) {
      world.fail('error:' + norm(e), `${p.name}: ${e}`);
    }
    for (const w of p.warnings) {
      world.fail('warn:' + norm(w), `${p.name}: ${w}`);
    }
  }
  const converged = checkPeers(world, 'final');
  world.metrics.diverged = !converged;
  world.metrics.threw = world.failures.some(
    f =>
      f.sig.startsWith('op-throw') ||
      f.sig.startsWith('apply-throw') ||
      f.sig.startsWith('error:'),
  );
  const a = world.peers[0];
  // fresh reader
  const fresh = new FPeer('fresh', 99, null, a.layout);
  try {
    fresh.Y.applyUpdate(
      fresh.doc as never,
      a.Y.encodeStateAsUpdate(a.doc as never),
      'load',
    );
    fresh.side.initialize();
  } catch (e) {
    world.fail('fresh-throw:' + norm(String(e)), String(e));
  }
  for (const e of fresh.errors) {
    world.fail('fresh-error:' + norm(e), e);
  }
  for (const w of fresh.warnings) {
    world.fail('fresh-warn:' + norm(w), w);
  }
  if (normJson(fresh) !== normJson(a)) {
    const dk = diffKey(
      jsonDiff(JSON.parse(normJson(a)), JSON.parse(normJson(fresh))),
    );
    world.fail(
      (converged ? 'fresh-mismatch:' : 'fresh-mismatch(diverged):') + dk,
      `${jsonDiff(JSON.parse(normJson(a)), JSON.parse(normJson(fresh)))}\npeer: ${a.describe()}\nfresh: ${fresh.describe()}`,
    );
  }
  for (const s of canonical(JSON.parse(a.json()))) {
    world.fail('shape:' + s, a.describe());
  }
  const {counts, frags} = a.editor.getEditorState().read($tokensOf);
  if (frags.length > 0 && !world.fragTainted) {
    world.metrics.fragment = true;
    world.fail('fragment', JSON.stringify(frags.slice(0, 5)));
  }
  const dups = [...counts].filter(([, n]) => n > 1).map(([t]) => t);
  world.metrics.dup = dups.reduce((n, t) => n + counts.get(t)! - 1, 0);
  world.metrics.dups = [...dups].sort();
  world.metrics.resurrected = [...world.deleted]
    .filter(t => counts.has(t))
    .sort();
  if (dups.length > 0) {
    const moved = dups.some(t => world.deleted.has(t));
    world.fail(
      moved ? 'dup(deleted-token)' : 'dup',
      `${dups.join(',')}\n${a.describe()}`,
    );
  }
  const lost = [...world.tokens.keys()].filter(
    t => !counts.has(t) && !world.deleted.has(t),
  );
  if (lost.length > 0) {
    const cls = lost.map(t => {
      const info = world.tokens.get(t)!;
      const inner = t.slice(1, -1);
      if (frags.some(f => f.includes(inner + '>') || f.includes('<' + inner))) {
        return 'rotated';
      }
      const otherRemoval = world.removals.some(r => r.peer !== info.peer);
      return info.inCont && otherRemoval ? 'container' : 'line';
    });
    world.metrics.lost = [...lost].sort();
    world.metrics.lostInContainer = lost
      .filter((_, i) => cls[i] === 'container')
      .sort();
    world.metrics.lineLost = cls.filter(c => c !== 'container').length;
    world.metrics.containerLost = cls.filter(c => c === 'container').length;
    const sig = cls.includes('line')
      ? 'loss?'
      : cls.includes('container')
        ? 'loss(container)'
        : 'loss(rotated)';
    world.fail(
      sig,
      `${lost.map((t, i) => `${t}[${cls[i]},op${world.tokens.get(t)!.op}]`).join(',')}\n${a.describe()}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Runner

export type RunResult = {
  seed: number;
  ms: number;
  ops: number;
  applied: number;
  deliveries: number;
  textLen: number;
  nodes: number;
  failures: Failure[];
  trace?: string[];
  metrics: World['metrics'];
  layout: Layout;
};

function $init(seed: number) {
  let k = 0;
  const t = () => `<0.${k++}>`;
  const li = () => $createListItemNode().append($createTextNode(t()));
  $getRoot().append(
    $para(t() + t()),
    $createHeadingNode('h2').append($createTextNode(t())),
    $createListNode('bullet').append(li(), li()),
    $para(t() + t() + t()),
    $createTableNode().append(
      $createTableRowNode().append(
        $createTableCellNode().append($para(t())),
        $createTableCellNode().append($para(t())),
      ),
      $createTableRowNode().append(
        $createTableCellNode().append($para(t())),
        $createTableCellNode().append($para(t())),
      ),
    ),
    $create(ColContainerNode).append(
      $create(ColTitleNode).append($createTextNode(t())),
      $create(ColContentNode).append($para(t())),
    ),
    $createBoxNode('o').append($para(t())),
    $para(t() + t()),
  );
}

export function runScript(script: Script, trace = false): RunResult {
  const t0 = performance.now();
  const world = new World();
  if (trace) {
    world.trace = [];
  }
  world.peers = script.ids.map((id, i) => new FPeer('ABC'[i] + id, id, world));
  const [a] = world.peers;
  // With @lexical/y every peer initializes the empty document with the same
  // content at once: they write the same items, under one client id derived
  // from them (checked byte for byte at the end, see checkFinal).
  for (const p of a.layout === 'y' ? world.peers : [a]) {
    p.editor.update(
      () => {
        $getRoot().clear();
        $init(script.seed);
      },
      {discrete: true},
    );
    if (p.layout === 'y') {
      p.side.initialize();
    }
  }
  deliverCausal(world, () => 0.9);
  for (const p of world.peers) {
    if (p.side.status() !== 'active') {
      world.fail('init-not-active', p.name + ' ' + p.side.status());
    }
    p.side.clearUndo();
  }
  a.editor.getEditorState().read(() => {
    for (const tok of $tokensOf().counts.keys()) {
      world.tokens.set(tok, {inCont: false, op: 0, peer: 0, round: -1});
    }
  });
  let ops = 0;
  let applied = 0;
  script.rounds.forEach((round, ri) => {
    world.round = ri;
    const rnd = mulberry32(Math.floor(round.d * 1e9));
    world.log(`-- round ${ri} mode=${round.mode}`);
    for (const op of round.ops) {
      ops++;
      runOp(world, ri, op);
      applied++;
      if (round.mode === 'live') {
        deliverCausal(world, rnd);
      }
    }
    if (round.mode === 'causal') {
      deliverCausal(world, rnd);
    } else if (round.mode === 'bulk') {
      deliverBulk(world, rnd);
    } else if (round.mode === 'sender') {
      deliverSender(world, rnd);
    } else if (round.mode === 'partial') {
      const i = Math.floor(rnd() * 3);
      const j = (i + 1 + Math.floor(rnd() * 2)) % 3;
      deliverSender(world, rnd, [world.peers[i], world.peers[j]]);
      world.log(`   partial ${world.peers[i].name}<->${world.peers[j].name}`);
    }
    if (round.mode !== 'partial') {
      checkPeers(world, 'mid');
    }
  });
  const frnd = mulberry32(Math.floor(script.fd * 1e9));
  if (script.final === 'causal') {
    deliverCausal(world, frnd);
  } else if (script.final === 'bulk') {
    deliverBulk(world, frnd);
  } else {
    deliverSender(world, frnd);
  }
  // settle anything emitted while receiving
  deliverCausal(world, frnd);
  checkFinal(world);
  const {textLen, nodes} = a.editor.getEditorState().read(() => ({
    nodes: $all().length,
    textLen: $getRoot().getTextContentSize(),
  }));
  return {
    applied,
    deliveries: world.deliveries,
    failures: world.failures,
    layout: a.layout,
    metrics: world.metrics,
    ms: Math.round(performance.now() - t0),
    nodes,
    ops,
    seed: script.seed,
    textLen,
    trace: world.trace ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Minimizer (ddmin over ops, then rounds, then mode simplification)

export function minimize(
  script: Script,
  sig: string,
  budget = 600,
): {script: Script; runs: number} {
  let runs = 0;
  const fails = (s: Script) => {
    runs++;
    try {
      return runScript(s).failures.some(f => f.sig === sig);
    } catch {
      return false;
    }
  };
  let cur: Script = JSON.parse(JSON.stringify(script));
  const flat = (s: Script) =>
    s.rounds.flatMap((r, ri) => r.ops.map(op => [ri, op] as const));
  const withOps = (s: Script, keep: Set<number>): Script => ({
    ...s,
    rounds: s.rounds.map(r => ({...r, ops: r.ops.filter(o => keep.has(o.id))})),
  });
  // drop whole rounds
  for (let i = cur.rounds.length - 1; i >= 0 && runs < budget; i--) {
    if (cur.rounds.length <= 1) {
      break;
    }
    const cand = {...cur, rounds: cur.rounds.filter((_, j) => j !== i)};
    if (fails(cand)) {
      cur = cand;
    }
  }
  // ddmin on ops
  let n = 2;
  while (runs < budget) {
    const ids = flat(cur).map(([, op]) => op.id);
    if (ids.length <= 1) {
      break;
    }
    const chunk = Math.ceil(ids.length / n);
    let reduced = false;
    for (let s = 0; s < ids.length && runs < budget; s += chunk) {
      const remove = new Set(ids.slice(s, s + chunk));
      const keep = new Set(ids.filter(x => !remove.has(x)));
      const cand = withOps(cur, keep);
      if (fails(cand)) {
        cur = cand;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (chunk <= 1) {
        break;
      }
      n = Math.min(ids.length, n * 2);
    }
  }
  // drop empty rounds
  for (let i = cur.rounds.length - 1; i >= 0 && runs < budget; i--) {
    if (cur.rounds[i].ops.length === 0 && cur.rounds.length > 1) {
      const cand = {...cur, rounds: cur.rounds.filter((_, j) => j !== i)};
      if (fails(cand)) {
        cur = cand;
      }
    }
  }
  // simplify modes: prefer causal
  for (let i = 0; i < cur.rounds.length && runs < budget; i++) {
    for (const m of ['causal', 'live'] as Mode[]) {
      if (cur.rounds[i].mode === m) {
        break;
      }
      const cand = {
        ...cur,
        rounds: cur.rounds.map((r, j) => (j === i ? {...r, mode: m} : r)),
      };
      if (fails(cand)) {
        cur = cand;
        break;
      }
    }
  }
  if (cur.final !== 'causal') {
    const cand: Script = {...cur, final: 'causal'};
    if (fails(cand)) {
      cur = cand;
    }
  }
  return {runs, script: cur};
}

// ---------------------------------------------------------------------------
// Differential runs (the same script on @lexical/y and @lexical/yjs's v2)

export type LayoutRuns = {
  /** @lexical/y on the full script (null: the runner itself threw). */
  y: RunResult | null;
  /** @lexical/y and the v2 layout, run on the same ops. */
  vsV2: {y: RunResult; other: RunResult; cut: number | null} | null;
};

function runOn(
  script: Script,
  layout: Layout,
  trace: boolean,
): RunResult | null {
  const prev = LAYOUT;
  try {
    setLayout(layout);
    return runScript(script, trace);
  } catch {
    return null;
  } finally {
    setLayout(prev);
  }
}

function opLines(r: RunResult | null): string[] {
  return (r?.trace ?? []).filter(l => l.startsWith('[r'));
}

/** The first op id resolved differently in the two runs, or null. */
function firstDifference(
  a: RunResult | null,
  b: RunResult | null,
): number | null {
  const x = opLines(a);
  const y = opLines(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) {
      const m = / #(\d+) /.exec(x[i] ?? y[i]);
      return m ? Number(m[1]) : null;
    }
  }
  return null;
}

function cutBefore(script: Script, id: number): Script {
  return {
    ...script,
    rounds: script.rounds.map(r => ({...r, ops: r.ops.filter(o => o.id < id)})),
  };
}

/**
 * Run a script on @lexical/y and on @lexical/yjs's default v2 layout. Ops
 * pick their targets in the current document, so once two documents differ
 * an op can resolve differently: the pair is compared on the script cut
 * before the first op the two runs resolved differently.
 */
export function runLayouts(script: Script): LayoutRuns {
  const y = runOn(script, 'y', true);
  const pair = (layout: Layout) => {
    const other = runOn(script, layout, true);
    if (y === null || other === null) {
      return null;
    }
    const cut = firstDifference(y, other);
    if (cut === null) {
      return {cut, other, y};
    }
    const s = cutBefore(script, cut);
    const y2 = runOn(s, 'y', false);
    const o2 = runOn(s, layout, false);
    return y2 && o2 ? {cut, other: o2, y: y2} : null;
  };
  return {vsV2: pair('v2'), y};
}

/**
 * Findings on @lexical/y's own full-script run that never depend on another
 * layout: divergence, an exception, a fragmented token, a self-check
 * warning, a fresh reader that differs, a read or write the binding had to
 * recover from, or a runner crash.
 */
export function absoluteFindings(runs: LayoutRuns): string[] {
  const y = runs.y;
  if (y === null) {
    return ['runner-threw'];
  }
  const out: string[] = [];
  if (y.metrics.diverged) {
    out.push('diverged');
  }
  if (y.metrics.threw) {
    out.push('threw');
  }
  if (y.metrics.fragment) {
    out.push('fragment');
  }
  for (const f of y.failures) {
    if (f.sig.includes('self-check')) {
      out.push('self-check');
    } else if (f.sig.startsWith('fresh-mismatch')) {
      out.push('fresh-mismatch');
    } else if (
      f.sig.includes('could not be read') ||
      f.sig.includes('write failed')
    ) {
      // The binding recovered from its own exception: still a finding.
      out.push('recovered');
    }
  }
  return [...new Set(out)];
}

/**
 * Whether @lexical/y's extra lost tokens against another layout are excused:
 * every one of them was typed into a container a peer removed (delete wins),
 * and the other layout kept them only by bringing back content a peer had
 * deleted (tokens @lexical/y keeps deleted). Honouring the delete is the
 * intended behaviour, so this is not counted as a loss.
 */
export function resurrectionExcuse(
  y: World['metrics'],
  other: World['metrics'],
): boolean {
  const otherLost = new Set(other.lost);
  const extra = y.lost.filter(t => !otherLost.has(t));
  if (extra.length === 0) {
    return false;
  }
  const inContainer = new Set(y.lostInContainer);
  const yResurrected = new Set(y.resurrected);
  return (
    extra.every(t => inContainer.has(t)) &&
    other.resurrected.some(t => !yResurrected.has(t))
  );
}

/**
 * Outcome categories where @lexical/y did worse than the v2 layout: more
 * unique tokens lost (see {@link resurrectionExcuse}) or duplicated, or a
 * divergence, exception or fragment the v2 layout does not have.
 */
export function worseThanV2(runs: LayoutRuns): string[] {
  const {vsV2} = runs;
  if (runs.y === null) {
    return ['runner-threw'];
  }
  if (!vsV2) {
    // The v2 runner threw (not a finding about @lexical/y).
    return [];
  }
  const val = (m: World['metrics'], c: string): number =>
    c === 'loss'
      ? m.lost.length
      : c === 'dup'
        ? m.dups.length
        : m[c as 'diverged' | 'threw' | 'fragment']
          ? 1
          : 0;
  return ['loss', 'dup', 'diverged', 'threw', 'fragment'].filter(
    c =>
      val(vsV2.y.metrics, c) > val(vsV2.other.metrics, c) &&
      !(c === 'loss' && resurrectionExcuse(vsV2.y.metrics, vsV2.other.metrics)),
  );
}
