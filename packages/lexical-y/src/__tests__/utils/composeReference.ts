/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A reference for what the update that ends a held composition should make
// (DECISIONS.md D115, D119 to D124), over a closed table of cells.
//
// A history: A composes with an input method in a line (the held line) while
// a collaborator, B, acts on that line (none, text, alignment or indent,
// type, join, split, delete); A's update that ends the composition then
// commits it in place (plain), lets a re-typing transform run (a hashtag, or
// a code highlighter), lets an app transform restructure the block, or
// presses Enter; with or without that update inserting text itself
// (Firefox's input, WebKit's insertFromComposition). A cell is
// `<collab>|<end>|<inserts>`.
//
// The binding's run plays that history with the binding's hold. The
// reference run plays the same history with A's composition collapsed into
// one edit (the committed text), made when the composition ends, at the
// composition's position mapped through B's edits (A's caret at the
// composition's start taken as relative positions with YBinding#getCursor
// and resolved with YBinding#$resolveCursor once B's edits arrived), with no
// hold: B acts on a document without A's composing text, A's editor reads
// B's edit at once, and A's edit then runs as an ordinary local update, its
// transforms included.
//
// `classify` compares a run with the reference on every peer and a fresh
// reader: none; attr (block type or attributes, text formats, NodeState,
// token types only); structure (the same text in other lines or another
// order); text-order, text-dup, text-loss; storage (a self-check or storage
// finding); divergence (the peers differ); error.

import {$createCodeNode} from '@lexical/code';
import {
  PrismTokenizer,
  registerCodeHighlighting as registerPrism,
} from '@lexical/code-prism';
import {HashtagNode, registerLexicalHashtag} from '@lexical/hashtag';
import {$createListItemNode, $createListNode, $isListNode} from '@lexical/list';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getState,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setCompositionKey,
  $setSelection,
  $setState,
  createState,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  stringValue,
  TextNode,
} from 'lexical';

import {flush, freshReader, NODES, Peer, setup} from './harness';
import {peerFindings, pick, rng} from './lanes/common';

// ---------------------------------------------------------------------------
// Cells

export const COLLABS = [
  'none',
  'text',
  'attr',
  'type',
  'join',
  'split',
  'delete',
] as const;
export const ENDS = ['plain', 'retype', 'struct', 'enter'] as const;
type Collab = (typeof COLLABS)[number];
type End = (typeof ENDS)[number];
export const CELLS: string[] = [];
for (const c of COLLABS) {
  for (const e of ENDS) {
    for (const i of [0, 1]) {
      CELLS.push(`${c}|${e}|${i}`);
    }
  }
}

const BLOCKS = ['paragraph', 'heading', 'quote', 'listitem', 'code'] as const;
type Block = (typeof BLOCKS)[number];

const note = createState('orc_note', {parse: stringValue()});
const BOLD = 1;

type Span = {text: string; bold: boolean; note: string};

export type Cfg = {
  cell: string;
  collab: Collab;
  end: End;
  ins: boolean;
  /** The held line's block type, and its spans of text. */
  from: Block;
  spans: Span[];
  /** Where A's composition starts (a character offset in the held line). */
  at: number;
  interim: string;
  /** What the end inserts itself (ins). */
  extra: string;
  /** Re-typing: a hashtag, or Prism on a code line. */
  retype: 'hashtag' | 'prism' | 'none';
  /** Transforms on every peer (else on A only). */
  allPeers: boolean;
  /** A format or NodeState set in the ending update. */
  endFmt: 'none' | 'bold' | 'note';
  endScope: 'composed' | 'line';
  /** The app transform's restructuring (struct). */
  struct: 'heading' | 'quote' | 'paragraph' | 'split' | 'move' | 'unwrap';
  /** B's action. */
  bText:
    | {kind: 'insert'; at: number}
    | {kind: 'delete'; from: number; to: number};
  bAttr: 'center' | 'right' | 'indent';
  bType: Block;
  bSplit: number;
  /** Whether B read A's composing text before acting. */
  bSaw: boolean;
  /** The line before the held line. */
  intro: 'paragraph' | 'heading';
  /** The held line in a list (a list item) has the list's other items? */
  aId: number;
  ids: [number, number];
};

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'omega'];

