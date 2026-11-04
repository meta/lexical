/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// Fuzz: the composer's hold (see Hidden) against remote formatting. A composes
// (starts, types, presses Enter, ends) while B and C format: text formats,
// links (a wrapper key), colors (a text field), comments (a set member), a raw
// writer's plain values, ends a raw writer inserts naming an opener (more than
// one per opener, in another paragraph too), deletions of stored format items
// (one, an opener only, an end only, or a whole key), binding undo and redo, an
// app undo manager over the raw writes (which keeps their payloads findable),
// and a flip of the NodeState that the second line's canBeEmpty and its inline
// containers' canInsertTextBefore/After read. Peers go offline and sync at
// random. In a quarter of the sessions A has an app's plugins that edit the
// last line in reply to the editor's own updates (see utils/appPlugins), and
// every edit they make must reach the others. In three in ten sessions the
// second line's text sits in two nested inline containers, in three in ten its
// middle word sits in an inline container between text, and raw writers write
// in the inline container that holds text half the time.
//
// After every step no peer warns a self-check, and every action of B or C (all
// of them formatting) leaves the text and the ids of its characters as they
// were. Whenever A composes nothing and every peer is synced, every peer reads
// the same and A equals a fresh read of its document.
//
// A's editor renders into a DOM root (CH_NODOM=1: none). A starts a composition
// at a caret Lexical has normalized, as a browser's starts (at a boundary
// between text nodes, in the one before or the one after), a quarter of the
// time with the selection's focus on the line's end (an element point). A's own
// typing keeps the DOM text node it composes in, and lands where A composes
// when its node and caret were there before (a failure otherwise). After each
// step of another peer, A makes an update: where it moves the composition to
// another node under a hold (a move the binding did not foresee, see
// YBinding#predicts; CH_NOPREDICT=1 turns its foresight off), the hold ends at
// once and A shows what is stored (a failure otherwise). Each session counts
// what other peers' steps did to A's composition (CH_STATS=1 prints the counts,
// see Stats): the DOM text node it runs in detached, the composed node replaced
// or the composition ended, the composition moved to another node by A's next
// local update after the step (under a hold, too), the caret moved to another
// place, off the text, or only to another node, and keystrokes that did not
// land at the caret. A peer left with Yjs structs waiting for others after a
// full sync fails as its own class, labeled `pending structs after a full sync
// (yjs#824)` (a Yjs 14 rc.29 effect, fixed by the unmerged yjs#827); a
// paragraph's text format or style derived from A's DOM selection, when it is
// all that differs, is counted, not failed (it depends on the editor's
// reconcile history, on main too).
//
// Each session records its actions in terms of lines, text offsets and root
// indexes (see Op), so that it can be replayed on another tree: CH_DUMP=<dir>
// writes failing sessions, CH_RECORD=<dir> every session, CH_REPLAY=<file>
// replays one, CH_REPLAY_DIR=<dir> (with CH_SHARD=k/n) all of them. Env:
// CH_SEEDS (default 12), CH_START, CH_OPS (default 30), CH_GC (both settings
// unless 0 or 1), CH_NOCOMPOSE=1, CH_NOPREDICT=1, CH_CARET=1 (log caret and DOM
// events).

import {$toggleLink} from '@lexical/link';
import {$addMarkID, $removeMarkID} from '@lexical/mark';
import {$patchStyleText} from '@lexical/selection';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getDocument,
  $getEditor,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getState,
  $isRangeSelection,
  $isTextNode,
  $setCompositionKey,
  $setSelection,
  $setState,
  type BaseSelection,
  createState,
  ElementNode,
  ParagraphNode,
  type RangeSelection,
  TextNode,
} from 'lexical';
import * as fs from 'node:fs';
import {expect, test} from 'vitest';

import {APP_MARKS, registerAppPlugins} from '../utils/appPlugins';
import {
  expectConverged,
  freshReader,
  NODES,
  type Peer,
  setup,
} from '../utils/harness';
import {prepareMarkState} from '../utils/sizeOps';

const SEEDS = Number(process.env.CH_SEEDS ?? 12);
const START = Number(process.env.CH_START ?? 1);
const OPS = Number(process.env.CH_OPS ?? 30);
const NO_COMPOSE = process.env.CH_NOCOMPOSE === '1';
const NO_PREDICT = process.env.CH_NOPREDICT === '1';
const GCS =
  process.env.CH_GC === '0'
    ? [false]
    : process.env.CH_GC === '1'
      ? [true]
      : [false, true];

function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    chance: (p: number) => next() < p,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    next,
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)],
  };
}

type Who = 'A' | 'B' | 'C';
/** Where a raw writer writes: the root, or the inner inline container. */
type Box = 'inner';
/** The document's shape: lines of text, or the second one's text in two inline containers. */
type Shape = 'flat' | 'nested' | 'inline';
type Range = [l0: number, o0: number, l1: number, o1: number];
type Format =
  | 'bold'
  | 'italic'
  | 'link'
  | 'unlink'
  | 'color'
  | 'comment'
  | 'uncomment';
/** One action, in terms of lines, text offsets and root indexes. */
type Op =
  | {k: 'start'; line: number; off: number; after?: true; focusEnd?: true}
  | {k: 'type'; ch: string}
  | {k: 'enter'}
  | {k: 'enter end'}
  | {k: 'end'}
  | {k: 'fmt'; who: Who; what: Format; range: Range; value: string}
  | {k: 'raw'; who: Who; at: number; n: number; value: boolean; box?: Box}
  | {
      k: 'del';
      who: Who;
      mode: 'one' | 'opener' | 'end' | 'key';
      box?: Box;
      key: string;
      pos: number;
      /** Which of the items nearest `pos` (default the first). */
      rank?: number;
    }
  | {k: 'rawEnd'; who: Who; key: string; target: number; at: number; box?: Box}
  | {k: 'undo'; who: Who}
  | {k: 'redo'; who: Who}
  | {k: 'app undo'; who: Who}
  | {k: 'app redo'; who: Who}
  | {k: 'sync'}
  | {k: 'online'; who: Who; on: boolean}
  | {k: 'flip'; who: Who};

const KEYS = ['f:bold', 'f:italic', 'w:link', 'p:style', 's:markIds\u001fc1'];
const RAW = 'raw writer';

