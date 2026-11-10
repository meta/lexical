/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// NodeState carry lanes: random NodeState changes on a code line, re-tokenized
// by a code highlighter that is either a public Tokenizer preserving every
// key, style and format per character, and the custom field `ownFoo` where
// its output class declares it (a custom highlight class does, stock
// highlight nodes do not), onto stock highlight nodes or a custom highlight
// class; or the stock Prism or Shiki tokenizer.
// Per history: 1 to 4 keys, each scalar, object or set-valued, flat on the
// text class, the highlight class, both or neither (names that collide with a
// node's fields, `style`, `format` and a custom JSON field `ownFoo`, are never
// flat); the line's text split into 1 to 3 nodes of the plain or a custom text
// class, with initial values, styles, formats and custom fields.
//
// carry: A composes in a code block; while the composition is held, B joins
// the code into the paragraph before it or turns it into a paragraph, and may
// append an untouched block (code or paragraph, with NodeState); A's ending
// update makes the NodeState changes; some histories hold an inline decorator
// in the line or have B delete the held line, delivered right after A's
// ending write. Checks, beyond every lane's: blocks other than the held line
// keep their characters as stored before the ending update, the decorator is
// kept, each changed character keeps its intended value and fields (with a
// preserving tokenizer; `ownFoo` is compared on the lane's text class only,
// see targetFindings), and the ending-phase invariant: from the stored state
// just before the ending update to the settled one, no text and no other
// block changes, and the held line changes only in NodeState values the
// update asked for or in what re-tokenizing replaced, never with a highlight
// token outside code.
//
// nohold: no composition. A edits NodeState on the code line (re-tokenized in
// the same update or by a later keystroke), on the paragraph next to it, or on
// the line B joined or converted; or B edits the code line and A receives it.
// Checks, beyond every lane's: highlight tokens only in code, and each changed
// character's intended value and fields (on code lines, with a preserving
// tokenizer).

import {
  $createCodeHighlightNode,
  $createCodeNode,
  $isCodeHighlightNode,
  $isCodeNode,
  CodeHighlightNode,
  type CodeNode,
} from '@lexical/code';
import {
  PrismTokenizer,
  registerCodeHighlighting as registerPrism,
  type Tokenizer,
} from '@lexical/code-prism';
import {
  registerCodeHighlighting as registerShiki,
  ShikiTokenizer,
} from '@lexical/code-shiki';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getState,
  $isDecoratorNode,
  $isElementNode,
  $isRangeSelection,
  $isTabNode,
  $isTextNode,
  $setCompositionKey,
  $setSelection,
  $setState,
  arraySetValue,
  createState,
  DecoratorNode,
  type ElementNode,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  nodeSchema,
  type StateConfig,
  stringValue,
  TextNode,
  withField,
} from 'lexical';

import {$selectIn, flush, freshReader, NODES, Peer, setup} from '../harness';
import {
  changesOf,
  convergenceFindings,
  describeChars,
  dropOne,
  type Finding,
  flatten,
  type Lane,
  type LaneHistory,
  peerFindings,
  pick,
  rng,
  trace,
} from './common';

type Shape = 'scalar' | 'object' | 'set';
type KeySpec = {name: string; shape: Shape; flatText: boolean; flatHl: boolean};
type Value = string | readonly string[] | Record<string, unknown> | null;
type Op = {
  ki: number;
  kind: 'set' | 'setobj' | 'clear' | 'add' | 'remove';
  val?: Value;
  member?: string;
  /** Range in the target, as fractions of its length. */
  s: number;
  e: number;
};
type TokenizerSpec = {
  kind: 'preserve' | 'drop';
  base: 'Prism' | 'Shiki';
  created: 'stock' | 'cls';
};
type Common = {
  keys: KeySpec[];
  tokenizer: TokenizerSpec;
  split: number[];
  storedCls: ('cls' | 'plain')[];
  init: Value[][];
  codeInit: Value[];
  style: string[];
  format: number[];
  ownFoo: string[];
  ops: Op[];
};
export type CarryConfig = Common & {
  variant: 'join' | 'blocktype';
  decor: boolean;
  deleteHeld: boolean;
  hlScope: 'composer' | 'all';
  untouched: 'none' | 'code' | 'paragraph';
  untouchedVals: Value[];
};
export type NoHoldConfig = Common & {
  variant:
    | 'code-same'
    | 'code-next'
    | 'near-code'
    | 'collab-code'
    | 'join-nohold'
    | 'convert-nohold';
};

const DEFAULT: Record<Shape, Value> = {object: null, scalar: '', set: []};
const TEXT = 'ABCDGH';

/** A NodeState key; its values are the lane's `Value`s for its shape. */
type State = StateConfig<string, Value>;

function makeState(name: string, shape: Shape): State {
  const config =
    shape === 'scalar'
      ? createState(name, {parse: stringValue()})
      : shape === 'set'
        ? createState(name, {parse: arraySetValue(stringValue())})
        : createState(name, {
            isEqual: (a: unknown, b: unknown) =>
              JSON.stringify(a) === JSON.stringify(b),
            parse: (v: unknown) =>
              v && typeof v === 'object' && !Array.isArray(v)
                ? {...(v as Record<string, unknown>)}
                : null,
          });
  return config as unknown as State;
}
type Key = KeySpec & {state: State};