export function generate(cell: string, seed: number): Cfg {
  const [collab, end, insS] = cell.split('|') as [Collab, End, string];
  const ins = insS === '1';
  let h = 2166136261;
  for (const ch of cell) {
    h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  }
  const r = rng((seed * 7919) ^ h);
  // Re-typing: a hashtag in any block but code, or Prism on a code line
  // (initially, or one B makes a code block).
  let retype: Cfg['retype'] = 'none';
  let from: Block = pick(r, BLOCKS);
  if (end === 'retype') {
    retype = r() < 0.5 ? 'hashtag' : 'prism';
    if (retype === 'hashtag' && from === 'code') {
      from = pick(r, ['paragraph', 'heading', 'quote', 'listitem'] as const);
    }
    if (retype === 'prism' && !(collab === 'type' && r() < 0.5)) {
      from = 'code';
    }
  }
  if (end === 'struct' && from === 'code') {
    from = pick(r, ['paragraph', 'heading', 'quote', 'listitem'] as const);
  }
  // The held line's spans: `see ` then one or two words, some bold, some
  // with a NodeState.
  const spans: Span[] = [{bold: false, note: '', text: 'see '}];
  const n = 1 + Math.floor(r() * 2);
  for (let i = 0; i < n; i++) {
    spans.push({
      bold: from !== 'code' && r() < 0.3,
      note: from !== 'code' && r() < 0.3 ? 'old' : '',
      text: (i > 0 ? ' ' : '') + pick(r, WORDS),
    });
  }
  const len = spans.reduce((s, x) => s + x.text.length, 0);
  // Where A composes: at a character offset, not at the line's start (so
  // that the caret has a character on its left to be anchored to).
  const at = 1 + Math.floor(r() * len);
  const interim =
    retype === 'hashtag'
      ? ' #tag'
      : retype === 'prism' || from === 'code'
        ? ' = 2'
        : pick(r, ['xyz', ' xyz', 'Ü']);
  // Positions of B's text edit and split that do not touch A's caret or the
  // character on its left (that would leave where A's text goes ambiguous).
  const away = (lo: number, hi: number): number => {
    const options: number[] = [];
    for (let i = lo; i <= hi; i++) {
      if (i < at - 1 || i > at) {
        options.push(i);
      }
    }
    return options.length === 0 ? -1 : pick(r, options);
  };
  let bText: Cfg['bText'] = {at: away(0, len), kind: 'insert'};
  if (r() < 0.4) {
    const a1 = away(0, len - 1);
    const a2 = a1 < at ? Math.min(at - 1, a1 + 2) : Math.min(len, a1 + 2);
    if (a1 >= 0 && a2 > a1 && (a2 <= at - 1 || a1 >= at)) {
      bText = {from: a1, kind: 'delete', to: a2};
    }
  }
  if (bText.kind === 'insert' && bText.at < 0) {
    bText = {at: len, kind: 'insert'};
  }
  let bSplit = away(1, len - 1);
  if (bSplit < 0) {
    bSplit = at > len - 1 ? 1 : len - 1;
  }
  let bType = pick(
    r,
    BLOCKS.filter(b => b !== from),
  );
  if (end === 'retype' && retype === 'prism' && collab === 'type') {
    // Either a code line made another block, or a block made a code line.
    bType =
      from === 'code'
        ? pick(r, ['paragraph', 'heading', 'quote'] as const)
        : 'code';
  }
  if (end === 'struct' && bType === 'code' && r() < 0.5) {
    bType = 'heading';
  }
  const ids: [number, number] = seed % 2 === 0 ? [11, 22] : [22, 11];
  return {
    aId: r() < 0.5 ? 33 : 5,
    allPeers: r() < 0.5,
    at,
    bAttr: pick(r, ['center', 'right', 'indent'] as const),
    bSaw: r() < 0.5,
    bSplit,
    bText,
    bType,
    cell,
    collab,
    end,
    endFmt: r() < 0.3 ? pick(r, ['bold', 'note'] as const) : 'none',
    endScope: r() < 0.6 ? 'composed' : 'line',
    extra: ' z',
    from,
    ids,
    ins,
    interim,
    intro: r() < 0.7 ? 'paragraph' : 'heading',
    retype,
    spans,
    struct: pick(r, [
      'heading',
      'quote',
      'paragraph',
      'split',
      'move',
      'unwrap',
    ] as const),
  };
}

// ---------------------------------------------------------------------------
// Documents and edits

const NODE_SET = [...NODES, HashtagNode];