const describeOp = (op: Op): string =>
  op.k === 'fmt'
    ? `${op.who} ${op.what} ${op.range.join(',')}`
    : op.k === 'raw'
      ? `${op.who} raw ${op.box ?? ''}${op.at}+${op.n}=${op.value}`
      : op.k === 'del'
        ? `${op.who} delete ${op.mode} ${op.key}@${op.pos}`
        : op.k === 'rawEnd'
          ? `${op.who} raw end ${op.key}->${op.target}@${op.at}`
          : op.k === 'online'
            ? `${op.who} online ${op.on}`
            : op.k === 'flip'
              ? `${op.who} flip`
              : op.k === 'start'
                ? `A start ${op.line}:${op.off}${op.after ? '+' : ''}${op.focusEnd ? ' to the line end' : ''}`
                : op.k === 'type'
                  ? `A type ${JSON.stringify(op.ch)}`
                  : 'who' in op
                    ? `${op.who} ${op.k}`
                    : op.k === 'sync'
                      ? 'sync'
                      : `A ${op.k}`;

/**
 * The container a raw writer writes in: the root, or the inner inline
 * container that holds text (in a document with one; else the root).
 */
function boxOf(p: Peer, box: Box | undefined): Y.Node {
  const root = p.doc.get('lexical-y');
  if (box !== 'inner') {
    return root;
  }
  const find = (y: Y.Node): Y.Node | null => {
    for (let it = y._start; it !== null; it = it.right as Y.Item | null) {
      if (!it.deleted && it.content instanceof Y.ContentType) {
        const inner = it.content.type as Y.Node;
        const deeper = find(inner);
        if (deeper !== null) {
          return deeper;
        }
        for (let x = inner._start; x !== null; x = x.right as Y.Item | null) {
          if (!x.deleted && x.content instanceof Y.ContentString) {
            return inner;
          }
        }
      }
    }
    return null;
  };
  return find(root) ?? root;
}

/** The container's items with the count of characters before each. */
function rootItems(p: Peer, box?: Box): {it: Y.Item; pos: number}[] {
  const out: {it: Y.Item; pos: number}[] = [];
  let pos = 0;
  for (
    let it = boxOf(p, box)._start;
    it !== null;
    it = it.right as Y.Item | null
  ) {
    out.push({it, pos});
    if (!it.deleted && it.countable) {
      pos += it.length;
    }
  }
  return out;
}

const rootLength = (p: Peer, box?: Box): number =>
  (boxOf(p, box) as unknown as {length: number}).length;

/** An inline container a client older than its node's storage wrote. */
/**
 * Whether the second line and its inline containers are "shut" (NodeState a
 * remote peer flips, see Op `flip`): no text beside an inline container, and
 * the line cannot be empty.
 */
const shut = createState('fuzz_shut', {parse: v => v === true});

class LegacyInline extends ElementNode {
  $config() {
    return this.config('fuzz_legacy_inline', {
      children: 'inline',
      extends: ElementNode,
      stateConfigs: [{stateConfig: shut}],
    });
  }
  isInline(): true {
    return true;
  }
  canInsertTextBefore(): boolean {
    return !$getState(this, shut);
  }
  canInsertTextAfter(): boolean {
    return !$getState(this, shut);
  }
  createDOM() {
    return $getDocument().createElement('span');
  }
  updateDOM(): false {
    return false;
  }
}

/** The second line: a paragraph whose canBeEmpty reads NodeState. */
class SwitchLine extends ParagraphNode {
  $config() {
    return this.config('fuzz_switch_line', {
      extends: ParagraphNode,
      stateConfigs: [{stateConfig: shut}],
    });
  }
  canBeEmpty(): boolean {
    return !$getState(this, shut);
  }
}

/** The composition's hold in `p`'s binding (see Hidden), or null. */
const holdOf = (p: Peer): unknown =>
  (p.binding as unknown as {state: {hidden: unknown}}).state.hidden;

/**
 * What `p` shows, text node boundaries aside (the node composed in is not
 * merged with its neighbours until the composition ends): per line, each
 * character with its format, style and the elements around it.
 */
function shownOf(p: Peer): string {
  return p.read(() =>
    $getRoot()
      .getChildren()
      .map(line =>
        line instanceof ElementNode
          ? line
              .getAllTextNodes()
              .map(n => {
                const ups: string[] = [];
                for (
                  let up = n.getParent();
                  up !== null && up !== line;
                  up = up.getParent()
                ) {
                  ups.push(up.getType());
                }
                const tag = `${n.getFormat()}/${n.getStyle()}/${ups.join('<')}`;
                return [...n.getTextContent()]
                  .map(ch => `${ch}{${tag}}`)
                  .join('');
              })
              .join('')
          : line.getTextContent(),
      )
      .join(' | '),
  );
}

/**
 * An app's TextNode whose selectionTransform moves a collapsed caret in it
 * to the end of the text before it, while its line is shut (SwitchLine's
 * NodeState) in the state committed before too: a move of the composition
 * the binding cannot foresee (see YBinding#noteComposed).
 */
class Leaning extends TextNode {
  $config() {
    return this.config('fuzz_leaning', {extends: TextNode});
  }
  selectionTransform(_prev: BaseSelection | null, next: RangeSelection): void {
    const previous = this.getPreviousSibling();
    const line = this.getTopLevelElement();
    if (
      line === null ||
      !$getState(line, shut) ||
      !next.isCollapsed() ||
      next.anchor.key !== this.getKey() ||
      !$isTextNode(previous)
    ) {
      return;
    }
    const key = line.getKey();
    const shutBefore = $getEditor()
      .getEditorState()
      .read(() => {
        const was = $getNodeByKey(key);
        return was !== null && $getState(was, shut);
      });
    if (shutBefore) {
      const size = previous.getTextContentSize();
      next.anchor.set(previous.getKey(), size, 'text');
      next.focus.set(previous.getKey(), size, 'text');
    }
  }
}

/** Whether `op` is one of A's composition steps. */
const isOwn = (op: Op): boolean =>
  op.k === 'start' ||
  op.k === 'type' ||
  op.k === 'enter' ||
  op.k === 'enter end' ||
  op.k === 'end';