function canon(shape: Shape, v: unknown): string {
  if (shape === 'set') {
    return JSON.stringify([...((v as string[]) || [])].sort());
  }
  if (shape === 'object') {
    return v
      ? JSON.stringify(Object.fromEntries(Object.entries(v as object).sort()))
      : 'null';
  }
  return JSON.stringify(v ?? '');
}

/** The lane's text and highlight classes, both with a custom JSON field. */
function makeClasses(keys: Key[]) {
  const flatOn = (which: 'flatText' | 'flatHl') =>
    keys.filter(k => k[which]).map(k => ({flat: true, stateConfig: k.state}));
  const textSchema = nodeSchema<LaneTextNode>()({
    ownFoo: withField(stringValue('MISSING'), {field: '__ownFoo'}),
  });
  class LaneTextNode extends TextNode {
    __ownFoo: string = 'MISSING';
    $config() {
      return this.config('lane_text', {
        extends: TextNode,
        json: textSchema,
        stateConfigs: flatOn('flatText'),
      });
    }
  }
  const hlSchema = nodeSchema<LaneHighlightNode>()({
    ownFoo: withField(stringValue('MISSING'), {field: '__ownFoo'}),
  });
  class LaneHighlightNode extends CodeHighlightNode {
    __ownFoo: string = 'MISSING';
    $config() {
      return this.config('lane_highlight', {
        extends: CodeHighlightNode,
        json: hlSchema,
        stateConfigs: flatOn('flatHl'),
      });
    }
  }
  return {LaneHighlightNode, LaneTextNode};
}

type Rec = {
  vals: Record<string, unknown>;
  style: string;
  format: number;
  ownFoo: string | null;
};
const ownFooOf = (n: TextNode): string | null =>
  '__ownFoo' in n
    ? (n.getLatest() as unknown as {__ownFoo: string}).__ownFoo
    : null;
function recOf(n: TextNode, keys: Key[]): Rec {
  return {
    format: n.getFormat(),
    ownFoo: ownFooOf(n),
    style: n.getStyle(),
    vals: Object.fromEntries(keys.map(k => [k.name, $getState(n, k.state)])),
  };
}
function $applyRec<T extends TextNode>(n: T, rec: Rec, keys: Key[]): T {
  for (const k of keys) {
    $setState(n, k.state, rec.vals[k.name] as never);
  }
  n.setStyle(rec.style);
  n.setFormat(rec.format);
  if (rec.ownFoo !== null && '__ownFoo' in n) {
    (n.getWritable() as unknown as {__ownFoo: string}).__ownFoo = rec.ownFoo;
  }
  return n;
}

/**
 * A public Tokenizer that carries every key, style and format per
 * character, and `ownFoo` onto an output class that declares it.
 */
function preservingTokenizer<T extends Pick<Tokenizer, '$tokenize'>>(
  base: T,
  keys: Key[],
  created: 'stock' | 'cls',
  Hl: Klass<CodeHighlightNode>,
): T {
  return {
    ...base,
    $tokenize(code: CodeNode, language?: string) {
      const src: Rec[] = [];
      for (const n of code.getAllTextNodes()) {
        const rec = recOf(n, keys);
        for (let i = 0; i < n.getTextContentSize(); i++) {
          src.push(rec);
        }
      }
      const next = base.$tokenize(code, language);
      const total = next.reduce((s, n) => s + n.getTextContentSize(), 0);
      if (total !== src.length) {
        return next;
      }
      let off = 0;
      const out: LexicalNode[] = [];
      for (const n of next) {
        const size = n.getTextContentSize();
        if (!$isTextNode(n) || $isTabNode(n)) {
          off += size;
          out.push(n);
          continue;
        }
        const text = n.getTextContent();
        const type = $isCodeHighlightNode(n) ? n.getHighlightType() : null;
        let i = 0;
        while (i < text.length) {
          const sig = JSON.stringify(src[off + i]);
          let j = i + 1;
          while (j < text.length && JSON.stringify(src[off + j]) === sig) {
            j++;
          }
          const piece =
            created === 'cls'
              ? $create(Hl)
                  .setTextContent(text.slice(i, j))
                  .setHighlightType(type)
              : $createCodeHighlightNode(text.slice(i, j), type);
          out.push($applyRec(piece, src[off + i], keys));
          i = j;
        }
        off += size;
      }
      return out;
    },
  };
}