function $makeBlock(kind: Block): ElementNode {
  if (kind === 'heading') {
    return $createHeadingNode('h2');
  }
  if (kind === 'quote') {
    return $createQuoteNode();
  }
  if (kind === 'code') {
    return $createCodeNode('javascript');
  }
  if (kind === 'listitem') {
    return $createListItemNode();
  }
  return $createParagraphNode();
}
function $container(kind: Block, block: ElementNode): ElementNode {
  return kind === 'listitem' ? $createListNode('bullet').append(block) : block;
}
/** The held line: the root's second child (or the item in it). */
const HELD = 1;
function $heldBlock(): ElementNode | null {
  const c = $getRoot().getChildAtIndex(HELD);
  if (!$isElementNode(c)) {
    return null;
  }
  return $isListNode(c) ? ((c.getFirstChild() as ElementNode) ?? null) : c;
}
function $flattenInto(target: ElementNode, from: ElementNode) {
  for (const k of from.getChildren()) {
    if ($isElementNode(k)) {
      target.append(...k.getChildren());
    } else {
      target.append(k);
    }
  }
}
function $convertBlock(block: ElementNode, to: Block) {
  const top = block.getTopLevelElementOrThrow();
  const next = $makeBlock(to);
  if (to === 'code') {
    $flattenInto(next, block);
  } else {
    next.append(...block.getChildren());
  }
  next.setFormat(block.getFormatType());
  next.setIndent(block.getIndent());
  if (!top.is(block) && $isListNode(top) && top.getChildrenSize() > 1) {
    // One item of several: the items after it stay a list after it.
    const after = block.getNextSiblings();
    if (after.length > 0) {
      top.insertAfter($createListNode(top.getListType()).append(...after));
    }
    top.insertAfter($container(to, next));
    block.remove();
    return;
  }
  top.replace($container(to, next));
}

function $initial(cfg: Cfg) {
  const intro =
    cfg.intro === 'heading' ? $createHeadingNode('h1') : $createParagraphNode();
  intro.append($createTextNode('intro line'));
  const held = $makeBlock(cfg.from);
  for (const s of cfg.spans) {
    const t = $createTextNode(s.text);
    if (s.bold) {
      t.setFormat(BOLD);
    }
    if (s.note !== '') {
      $setState(t, note, s.note);
    }
    held.append(t);
  }
  const tail = $createParagraphNode().append($createTextNode('tail line'));
  $getRoot().append(intro, $container(cfg.from, held), tail);
}

/** The text node and offset at character `offset` of `block`'s text. */
function $locate(
  block: ElementNode,
  offset: number,
  preferEnd: boolean,
): {node: TextNode; offset: number} | null {
  let pos = 0;
  const texts = block.getAllTextNodes();
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    const size = t.getTextContentSize();
    if (
      offset < pos + size ||
      (offset === pos + size && (preferEnd || i === texts.length - 1))
    ) {
      return {node: t, offset: offset - pos};
    }
    pos += size;
  }
  return null;
}

/**
 * Select `[start, end)` of `node`, with the node's format and style as the
 * selection's (as a browser's selection in that text sets them), so that
 * text typed there joins the node.
 */
function $selectText(node: TextNode, start: number, end: number) {
  const sel = node.select(start, end);
  sel.setFormat(node.getFormat());
  sel.setStyle(node.getStyle());
}

/**
 * The composition's range in A's editor: `interim` at `offset` of the node
 * it was typed in, or, where that node changed (a transform re-typed the
 * line while composing), the last occurrence of `interim` in the line.
 */
function $selectComposition(
  key: string,
  offset: number,
  interim: string,
): boolean {
  const node = $getNodeByKey(key);
  if (
    $isTextNode(node) &&
    node.isAttached() &&
    node.getTextContent().slice(offset, offset + interim.length) === interim
  ) {
    $selectText(node, offset, offset + interim.length);
    return true;
  }
  const block =
    $isTextNode(node) && node.isAttached() ? node.getParent() : $heldBlock();
  if (!$isElementNode(block)) {
    return false;
  }
  const at = block.getTextContent().lastIndexOf(interim);
  if (at < 0) {
    return false;
  }
  const start = $locate(block, at, false);
  const end = $locate(block, at + interim.length, true);
  if (start === null || end === null) {
    return false;
  }
  const sel = start.node.select(start.offset, start.offset);
  sel.focus.set(end.node.getKey(), end.offset, 'text');
  sel.setFormat(start.node.getFormat());
  sel.setStyle(start.node.getStyle());
  return true;
}