const isEnd = (it: Y.Item): boolean =>
  Array.isArray((it.content as Y.ContentFormat).value);

/**
 * The live text of `p`'s document, with the id of each character; without
 * the marks client `skip`'s plugins write (A's, whose plugins can reply to
 * another peer's action as it arrives, see utils/appPlugins), never A's own
 * typing.
 */
function textIds(p: Peer, skip: number | null = null): string {
  const out: string[] = [];
  let text = '';
  const walk = (y: Y.Node) => {
    for (let it = y._start; it !== null; it = it.right as Y.Item | null) {
      if (it.deleted) {
        continue;
      }
      if (it.content instanceof Y.ContentString) {
        const str = it.content.str;
        for (let i = 0; i < it.length; i++) {
          if (it.id.client === skip && APP_MARKS.includes(str[i])) {
            continue;
          }
          text += str[i];
          out.push(`${it.id.client}:${it.id.clock + i}`);
        }
      } else if (it.content instanceof Y.ContentType) {
        walk(it.content.type as Y.Node);
      }
    }
  };
  walk(p.doc.get('lexical-y'));
  return `${skip === null ? p.read(() => $getRoot().getTextContent()) : text}\n${out.join(' ')}`;
}

/**
 * Select `range` (lines and text offsets) in `p`'s editor: at a boundary
 * between text nodes, at the end of the one before (`after`: at the start
 * of the one after).
 */
function $selectRange(range: Range, after = false): boolean {
  const lines = $getRoot().getChildren() as ElementNode[];
  const point = (li: number, o: number): [TextNode, number] | null => {
    const line = lines[li];
    if (line === undefined) {
      return null;
    }
    const texts = line.getAllTextNodes();
    let at = o;
    for (const t of texts) {
      if (
        at < t.getTextContentSize() ||
        (!after && at === t.getTextContentSize())
      ) {
        return [t, at];
      }
      at -= t.getTextContentSize();
    }
    const last = texts[texts.length - 1];
    return last === undefined ? null : [last, last.getTextContentSize()];
  };
  const a = point(range[0], range[1]);
  const b = point(range[2], range[3]);
  if (a === null || b === null) {
    return false;
  }
  const selection = $createRangeSelection();
  selection.anchor.set(a[0].getKey(), a[1], 'text');
  selection.focus.set(b[0].getKey(), b[1], 'text');
  $setSelection(selection);
  return !selection.isCollapsed();
}

type Stats = {
  /** Another peer's step replaced A's composed node or ended its composition. */
  disrupted: number;
  cancelled: number;
  /**
   * Another peer's step moved A's caret while A composed: to another place
   * in the text (its line, or its offset in the line's text), or only to
   * another node at the same place.
   */
  caretMoved: number;
  caretNodeOnly: number;
  /** Another peer's step left A without a caret while A composed. */
  caretLost: number;
  /**
   * Another peer's step detached the DOM text node A composes in (A's
   * editor has a DOM root): the browser's composition would end.
   */
  domDetached: number;
  /** A keystroke that did not land at A's caret (its line and offset). */
  typedElsewhere: number;
  /** Peers that differed only in a paragraph's derived format or style. */
  derivedStyle: number;
  /**
   * A's next local update after another peer's step moved the composition
   * to another node (see the step loop).
   */
  keyMoved: number;
  /** Of those, the moves under a hold (which end it, see the step loop). */
  keyMovedUnderHold: number;
  /** A's own typing detached the DOM text node it composes in (fails). */
  typingDetached: number;
  /** A's own typing replaced the composed node or ended the composition. */
  typingReplaced: number;
  typed: number;
  /** A typing step that found the caret off the composed node. */
  typeNoop: number;
};