class InlineAtom extends DecoratorNode<null> {
  $config() {
    return this.config('lane_carry_atom', {extends: DecoratorNode});
  }
  isInline(): boolean {
    return true;
  }
  createDOM(): HTMLElement {
    return document.createElement('span');
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
  getTextContent(): string {
    return 'x^2';
  }
}

// ---------------------------------------------------------------------------
// Generation

function sampleValue(r: () => number, shape: Shape): Value {
  if (shape === 'scalar') {
    return pick(r, ['s1', 's2', 's3']);
  }
  if (shape === 'object') {
    return pick(r, [{a: 1}, {a: 2}, {b: 'x'}, {a: 1, b: 'y'}]);
  }
  return pick(r, [['m1'], ['m2'], ['m1', 'm2'], ['m3'], ['m1', 'm3']]);
}

function genOp(r: () => number, keys: KeySpec[]): Op {
  const ki = Math.floor(r() * keys.length);
  const shape = keys[ki].shape;
  const kinds: Op['kind'][] =
    shape === 'scalar'
      ? ['set', 'clear']
      : shape === 'object'
        ? ['setobj', 'clear']
        : ['set', 'clear', 'add', 'remove'];
  const kind = pick(r, kinds);
  const op: Op = {e: r(), ki, kind, s: r()};
  if (kind === 'set' || kind === 'setobj') {
    op.val = sampleValue(r, shape);
  } else if (kind === 'add' || kind === 'remove') {
    op.member = pick(r, ['m1', 'm2', 'm3', 'm4']);
  }
  return op;
}

function applyOp(op: Op, shape: Shape, old: unknown): Value {
  if (op.kind === 'clear') {
    return DEFAULT[shape];
  }
  if (op.kind === 'add') {
    return [...new Set([...((old as string[]) || []), op.member!])];
  }
  if (op.kind === 'remove') {
    return ((old as string[]) || []).filter(x => x !== op.member);
  }
  return op.val ?? null;
}

const NAMES = ['k-a', 'k-b', 'k-c', 'k-d', 'style', 'format', 'ownFoo'];
const NOHOLD_NAMES = [
  'k-a',
  'k-b',
  'k-c',
  'markIds',
  'style',
  'format',
  'ownFoo',
];
const COLLIDE = new Set(['style', 'format', 'ownFoo', 'markIds']);

function genCommon(r: () => number, names: string[]): Common {
  const nkeys = 1 + Math.floor(r() * 4);
  const pool = [...names];
  const chosen: string[] = [];
  for (let i = 0; i < nkeys; i++) {
    chosen.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  }
  const keys = chosen.map(name => {
    const shape: Shape =
      name === 'markIds'
        ? 'set'
        : pick(r, ['scalar', 'object', 'set'] as const);
    const fl = COLLIDE.has(name)
      ? 'neither'
      : pick(r, ['text', 'hl', 'both', 'neither'] as const);
    return {
      flatHl: fl === 'hl' || fl === 'both',
      flatText: fl === 'text' || fl === 'both',
      name,
      shape,
    };
  });
  const three = <T>(f: () => T): T[] => [f(), f(), f()];
  return {
    codeInit: keys.map(k => (r() < 0.4 ? null : sampleValue(r, k.shape))),
    format: three(() => pick(r, [0, 0, 1, 2, 8])),
    init: three(() =>
      keys.map(k => (r() < 0.5 ? null : sampleValue(r, k.shape))),
    ),
    keys,
    ops: Array.from({length: 1 + Math.floor(r() * 3)}, () => genOp(r, keys)),
    ownFoo: three(() => pick(r, ['MISSING', 'pay1', 'pay2'])),
    split: pick(r, [[6], [3, 6], [2, 4, 6], [1, 6], [5, 6]]),
    storedCls: three(() => (r() < 0.6 ? 'cls' : 'plain')),
    style: three(() => pick(r, ['', '', 'color: red', 'font-size: 12px'])),
    tokenizer: {
      base: pick(r, ['Prism', 'Shiki'] as const),
      created: r() < 0.5 ? 'stock' : 'cls',
      kind: r() < 0.6 ? 'preserve' : 'drop',
    },
  };
}

function generateCarry(seed: number, gc: boolean): LaneHistory<CarryConfig> {
  const r = rng(seed * 7477 + (gc ? 13 : 0) + 5);
  const common = genCommon(r, NAMES);
  const cfg: CarryConfig = {
    ...common,
    decor: r() < 0.35,
    deleteHeld: r() < 0.25,
    hlScope: r() < 0.4 ? 'composer' : 'all',
    untouched: pick(r, ['none', 'code', 'paragraph'] as const),
    untouchedVals: common.keys.map(k =>
      r() < 0.6 ? sampleValue(r, k.shape) : null,
    ),
    variant: r() < 0.7 ? 'join' : 'blocktype',
  };
  return {cfg, gc, ids: seed % 2 === 0 ? [1, 2] : [2, 1], lane: 'carry', seed};
}

function generateNoHold(seed: number, gc: boolean): LaneHistory<NoHoldConfig> {
  const r = rng(seed * 7477 + (gc ? 13 : 0) + 6);
  const common = genCommon(r, NOHOLD_NAMES);
  const cfg: NoHoldConfig = {
    ...common,
    variant: pick(r, [
      'code-same',
      'code-next',
      'near-code',
      'collab-code',
      'join-nohold',
      'convert-nohold',
    ] as const),
  };
  return {cfg, gc, ids: seed % 2 === 0 ? [1, 2] : [2, 1], lane: 'nohold', seed};
}

/** Variants of the shared parts: fewer ops and keys, plainer nodes. */
function simplifyCommon<C extends Common>(cfg: C): C[] {
  const out: C[] = [];
  if (cfg.ops.length > 1) {
    for (const ops of dropOne(cfg.ops)) {
      out.push({...cfg, ops});
    }
  }
  if (cfg.keys.length > 1) {
    cfg.keys.forEach((_, ki) => {
      if (cfg.ops.some(o => o.ki !== ki)) {
        const keep = (_v: unknown, i: number) => i !== ki;
        out.push({
          ...cfg,
          codeInit: cfg.codeInit.filter(keep),
          init: cfg.init.map(row => row.filter(keep)),
          keys: cfg.keys.filter(keep),
          ops: cfg.ops
            .filter(o => o.ki !== ki)
            .map(o => ({...o, ki: o.ki > ki ? o.ki - 1 : o.ki})),
          ...('untouchedVals' in cfg
            ? {
                untouchedVals: (
                  cfg as unknown as CarryConfig
                ).untouchedVals.filter(keep),
              }
            : {}),
        });
      }
    });
  }
  if (cfg.split.length > 1) {
    out.push({...cfg, split: [6]});
  }
  const plain: Partial<Common> = {
    codeInit: cfg.codeInit.map(() => null),
    format: [0, 0, 0],
    init: cfg.init.map(row => row.map(() => null)),
    ownFoo: ['MISSING', 'MISSING', 'MISSING'],
    storedCls: ['plain', 'plain', 'plain'],
    style: ['', '', ''],
  };
  for (const [k, v] of Object.entries(plain)) {
    if (JSON.stringify(cfg[k as keyof C]) !== JSON.stringify(v)) {
      out.push({...cfg, [k]: v});
    }
  }
  if (cfg.tokenizer.created !== 'stock') {
    out.push({...cfg, tokenizer: {...cfg.tokenizer, created: 'stock'}});
  }
  if (cfg.tokenizer.base !== 'Prism') {
    out.push({...cfg, tokenizer: {...cfg.tokenizer, base: 'Prism'}});
  }
  return out;
}

function simplifyCarry(
  h: LaneHistory<CarryConfig>,
): LaneHistory<CarryConfig>[] {
  const c = h.cfg;
  const out: CarryConfig[] = [];
  if (c.deleteHeld) {
    out.push({...c, deleteHeld: false});
  }
  if (c.untouched !== 'none' && !c.deleteHeld) {
    out.push({...c, untouched: 'none'});
  }
  if (c.decor) {
    out.push({...c, decor: false});
  }
  if (c.hlScope !== 'all') {
    out.push({...c, hlScope: 'all'});
  }
  out.push(...simplifyCommon(c));
  const hs = out.map(cfg => ({...h, cfg}));
  if (h.gc) {
    hs.push({...h, gc: false});
  }
  return hs;
}

function simplifyNoHold(
  h: LaneHistory<NoHoldConfig>,
): LaneHistory<NoHoldConfig>[] {
  const hs = simplifyCommon(h.cfg).map(cfg => ({...h, cfg}));
  if (h.gc) {
    hs.push({...h, gc: false});
  }
  return hs;
}

// ---------------------------------------------------------------------------
// Views

type Char = {
  ch: string;
  v: Record<string, string>;
  style: string;
  format: number;
  ownFoo: string | null;
  type: string;
  tok: number;
};
type View = {type: string; decos: number; chars: Char[]}[];

function viewOf(keys: Key[]) {
  return (p: Peer): View =>
    p.read(() =>
      $getRoot()
        .getChildren()
        .map(block => {
          if (!$isElementNode(block)) {
            return {chars: [], decos: 0, type: block.getType()};
          }
          const chars: Char[] = [];
          block.getAllTextNodes().forEach((n, tok) => {
            const r = recOf(n, keys);
            const v = Object.fromEntries(
              keys.map(k => [k.name, canon(k.shape, r.vals[k.name])]),
            );
            for (const ch of n.getTextContent()) {
              chars.push({
                ch,
                format: r.format,
                ownFoo: r.ownFoo,
                style: r.style,
                tok,
                type: n.getType(),
                v,
              });
            }
          });
          return {
            chars,
            decos: block.getChildren().filter(c => $isDecoratorNode(c)).length,
            type: block.getType(),
          };
        }),
    );
}

const isHighlight = (type: string) =>
  type === 'code-highlight' || type === 'lane_highlight';
const textOf = (b: View[number]) => b.chars.map(c => c.ch).join('');
const stripTok = (v: View) =>
  v.map(b => ({...b, chars: b.chars.map(({tok: _tok, ...c}) => c)}));

function outsideCode(final: View): Finding[] {
  return final
    .filter(b => b.type !== 'code' && b.chars.some(c => isHighlight(c.type)))
    .map(b => ({cls: 'code-highlight-outside-code', detail: textOf(b)}));
}

/**
 * Each changed character's value against what was asked for. Not counted:
 * a cell whose last change was a clear, or removed the last member; a set or
 * object value that keeps its value from before the update; a value of
 * another changed character of the same final token (one token carries one
 * value).
 */
function targetFindings(
  keys: Key[],
  pre: Char[],
  intended: Record<string, string>[],
  lastKind: string[][],
  final: Char[],
): Finding[] {
  const out: Finding[] = [];
  final.forEach((c, i) => {
    keys.forEach((k, ki) => {
      const got = c.v[k.name];
      const want = intended[i][k.name];
      if (got === want) {
        return;
      }
      const last = lastKind[i][ki];
      if (
        last === 'clear' ||
        (last === 'remove' && want === canon(k.shape, DEFAULT[k.shape]))
      ) {
        return;
      }
      if (got === pre[i].v[k.name] && k.shape !== 'scalar' && last !== 'none') {
        return;
      }
      if (
        final.some(
          (o, j) => j !== i && o.tok === c.tok && intended[j][k.name] === got,
        )
      ) {
        return;
      }
      out.push({
        cls: 'target-value',
        detail: `${k.name} (${k.shape}, last ${last}) on ${JSON.stringify(c.ch)}: ${got}, intended ${want}`,
      });
    });
    // Fields are compared on a node of the same class. Lexical's splitText
    // makes the parts after the first plain text nodes, without the class's
    // own fields, so a highlight token a tokenizer makes again from such a
    // part has the field's default: the custom field is compared on the
    // lane's text class only. A highlight node has no format.
    const p = pre[i];
    if (
      c.type === p.type &&
      (c.style !== p.style ||
        (!isHighlight(c.type) && c.format !== p.format) ||
        (c.type === 'lane_text' && c.ownFoo !== p.ownFoo))
    ) {
      out.push({
        cls: 'target-field',
        detail: `${JSON.stringify(c.ch)}: ${JSON.stringify([p.style, p.format, p.ownFoo])} -> ${JSON.stringify([c.style, c.format, c.ownFoo])}`,
      });
    }
  });
  return out;
}

function resolveOps(cfg: Common, len: number) {
  return cfg.ops.map(o => {
    const s = Math.floor(o.s * len);
    const e = Math.min(len, s + 1 + Math.floor(o.e * (len - s)));
    return {e, op: o, s};
  });
}

function intendedOf(
  keys: Key[],
  raw: unknown[][],
  ops: ReturnType<typeof resolveOps>,
) {
  const values = raw.map(row => [...row]);
  const lastKind = raw.map(row => row.map(() => 'none'));
  for (const {op, s, e} of ops) {
    for (let i = s; i < e && i < values.length; i++) {
      values[i][op.ki] = applyOp(op, keys[op.ki].shape, values[i][op.ki]);
      lastKind[i][op.ki] = op.kind;
    }
  }
  const intended = values.map(row =>
    Object.fromEntries(keys.map((k, ki) => [k.name, canon(k.shape, row[ki])])),
  );
  return {intended, lastKind};
}

function $applyOps(
  keys: Key[],
  line: number,
  start: number,
  ops: ReturnType<typeof resolveOps>,
) {
  for (const {op, s, e} of ops) {
    const st = keys[op.ki].state;
    for (const n of $selectIn([line], start + s, start + e).extract()) {
      if ($isTextNode(n)) {
        $setState(
          n,
          st,
          applyOp(op, keys[op.ki].shape, $getState(n, st)) as never,
        );
      }
    }
  }
  $setSelection(null);
}

function $rawValues(keys: Key[], line: number, start: number, len: number) {
  const out: unknown[][] = [];
  const blk = $getRoot().getChildren()[line] as ElementNode;
  for (const n of blk.getAllTextNodes()) {
    for (let i = 0; i < n.getTextContentSize(); i++) {
      out.push(keys.map(k => $getState(n, k.state)));
    }
  }
  return out.slice(start, start + len);
}

type World = {
  keys: Key[];
  nodes: Klass<LexicalNode>[];
  Text: Klass<TextNode>;
  Hl: Klass<CodeHighlightNode>;
  register: (editor: LexicalEditor) => void;
};

function makeWorld(cfg: Common): World {
  const keys: Key[] = cfg.keys.map(k => ({
    ...k,
    state: makeState(k.name, k.shape),
  }));
  const {LaneTextNode, LaneHighlightNode} = makeClasses(keys);
  const {kind, created} = cfg.tokenizer;
  const carry = <T extends Pick<Tokenizer, '$tokenize'>>(base: T): T =>
    kind === 'preserve'
      ? preservingTokenizer(base, keys, created, LaneHighlightNode)
      : base;
  const prism = carry(PrismTokenizer);
  const shiki = carry(ShikiTokenizer);
  return {
    Hl: LaneHighlightNode,
    Text: LaneTextNode,
    keys,
    nodes: [...NODES, LaneTextNode, LaneHighlightNode, InlineAtom],
    register(editor) {
      if (cfg.tokenizer.base === 'Prism') {
        registerPrism(editor, prism);
      } else {
        registerShiki(editor, shiki);
      }
      // A highlight node outside code turns back into the lane's text class.
      editor.registerNodeTransform(LaneHighlightNode, n => {
        if (!$isCodeNode(n.getParent())) {
          n.replace(
            $applyRec(
              $create(LaneTextNode).setTextContent(n.getTextContent()),
              recOf(n, keys),
              keys,
            ),
          );
        }
      });
    },
  };
}

function $appendSplit(
  w: World,
  cfg: Common,
  p: ElementNode,
  prefix: string,
  code: boolean,
  vals: (i: number) => Value[],
) {
  let prev = 0;
  cfg.split.forEach((end, i) => {
    const text = prefix + TEXT.slice(prev, end);
    const cls = cfg.storedCls[i] === 'cls';
    const n: TextNode = code
      ? cls
        ? $create(w.Hl).setTextContent(text)
        : $createCodeHighlightNode(text)
      : cls
        ? $create(w.Text).setTextContent(text)
        : $createTextNode(text);
    if (cls) {
      (n.getWritable() as unknown as {__ownFoo: string}).__ownFoo =
        cfg.ownFoo[i];
    }
    w.keys.forEach((k, ki) => {
      const v = vals(i)[ki];
      if (v !== null) {
        $setState(n, k.state, v as never);
      }
    });
    if (!code) {
      n.setStyle(cfg.style[i]);
      n.setFormat(cfg.format[i]);
    }
    p.append(n);
    prev = end;
  });
}

async function storedView(
  bytes: Uint8Array,
  w: World,
  gc: boolean,
): Promise<View> {
  const net = {
    delivery: 'causal' as const,
    peers: [],
    pumping: false,
    queue: [],
  };
  const q = new Peer(98, net, w.nodes, undefined, false, gc);
  try {
    Y.applyUpdate(q.doc, bytes, 'load');
    q.binding.initialize();
    await flush();
    return viewOf(w.keys)(q);
  } finally {
    q.stop();
  }
}

// ---------------------------------------------------------------------------
// carry

async function runCarry(h: LaneHistory<CarryConfig>): Promise<Finding[]> {
  const {cfg, gc, ids} = h;
  const w = makeWorld(cfg);
  const {keys} = w;
  const view = viewOf(keys);
  let ordinal = 0;
  const t = await setup(
    () => {
      const p = $createParagraphNode();
      $appendSplit(w, cfg, p, '', false, i => cfg.init[i]);
      if (cfg.decor) {
        p.append($create(InlineAtom));
      }
      p.append($createTextNode(' '));
      const hl = $createCodeHighlightNode('let x = 1;');
      keys.forEach((k, ki) => {
        if (cfg.codeInit[ki] !== null) {
          $setState(hl, k.state, cfg.codeInit[ki] as never);
        }
      });
      $getRoot().append(p, $createCodeNode('javascript').append(hl));
    },
    {
      gc,
      ids,
      nodes: w.nodes,
      prepare: editor => {
        if (cfg.hlScope === 'composer' && ordinal++ > 0) {
          return;
        }
        w.register(editor);
      },
    },
  );
  const host = document.createElement('div');
  host.contentEditable = 'true';
  document.body.append(host);
  t.a.editor.setRootElement(host);
  host.focus();
  let fresh: Peer | undefined;
  let hook: ((tr: Y.Transaction) => void) | null = null;
  try {
    t.a.update(() => {
      const code = $getRoot().getLastChildOrThrow() as ElementNode;
      const n = code.getAllTextNodes()[0];
      n.select(1, 1);
      $setCompositionKey(n.getKey());
    });
    await t.sync();
    trace('A composes', {A: t.a, B: t.b});
    t.b.update(() => {
      const last = $getRoot().getLastChildOrThrow() as ElementNode;
      if (cfg.variant === 'join') {
        last.selectStart().deleteCharacter(true);
      } else {
        last.replace($createParagraphNode(), true);
      }
      if (cfg.untouched !== 'none' || cfg.deleteHeld) {
        const txt =
          $createTextNode('let untouched = 1;').setFormat('underline');
        keys.forEach((k, ki) => {
          if (cfg.untouchedVals[ki] !== null) {
            $setState(txt, k.state, cfg.untouchedVals[ki] as never);
          }
        });
        const blk =
          cfg.untouched === 'paragraph'
            ? $createParagraphNode()
            : $createCodeNode('javascript');
        $getRoot().getLastChildOrThrow().insertAfter(blk.append(txt));
      }
      $setSelection(null);
    });
    await t.sync();
    trace('B changed the code block', {A: t.a, B: t.b});
    const heldView = view(t.a);
    const line = cfg.variant === 'join' ? 0 : 1;
    const lineText = textOf(heldView[line]);
    const tStart = cfg.variant === 'join' ? lineText.indexOf(TEXT) : 0;
    const tLen = cfg.variant === 'join' ? TEXT.length : lineText.length;
    const preChars = heldView[line].chars.slice(tStart, tStart + tLen);
    const ops = resolveOps(cfg, tLen);
    const raw = t.a.read(() => $rawValues(keys, line, tStart, tLen));
    const {intended, lastKind} = intendedOf(keys, raw, ops);
    let deleted = false;
    if (cfg.deleteHeld) {
      t.offline();
      t.b.update(() => {
        const blocks = $getRoot().getChildren();
        const held =
          cfg.variant === 'join'
            ? blocks.find(b => b.getTextContent().includes(TEXT))
            : blocks[1];
        held?.remove();
        $setSelection(null);
      });
      const remote = Y.encodeStateAsUpdate(
        t.b.doc,
        Y.encodeStateVector(t.a.doc),
      );
      hook = (tr: Y.Transaction) => {
        if (!deleted && tr.origin === t.a.binding) {
          deleted = true;
          Y.applyUpdate(t.a.doc, remote, 'provider-after-write');
        }
      };
      t.a.doc.on('afterTransactionCleanup', hook);
    }
    const preEnd = Y.encodeStateAsUpdate(t.a.doc);
    t.a.update(() => {
      $setCompositionKey(null);
      $applyOps(keys, line, tStart, ops);
    });
    await flush();
    trace('A ended its composition', {A: t.a, B: t.b});
    if (hook) {
      t.a.doc.off('afterTransactionCleanup', hook);
      hook = null;
    }
    await t.sync();
    await t.sync();
    await t.sync();
    fresh = await freshReader(t.a);
    trace('synced', {A: t.a, B: t.b, fresh});
    const all = [...t.peers, fresh];
    const labels = ['A', 'B', 'fresh'];
    const findings: Finding[] = [];
    all.forEach((p, i) => findings.push(...peerFindings(p, labels[i])));
    const views = all.map(view);
    findings.push(...convergenceFindings(views.map(stripTok), labels));
    const final = views[views.length - 1];
    const pre = await storedView(preEnd, w, gc);
    const heldPre = pre.findIndex(b => textOf(b).includes(TEXT));
    const heldIn = (v: View) =>
      deleted
        ? -1
        : cfg.variant === 'join'
          ? v.findIndex(b => textOf(b).includes(TEXT))
          : v.findIndex(
              b => textOf(b) === lineText || textOf(b).startsWith('let'),
            );
    // Blocks other than the held line keep their characters as stored
    // before the ending update (text the composer wrote into a line a
    // collaborator deleted joins the next line, so a block may gain text).
    const preHeld = cfg.variant === 'blocktype' && pre.length > 1 ? 1 : heldPre;
    const finalHeld = deleted
      ? -1
      : cfg.variant === 'blocktype'
        ? 1
        : heldIn(final);
    pre.forEach((b, i) => {
      if (i === preHeld || b.chars.length === 0) {
        return;
      }
      const text = textOf(b);
      const want = JSON.stringify(stripTok([b])[0].chars);
      const found = final.some((f, j) => {
        const at = j === finalHeld ? -1 : textOf(f).indexOf(text);
        return (
          at >= 0 &&
          f.type === b.type &&
          JSON.stringify(stripTok([f])[0].chars.slice(at, at + text.length)) ===
            want
        );
      });
      if (!found) {
        findings.push({
          cls: 'other-block-changed',
          detail: `${b.type} ${describeChars(stripTok([b])[0].chars)} -> ${final.map(f => `${f.type} ${describeChars(stripTok([f])[0].chars)}`).join(' / ')}`,
        });
      }
    });
    if (!deleted) {
      const decos = (v: View) => v.reduce((s, b) => s + b.decos, 0);
      if (decos(final) < decos(pre)) {
        findings.push({
          cls: 'decorator-lost',
          detail: `${decos(pre)} -> ${decos(final)}`,
        });
      }
      const fi = heldIn(final);
      const ft = fi < 0 ? '' : textOf(final[fi]);
      const fStart = cfg.variant === 'join' ? ft.indexOf(TEXT) : 0;
      if (fi < 0 || fStart < 0 || ft.length < fStart + tLen) {
        findings.push({
          cls: 'target-text-missing',
          detail: JSON.stringify(final.map(textOf)),
        });
      } else if (cfg.tokenizer.kind === 'preserve') {
        findings.push(
          ...targetFindings(
            keys,
            preChars,
            intended,
            lastKind,
            final[fi].chars.slice(fStart, fStart + tLen),
          ),
        );
      }
    }
    // The values the update asked for, per key.
    const allowed = new Map<string, Set<string>>();
    for (const row of intended) {
      for (const [k, v] of Object.entries(row)) {
        if (!allowed.has(k)) {
          allowed.set(k, new Set());
        }
        allowed.get(k)!.add(v);
      }
    }
    const settled = await storedView(Y.encodeStateAsUpdate(t.a.doc), w, gc);
    findings.push(
      ...carryEndingPhase(pre, preHeld, settled, keys, allowed, cfg.deleteHeld),
    );
    return findings;
  } finally {
    if (hook) {
      t.a.doc.off('afterTransactionCleanup', hook);
    }
    fresh?.stop();
    t.a.editor.setRootElement(null);
    host.remove();
    for (const p of t.peers) {
      p.stop();
    }
  }
}

/**
 * The ending-phase invariant of the carry lane: the composer's writes from
 * its ending update on change no text and no block other than the held line;
 * on the held line, a NodeState value only to a value the update asked for,
 * and fields only where re-tokenizing replaced the node.
 */
function carryEndingPhase(
  pre: View,
  heldPre: number,
  after: View,
  keys: Key[],
  allowed: Map<string, Set<string>>,
  deleteHeld: boolean,
): Finding[] {
  const flat = (v: View) =>
    flatten(
      v.map(b => ({
        chars: b.chars.map(({tok: _tok, v: vals, ...c}) => ({
          ...c,
          ...Object.fromEntries(
            Object.entries(vals).map(([k, x]) => [`v:${k}`, x]),
          ),
        })),
        type: b.type,
      })),
    );
  const ref = flat(pre);
  const held = heldPre;
  const attrs = [
    'type',
    'style',
    'format',
    'ownFoo',
    ...keys.map(k => `v:${k.name}`),
  ];
  const out: Finding[] = [];
  // The collaborator's delete of the held line removes one block boundary
  // (counted: where it falls is ambiguous to the alignment).
  let boundaryDel = deleteHeld ? 1 : 0;
  // With the held line deleted by the collaborator, its characters go and
  // text the ending update re-tokenized into it survives and joins the next
  // line (a line is not a container): at most the held line's own
  // characters, by character and count.
  const survives = new Map<string, number>();
  if (deleteHeld) {
    for (const c of ref) {
      if (c !== null && c.block === held) {
        survives.set(c.ch, (survives.get(c.ch) ?? 0) + 1);
      }
    }
  }
  for (const c of changesOf(ref, ref, flat(after), attrs)) {
    if (c.kind === 'boundary') {
      if (!(c.op === 'del' && boundaryDel-- > 0)) {
        out.push({
          cls: 'ending-phase-boundary',
          detail: `a block boundary ${c.op === 'ins' ? 'added in' : 'removed after'} block ${c.block} (held: ${held})`,
        });
      }
      continue;
    }
    const refChar = c.at === null ? null : ref[c.at];
    const onHeld = refChar === null || refChar.block === held;
    if (deleteHeld && c.kind === 'ins') {
      const left = survives.get(c.ch) ?? 0;
      survives.set(c.ch, left - 1);
      if (left > 0) {
        continue;
      }
    }
    // What still maps to the deleted held line's characters is text written
    // into it, joined to the next line.
    if (deleteHeld && onHeld && c.kind === 'attr' && c.attr === 'btype') {
      continue;
    }
    if (c.kind !== 'attr') {
      if (!(deleteHeld && onHeld && c.kind === 'del')) {
        out.push({
          cls: 'ending-phase-text',
          detail: `${c.kind} ${JSON.stringify(c.ch)} ${onHeld ? 'in the held line' : 'in another block'}`,
        });
      }
      continue;
    }
    const where = `${c.attr} ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)} on ${JSON.stringify(c.char.ch)} (${c.char.btype})`;
    if (!onHeld) {
      out.push({cls: 'ending-phase-other-block', detail: where});
    } else if (c.attr === 'btype') {
      out.push({cls: 'ending-phase-block-type', detail: where});
    } else if (c.attr === 'type') {
      if (isHighlight(String(c.to)) && c.char.btype !== 'code') {
        out.push({
          cls: 'ending-phase-code-highlight-outside-code',
          detail: where,
        });
      }
    } else if (c.attr.startsWith('v:')) {
      if (
        !allowed.get(c.attr.slice(2))?.has(c.to as string) &&
        !isHighlight(String(c.char.type))
      ) {
        out.push({cls: 'ending-phase-state', detail: where});
      }
    } else if (!isHighlight(String(c.char.type))) {
      out.push({cls: 'ending-phase-field', detail: where});
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// nohold

async function runNoHold(h: LaneHistory<NoHoldConfig>): Promise<Finding[]> {
  const {cfg, gc, ids} = h;
  const w = makeWorld(cfg);
  const {keys} = w;
  const view = viewOf(keys);
  const t = await setup(
    () => {
      const p = $createParagraphNode();
      $appendSplit(w, cfg, p, '', false, i => cfg.init[i]);
      p.append($createTextNode(' '));
      const code = $createCodeNode('javascript');
      $appendSplit(w, cfg, code, 'let', true, () => cfg.codeInit);
      $getRoot().append(p, code);
    },
    {gc, ids, nodes: w.nodes, prepare: w.register},
  );
  const host = document.createElement('div');
  host.contentEditable = 'true';
  document.body.append(host);
  t.a.editor.setRootElement(host);
  host.focus();
  let fresh: Peer | undefined;
  try {
    await t.sync();
    const {variant} = cfg;
    if (variant === 'join-nohold' || variant === 'convert-nohold') {
      t.b.update(() => {
        const last = $getRoot().getLastChildOrThrow() as ElementNode;
        if (variant === 'join-nohold') {
          last.selectStart().deleteCharacter(true);
        } else {
          last.replace($createParagraphNode(), true);
        }
        $setSelection(null);
      });
      await t.sync();
    }
    const actor = variant === 'collab-code' ? t.b : t.a;
    const line = actor.read(() =>
      Math.min(
        variant === 'near-code' || variant === 'join-nohold' ? 0 : 1,
        $getRoot().getChildrenSize() - 1,
      ),
    );
    const before = view(actor)[line];
    const tLen = Math.min(textOf(before).length, 12);
    const preChars = before.chars.slice(0, tLen);
    const ops = resolveOps(cfg, tLen);
    const raw = actor.read(() => $rawValues(keys, line, 0, tLen));
    const {intended, lastKind} = intendedOf(keys, raw, ops);
    actor.update(() => $applyOps(keys, line, 0, ops));
    await t.sync();
    if (variant === 'code-next') {
      // A later keystroke that re-tokenizes the code line.
      t.a.update(() => {
        const last = (
          $getRoot().getLastChildOrThrow() as ElementNode
        ).getLastDescendant();
        if ($isTextNode(last)) {
          last.select(last.getTextContentSize(), last.getTextContentSize());
          const sel = $getSelection();
          if ($isRangeSelection(sel)) {
            sel.insertText(';');
          }
        }
        $setSelection(null);
      });
      await t.sync();
    }
    await t.sync();
    fresh = await freshReader(t.a);
    const all = [...t.peers, fresh];
    const labels = ['A', 'B', 'fresh'];
    const findings: Finding[] = [];
    all.forEach((p, i) => findings.push(...peerFindings(p, labels[i])));
    const views = all.map(view);
    findings.push(...convergenceFindings(views.map(stripTok), labels));
    const final = views[views.length - 1];
    findings.push(...outsideCode(final));
    const code = before.type === 'code';
    if (!code || cfg.tokenizer.kind === 'preserve') {
      const got = final[line]?.chars.slice(0, tLen) ?? [];
      if (got.map(c => c.ch).join('') !== preChars.map(c => c.ch).join('')) {
        findings.push({
          cls: 'target-text-missing',
          detail: JSON.stringify(final.map(textOf)),
        });
      } else {
        findings.push(
          ...targetFindings(keys, preChars, intended, lastKind, got),
        );
      }
    }
    return findings;
  } finally {
    fresh?.stop();
    t.a.editor.setRootElement(null);
    host.remove();
    for (const p of t.peers) {
      p.stop();
    }
  }
}

export const carryLane: Lane<CarryConfig> = {
  generate: generateCarry,
  name: 'carry',
  run: runCarry,
  simplify: simplifyCarry,
};

export const noHoldLane: Lane<NoHoldConfig> = {
  generate: generateNoHold,
  name: 'nohold',
  run: runNoHold,
  simplify: simplifyNoHold,
};