/** B's action on the held line; `shift` maps B's offsets past A's text. */
function $collab(cfg: Cfg, shift: (o: number) => number) {
  const held = $heldBlock();
  if (held === null) {
    return;
  }
  if (cfg.collab === 'none') {
    const tail = $getRoot().getLastChild();
    if ($isElementNode(tail)) {
      const t = tail.getLastDescendant();
      if ($isTextNode(t)) {
        t.setTextContent(t.getTextContent() + ' more');
      }
    }
  } else if (cfg.collab === 'text') {
    if (cfg.bText.kind === 'insert') {
      const at = $locate(held, shift(cfg.bText.at), true);
      if (at !== null) {
        at.node.spliceText(at.offset, 0, 'BB');
      }
    } else {
      const from = shift(cfg.bText.from);
      const to = shift(cfg.bText.to);
      for (let i = to - 1; i >= from; i--) {
        const at = $locate(held, i, false);
        if (at !== null) {
          at.node.spliceText(at.offset, 1, '');
        }
      }
    }
  } else if (cfg.collab === 'attr') {
    if (cfg.bAttr === 'indent') {
      held.setIndent(held.getIndent() + 1);
    } else {
      held.setFormat(cfg.bAttr);
    }
  } else if (cfg.collab === 'type') {
    $convertBlock(held, cfg.bType);
  } else if (cfg.collab === 'join') {
    const intro = $getRoot().getFirstChildOrThrow() as ElementNode;
    const top = held.getTopLevelElementOrThrow();
    intro.append(...held.getChildren());
    top.remove();
  } else if (cfg.collab === 'split') {
    const at = $locate(held, shift(cfg.bSplit), false);
    if (at === null) {
      return;
    }
    let first: LexicalNode;
    if (at.offset === 0) {
      first = at.node;
    } else {
      const parts = at.node.splitText(at.offset);
      first = parts[1] ?? null!;
      if (first === null || first === undefined) {
        return;
      }
    }
    const moving = [first, ...first.getNextSiblings()];
    const kind: Block = cfg.from;
    const next = $makeBlock(held.getType() === 'listitem' ? 'listitem' : kind);
    next.append(...moving);
    held.insertAfter(next);
  } else if (cfg.collab === 'delete') {
    const top = held.getTopLevelElementOrThrow();
    top.remove();
  }
}

/**
 * The app transform that restructures the block holding the committed text:
 * armed by the update that ends the composition (in both runs), it runs
 * whenever such a block is dirty, until its condition no longer holds (it is
 * idempotent), so it runs again on what A reads after the hold ends.
 */
const gate = {armed: false, committed: ''};

function registerStruct(editor: LexicalEditor, kind: Cfg['struct']) {
  return editor.registerNodeTransform(TextNode, node => {
    if (!gate.armed || gate.committed === '') {
      return;
    }
    const block = node.getParent();
    if (
      !$isElementNode(block) ||
      block.isInline() ||
      block.getType() === 'code' ||
      !block.getTextContent().includes(gate.committed)
    ) {
      return;
    }
    const top = block.getTopLevelElementOrThrow();
    if (kind === 'heading' || kind === 'quote' || kind === 'paragraph') {
      if (block.getType() !== kind) {
        $convertBlock(block, kind);
      }
    } else if (kind === 'split') {
      // The block ends after the committed text.
      const text = block.getTextContent();
      const at = text.lastIndexOf(gate.committed) + gate.committed.length;
      if (at >= text.length) {
        return;
      }
      const loc = $locate(block, at, true);
      if (loc === null) {
        return;
      }
      let moving: LexicalNode[];
      if (loc.offset >= loc.node.getTextContentSize()) {
        moving = loc.node.getNextSiblings();
      } else if (loc.offset === 0) {
        moving = [loc.node, ...loc.node.getNextSiblings()];
      } else {
        const [, right] = loc.node.splitText(loc.offset);
        moving = [right, ...right.getNextSiblings()];
      }
      if (moving.length > 0) {
        top.insertAfter($createParagraphNode().append(...moving));
      }
    } else if (kind === 'move') {
      // The block moves to the end of the document.
      const last = $getRoot().getLastChild();
      if (last !== null && !last.is(top)) {
        last.insertAfter(top);
      }
    } else {
      // The block joins the line before it, unless it holds that line.
      const prev = top.getPreviousSibling();
      if (
        $isElementNode(prev) &&
        !$isListNode(prev) &&
        prev.getType() !== 'code' &&
        !block.getTextContent().includes('intro')
      ) {
        prev.append(...block.getChildren());
        if (top.is(block) || top.getChildrenSize() <= 1) {
          top.remove();
        } else {
          block.remove();
        }
      }
    }
  });
}

function makePrepare(cfg: Cfg, composer: boolean) {
  return (editor: LexicalEditor) => {
    if (composer || cfg.allPeers) {
      if (cfg.retype === 'hashtag') {
        registerLexicalHashtag(editor);
      }
      if (
        cfg.retype === 'prism' ||
        cfg.from === 'code' ||
        cfg.bType === 'code'
      ) {
        registerPrism(editor, PrismTokenizer);
      }
    }
    if (composer && cfg.end === 'struct') {
      registerStruct(editor, cfg.struct);
    }
  };
}

/**
 * The ending update's own edits at A's selection: `insertNow` inserted there
 * (replacing a composition's range: Firefox's input, WebKit's
 * insertFromComposition), or, with null, the selection collapsed to its end
 * (a composition committed in place, as Chrome does); then the format or
 * NodeState set, and Enter.
 */