async function session(
  seed: number,
  gc: boolean,
  replay: Op[] | null = null,
  recorded: Shape = 'flat',
  recordedPlugins = false,
): Promise<{ops: Op[]; stats: Stats; shape: Shape; plugins: boolean}> {
  const r = rng(seed * 2 + (gc ? 1 : 0));
  const ids = r.chance(0.5) ? [1, 2, 3] : [3, 2, 1];
  const drawn: Shape = r.chance(0.3)
    ? 'nested'
    : r.chance(3 / 7)
      ? 'inline'
      : 'flat';
  const shape: Shape = replay === null ? drawn : recorded;
  // A quarter of the sessions give A an app's plugins that edit the last
  // line in reply to the editor's own updates (see utils/appPlugins), and,
  // in a document of lines of text, an app's selection transform on the
  // second line (see Leaning).
  const drawnPlugins = r.chance(0.25);
  const plugins = replay === null ? drawnPlugins : recordedPlugins;
  const t = await setup(
    () =>
      $getRoot().append(
        $createParagraphNode().append($createTextNode('one two three')),
        $create(SwitchLine).append(
          ...(shape === 'nested'
            ? [
                $create(LegacyInline).append(
                  $create(LegacyInline).append(
                    $createTextNode('four five six'),
                  ),
                ),
              ]
            : shape === 'inline'
              ? [
                  $createTextNode('four '),
                  $create(LegacyInline).append($createTextNode('five')),
                  $createTextNode(' six'),
                ]
              : plugins
                ? // An app's selection transform (see Leaning) on A.
                  [
                    $createTextNode('four '),
                    $create(Leaning).setTextContent('five six'),
                  ]
                : [$createTextNode('four five six')]),
        ),
        $createParagraphNode().append($createTextNode('seven eight')),
      ),
    {
      gc,
      ids,
      nodes: [...NODES, LegacyInline, SwitchLine, Leaning],
      prepare: prepareMarkState,
    },
  );
  const {a, b, c} = t;
  // With the selection transform (Leaning, in a document of lines of
  // text), the update listener alone: an app's selection transform that
  // changes the selection in a remote read makes Lexical dispatch
  // SELECTION_CHANGE_COMMAND and run node transforms inside that read's
  // commit, whose edits are not written, on main too.
  const appPlugins = plugins
    ? registerAppPlugins(
        a.editor,
        4,
        shape === 'flat' ? ['update'] : ['selection', 'update', 'transform'],
      )
    : null;
  if (NO_PREDICT) {
    // A missed prediction everywhere (see YBinding#predicts): the safety
    // net alone.
    (a.binding as unknown as {predicts: boolean}).predicts = false;
  }
  const peer = (who: Who): Peer => (who === 'A' ? a : who === 'B' ? b : c);
  const ops: Op[] = [];
  const stats: Stats = {
    cancelled: 0,
    caretLost: 0,
    caretMoved: 0,
    caretNodeOnly: 0,
    derivedStyle: 0,
    disrupted: 0,
    domDetached: 0,
    keyMoved: 0,
    keyMovedUnderHold: 0,
    typeNoop: 0,
    typed: 0,
    typedElsewhere: 0,
    typingDetached: 0,
    typingReplaced: 0,
  };
  const apps = new Map<Peer, Y.UndoManager>();
  for (const p of [b, c]) {
    apps.set(
      p,
      new Y.UndoManager(p.doc.get('lexical-y'), {
        captureTimeout: 0,
        trackedOrigins: new Set([RAW]),
      }),
    );
  }
  let comp: {key: string} | null = null;
  // A's editor renders into a DOM root: the text node a composition runs
  // in is the browser's, and a read that replaces it ends the composition.
  // The root has the focus, as an editor composing does (Lexical writes the
  // DOM selection of a remote read only then).
  const host = document.createElement('div');
  host.contentEditable = 'true';
  document.body.append(host);
  if (process.env.CH_NODOM !== '1') {
    a.editor.setRootElement(host);
    host.focus();
  }
  let domText: Node | null = null;
  const domOf = (key: string): Node | null => {
    const element = a.editor.getElementByKey(key);
    return element === null ? null : element.firstChild;
  };
  const where = (step: number) =>
    `seed ${seed} gc ${gc} step ${step} ${ops.map(describeOp).join(' | ')}`;
  const check = (step: number) => {
    for (const p of t.peers) {
      // The text format and style a paragraph derives from A's DOM
      // selection are not stored (see converge): a self-check of them
      // alone is that class, counted.
      const derived = (w: string) =>
        /self-check(?: \(remote\))?: container root\[\d+\]\.text(Format|Style):/.test(
          w,
        );
      if (p.warnings.some(derived)) {
        stats.derivedStyle++;
        p.warnings = p.warnings.filter(w => !derived(w));
      }
      const warned = p.warnings.filter(w => w.includes('self-check'));
      if (warned.length > 0) {
        throw new Error(
          `${where(step)}: ${p === a ? 'A' : p === b ? 'B' : 'C'} warned ${warned[0]}`,
        );
      }
    }
  };
  /**
   * With A's plugins: the edits they make in reply to the last updates, each
   * of which can bring another, synced until none comes (two rounds in a
   * row with nothing new on any peer).
   */
  const settle = async () => {
    let quiet = 0;
    for (
      let round = 0;
      appPlugins !== null && round < 40 && quiet < 2;
      round++
    ) {
      const was = t.peers.map(p => p.describe()).join('\n');
      await new Promise(resolve => setTimeout(resolve, 0));
      await t.sync();
      quiet = t.peers.map(p => p.describe()).join('\n') === was ? quiet + 1 : 0;
    }
  };
  /**
   * Every peer reads the same, and as a fresh read of its document does.
   * The text format and style a paragraph derives from A's DOM selection
   * (Lexical sets them on elements while A's editor has a DOM root) are
   * left out where they are all that differs: they depend on the editor's
   * reconcile history, on main too.
   */
  const converge = async () => {
    await settle();
    try {
      await expectConverged(t.peers);
    } catch (error) {
      const strip = (json: unknown) =>
        JSON.stringify(json, (k, v) =>
          k === 'textStyle' || k === 'textFormat' ? undefined : v,
        );
      const first = strip(t.peers[0].json());
      const fresh = await freshReader(t.peers[0]);
      const same =
        t.peers.every(
          p =>
            p.errors.length === 0 &&
            !p.warnings.some(
              w => w.includes('self-check') || w.includes('could not be'),
            ) &&
            p.describe() === t.peers[0].describe() &&
            strip(p.json()) === first,
        ) &&
        fresh.describe() === t.peers[0].describe() &&
        strip(fresh.json()) === first;
      if (!same) {
        throw error;
      }
      stats.derivedStyle++;
    }
  };

  /**
   * Peers left with Yjs structs that wait for others after a full sync: a
   * Yjs 14 rc.29 class (yjs#824, fixed by yjs#827) in which that peer lacks
   * updates it has received. Labeled, so that it is not taken for the
   * binding's.
   */
  const checkPending = (step: number) => {
    const waiting = t.peers.filter(
      p =>
        (p.doc as unknown as {store: {pendingStructs: unknown}}).store
          .pendingStructs !== null,
    );
    if (waiting.length > 0) {
      throw new Error(
        `${where(step)}: pending structs after a full sync (yjs#824) on ${waiting
          .map(p => (p === a ? 'A' : p === b ? 'B' : 'C'))
          .join(', ')}`,
      );
    }
  };
  /**
   * Follow A's composition through what the step did to it: a step of
   * another peer's that replaced the composed text node, or ended the
   * composition, disrupted it (A's own Enter moves it, as an IME would).
   */
  let caret = ['', ''];
  let caretEvent = false;
  /** A's caret: its node and offset, and its line and offset in its text. */
  const caretOf = () =>
    a.read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        return ['', ''];
      }
      const node = selection.anchor.getNode();
      const line = node.getTopLevelElement();
      let at = selection.anchor.offset;
      if ($isTextNode(node) && line !== null) {
        for (const text of line.getAllTextNodes()) {
          if (text.is(node)) {
            break;
          }
          at += text.getTextContentSize();
        }
      }
      return [
        `${selection.anchor.key}:${selection.anchor.offset}`,
        `${line === null ? -1 : line.getIndexWithinParent()}:${at}`,
      ];
    });
  const followComposition = (kind: 'own' | 'typing' | 'remote') => {
    if (comp === null) {
      return;
    }
    // A's Enter, its composition's start and end move or end the
    // composition themselves; its typing moves the caret.
    const own = kind !== 'remote';
    const now0 = caretOf();
    if (!own && now0[1] !== caret[1]) {
      caretEvent = true;
      if (now0[1] === '') {
        stats.caretLost++;
      } else {
        stats.caretMoved++;
      }
      if (process.env.CH_CARET) {
        // eslint-disable-next-line no-console
        console.log(
          `CARET ${seed} ${gc} step ${ops.length - 1} ${caret[1]} -> ${now0[1]}`,
        );
      }
    } else if (!own && now0[0] !== caret[0]) {
      stats.caretNodeOnly++;
    }
    caret = now0;
    if (kind === 'typing' && domText !== null && !domText.isConnected) {
      // A's own typing in the node it composes in keeps it (as on main).
      stats.typingDetached++;
      throw new Error(
        `${where(ops.length - 1)}: A's typing detached the DOM text node it composes in`,
      );
    }
    if (!own && domText !== null && !domText.isConnected) {
      stats.domDetached++;
      caretEvent = true;
      if (process.env.CH_CARET) {
        // eslint-disable-next-line no-console
        console.log(
          `DOMDETACH ${seed} ${gc} step ${ops.length - 1} ${describeOp(ops[ops.length - 1])}`,
        );
      }
    }
    const now = a.editor._compositionKey;
    const attached = a.read(() => {
      const n = $getNodeByKey(comp!.key);
      return n !== null && n.isAttached();
    });
    if (now === comp.key && attached) {
      domText = domOf(comp.key);
      return;
    }
    if (kind === 'typing') {
      stats.typingReplaced++;
    }
    if (!own) {
      stats.disrupted++;
    }
    if (now === null) {
      if (!own) {
        stats.cancelled++;
      }
      comp = null;
      domText = null;
    } else {
      comp = {key: now};
      domText = domOf(now);
    }
  };

  /** A random action, as an Op. */
  const pick = (): Op => {
    const roll = r.next();
    if (roll < 0.35 && !NO_COMPOSE) {
      if (comp === null) {
        const lines = a.read(() =>
          $getRoot()
            .getChildren()
            .map(l => l.getTextContentSize()),
        );
        const line = r.int(0, lines.length - 1);
        const off = r.int(0, lines[line]);
        const start: Op = r.chance(0.5)
          ? {after: true, k: 'start', line, off}
          : {k: 'start', line, off};
        return r.chance(0.25) ? {...start, focusEnd: true} : start;
      }
      const what = r.pick(['type', 'type', 'enter', 'enter end', 'end']);
      return what === 'type'
        ? {ch: r.pick(['x', 'y', 'z', ' ']), k: 'type'}
        : {k: what as 'enter' | 'enter end' | 'end'};
    }
    if (roll < 0.85) {
      const who: Who = r.chance(0.5) ? 'B' : 'C';
      const p = peer(who);
      const what = r.pick([
        'bold',
        'italic',
        'link',
        'unlink',
        'color',
        'comment',
        'uncomment',
        'raw',
        'raw end',
        'delete one',
        'delete opener',
        'delete end',
        'delete key',
        'undo',
        'redo',
        'app undo',
        'app redo',
        'flip',
      ]);
      if (what === 'flip') {
        return {k: 'flip', who};
      }
      if (
        what === 'undo' ||
        what === 'redo' ||
        what === 'app undo' ||
        what === 'app redo'
      ) {
        return {k: what, who};
      }
      // With an inline container, a raw writer writes in the one that holds
      // text half the time.
      const box: Box | undefined =
        (what === 'raw' || what === 'raw end' || what.startsWith('delete')) &&
        shape !== 'flat' &&
        r.chance(0.5)
          ? 'inner'
          : undefined;
      const inBox = box === undefined ? {} : {box};
      if (what === 'raw') {
        const len = rootLength(p, box);
        const at = r.int(0, Math.max(0, len - 2));
        return {
          at,
          k: 'raw',
          n: r.int(1, Math.max(1, Math.min(12, len - at))),
          value: r.chance(0.6),
          who,
          ...inBox,
        };
      }
      if (what === 'raw end') {
        return {
          at: r.int(0, Math.max(0, rootLength(p, box) - 1)),
          k: 'rawEnd',
          key: r.pick(KEYS),
          target: r.int(0, rootLength(p, box)),
          who,
          ...inBox,
        };
      }
      if (what.startsWith('delete')) {
        return {
          k: 'del',
          key: r.pick(KEYS),
          mode: what.slice(7) as 'one' | 'opener' | 'end' | 'key',
          pos: r.int(0, rootLength(p, box)),
          who,
          ...inBox,
        };
      }
      const range = p.read((): Range => {
        const lines = $getRoot()
          .getChildren()
          .map(l => l.getTextContentSize());
        const l0 = r.int(0, lines.length - 1);
        const l1 = r.chance(0.3) && l0 + 1 < lines.length ? l0 + 1 : l0;
        let o0 = r.int(0, lines[l0]);
        let o1 = r.int(0, lines[l1]);
        if (l0 === l1 && o1 < o0) {
          [o0, o1] = [o1, o0];
        }
        return [l0, o0, l1, o1];
      });
      const value =
        what === 'link'
          ? r.pick(['https://l.test/1', 'https://l.test/2'])
          : what === 'color'
            ? r.pick(['red', 'blue'])
            : r.pick(['c1', 'c2']);
      return {k: 'fmt', range, value, what: what as Format, who};
    }
    if (r.chance(0.5)) {
      return {k: 'sync'};
    }
    const who = r.pick(['A', 'B', 'C'] as const);
    return {k: 'online', on: !peer(who).online, who};
  };

  const exec = async (op: Op) => {
    if (op.k === 'start') {
      if (comp !== null) {
        return;
      }
      // The caret first (Lexical normalizes it at a boundary, as it does
      // before a browser's composition starts), then the composition at it.
      a.update(() => {
        $selectRange([op.line, op.off, op.line, op.off], op.after === true);
        const selection = $getSelection();
        const line = $getRoot().getChildAtIndex(op.line);
        if (
          op.focusEnd === true &&
          $isRangeSelection(selection) &&
          line instanceof ElementNode
        ) {
          selection.focus.set(line.getKey(), line.getChildrenSize(), 'element');
        }
      });
      a.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          const n = selection.anchor.getNode();
          if ($isTextNode(n)) {
            $setCompositionKey(n.getKey());
            comp = {key: n.getKey()};
          }
        }
      });
    } else if (op.k === 'type') {
      if (comp === null) {
        return;
      }
      const target = comp.key;
      let typed = false;
      const before = caretOf()[1];
      // Whether A types where it composes: the composition's node, attached,
      // with the caret in it.
      const valid =
        a.editor._compositionKey === target &&
        a.read(() => {
          const n = $getNodeByKey(target);
          const selection = $getSelection();
          return (
            $isTextNode(n) &&
            n.isAttached() &&
            $isRangeSelection(selection) &&
            selection.anchor.key === target
          );
        });
      a.update(() => {
        const n = $getNodeByKey(target);
        const selection = $getSelection();
        if (
          $isTextNode(n) &&
          n.isAttached() &&
          $isRangeSelection(selection) &&
          selection.anchor.key === n.getKey()
        ) {
          const at = selection.anchor.offset;
          const text = n.getTextContent();
          n.setTextContent(text.slice(0, at) + op.ch + text.slice(at));
          n.select(at + 1, at + 1);
          typed = true;
        }
      });
      if (typed) {
        stats.typed++;
        const [line, offset] = before.split(':').map(Number);
        const landed = a.read(
          () =>
            ($getRoot().getChildren()[line]?.getTextContent() ?? '')[offset],
        );
        if (landed !== op.ch || caretOf()[1] !== `${line}:${offset + 1}`) {
          stats.typedElsewhere++;
        }
      } else if (valid) {
        // Its update moved the composition off its node (Lexical's
        // selection normalization at a boundary, see keyMoved).
        throw new Error(
          `${where(ops.length - 1)}: A's typing lost its target (composition moved to ${String(a.editor._compositionKey)})`,
        );
      } else {
        // Not where A composes any more: a read moved the caret, or replaced
        // the composed node (see followComposition).
        stats.typeNoop++;
      }
    } else if (op.k === 'enter' || op.k === 'enter end' || op.k === 'end') {
      if (comp === null) {
        return;
      }
      if (op.k !== 'end') {
        a.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertParagraph();
          }
        });
      }
      if (op.k !== 'enter') {
        a.update(() => $setCompositionKey(null));
        comp = null;
      }
    } else if (op.k === 'sync') {
      await t.sync();
      await settle();
    } else if (op.k === 'online') {
      peer(op.who).online = op.on;
    } else {
      await format(op);
    }
  };

  /** B's or C's formatting: the text and its ids stay. */
  const format = async (
    op: Exclude<
      Op,
      {k: 'start' | 'type' | 'enter' | 'enter end' | 'end' | 'sync' | 'online'}
    >,
  ) => {
    const p = peer(op.who);
    const skip = appPlugins === null ? null : a.doc.clientID;
    const before = textIds(p, skip);
    if (op.k === 'flip') {
      p.update(() => {
        const line = $getRoot().getChildAtIndex(1);
        if (line instanceof ElementNode) {
          const now = !$getState(line, shut);
          $setState(line, shut, now);
          for (const n of line.getChildren()) {
            if (n instanceof LegacyInline) {
              $setState(n, shut, now);
            }
          }
        }
        $setSelection(null);
      });
    } else if (op.k === 'undo') {
      p.binding.undo();
    } else if (op.k === 'redo') {
      p.binding.redo();
    } else if (op.k === 'app undo') {
      apps.get(p)!.undo();
    } else if (op.k === 'app redo') {
      apps.get(p)!.redo();
    } else if (op.k === 'raw') {
      const root = boxOf(p, op.box) as unknown as {
        format(at: number, length: number, attrs: object): void;
      };
      const len = rootLength(p, op.box);
      const at = Math.min(op.at, Math.max(0, len - 1));
      const n = Math.min(op.n, len - at);
      if (n > 0) {
        p.doc.transact(
          () => root.format(at, n, {'f:bold': op.value ? true : null}),
          RAW,
        );
      }
    } else if (op.k === 'rawEnd') {
      const items = rootItems(p, op.box);
      const openers = items.filter(
        ({it}) =>
          !it.deleted &&
          it.content instanceof Y.ContentFormat &&
          it.content.key === op.key &&
          (it.content as Y.ContentFormat).value !== null &&
          !isEnd(it),
      );
      if (openers.length > 0) {
        const target = openers.reduce((x, y) =>
          Math.abs(y.pos - op.target) < Math.abs(x.pos - op.target) ? y : x,
        ).it;
        const root = boxOf(p, op.box) as unknown as {
          format(at: number, length: number, attrs: object): void;
        };
        const len = rootLength(p, op.box);
        const at = Math.min(op.at, Math.max(0, len - 1));
        if (len - at > 0) {
          // A layout 2 document has no ends: there the writer closes.
          const paired = p.doc.get('lexical-y').getAttr('lexical-y:3') === true;
          p.doc.transact(
            () =>
              root.format(at, 1, {
                [op.key]: paired ? [target.id.client, target.id.clock] : null,
              }),
            RAW,
          );
        }
      }
    } else if (op.k === 'del') {
      const items = rootItems(p, op.box).filter(
        ({it}) =>
          !it.deleted &&
          it.content instanceof Y.ContentFormat &&
          it.content.key === op.key &&
          (op.mode === 'opener'
            ? !isEnd(it) && (it.content as Y.ContentFormat).value !== null
            : op.mode === 'end'
              ? isEnd(it) || (it.content as Y.ContentFormat).value === null
              : true),
      );
      if (items.length > 0) {
        const best = Math.min(...items.map(x => Math.abs(x.pos - op.pos)));
        const nearest = items.filter(x => Math.abs(x.pos - op.pos) === best);
        const doomed =
          op.mode === 'key'
            ? items.map(x => x.it)
            : [nearest[Math.min(op.rank ?? 0, nearest.length - 1)].it];
        p.doc.transact(tr => doomed.forEach(it => it.delete(tr)), RAW);
      }
    } else {
      p.update(() => {
        if (!$selectRange(op.range)) {
          $setSelection(null);
          return;
        }
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return;
        }
        if (op.what === 'bold' || op.what === 'italic') {
          selection.formatText(op.what);
        } else if (op.what === 'link') {
          $toggleLink(op.value);
        } else if (op.what === 'unlink') {
          $toggleLink(null);
        } else if (op.what === 'color') {
          $patchStyleText(selection, {color: op.value});
        } else if (op.what === 'comment') {
          $addMarkID(op.value, selection);
        } else {
          $removeMarkID(op.value);
        }
        $setSelection(null);
      });
    }
    const after = textIds(p, skip);
    if (after !== before) {
      throw new Error(
        `${where(ops.length)}: ${op.who}'s formatting changed its text\n  ${before}\n  ${after}`,
      );
    }
  };

  const steps = replay ?? null;
  try {
    for (let step = 0; step < (steps === null ? OPS : steps.length); step++) {
      const op = steps === null ? pick() : steps[step];
      ops.push(op);
      await exec(op);
      // A's next local update after another peer's step: one that moves the
      // composition to another node (Lexical's selection normalization, at a
      // boundary the step left at the caret) is that step's doing.
      if (comp !== null && !isOwn(op)) {
        const keyBefore = a.editor._compositionKey;
        const held = holdOf(a) !== null;
        a.update(() => {});
        if (a.editor._compositionKey !== keyBefore) {
          stats.keyMoved++;
          if (held) {
            // A move the binding did not foresee (see YBinding#predicts):
            // the hold ends at once, and A shows what is stored (a binding
            // with that safety net; main has none).
            stats.keyMovedUnderHold++;
          }
          if (held && 'predicts' in a.binding) {
            await Promise.resolve();
            const stored = await freshReader(a);
            if (holdOf(a) !== null || shownOf(stored) !== shownOf(a)) {
              throw new Error(
                `${where(ops.length - 1)}: the composition moved under the hold, and A ${holdOf(a) !== null ? 'still holds' : `shows ${a.describe()}, stored ${stored.describe()}`}`,
              );
            }
          }
          caretEvent = true;
          if (process.env.CH_CARET) {
            // eslint-disable-next-line no-console
            console.log(
              `KEYMOVED ${seed} ${gc} step ${ops.length - 1} ${describeOp(op)}`,
            );
          }
        }
      }
      followComposition(
        op.k === 'type'
          ? 'typing'
          : op.k === 'start' ||
              op.k === 'enter' ||
              op.k === 'enter end' ||
              op.k === 'end'
            ? 'own'
            : 'remote',
      );
      check(step);
      if (comp === null && op.k === 'sync') {
        checkPending(step);
        await converge();
        expect((await freshReader(a)).describe()).toBe(a.describe());
      }
    }
    if (comp !== null) {
      a.update(() => $setCompositionKey(null));
    }
    await t.sync();
    check(ops.length);
    checkPending(ops.length);
    await converge();
    expect((await freshReader(a)).describe()).toBe(a.describe());
  } catch (error) {
    a.editor.setRootElement(null);
    host.remove();
    if (process.env.CH_DUMP) {
      fs.mkdirSync(process.env.CH_DUMP, {recursive: true});
      fs.writeFileSync(
        `${process.env.CH_DUMP}/${seed}-${gc ? 1 : 0}.json`,
        JSON.stringify({
          error: String(error).slice(-600),
          gc,
          ops,
          seed,
          shape,
          ...(plugins ? {plugins} : {}),
        }),
      );
    }
    throw error;
  }
  if (process.env.CH_RECORD) {
    // Every session's actions, to replay on another tree (paired counts).
    fs.mkdirSync(process.env.CH_RECORD, {recursive: true});
    fs.writeFileSync(
      `${process.env.CH_RECORD}/${seed}-${gc ? 1 : 0}.json`,
      JSON.stringify({gc, ops, seed, shape, ...(plugins ? {plugins} : {})}),
    );
  }
  if (process.env.CH_DUMP && caretEvent) {
    fs.mkdirSync(process.env.CH_DUMP, {recursive: true});
    fs.writeFileSync(
      `${process.env.CH_DUMP}/caret-${seed}-${gc ? 1 : 0}.json`,
      JSON.stringify({gc, ops, seed, shape, ...(plugins ? {plugins} : {})}),
    );
  }
  for (const app of apps.values()) {
    app.destroy();
  }
  appPlugins?.dispose();
  a.editor.setRootElement(null);
  host.remove();
  for (const p of t.peers) {
    p.stop();
  }
  return {ops, plugins, shape, stats};
}