function $endEdits(cfg: Cfg, insertNow: string | null) {
  const sel = $getSelection();
  if (!$isRangeSelection(sel)) {
    return;
  }
  if (insertNow !== null && insertNow !== '') {
    sel.insertText(insertNow);
  } else if (!sel.isCollapsed()) {
    const end = sel.isBackward() ? sel.anchor : sel.focus;
    sel.anchor.set(end.key, end.offset, end.type);
    sel.focus.set(end.key, end.offset, end.type);
  }
  const sel2 = $getSelection();
  if (!$isRangeSelection(sel2)) {
    return;
  }
  const caret = sel2.anchor;
  const node = caret.getNode();
  const block = $isTextNode(node) ? node.getParent() : node;
  if (cfg.endFmt !== 'none' && $isTextNode(node) && $isElementNode(block)) {
    // On the committed text (the characters before the caret), or on the
    // whole line.
    const committed = cfg.interim + (cfg.ins ? cfg.extra : '');
    let targets: TextNode[] = [];
    if (cfg.endScope === 'line') {
      targets = block.getAllTextNodes();
    } else {
      const text = block.getTextContent();
      let caretAt = 0;
      for (const t of block.getAllTextNodes()) {
        if (t.is(node)) {
          caretAt += caret.offset;
          break;
        }
        caretAt += t.getTextContentSize();
      }
      const startAt = text.lastIndexOf(committed, caretAt - committed.length);
      const start = startAt < 0 ? null : $locate(block, startAt, false);
      if (start !== null) {
        const range = start.node.select(start.offset, start.offset);
        range.focus.set(caret.key, caret.offset, caret.type);
        targets = range.extract().filter((n): n is TextNode => $isTextNode(n));
      }
    }
    for (const t of targets) {
      if (cfg.endFmt === 'bold' && !t.hasFormat('bold')) {
        t.toggleFormat('bold');
      }
      if (cfg.endFmt === 'note') {
        $setState(t, note, 'N');
      }
    }
    // Back to the caret after the committed text.
    const after = $getNodeByKey(caret.key);
    if ($isTextNode(after) && after.isAttached()) {
      after.select(
        Math.min(caret.offset, after.getTextContentSize()),
        Math.min(caret.offset, after.getTextContentSize()),
      );
    }
  }
  if (cfg.end === 'enter') {
    const sel3 = $getSelection();
    if ($isRangeSelection(sel3)) {
      sel3.insertParagraph();
    }
  }
}

// ---------------------------------------------------------------------------
// Views and classes

type Char = {ch: string; fmt: number; kind: string; note: string};
type BlockView = {type: string; format: string; indent: number; chars: Char[]};
export type View = BlockView[];

function $charsOf(el: ElementNode, wrap = ''): Char[] {
  const out: Char[] = [];
  for (const n of el.getChildren()) {
    if ($isTextNode(n)) {
      const hl = (n as unknown as {__highlightType?: string | null})
        .__highlightType;
      const kind = wrap + n.getType() + (hl ? ':' + hl : '');
      for (const ch of n.getTextContent()) {
        out.push({ch, fmt: n.getFormat(), kind, note: $getState(n, note)});
      }
    } else if ($isLineBreakNode(n)) {
      out.push({ch: '\n', fmt: 0, kind: 'linebreak', note: ''});
    } else if ($isDecoratorNode(n)) {
      out.push({ch: '\ufffc', fmt: 0, kind: 'deco', note: ''});
    } else if ($isElementNode(n)) {
      out.push(...$charsOf(n, wrap + n.getType() + '>'));
    }
  }
  return out;
}

function view(p: Peer): View {
  return p.read(() => {
    const blocks: View = [];
    const push = (b: ElementNode, type: string) =>
      blocks.push({
        chars: $charsOf(b),
        format: b.getFormatType(),
        indent: b.getIndent(),
        type,
      });
    for (const c of $getRoot().getChildren()) {
      if ($isListNode(c)) {
        for (const item of c.getChildren()) {
          if ($isElementNode(item)) {
            push(item, 'listitem');
          }
        }
      } else if ($isElementNode(c)) {
        push(
          c,
          c.getType() === 'heading'
            ? `heading:${(c as unknown as {getTag(): string}).getTag()}`
            : c.getType(),
        );
      }
    }
    return blocks;
  });
}

export const textOf = (v: View): string[] =>
  v.map(b => b.chars.map(c => c.ch).join(''));

function multisetMinus(a: string, b: string): string {
  const counts = new Map<string, number>();
  for (const ch of b) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let out = '';
  for (const ch of a) {
    const n = counts.get(ch) ?? 0;
    if (n > 0) {
      counts.set(ch, n - 1);
    } else {
      out += ch;
    }
  }
  return out;
}

export type Outcome = {
  cls: string;
  sub: string[];
  detail: string;
};

export function classify(
  impl: {views: View[]; findings: string[]},
  ref: View,
): Outcome {
  if (
    impl.findings.some(
      f => f.startsWith('editor-error') || f.startsWith('crash'),
    )
  ) {
    return {
      cls: 'error',
      detail: impl.findings.join('; ').slice(0, 400),
      sub: [],
    };
  }
  const first = JSON.stringify(impl.views[0]);
  if (impl.views.some(v => JSON.stringify(v) !== first)) {
    const labels = ['C', 'B', 'A', 'fresh'];
    const diff = impl.views
      .map((v, i) => (JSON.stringify(v) === first ? null : labels[i]))
      .filter(x => x !== null);
    return {
      cls: 'divergence',
      detail: `differs from C: ${diff.join(',')}; C ${JSON.stringify(textOf(impl.views[0]))}`,
      sub: [],
    };
  }
  const storage = impl.findings.filter(
    x =>
      x.startsWith('self-check') ||
      x.startsWith('storage-') ||
      x.startsWith('recovered-write'),
  );
  if (storage.length > 0) {
    return {cls: 'storage', detail: storage.join('; ').slice(0, 400), sub: []};
  }
  const f = impl.views[impl.views.length - 1];
  const ft = textOf(f);
  const rt = textOf(ref);
  // The same lines in another order (a block moved).
  if (
    JSON.stringify(ft) !== JSON.stringify(rt) &&
    JSON.stringify([...ft].sort()) === JSON.stringify([...rt].sort())
  ) {
    return {
      cls: 'structure',
      detail: `impl ${JSON.stringify(ft)} ref ${JSON.stringify(rt)} (order)`,
      sub: ['order'],
    };
  }
  const fAll = ft.join('');
  const rAll = rt.join('');
  const sub: string[] = [];
  if (impl.findings.length > 0) {
    sub.push(
      'warned:' +
        [...new Set(impl.findings.map(x => x.split(':')[0]))].join('+'),
    );
  }
  // A line break and a block boundary hold the same text in two shapes (Enter
  // in a code block makes a line break, elsewhere a new block).
  const noBreaks = (x: string) => x.replaceAll('\n', '');
  if (fAll !== rAll && noBreaks(fAll) === noBreaks(rAll)) {
    return {
      cls: 'structure',
      detail: `impl ${JSON.stringify(ft)} ref ${JSON.stringify(rt)} (line breaks)`,
      sub,
    };
  }
  if (fAll !== rAll) {
    const missing = multisetMinus(rAll, fAll);
    const extra = multisetMinus(fAll, rAll);
    const cls =
      missing.length > 0
        ? 'text-loss'
        : extra.length > 0
          ? 'text-dup'
          : 'text-order';
    return {
      cls,
      detail: `impl ${JSON.stringify(ft)} ref ${JSON.stringify(rt)} missing ${JSON.stringify(missing)} extra ${JSON.stringify(extra)}`,
      sub,
    };
  }
  if (JSON.stringify(ft) !== JSON.stringify(rt)) {
    return {
      cls: 'structure',
      detail: `impl ${JSON.stringify(ft)} ref ${JSON.stringify(rt)}`,
      sub,
    };
  }
  const diffs = new Set<string>();
  const details: string[] = [];
  f.forEach((b, i) => {
    const rb = ref[i];
    if (b.type !== rb.type) {
      diffs.add('block-type');
      details.push(`block ${i} type ${b.type} vs ${rb.type}`);
    }
    if (b.format !== rb.format || b.indent !== rb.indent) {
      diffs.add('block-attr');
      details.push(
        `block ${i} format ${b.format}/${b.indent} vs ${rb.format}/${rb.indent}`,
      );
    }
    b.chars.forEach((c, j) => {
      const rc = rb.chars[j];
      if (c.fmt !== rc.fmt) {
        diffs.add('format');
        details.push(
          `block ${i} char ${j} ${JSON.stringify(c.ch)} fmt ${c.fmt} vs ${rc.fmt}`,
        );
      }
      if (c.note !== rc.note) {
        diffs.add('nodestate');
        details.push(
          `block ${i} char ${j} ${JSON.stringify(c.ch)} note ${c.note} vs ${rc.note}`,
        );
      }
      if (c.kind !== rc.kind) {
        diffs.add('token');
        details.push(
          `block ${i} char ${j} ${JSON.stringify(c.ch)} kind ${c.kind} vs ${rc.kind}`,
        );
      }
    });
  });
  if (diffs.size === 0) {
    return {cls: 'none', detail: '', sub};
  }
  return {
    cls: 'attr',
    detail: details.slice(0, 6).join('; '),
    sub: [...sub, ...diffs],
  };
}

// ---------------------------------------------------------------------------
// Runs

export type Run = {views: View[]; findings: string[]; trace: string[]};

const TRACE = process.env.COMPOSE_REF_TRACE === '1';