async function run(
  seed: number,
  gc: boolean,
  replay: Op[] | null = null,
  shape: Shape = 'flat',
  plugins = false,
) {
  const {stats} = await session(seed, gc, replay, shape, plugins);
  if (process.env.CH_STATS) {
    // eslint-disable-next-line no-console
    console.log(`CHSTATS ${seed} ${gc} ${JSON.stringify(stats)}`);
  }
}

// Sessions that failed once (their recorded actions), run on every run:
// - 558: the binding read the composed line again after A's own typing (a
//   write it could not store as the editor holds it), in an update Lexical
//   ran after A's, outside the binding's view: the run the hold kept read
//   without its kept end, and A's next write warned `format f:italic`.
// - 7644, 7799: a value a raw writer inserted in the composed line, under a
//   run the hold kept there, reached past the line in the document but not
//   in the hold's view: the next line showed it, the composed line handed on
//   no such format, and A's next write warned `format s:markIds␟c1` and
//   `format f:bold`.
const FOUND: {seed: number; gc: boolean; ops: Op[]}[] = [
  {
    gc: true,
    ops: [
      {k: 'online', on: false, who: 'B'},
      {at: 24, k: 'raw', n: 6, value: true, who: 'C'},
      {k: 'start', line: 2, off: 2},
      {at: 20, k: 'raw', n: 6, value: false, who: 'C'},
      {k: 'fmt', range: [2, 9, 2, 11], value: 'c1', what: 'comment', who: 'B'},
      {
        k: 'del',
        key: 's:markIds\u001fc1',
        mode: 'key',
        pos: 39,
        rank: 0,
        who: 'B',
      },
      {at: 9, k: 'raw', n: 3, value: true, who: 'C'},
      {k: 'sync'},
      {k: 'fmt', range: [1, 13, 1, 9], value: '', what: 'italic', who: 'C'},
      {at: 10, k: 'raw', n: 8, value: true, who: 'B'},
      {k: 'enter'},
      {k: 'fmt', range: [0, 2, 1, 12], value: '', what: 'italic', who: 'C'},
      {k: 'end'},
      {k: 'start', line: 1, off: 12},
      {k: 'end'},
      {k: 'fmt', range: [1, 5, 1, 13], value: '', what: 'bold', who: 'B'},
      {k: 'start', line: 1, off: 8},
      {k: 'fmt', range: [3, 4, 3, 7], value: '', what: 'unlink', who: 'B'},
      {k: 'app redo', who: 'B'},
      {k: 'sync'},
      {k: 'del', key: 'f:italic', mode: 'key', pos: 14, rank: 0, who: 'C'},
      {k: 'del', key: 'f:bold', mode: 'key', pos: 31, rank: 0, who: 'C'},
      {k: 'online', on: false, who: 'A'},
      {k: 'app undo', who: 'B'},
      {at: 30, k: 'raw', n: 2, value: true, who: 'C'},
      {k: 'del', key: 'f:bold', mode: 'key', pos: 30, rank: 0, who: 'C'},
      {ch: 'x', k: 'type'},
      {k: 'fmt', range: [2, 1, 3, 9], value: 'blue', what: 'color', who: 'C'},
    ],
    seed: 558,
  },
  {
    gc: true,
    ops: [
      {k: 'undo', who: 'B'},
      {k: 'sync'},
      {k: 'fmt', range: [2, 3, 2, 10], value: 'c1', what: 'comment', who: 'C'},
      {k: 'app redo', who: 'B'},
      {k: 'fmt', range: [1, 9, 2, 0], value: '', what: 'italic', who: 'B'},
      {k: 'start', line: 0, off: 4},
      {k: 'app undo', who: 'B'},
      {k: 'online', on: false, who: 'A'},
      {k: 'fmt', range: [2, 0, 2, 6], value: 'c1', what: 'comment', who: 'C'},
      {k: 'enter'},
      {
        k: 'del',
        key: 's:markIds\u001fc1',
        mode: 'key',
        pos: 31,
        rank: 1,
        who: 'B',
      },
      {k: 'online', on: true, who: 'A'},
      {k: 'enter end'},
      {k: 'start', line: 3, off: 5},
      {k: 'app undo', who: 'C'},
      {k: 'fmt', range: [1, 11, 2, 6], value: 'blue', what: 'color', who: 'C'},
      {k: 'undo', who: 'B'},
      {ch: 'y', k: 'type'},
      {k: 'fmt', range: [1, 13, 2, 8], value: 'blue', what: 'color', who: 'C'},
      {k: 'fmt', range: [1, 12, 1, 14], value: '', what: 'italic', who: 'B'},
      {k: 'fmt', range: [2, 7, 2, 8], value: 'c1', what: 'comment', who: 'C'},
      {
        k: 'fmt',
        range: [0, 3, 0, 7],
        value: 'https://l.test/2',
        what: 'link',
        who: 'C',
      },
      {k: 'fmt', range: [2, 9, 2, 8], value: '', what: 'unlink', who: 'C'},
      {k: 'enter end'},
      {k: 'start', line: 5, off: 3},
      {k: 'redo', who: 'C'},
      {k: 'fmt', range: [2, 0, 3, 11], value: '', what: 'italic', who: 'B'},
      {k: 'fmt', range: [2, 6, 2, 3], value: '', what: 'bold', who: 'C'},
      {k: 'sync'},
    ],
    seed: 7644,
  },
  {
    gc: true,
    ops: [
      {k: 'start', line: 0, off: 2},
      {k: 'enter'},
      {k: 'enter end'},
      {k: 'online', on: false, who: 'B'},
      {k: 'fmt', range: [3, 0, 3, 6], value: 'c2', what: 'uncomment', who: 'B'},
      {k: 'fmt', range: [2, 2, 2, 11], value: '', what: 'bold', who: 'C'},
      {k: 'start', line: 2, off: 10},
      {k: 'app redo', who: 'B'},
      {k: 'fmt', range: [3, 7, 4, 1], value: '', what: 'bold', who: 'B'},
      {ch: ' ', k: 'type'},
      {k: 'fmt', range: [4, 5, 4, 8], value: 'c2', what: 'uncomment', who: 'C'},
      {k: 'redo', who: 'B'},
      {k: 'del', key: 'f:bold', mode: 'key', pos: 6, rank: 0, who: 'C'},
      {at: 13, k: 'raw', n: 7, value: true, who: 'C'},
      {k: 'enter end'},
    ],
    seed: 7799,
  },
];