async function runOne(cfg: Cfg, gc: boolean, reference: boolean): Promise<Run> {
  gate.armed = false;
  gate.committed = cfg.interim + (cfg.ins ? cfg.extra : '');
  const traceLog: string[] = [];
  const t = await setup(() => $initial(cfg), {
    gc,
    ids: cfg.ids,
    nodes: NODE_SET,
    prepare: makePrepare(cfg, false),
    withBlockIds: false,
  });
  const net = {
    delivery: 'causal' as const,
    peers: [],
    pumping: false,
    queue: [],
  };
  const a = new Peer(cfg.aId, net, NODE_SET, makePrepare(cfg, true), false, gc);
  const host = document.createElement('div');
  host.contentEditable = 'true';
  document.body.append(host);
  const deliver = (from: Peer, to: Peer) =>
    Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc), 'transport');
  const peers: Peer[] = [...t.peers, a];
  let fresh: Peer | undefined;
  const step = (name: string) => {
    if (TRACE) {
      traceLog.push(`${name}: A ${a.describe()} | B ${t.b.describe()}`);
    }
  };
  try {
    deliver(t.a, a);
    a.binding.initialize();
    await flush();
    a.editor.setRootElement(host);
    host.focus();
    const len = cfg.spans.reduce((s, x) => s + x.text.length, 0);
    const shiftNone = (o: number) => o;
    const shiftSaw = (o: number) => (o >= cfg.at ? o + cfg.interim.length : o);
    let cursor: ReturnType<typeof a.binding.getCursor> = null;
    let composedKey = '';
    let composedOffset = 0;
    let unresolved = false;
    // A's composition: its caret at `point`, the composition, the composing
    // text (Lexical selects it while composing).
    // The composing text takes the attributes of the text it is typed in at
    // the composition's start (in the reference too, wherever B's edit moved
    // that position).
    let typed: {format: number; style: string; note: string} | null = null;
    const composeStart = (
      point: () => {key: string; offset: number; type: string} | null,
    ) =>
      a.update(() => {
        const at = point();
        const node = at === null ? null : $getNodeByKey(at.key);
        if (at === null || node === null) {
          unresolved = true;
          return;
        }
        const same = (tn: TextNode) =>
          typed === null ||
          (tn.getFormat() === typed.format &&
            tn.getStyle() === typed.style &&
            $getState(tn, note) === typed.note);
        if ($isTextNode(node) && same(node)) {
          if (typed === null) {
            typed = {
              format: node.getFormat(),
              note: $getState(node, note),
              style: node.getStyle(),
            };
          }
          $selectText(node, at.offset, at.offset);
        } else if (typed !== null) {
          // A text node of its own, with those attributes, at the position.
          const own = $createTextNode('');
          own.setFormat(typed.format);
          own.setStyle(typed.style);
          if (typed.note !== '') {
            $setState(own, note, typed.note);
          }
          if ($isTextNode(node)) {
            if (at.offset <= 0) {
              node.insertBefore(own);
            } else if (at.offset >= node.getTextContentSize()) {
              node.insertAfter(own);
            } else {
              const [left] = node.splitText(at.offset);
              left.insertAfter(own);
            }
          } else if ($isElementNode(node)) {
            const child = node.getChildAtIndex(at.offset);
            if (child !== null) {
              child.insertBefore(own);
            } else {
              node.append(own);
            }
          } else {
            unresolved = true;
            return;
          }
          $selectText(own, 0, 0);
        } else if ($isElementNode(node)) {
          node.select(at.offset, at.offset);
        } else {
          unresolved = true;
          return;
        }
        const anchor = $getSelection();
        if (!$isRangeSelection(anchor)) {
          unresolved = true;
          return;
        }
        $setCompositionKey(anchor.anchor.getNode().getKey());
        anchor.insertText(cfg.interim);
        const after = $getSelection();
        if ($isRangeSelection(after)) {
          const end = after.isBackward() ? after.anchor : after.focus;
          composedKey = end.key;
          composedOffset = Math.max(0, end.offset - cfg.interim.length);
          $setCompositionKey(composedKey);
        }
      });
    // The update that ends it: the composition's range committed in place or
    // replaced by the committed text, then the ending update's own edits.
    const composeEnd = () => {
      gate.armed = true;
      a.update(() => {
        const sel = $getSelection();
        $setCompositionKey(null);
        if ($isRangeSelection(sel)) {
          const n = sel.anchor.getNode();
          if ($isTextNode(n) && n.isAttached()) {
            n.getWritable();
          }
        }
        if (composedKey !== '') {
          $selectComposition(composedKey, composedOffset, cfg.interim);
        }
        $endEdits(cfg, cfg.ins ? cfg.interim + cfg.extra : null);
        $setSelection(null);
      });
    };
    const $heldPoint = () => {
      const held = $heldBlock();
      const at =
        held === null ? null : $locate(held, Math.min(cfg.at, len), true);
      return at === null
        ? null
        : {key: at.node.getKey(), offset: at.offset, type: 'text'};
    };
    if (reference) {
      // A's caret where the composition would start, as relative positions.
      a.update(() => {
        const at = $heldPoint();
        const node = at === null ? null : $getNodeByKey(at.key);
        if (at !== null && $isTextNode(node)) {
          $selectText(node, at.offset, at.offset);
          typed = {
            format: node.getFormat(),
            note: $getState(node, note),
            style: node.getStyle(),
          };
        }
      });
      cursor = a.binding.getCursor();
      step('ref caret');
      t.b.update(() => {
        $collab(cfg, shiftNone);
        $setSelection(null);
      });
      await t.sync();
      deliver(t.a, a);
      await flush();
      step('ref collab');
      // The composition collapsed to the moment it ends: the same local
      // updates, at the caret mapped through B's edit, with nothing arriving
      // in between (no hold).
      composeStart(() => {
        const pts = cursor === null ? null : a.binding.$resolveCursor(cursor);
        return pts === null ? null : pts.anchor;
      });
      await flush();
      composeEnd();
      await flush();
      step('ref end');
    } else {
      composeStart($heldPoint);
      step('A composed');
      if (cfg.bSaw) {
        deliver(a, t.a);
        await t.sync();
      }
      t.b.update(() => {
        $collab(cfg, cfg.bSaw ? shiftSaw : shiftNone);
        $setSelection(null);
      });
      await t.sync();
      deliver(t.a, a);
      await flush();
      step('B acted');
      if (TRACE) {
        traceLog.push(
          'A selection before end: ' +
            a.read(() => {
              const s0 = $getSelection();
              return $isRangeSelection(s0)
                ? `${s0.anchor.key}:${s0.anchor.offset}:${s0.anchor.type} ${s0.focus.key}:${s0.focus.offset} "${s0.getTextContent()}"`
                : String(s0);
            }),
        );
      }
      composeEnd();
      await flush();
      step('A ended');
    }
    for (let round = 0; round < 3; round++) {
      deliver(a, t.a);
      await t.sync();
      deliver(t.a, a);
      await flush();
    }
    fresh = await freshReader(a);
    const all = [...peers, fresh];
    const labels = ['C', 'B', 'A', 'fresh'];
    const findings: string[] = [];
    all.forEach((p, i) => {
      for (const f of peerFindings(p, labels[i])) {
        findings.push(`${f.cls}: ${f.detail}`);
      }
    });
    if (unresolved) {
      findings.push('ref-unresolved: the composition had no position');
    }
    step('synced');
    return {findings, trace: traceLog, views: all.map(view)};
  } finally {
    gate.armed = false;
    fresh?.stop();
    a.editor.setRootElement(null);
    host.remove();
    for (const p of peers) {
      p.stop();
    }
  }
}