if (process.env.CH_REPLAY_DIR) {
  // Every recorded session in a directory (CH_RECORD), a shard of them with
  // CH_SHARD=k/n: paired counts against the tree that recorded them.
  const dir = process.env.CH_REPLAY_DIR;
  const [k, n] = (process.env.CH_SHARD ?? '0/1').split('/').map(Number);
  const files = fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .filter((_, i) => i % n === k);
  for (const file of files) {
    test(`composer's hold against remote formatting: replay of ${file}`, async () => {
      const {seed, gc, ops, shape, plugins} = JSON.parse(
        fs.readFileSync(`${dir}/${file}`, 'utf8'),
      ) as {
        seed: number;
        gc: boolean;
        ops: Op[];
        shape?: Shape;
        plugins?: boolean;
      };
      await run(seed, gc, ops, shape, plugins);
    });
  }
} else if (process.env.CH_REPLAY) {
  const {seed, gc, ops, shape, plugins} = JSON.parse(
    fs.readFileSync(process.env.CH_REPLAY, 'utf8'),
  ) as {
    seed: number;
    gc: boolean;
    ops: Op[];
    shape?: Shape;
    plugins?: boolean;
  };
  test(`composer's hold against remote formatting: replay of seed ${seed} (gc ${gc})`, async () => {
    await run(seed, gc, ops, shape, plugins);
  });
} else {
  for (const {seed, gc, ops} of FOUND) {
    test(`composer's hold against remote formatting: found session ${seed} (gc ${gc})`, async () => {
      await run(seed, gc, ops);
    });
  }
  for (const gc of GCS) {
    for (let seed = START; seed < START + SEEDS; seed++) {
      test(`composer's hold against remote formatting: seed ${seed} (gc ${gc})`, async () => {
        await run(seed, gc);
      });
    }
  }
}