/**
 * Plays the history `cfg` with garbage collection `gc`: the binding's run,
 * or with `reference` the reference run. A throw is a `crash` finding.
 */
export async function runHistory(
  cfg: Cfg,
  gc: boolean,
  reference: boolean,
): Promise<Run> {
  try {
    return await runOne(cfg, gc, reference);
  } catch (e) {
    return {
      findings: [`crash: ${String(e).slice(0, 300)}`],
      trace: [],
      views: [],
    };
  }
}

/**
 * The binding's run of `cfg` compared with the reference: `ref-bad` where
 * the reference itself does not converge or warns, unless the binding's run
 * errs, diverges or fails a storage check on its own (reported as such).
 */
export async function compareWithReference(
  cfg: Cfg,
  gc: boolean,
): Promise<{outcome: Outcome; ref: Run; impl: Run}> {
  const ref = await runHistory(cfg, gc, true);
  const impl = await runHistory(cfg, gc, false);
  const refBad =
    ref.views.length === 0 ||
    ref.findings.length > 0 ||
    ref.views.some(v => JSON.stringify(v) !== JSON.stringify(ref.views[0]));
  // The binding's run alone: an error, a divergence or a storage finding,
  // whatever the reference did.
  const own =
    impl.views.length === 0
      ? null
      : classify(impl, impl.views[impl.views.length - 1]);
  const outcome: Outcome =
    impl.views.length === 0
      ? {cls: 'error', detail: impl.findings.join('; ').slice(0, 300), sub: []}
      : refBad
        ? own !== null && own.cls !== 'none'
          ? own
          : {
              cls: 'ref-bad',
              detail: ref.findings.join('; ').slice(0, 300),
              sub: [],
            }
        : classify(impl, ref.views[ref.views.length - 1]);
  return {impl, outcome, ref};
}
