/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {blockIdState} from '@lexical/extension';
import invariant from '@lexical/internal/invariant';
import {
  ContentFormat,
  ContentString,
  ContentType,
  type Item,
  type Node as YNode,
} from '@y/y';
import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getNodeByKey,
  $getSelection,
  $getWritableNodeState,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $parseSerializedNode,
  $setSelection,
  type ElementNode,
  type Klass,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type TextNode,
} from 'lexical';

import {$appendAll, spliceAll} from './Arrays';
import {$innerBlockIdsOf, BlockIdSettler, NO_IDS} from './BlockIds';
import {type Formats} from './Cursor';
import {groupKeySig, groupSig} from './Groups';
import {Hidden} from './Hidden';
import {
  $foreignFlatKeys,
  $groupFields,
  $isGroupNode,
  $isWrapper,
  $levelItemFields,
  $lineAttrs,
  $lineBreakAttrs,
  $nodeAttrs,
  $schemaJSON,
  $setTextFields,
  $textAttrs,
  $wrapperAttrs,
  type Attrs,
  BLOCK_PREFIX,
  decodeFormatValue,
  eachOuterLevel,
  FIELD_PREFIX,
  fieldsOfTypes,
  getContainerGroupSpec,
  getGroupSpec,
  getLineSpec,
  getWrapperSpec,
  GROUP_FIELD_PREFIX,
  GROUP_KEY,
  groupItemFields,
  type GroupSpec,
  hasOwn,
  INLINE_PREFIX,
  isUnsafeKey,
  joinSetMembers,
  joinSetMembersInJSON,
  KIND_KEY,
  klassOf,
  learnedSetKeys,
  LEVEL_KEY,
  lineBreakStateFromAttrs,
  MARKER,
  nodeJSONFromAttrs,
  OUTER_KEY,
  type OwnedFields,
  ownedFields,
  ownedFieldsOf,
  ownsMarkerAttr,
  ownsNodeAttr,
  SEGMENT_KEY,
  stableStringify,
  STATE_PREFIX,
  storedTypeOf,
  textJSONFromAttrs,
  TYPE_KEY,
  withoutUnownedMembers,
  WRAPPER_FIELDS_KEY,
  WRAPPER_PREFIX,
  wrapperFieldsOf,
  wrappersFromAttrs,
  type WrapperValue,
} from './Schema';
import {
  isGone,
  isHeld,
  isShown,
  isShownEnd,
  prevLiveEnd,
  shownAttrs,
  shownText,
} from './Seen';
import {$holds, $readSlots, $replaceStored, SLOT_PREFIX} from './Slots';
import {
  type CS,
  EMPTY_FORMATS,
  isEndItem,
  type Kind,
  nameOf,
  type State,
  typeOf,
  type Unit,
  type UnitKind,
} from './State';

// Reader: Yjs to the editor. It reads whole containers ($readFull) and the
// changes of remote transactions ($apply) into Lexical nodes, reusing the
// nodes a read can keep (lines, groups, wrappers), so that keys, the
// selection and an IME composition survive it. Block ids it reads go through
// BlockIdSettler (see BlockIds.ts).
//
// Invariant: a read shows what is stored, as a fresh reader of the document
// does, whatever shape concurrent edits left (text without a marker, an item
// outside its group, a line of another type in a list stored as a node).
// Why: every client converges on the document, not on its own history.
//
// Invariant: a read writes nothing. Why: only users' own edits write. A shape
// the editor cannot hold as stored is projected the same way on every reader
// (text without a marker reads as a paragraph, an item outside a group in its
// class's group), and stored by the next write of that content.

type Parsed = {
  kind: UnitKind;
  end: Item | null;
  startItem: Item | null;
  stop: Item | null;
  start: Formats;
};

type Piece = (
  | {
      kind: 'text';
      text: string;
      tattrs: Attrs;
      tsig: string;
      wrappers: WrapperValue[];
      /**
       * Where in its text the composition's character is (see composedAt),
       * when it holds it.
       */
      caretAt?: number;
      /** This text is the node being composed (see $readInline). */
      composed?: boolean;
    }
  | {kind: 'br'; tattrs: Attrs; wrappers: WrapperValue[]}
  | {kind: 'node'; y: YNode; wrappers: WrapperValue[]}
) & {
  /** The first item it was read from (see $inShadowRoot). */
  readonly item: Item;
};

type GroupItem = {
  node: ElementNode;
  /**
   * The id a group whose first item this is gets when its items store none
   * (see derivedBlockId), or null.
   */
  derivedId: string | null;
  level: number;
  gtype: string;
  gkey: Attrs;
  gsig: string;
  spec: GroupSpec;
  /** The group key at each level 0..level (null: not recorded). */
  keys: (Attrs | null)[];
  /** The fields of the wrapper item at each outer level (null: none). */
  wrappers: (Attrs | null)[];
};

type Pool = {
  groups: Map<string, ElementNode[]>;
  levels: ElementNode[];
  /** The keys of the wrappers in `levels` not taken yet. */
  levelKeys: Set<NodeKey>;
  /** Nodes that are lines of this read: never reused as wrappers. */
  lines: Set<NodeKey>;
};

/**
 * Parse the units of a block container between two items, as the editor
 * shows them: held-back content and end items (see Hidden) are not there.
 * The formats each unit starts with are the stored ones, held-back formats
 * too (only the line being composed is held, by its reads, see $pieces).
 */
function parseRange(
  start: Item | null,
  stop: Item | null,
  formats: Formats,
  hidden: Hidden | null,
): {parsed: Parsed[]; after: Formats} {
  const parsed: Parsed[] = [];
  const current = new Map(formats);
  let unitStart = start;
  let unitFormats = new Map(current);
  let pending = false;
  for (let it = start; it !== null && it !== stop; it = it.right) {
    if (it.deleted) {
      continue;
    }
    const content = it.content;
    if (content instanceof ContentFormat) {
      if (content.value === null) {
        current.delete(content.key);
      } else {
        current.set(content.key, content.value);
      }
      continue;
    }
    if (!it.countable || isHeld(it, hidden)) {
      continue;
    }
    if (isEndItem(it)) {
      const name = nameOf(it);
      if (name.startsWith(BLOCK_PREFIX)) {
        if (pending) {
          parsed.push({
            end: null,
            kind: 'implicit',
            start: unitFormats,
            startItem: unitStart,
            stop: it,
          });
        }
        parsed.push({
          end: it,
          kind: 'node',
          start: unitFormats,
          startItem: it,
          stop: it.right,
        });
      } else {
        parsed.push({
          end: it,
          kind: name === MARKER ? 'line' : 'run',
          start: unitFormats,
          startItem: unitStart,
          stop: it,
        });
      }
      unitStart = it.right;
      unitFormats = new Map(current);
      pending = false;
    } else {
      pending = true;
    }
  }
  if (pending) {
    parsed.push({
      end: null,
      kind: 'implicit',
      start: unitFormats,
      startItem: unitStart,
      stop,
    });
  }
  return {after: current, parsed};
}

/** Whether UTF-16 code unit `c` is the second half of a surrogate pair. */
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

export class Reader {
  /**
   * The fields this editor owns in the value of a format wrapper (see
   * wrapperFieldsOf), or null where it does not store the type as one. A
   * type it does not register is an unknown type (see State#unknownTypes).
   */
  private readonly wrapperFields: (type: string) => OwnedFields | null;
  /**
   * Stored elements (a mark, an overflow) whose children this read set (see
   * $settleWrapperTextFields).
   */
  private readonly childrenSet = new Set<NodeKey>();
  /** Item -> unit cache for one read. */
  private located = new Map<Item, Unit | null>();
  /** Inline owners already read from the current document without a hold. */
  private readonly consumed = new Set<NodeKey>();
  /** Formats in effect after the content last read by $pieces. */
  private lastFormats: Formats = EMPTY_FORMATS;
  readonly fresh = new Set<YNode>();
  /**
   * Nesting of entry points (see BlockIdSettler#$settleIds, run by the
   * outermost).
   */
  private depth = 0;
  /**
   * The nodes this read took out of where the editor held them (see
   * $checkTakenOut).
   */
  private readonly takenOut = new Set<NodeKey>();
  /**
   * The lines of the containers this read read in full (see $readFullInner
   * and $checkTakenOut).
   */
  private readonly linesTakenOut = new Set<NodeKey>();
  /**
   * The stored inline elements this read leaves out on purpose: emptied,
   * and unable to be empty (see $readInline). Their Y.Node is still held, and
   * they are no loss (see $checkTakenOut).
   */
  private readonly leftOut = new Set<NodeKey>();
  /**
   * The line or inline container the local editor is composing in (set by
   * the binding): what a remote change does to it is held back where Yjs
   * keeps it (see Hidden and $hold), and every read shows it without what
   * is held.
   */
  composingKey: NodeKey | null = null;
  /**
   * The id of a character the composition holds, from before the read (set
   * by the binding): where a read cannot keep the node being composed with
   * its text, it keeps it for the text holding that character (see
   * $readInline).
   */
  composedAt: {client: number; clock: number; offset: number} | null = null;
  /**
   * The values attributes `keys` of marker `y` had before the change read
   * (set by the binding, see Hidden#marker).
   */
  attrsBefore:
    | ((y: YNode, keys: ReadonlySet<string>) => Map<string, unknown>)
    | null = null;
  /** The marker attributes the change read set (see $apply). */
  private changedAttrs: Map<YNode, Set<string>> = new Map();
  /** Units whose marker attributes changed in this transaction. */
  private readonly attrChanged = new Set<Unit>();
  /** Containers whose structure this read rebuilt (for the self-check). */
  readonly rebuilt = new Set<CS>();
  /** The block ids this read shows (see BlockIdSettler). */
  readonly settler: BlockIdSettler;
  constructor(readonly state: State) {
    this.settler = new BlockIdSettler(state);
    const editor = state.editor;
    this.wrapperFields = type => {
      if (!editor._nodes.has(type)) {
        state.unknownTypes.add(type);
      }
      return wrapperFieldsOf(editor, type);
    };
  }

  /**
   * Run `read`, code of the class of stored content of `type` that builds a
   * node from the stored values (its importJSON). Where it throws, this
   * editor cannot read that content, as with content of a type it does not
   * register: the type is noted (see State#unreadable), the binding opens
   * read only after the read, and `fallback` stands in, so that what is
   * shown keeps the rest of the document.
   */
  private $readStored<T>(type: string, read: () => T, fallback: () => T): T {
    try {
      return read();
    } catch (error) {
      this.noteUnreadable(type, error);
      return fallback();
    }
  }

  /**
   * Run `update`, code of `node`'s class that gives it stored values (its
   * updateFromJSON, a NodeState parse). Where it throws, as in $readStored,
   * and `node` keeps what it held before: what the class changed before it
   * threw is undone.
   */
  private $updateStored(node: LexicalNode, update: () => void): void {
    const was = {...node.getLatest()} as Record<string, unknown>;
    try {
      update();
    } catch (error) {
      this.noteUnreadable(node.getType(), error);
      $restoreNode(node, was);
    }
  }

  private noteUnreadable(type: string, error: unknown): void {
    if (!this.state.unreadable.has(type)) {
      this.state.unreadable.set(type, error);
    }
  }

  // -------------------------------------------------------------------------
  // Entry points

  /**
   * Run `read`, one logical read made of several entry points (the
   * containers a re-read reads in full, one after the other): what each
   * takes out is checked once, at the end (see $checkTakenOut), as a node
   * one container sets aside can be placed again by the read of another.
   */
  $reading(read: () => void): void {
    this.depth++;
    try {
      read();
      if (this.depth === 1) {
        this.$settleWrapperTextFields();
        this.$checkTakenOut();
      }
    } finally {
      if (--this.depth === 0) {
        this.settler.$settleIds();
      }
    }
  }

  /** Read a whole container into its Lexical node. */
  $readFull(cs: CS, el: ElementNode): void {
    this.depth++;
    try {
      this.$readFullInner(cs, el);
      if (this.depth === 1) {
        this.$settleWrapperTextFields();
        this.$checkTakenOut();
      }
    } finally {
      if (--this.depth === 0) {
        this.settler.$settleIds();
      }
    }
  }

  private $readFullInner(cs: CS, el: ElementNode): void {
    this.fresh.add(cs.y);
    this.rebuilt.add(cs);
    if (cs.kind === 'i') {
      this.$setChildren(
        el,
        this.$readInline(cs.y._start, null, EMPTY_FORMATS, el),
      );
      for (const u of cs.units) {
        this.state.dropUnit(u);
      }
      cs.units = [];
      return;
    }
    const {parsed} = parseRange(
      cs.y._start,
      null,
      EMPTY_FORMATS,
      this.state.hidden,
    );
    const old = cs.units;
    // The lines the editor holds here, which a full read sets aside where the
    // document does not hold them here (see $checkTakenOut).
    for (const child of el.getChildren()) {
      if (this.state.unitByKey.has(child.getKey())) {
        this.linesTakenOut.add(child.getKey());
      }
    }
    const {units, tops} = this.$materialize(cs, el, parsed, old);
    this.$setChildren(el, tops);
    this.$commitUnits(cs, 0, old.length, units, old);
  }

  /**
   * Read the units of block container `cs` from item `start` up to `stop`
   * (null: its end), which start with `formats` in effect, into `el`, an
   * element of an editor of its own (see $followUpDifference): what a fresh
   * reader shows for that part of the container.
   */
  $readRange(
    cs: CS,
    el: ElementNode,
    start: Item | null,
    stop: Item | null,
    formats: Formats,
  ): void {
    this.depth++;
    try {
      this.fresh.add(cs.y);
      const {parsed} = parseRange(start, stop, formats, this.state.hidden);
      const {units, tops} = this.$materialize(cs, el, parsed, []);
      this.$setChildren(el, tops);
      this.$commitUnits(cs, 0, 0, units, []);
    } finally {
      if (--this.depth === 0) {
        this.settler.$settleIds();
      }
    }
  }

  /** Apply a remote transaction's changes. */
  $apply(
    childItems: Map<YNode, Item[]>,
    attrKeys: Map<YNode, Set<string>>,
  ): void {
    this.depth++;
    const changedAttrs = this.changedAttrs;
    this.changedAttrs = attrKeys;
    try {
      this.$applyInner(childItems, attrKeys);
      if (this.depth === 1) {
        this.$checkTakenOut();
      }
    } finally {
      this.changedAttrs = changedAttrs;
      if (--this.depth === 0) {
        this.settler.$settleIds();
      }
    }
  }

  /**
   * A read never drops a node the document still holds. A read takes nodes
   * out of a container it reads where the document no longer has them
   * there, and places every node the document moved where it now is: in a
   * container this read reads, as a change moves a node by deleting it in
   * one container and inserting it in another. A node it took out that is
   * still out of the tree at the end, and that the document still holds (a
   * stored node whose item is not deleted, other than an inline element
   * this read left out because it is empty and cannot be), is one the editor held
   * elsewhere than the document stores it: an update tagged SKIP_COLLAB_TAG
   * moved it there, into the content read, or put the content that stores
   * it inside it (see $setChildren). Left out, it would be dropped with everything it holds,
   * and the editor would miss a part of the document until it reloads. The
   * read throws instead, which reads the whole document again (see
   * YBinding#recoverRead).
   */
  private $checkTakenOut(): void {
    const state = this.state;
    for (const key of this.takenOut) {
      const node = $getNodeByKey(key);
      if (node === null || node.isAttached()) {
        continue;
      }
      const y = state.yByKey.get(key);
      const held =
        y !== undefined &&
        state.keyByY.get(y) === key &&
        !isDeleted(y) &&
        !this.leftOut.has(key);
      invariant(
        !held,
        '@lexical/y: a read would drop a node the document still holds',
      );
    }
    // A line a full read of its container set aside that is still out of
    // the tree, and that another container the document holds still stores
    // (its unit there was not read): the editor held it in the container
    // read, where an update tagged SKIP_COLLAB_TAG moved it.
    for (const key of this.linesTakenOut) {
      const node = $getNodeByKey(key);
      if (node === null || node.isAttached()) {
        continue;
      }
      // Its unit, still its own: a read that made the line's node anew (a
      // line whose type changed) keeps its unit for the new node, and the
      // old key's entry, stale, names it.
      const unit = state.unitByKey.get(key);
      invariant(
        unit === undefined ||
          unit.key !== key ||
          state.containers.get(unit.cs.y) !== unit.cs ||
          isDeleted(unit.cs.y) ||
          !unit.cs.units.includes(unit),
        '@lexical/y: a read would drop a node the document still holds',
      );
    }
    this.takenOut.clear();
    this.leftOut.clear();
    this.linesTakenOut.clear();
  }

  /**
   * Settle `ids` (see BlockIdSettler#$settleIds) in an update of the
   * binding's own, after a local write changed which blocks store them.
   */
  $settle(ids: Iterable<string>): void {
    for (const id of ids) {
      this.state.ids.touchedIds.add(id);
    }
    if (this.depth === 0) {
      this.settler.$settleIds();
    }
  }

  private $applyInner(
    childItems: Map<YNode, Item[]>,
    attrKeys: Map<YNode, Set<string>>,
  ): void {
    const state = this.state;
    this.located = new Map();
    const markerUnits = new Map<CS, Set<Unit>>();
    const fullReads = new Set<CS>();
    for (const [y, keys] of attrKeys) {
      if (y === state.root) {
        continue;
      }
      if (y.name === MARKER) {
        const item = y._item;
        const unit = item === null ? undefined : state.unitByEnd.get(item);
        if (unit !== undefined && !item!.deleted) {
          let set = markerUnits.get(unit.cs);
          if (set === undefined) {
            set = new Set();
            markerUnits.set(unit.cs, set);
          }
          set.add(unit);
        }
        continue;
      }
      const key = state.keyByY.get(y);
      const node = key === undefined ? null : $getNodeByKey(key);
      if (node === null || (y._item !== null && y._item.deleted)) {
        continue;
      }
      this.$applyNodeAttrs(node, y);
      if ([...keys].some(k => k.startsWith(SLOT_PREFIX))) {
        // Its named slots changed (the node may have been retyped above).
        const now = $getNodeByKey(state.keyByY.get(y) ?? key!);
        if (now !== null) {
          $readSlots(this, now, y);
        }
      }
      const cs = state.containers.get(y);
      if (cs !== undefined && keys.has(KIND_KEY)) {
        const kind: Kind = y.getAttr(KIND_KEY) === 'i' ? 'i' : 'b';
        if (kind !== cs.kind) {
          cs.kind = kind;
          fullReads.add(cs);
        }
      }
    }
    for (const cs of fullReads) {
      const el = $getNodeByKey(cs.key);
      if ($isElementNode(el)) {
        this.$readFull(cs, el);
      }
    }
    for (const [y, items] of childItems) {
      const cs = state.containers.get(y);
      if (
        cs === undefined ||
        this.fresh.has(y) ||
        fullReads.has(cs) ||
        isDeleted(y)
      ) {
        continue;
      }
      const el = $getNodeByKey(cs.key);
      if (!$isElementNode(el)) {
        continue;
      }
      if (cs.kind === 'i') {
        if (cs.key === this.composingKey && this.$hold(null, items, false)) {
          continue;
        }
        this.$setChildren(
          el,
          this.$readInline(y._start, null, EMPTY_FORMATS, el),
        );
      } else {
        this.$readChanges(cs, el, items, markerUnits.get(cs));
        markerUnits.delete(cs);
      }
    }
    for (const [cs, units] of markerUnits) {
      const el = $getNodeByKey(cs.key);
      if ($isElementNode(el) && !isDeleted(cs.y)) {
        this.$readChanges(cs, el, [], units);
      }
    }
    // An element that cannot be empty is shown only while its content is
    // not (as a fresh reader builds it): a stored container whose content
    // peers emptied, or filled again, is read again where it is held. One
    // not shown for a whole update is gone from the editor (Lexical drops
    // detached nodes): filled again, it is read anew there.
    for (const y of childItems.keys()) {
      const cs = state.containers.get(y);
      const el = cs === undefined ? null : $getNodeByKey(cs.key);
      if (
        typeof y.name === 'string' &&
        y.name.startsWith(INLINE_PREFIX) &&
        cs !== undefined &&
        !isDeleted(y) &&
        (el === null ||
          ($isElementNode(el) &&
            !el.canBeEmpty() &&
            (el.getChildrenSize() === 0) === el.isAttached()))
      ) {
        this.$rereadHolder(y);
      }
    }
    this.$repairSelection();
  }

  /** Read again the line (or inline container) holding a stored node. */
  private $rereadHolder(y: YNode): void {
    const item = y._item;
    if (item === null || item.deleted) {
      return;
    }
    const parent = item.parent as YNode;
    const pcs = this.state.containers.get(parent);
    const pel = pcs === undefined ? null : $getNodeByKey(pcs.key);
    if (pcs === undefined || !$isElementNode(pel)) {
      return;
    }
    if (pcs.kind === 'i') {
      this.$setChildren(
        pel,
        this.$readInline(parent._start, null, EMPTY_FORMATS, pel),
      );
      return;
    }
    let end: Item | null = item;
    while (end !== null && !isShownEnd(end, this.state.hidden)) {
      end = end.right;
    }
    const unit = end === null ? undefined : this.state.unitByEnd.get(end);
    if (unit === undefined) {
      return;
    }
    if (unit.kind === 'line' && this.$readLineInPlace(unit)) {
      return;
    }
    const i = pcs.units.indexOf(unit);
    if (i >= 0) {
      this.$readRegion(pcs, pel, i, i, new Set([unit]));
    }
  }

  // -------------------------------------------------------------------------
  // Block containers

  /**
   * The unit `item` is in: the unit of the first end item after it that
   * the editor shows as one (a held-back end item is not, see Hidden).
   * `flags.structural` is set when units change: the walk passes an end
   * item that ends no unit and is live (inserted by this change), or
   * reaches a unit whose end was deleted; the deleted end item of an
   * earlier join ends nothing and is passed.
   */
  private $unitOf(
    cs: CS,
    item: Item,
    flags: {structural: boolean; tail: boolean},
  ): Unit | null {
    const hidden = this.state.hidden;
    const passed: Item[] = [];
    let result: Unit | null = null;
    let found = false;
    for (let p: Item | null = item; p !== null; p = p.right) {
      const cached = this.located.get(p);
      if (cached !== undefined) {
        result = cached;
        found = true;
        break;
      }
      passed.push(p);
      if (isEndItem(p) && !isHeld(p, hidden)) {
        const u = this.state.unitByEnd.get(p);
        if (u !== undefined && u.cs === cs) {
          // Content before a node unit (concurrent typing next to an
          // inserted block) is not part of that node: regroup.
          if (p.deleted || (u.kind === 'node' && p !== item)) {
            flags.structural = true;
          }
          result = u;
          found = true;
          break;
        }
        if (!p.deleted) {
          flags.structural = true;
        }
      }
    }
    if (!found) {
      flags.tail = true;
    }
    for (const p of passed) {
      this.located.set(p, result);
    }
    if (result === null) {
      flags.tail = true;
    }
    return result;
  }

  private $readChanges(
    cs: CS,
    el: ElementNode,
    items: Item[],
    attrUnits: Set<Unit> | undefined,
  ): void {
    const flags = {structural: false, tail: false};
    const affected = new Set<Unit>();
    const composingItems: Item[] = [];

    for (const it of items) {
      if (isEndItem(it) && !this.state.unitByEnd.has(it) && it.deleted) {
        // inserted and deleted in the same transaction
        continue;
      }
      const u = this.$unitOf(cs, it, flags);
      if (u !== null) {
        affected.add(u);
        if (u.key !== null && u.key === this.composingKey) {
          composingItems.push(it);
        }
      }
    }
    if (attrUnits !== undefined) {
      for (const u of attrUnits) {
        affected.add(u);
        this.attrChanged.add(u);
      }
    }
    // A format item inserted or deleted changes the formats later units
    // start with: recompute them from the first such unit, until they agree
    // again past the last one, and read the units whose start changed.
    const formatUnits: Unit[] = [];
    for (const it of items) {
      if (it.content instanceof ContentFormat) {
        const u = this.located.get(it);
        if (u !== undefined && u !== null) {
          formatUnits.push(u);
        }
      }
    }
    const startChanged =
      formatUnits.length > 0
        ? recomputeUnitStarts(cs, formatUnits)
        : ([] as Unit[]);
    for (const u of startChanged) {
      affected.add(u);
    }
    // The line being composed: what the change did to it is held back where
    // it can be (see $hold), whatever it did to the other units; the line
    // is read only for the rest, without what is held. A format reaching it
    // from before (its start changed) is not its own item: read.
    for (const u of affected) {
      if (
        u.key !== null &&
        u.key === this.composingKey &&
        this.$hold(
          u,
          composingItems,
          attrUnits !== undefined && attrUnits.has(u),
        ) &&
        !startChanged.includes(u)
      ) {
        affected.delete(u);
        this.attrChanged.delete(u);
      }
    }
    if (affected.size === 0 && !flags.tail) {
      return;
    }
    if (!flags.structural && !flags.tail) {
      const rest = new Set<Unit>();
      for (const u of affected) {
        if (!(u.kind === 'line' && this.$readLineInPlace(u))) {
          if (u.kind !== 'node') {
            rest.add(u);
          }
        }
      }
      if (rest.size === 0) {
        return;
      }
      affected.clear();
      for (const u of rest) {
        affected.add(u);
      }
    }
    const units = cs.units;
    const index = new Map<Unit, number>();
    units.forEach((u, i) => index.set(u, i));
    const idx: number[] = [];
    for (const u of affected) {
      const i = index.get(u);
      if (i !== undefined) {
        idx.push(i);
      }
    }
    if (flags.tail) {
      idx.push(units.length);
    }
    idx.sort((a, b) => a - b);
    // Merge into ranges [i, j] (j may be units.length = the tail).
    const ranges: [number, number][] = [];
    for (const i of idx) {
      const last = ranges[ranges.length - 1];
      if (last !== undefined && i <= last[1] + 1) {
        last[1] = Math.max(last[1], i);
      } else {
        ranges.push([i, i]);
      }
    }
    // A region's read can widen into an earlier range (merging units), so
    // ranges are kept as units and located again before each read.
    const rangeUnits = ranges.map(([a, b]) => ({
      tail: b >= units.length,
      units: units.slice(a, Math.min(b + 1, units.length)),
    }));
    for (let r = rangeUnits.length - 1; r >= 0; r--) {
      const {units: us, tail} = rangeUnits[r];
      const now = cs.units;
      let a = -1;
      let b = -1;
      for (const u of us) {
        const k = now.indexOf(u);
        if (k >= 0) {
          a = a < 0 ? k : Math.min(a, k);
          b = Math.max(b, k);
        }
      }
      if (tail) {
        if (a < 0) {
          a = now.length;
        }
        b = now.length;
      }
      if (a < 0) {
        // Every unit of this range was read with a later one.
        continue;
      }
      this.$readRegion(cs, el, a, b, affected);
    }
  }

  /**
   * Hold back what a remote change did to the line (`unit`) or inline
   * container (null) being composed (see Hidden): the items it inserted,
   * those it deleted that were held back already, and, with `attrs`, the
   * attributes it set on the line's marker. Returns whether all of it is
   * held; the line is otherwise read for the rest, without what is held.
   * A change that removes something the editor shows (Yjs does not keep
   * it) is read whole, its inserts too, so the line never shows a word it
   * replaced without its replacement; lines it makes before the line are
   * not the line's, and are read (see $linesBefore).
   */
  private $hold(unit: Unit | null, items: Item[], attrs: boolean): boolean {
    const state = this.state;
    const key = unit === null ? this.composingKey : unit.key;
    // Releasing an invalid old hold can already have read this region from
    // the integrated transaction. Its inserts are shown, not new hold-back
    // candidates; the rest of the transaction must still be applied.
    if (key !== null && this.consumed.has(key)) {
      return false;
    }
    let hidden = state.hidden;
    for (const it of items) {
      if (it.deleted && !isHeld(it, hidden)) {
        return false;
      }
    }
    const before =
      unit === null ? null : this.$linesBefore(unit, new Set(items));
    const held = items.filter(
      it => !it.deleted && (before === null || !before.has(it)),
    );
    // The marker's attributes this client owns, with the values they had
    // (the line is read for lines made before it, its marker too); a change
    // of attributes it does not own changes nothing it shows.
    const end = unit === null || before !== null ? null : unit.end;
    const changed =
      attrs && end !== null && this.attrsBefore !== null
        ? this.$ownedChanges(end, hidden)
        : null;
    if (held.length > 0 || (changed !== null && changed.size > 0)) {
      if (hidden === null) {
        hidden = new Hidden(this.composingKey!);
        state.hidden = hidden;
      }
      for (const it of held) {
        hidden.add(it.id.client, it.id.clock, it.length);
      }
      if (changed !== null && changed.size > 0) {
        const marker = hidden.marker || {
          ends: new Set<Item>(),
          now: new Map<string, unknown>(),
          was: new Map<string, unknown>(),
        };
        const now = typeOf(end!).getAttrs() as Attrs;
        for (const [k, v] of changed) {
          if (!marker.was.has(k)) {
            marker.was.set(k, v);
          }
          marker.now.set(k, now[k]);
        }
        marker.ends.add(end!);
        hidden.marker = marker;
      }
    }
    return before === null && (!attrs || changed !== null);
  }

  /**
   * Of the attributes of marker `end` the change read set, those this
   * client owns (see ownsMarkerAttr), with the values they had: of the
   * fields, those its classes of the line's type and group declare, of the
   * types the change goes from and to, and of the type the editor shows (a
   * held change of it). A field no class of this client declares is another
   * client's, which this one neither shows nor writes.
   */
  private $ownedChanges(
    end: Item,
    hidden: Hidden | null,
  ): Map<string, unknown> {
    const y = typeOf(end);
    const keys = this.changedAttrs.get(y) || new Set<string>();
    const was = this.attrsBefore!(y, keys);
    const now = y.getAttrs() as Attrs;
    const shown =
      hidden !== null && hidden.marker !== null && hidden.marker.ends.has(end)
        ? hidden.marker.was
        : null;
    const valuesOf = (key: string) => [
      was.has(key) ? was.get(key) : now[key],
      now[key],
      ...(shown !== null && shown.has(key) ? [shown.get(key)] : []),
    ];
    const editor = this.state.editor;
    const fields = fieldsOfTypes(editor, valuesOf(TYPE_KEY));
    const groupFields = fieldsOfTypes(
      editor,
      valuesOf(GROUP_KEY).filter(g => typeof g === 'string'),
    );
    const out = new Map<string, unknown>();
    for (const [k, v] of was) {
      if (ownsMarkerAttr(k, fields, groupFields)) {
        out.set(k, v);
      }
    }
    return out;
  }

  /**
   * Of `items` (a change to line `unit`), those that make lines of their
   * own before its content: the line then starts at an end item the change
   * inserted, with none of its own content before it. They do not change
   * the line's nodes (a read keeps its node, matched by its marker), so
   * they are read, not held (see $hold). Null when there are none.
   */
  private $linesBefore(unit: Unit, items: ReadonlySet<Item>): Set<Item> | null {
    const hidden = this.state.hidden;
    const start = unit.end === null ? null : prevLiveEnd(unit.end, hidden);
    if (start === null || !items.has(start) || start.deleted) {
      return null;
    }
    let p: Item | null = start.left;
    for (; p !== null; p = p.left) {
      if (items.has(p) || !isShown(p, hidden)) {
        continue;
      }
      if (isEndItem(p)) {
        break;
      }
      if (p.countable) {
        // The line's own content before it: a split of the line.
        return null;
      }
    }
    const out = new Set<Item>();
    for (
      let it: Item | null = p === null ? unit.cs.y._start : p.right;
      it !== null && it !== start.right;
      it = it.right
    ) {
      if (items.has(it)) {
        out.add(it);
      }
    }
    return out;
  }

  private $readRegion(
    cs: CS,
    el: ElementNode,
    i: number,
    j: number,
    affected: ReadonlySet<Unit> | null = null,
  ): void {
    const units = cs.units;
    i = Math.min(i, units.length);
    j = Math.max(i, Math.min(j, units.length));
    this.rebuilt.add(cs);
    const len = units.length;
    const sameTop = (a: number, b: number) =>
      a >= 0 &&
      b < len &&
      units[a].first !== null &&
      units[a].first === units[b].first;
    for (;;) {
      let changed = false;
      while (j < len && units[j].end !== null && units[j].end!.deleted) {
        j++;
        changed = true;
      }
      if (j < len && units[j].end === null && j < len - 1) {
        j++;
        changed = true;
      }
      while (
        i > 0 &&
        (units[i - 1].end === null || units[i - 1].end!.deleted)
      ) {
        i--;
        changed = true;
      }
      while (i > 0 && i < len && sameTop(i - 1, i)) {
        i--;
        changed = true;
      }
      while (j < len - 1 && sameTop(j, j + 1)) {
        j++;
        changed = true;
      }
      if (!changed) {
        break;
      }
    }
    for (;;) {
      const tail = j >= len;
      const left = i > 0 ? units[i - 1].end : null;
      const startItem = left === null ? cs.y._start : left.right;
      const stop =
        j >= len ? null : units[j].end === null ? null : units[j].end!.right;
      const startFormats =
        i < len
          ? units[i].start || EMPTY_FORMATS
          : formatsAfterUnit(units, i - 1);
      const {parsed, after} = parseRange(
        startItem,
        stop,
        startFormats,
        this.state.hidden,
      );
      // Groups next to the region may merge with it.
      const isGroupItem = (p: Parsed | undefined) =>
        p !== undefined &&
        p.kind === 'line' &&
        this.$groupOf(cs, shownMarkerAttrs(p.end!, this.state.hidden)) !== null;
      // A region that reads back empty (its units were removed) can leave
      // two groups adjacent: read them together so they regroup as one when
      // their keys are equal.
      if (
        parsed.length === 0 &&
        !tail &&
        i > 0 &&
        Math.min(j, len - 1) + 1 < len &&
        units[i - 1].sig !== '' &&
        units[Math.min(j, len - 1) + 1].sig !== ''
      ) {
        const top = units[i - 1].first;
        while (i > 0 && units[i - 1].first === top) {
          i--;
        }
        const nextTop = units[Math.min(j, len - 1) + 1].first;
        while (j + 1 < len && units[j + 1].first === nextTop) {
          j++;
        }
        continue;
      }
      if (i > 0 && units[i - 1].sig !== '' && isGroupItem(parsed[0])) {
        const top = units[i - 1].first;
        while (i > 0 && units[i - 1].first === top) {
          i--;
        }
        continue;
      }
      const lastJ = Math.min(j, len - 1);
      if (
        !tail &&
        lastJ + 1 < len &&
        units[lastJ + 1].sig !== '' &&
        isGroupItem(parsed[parsed.length - 1])
      ) {
        const top = units[lastJ + 1].first;
        while (j + 1 < len && units[j + 1].first === top) {
          j++;
        }
        continue;
      }
      const old = units.slice(i, Math.min(j + 1, len));
      // The Lexical children the old units cover, and the node before them,
      // before materializing (which may move pooled nodes). A unit the
      // editor holds no node for (a node of a type it cannot build, read
      // only) covers none.
      // Each unit's own nodes: the editor holds them in the units' order,
      // unless an update the binding did not write (SKIP_COLLAB_TAG) moved
      // one: then a node between them is not theirs, and stays.
      const oldTops: LexicalNode[] = [];
      let prev: LexicalNode | null = null;
      const covered = new Set<NodeKey>();
      for (const u of old) {
        if (u.first === null || u.last === null) {
          continue;
        }
        const first = $getNodeByKey(u.first);
        const last = $getNodeByKey(u.last);
        if (first === null || last === null || !el.is(first.getParent())) {
          continue;
        }
        if (covered.size === 0) {
          prev = first.getPreviousSibling();
        }
        const span: LexicalNode[] = [];
        let reached = false;
        for (
          let n: LexicalNode | null = first;
          n !== null;
          n = n.getNextSibling()
        ) {
          span.push(n);
          if (n.is(last)) {
            reached = true;
            break;
          }
        }
        for (const n of reached ? span : [first]) {
          if (!covered.has(n.getKey())) {
            covered.add(n.getKey());
            oldTops.push(n);
          }
        }
      }
      const {units: fresh, tops} = this.$materialize(
        cs,
        el,
        parsed,
        old,
        affected,
        left,
      );
      const keep = new Set(tops.map(t => t.getKey()));
      for (const n of oldTops) {
        const parent = n.getParent();
        // Nodes the read moved elsewhere (reused groups) stay where they are.
        if (!keep.has(n.getKey()) && parent !== null && parent.is(el)) {
          this.takenOut.add(n.getKey());
          $keepingSelection(() => n.remove(true));
        }
      }
      // The region's children go after the node that preceded the old ones
      // if `el` still holds it once the read is done and the read does not
      // place it; else after the last child of the nearest unit before the
      // region that `el` holds, or first. The read may have moved that node
      // into one it places (a stored node an unwritten update moved out of
      // the line that stores it): placed next to it, that one would end up
      // inside itself.
      let cursor =
        prev !== null && el.is(prev.getParent()) && !keep.has(prev.getKey())
          ? prev
          : $lastChildIn(el, units, i);
      for (const t of tops) {
        invariant(
          !$holds(t, el),
          '@lexical/y: a read would place a node inside itself',
        );
        if (cursor === null) {
          const firstChild = el.getFirstChild();
          if (firstChild === null) {
            el.append(t);
          } else if (!firstChild.is(t)) {
            $keepingSelection(() => firstChild.insertBefore(t));
          }
        } else {
          const next = cursor.getNextSibling();
          if (next === null || !next.is(t)) {
            const before = cursor;
            $keepingSelection(() => before.insertAfter(t));
          }
        }
        cursor = t;
      }
      this.$commitUnits(cs, i, Math.min(j + 1, len), fresh, old);
      // Formats that now reach past the region change the next unit.
      const nextIndex = i + fresh.length;
      const next = cs.units[nextIndex];
      if (
        next !== undefined &&
        !sameFormats(next.start || EMPTY_FORMATS, after)
      ) {
        next.start = after.size > 0 ? after : null;
        if (next.kind !== 'line' || !this.$readLineInPlace(next)) {
          this.$readRegion(cs, el, nextIndex, nextIndex);
        }
      }
      return;
    }
  }

  private $commitUnits(
    cs: CS,
    from: number,
    to: number,
    fresh: Unit[],
    old: Unit[],
  ): void {
    const keep = new Set(fresh);
    for (const u of old) {
      if (!keep.has(u)) {
        this.state.dropUnit(u);
      }
    }
    for (const u of fresh) {
      this.state.setUnit(u);
      this.settler.$placeUnit(u);
    }
    spliceAll(cs.units, from, to - from, fresh);
    // A container that is a group itself (stored as a node) recomputes its
    // items' derived fields too.
    if (this.$containerGroupSpec(cs) !== null) {
      this.state.refresh.add(cs.key);
    }
  }

  private $readLineInPlace(u: Unit): boolean {
    const line = u.key === null ? null : $getNodeByKey(u.key);
    if (!$isElementNode(line) || u.end === null || u.end.deleted) {
      return false;
    }
    const hidden = this.state.hidden;
    let attrs = shownMarkerAttrs(u.end, hidden);
    if (attrs[TYPE_KEY] !== line.getType()) {
      return false;
    }
    attrs = this.settler.$lineIdInPlace(line, attrs, u.end);
    const group = this.$groupOf(u.cs, attrs);
    if (lineGroupSig(attrs, group) !== u.sig) {
      return false;
    }
    this.$applyLineAttrs(
      line,
      attrs,
      this.$derivedFor(u.cs, group),
      this.attrChanged.has(u),
    );
    const left = prevLiveEnd(u.end, hidden);
    const first = left === null ? u.cs.y._start : left.right;
    this.$setChildren(
      line,
      this.$readInline(first, u.end, u.start || EMPTY_FORMATS, line),
    );
    // Whether it keeps the id it derives, as a line placed anew does (see
    // $commitUnits): the attributes just applied can change that (a quote
    // that comes to hold paragraphs is no identified block in a cell).
    this.settler.$placeUnit(u);
    // A format that now reaches past the marker changes the next unit: the
    // formats stored there, held-back ones too (the next line is not held).
    const after =
      hidden === null
        ? this.lastFormats
        : formatsAfter(first, u.end, u.start || EMPTY_FORMATS);
    let nextEnd: Item | null = u.end.right;
    while (nextEnd !== null && !isShownEnd(nextEnd, hidden)) {
      nextEnd = nextEnd.right;
    }
    const next =
      nextEnd === null ? undefined : this.state.unitByEnd.get(nextEnd);
    if (
      next !== undefined &&
      !sameFormats(next.start || EMPTY_FORMATS, after)
    ) {
      next.start = after.size > 0 ? new Map(after) : null;
      if (next.kind !== 'line' || !this.$readLineInPlace(next)) {
        const el = $getNodeByKey(next.cs.key);
        const i = next.cs.units.indexOf(next);
        if ($isElementNode(el) && i >= 0) {
          this.$readRegion(next.cs, el, i, i);
        }
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Materializing units

  private $containerGroupSpec(cs: CS): GroupSpec | null {
    const el = $getNodeByKey(cs.key);
    return el === null ? null : getContainerGroupSpec(klassOf(el));
  }

  private $derivedFor(
    cs: CS,
    group: GroupItemInfo | null,
  ): ReadonlySet<string> | null {
    if (group !== null) {
      return group.spec.derived;
    }
    const spec = this.$containerGroupSpec(cs);
    return spec === null ? null : spec.derived;
  }

  /** The group a marker puts its line in, or null. */
  private $groupOf(cs: CS, attrs: Attrs): GroupItemInfo | null {
    if (this.$containerGroupSpec(cs) !== null) {
      return null;
    }
    const type = attrs[TYPE_KEY];
    const info =
      typeof type === 'string' ? this.state.editor._nodes.get(type) : undefined;
    if (info === undefined || getLineSpec(info.klass) === null) {
      return null;
    }
    const g = attrs[GROUP_KEY];
    const ginfo =
      typeof g === 'string' ? this.state.editor._nodes.get(g) : undefined;
    if (typeof g === 'string' && ginfo === undefined) {
      this.state.unknownTypes.add(g);
    }
    const spec = ginfo === undefined ? null : getGroupSpec(ginfo.klass);
    if (spec !== null && spec.items.includes(info.klass)) {
      // What this editor's classes read: the group fields it owns (see
      // ownsMarkerAttr), as its writes give them.
      const lineFields = ownedFieldsOf(info.klass, false);
      const groupFields = ownedFieldsOf(spec.klass, false);
      const gkey: Attrs = {};
      for (const k in attrs) {
        if (
          k.startsWith(GROUP_FIELD_PREFIX) &&
          ownsMarkerAttr(k, lineFields, groupFields)
        ) {
          gkey[k] = attrs[k];
        }
      }
      // The level as written: the writer records the outer levels with it
      // (one entry each), so a level whose record matches is read at any
      // depth. One without a matching record (concurrent writes of the two
      // keys, or a writer that kept no record) is capped: its outer levels
      // are not known, and each costs memory.
      const raw = attrs[LEVEL_KEY];
      const o = attrs[OUTER_KEY];
      const level =
        typeof raw === 'number' && Number.isInteger(raw) && raw > 0
          ? Array.isArray(o) && o.length === raw
            ? raw
            : Math.min(64, raw)
          : 0;
      const outer =
        level > 0 &&
        Array.isArray(o) &&
        o.length === level &&
        o.every(v => v !== null && typeof v === 'object' && !Array.isArray(v))
          ? eachOuterLevel(
              o as Attrs[],
              null,
              groupFields,
              groupItemFields(spec),
              (value, _stored, owns) => withoutUnownedMembers(value, owns),
            )
          : null;
      return {gkey, gtype: g as string, level, outer, spec};
    }
    // An item of a group outside any group: Lexical would wrap it.
    const fallback = this.$defaultGroup(info.klass);
    return fallback === null
      ? null
      : {
          gkey: {},
          gtype: fallback.klass.getType(),
          level: 0,
          outer: null,
          spec: fallback,
        };
  }

  private $defaultGroup(item: Klass<LexicalNode>): GroupSpec | null {
    for (const {klass} of this.state.editor._nodes.values()) {
      const spec = getGroupSpec(klass);
      if (spec !== null && spec.klass === klass && spec.items.includes(item)) {
        return spec;
      }
    }
    return null;
  }

  private $materialize(
    cs: CS,
    el: ElementNode,
    parsed: Parsed[],
    old: Unit[],
    affected: ReadonlySet<Unit> | null = null,
    left: Item | null = null,
  ): {units: Unit[]; tops: LexicalNode[]} {
    const state = this.state;
    // The end before each old unit, to tell a line whose range did not change.
    const prevEnd = new Map<Unit, Item | null>();
    old.forEach((u, k) => prevEnd.set(u, k === 0 ? left : old[k - 1].end));
    let parsedPrevEnd: Item | null = left;
    const byEnd = new Map<Item, Unit>();
    const implicit: Unit[] = [];
    for (const u of old) {
      if (u.end !== null) {
        byEnd.set(u.end, u);
      } else {
        implicit.push(u);
      }
    }
    // The line being composed (IME) that a remote change merges into the
    // next line (its marker was deleted) keeps its node for the merged line:
    // the browser's composition stays in its DOM.
    let composedLine: {into: Unit; key: NodeKey} | null = null;
    const ck = this.composingKey;
    if (ck !== null && this.state.editor._compositionKey !== null) {
      const k = old.findIndex(u => u.key === ck);
      if (k >= 0 && old[k].end !== null && old[k].end!.deleted) {
        let j = k + 1;
        while (j < old.length && old[j].end !== null && old[j].end!.deleted) {
          j++;
        }
        if (j < old.length && old[j].end !== null && old[j].kind === 'line') {
          composedLine = {into: old[j], key: ck};
        }
      }
    }
    const pool: Pool = {
      groups: new Map(),
      levelKeys: new Set(),
      levels: [],
      lines: new Set(),
    };
    const seenTops = new Set<NodeKey>();
    for (const u of old) {
      if (u.sig !== '' && u.first !== null && !seenTops.has(u.first)) {
        seenTops.add(u.first);
        const top = $getNodeByKey(u.first);
        if ($isElementNode(top)) {
          collectPool(top, pool, state);
        }
      }
    }
    type Entry = {unit: Unit; nodes: LexicalNode[]; group: GroupItem | null};
    const entries: Entry[] = [];
    for (const p of parsed) {
      if (p.kind === 'node') {
        const y = typeOf(p.end!);
        let node = this.$storedNode(y);
        if (node === null) {
          node = this.$createStored(y);
        }
        const prevUnit = byEnd.get(p.end!);
        const unit: Unit = prevUnit || {
          cs,
          end: p.end,
          first: null,
          key: null,
          kind: 'node',
          last: null,
          sig: '',
          start: null,
        };
        unit.key = node === null ? null : node.getKey();
        unit.first = unit.last = unit.key;
        unit.sig = '';
        // Its start formats (a format can span a block node: the following
        // units' reads start from this value).
        unit.start = p.start.size > 0 ? p.start : null;
        entries.push({group: null, nodes: node === null ? [] : [node], unit});
        parsedPrevEnd = p.end;
        continue;
      }
      if (p.kind === 'run') {
        const prevUnit = byEnd.get(p.end!);
        const poolNodes: LexicalNode[] = [];
        if (prevUnit !== undefined && prevUnit.first !== null) {
          for (
            let n = $getNodeByKey(prevUnit.first);
            n !== null;
            n = n.getNextSibling()
          ) {
            poolNodes.push(n);
            if (n.getKey() === prevUnit.last) {
              break;
            }
          }
        }
        const nodes = this.$readInline(
          p.startItem,
          p.stop,
          p.start,
          null,
          poolNodes,
        );
        const unit: Unit = prevUnit || {
          cs,
          end: p.end,
          first: null,
          key: null,
          kind: 'run',
          last: null,
          sig: '',
          start: null,
        };
        unit.kind = 'run';
        unit.start = p.start.size > 0 ? p.start : null;
        entries.push({group: null, nodes, unit});
        parsedPrevEnd = p.end;
        continue;
      }
      // line or implicit line
      // Text without a marker reads as a paragraph, or in a container that
      // is a group itself (a list stored as a node) as an item of the group:
      // the class Lexical would wrap it in, on every reader. With block ids,
      // its id is derived from its first character (see implicitBlockId).
      const containerGroup = this.$containerGroupSpec(cs);
      let attrs: Attrs =
        p.kind === 'line'
          ? shownMarkerAttrs(p.end!, state.hidden)
          : {
              [TYPE_KEY]:
                containerGroup === null
                  ? 'paragraph'
                  : containerGroup.items[0].getType(),
            };
      // A line of another type in a container that is a group itself (a
      // quote in a list stored as a node, left by concurrent edits) reads as
      // an item of the group holding its content, as Lexical converts a block
      // put into the group (ListNode.splice), on every reader. A type this
      // editor does not register as a line is not converted: it makes the
      // binding read only (see $lineFromMarker), so that what it holds is
      // never rewritten as another type.
      if (containerGroup !== null && p.kind === 'line') {
        const info = this.state.editor._nodes.get(String(attrs[TYPE_KEY]));
        if (
          info !== undefined &&
          getLineSpec(info.klass) !== null &&
          !containerGroup.items.includes(info.klass)
        ) {
          attrs = {[TYPE_KEY]: containerGroup.items[0].getType()};
        }
      }
      // A line whose marker stores no block id (written without
      // BlockIdExtension, or by a client whose naming was not written) has
      // one derived from Yjs identity, as a line without a marker does.
      const storedId = attrs[STATE_PREFIX + blockIdState.key];
      const derivedId = this.settler.derivedLineId(p);
      attrs = this.settler.withDerivedLineId(attrs, derivedId);
      const prevUnit = p.end !== null ? byEnd.get(p.end) : implicit.shift();
      const merged =
        composedLine !== null && prevUnit === composedLine.into
          ? $getNodeByKey(composedLine.key)
          : null;
      const existing =
        merged !== null
          ? merged
          : prevUnit !== undefined && prevUnit.key !== null
            ? $getNodeByKey(prevUnit.key)
            : null;
      const ginfo = this.$groupOf(cs, attrs);
      const derived = this.$derivedFor(cs, ginfo);
      // A line the change did not touch (pulled in to regroup) keeps its
      // node, attributes and content.
      const untouched =
        merged === null &&
        affected !== null &&
        prevUnit !== undefined &&
        p.end !== null &&
        prevUnit.end === p.end &&
        prevEnd.get(prevUnit) === parsedPrevEnd &&
        !affected.has(prevUnit) &&
        $isElementNode(existing) &&
        existing.getType() === attrs[TYPE_KEY] &&
        sameFormats(prevUnit.start || EMPTY_FORMATS, p.start);
      const line = untouched
        ? (existing as ElementNode)
        : this.$lineFromMarker(
            attrs,
            $isElementNode(existing) ? existing : null,
            derived,
          );
      state.ids.noteStoredId(line.getKey(), storedId);
      if (!untouched) {
        this.$setChildren(
          line,
          this.$readInline(
            p.startItem,
            p.stop,
            p.start,
            line,
            merged !== null && prevUnit !== undefined && prevUnit.key !== null
              ? (() => {
                  const into = $getNodeByKey(prevUnit.key);
                  return $isElementNode(into) && !into.is(line)
                    ? into.getChildren()
                    : undefined;
                })()
              : $isElementNode(existing) && !existing.is(line)
                ? existing.getChildren()
                : undefined,
          ),
        );
      }
      const unit: Unit = prevUnit || {
        cs,
        end: p.end,
        first: null,
        key: null,
        kind: p.kind,
        last: null,
        sig: '',
        start: null,
      };
      unit.kind = p.kind;
      unit.end = p.end;
      unit.key = line.getKey();
      unit.start = p.start.size > 0 ? p.start : null;
      unit.sig = lineGroupSig(attrs, ginfo);
      unit.first = unit.last = unit.key;
      const group: GroupItem | null =
        ginfo === null
          ? null
          : {
              // Groups are identified blocks only at the root's top level
              // (BlockIdExtension's default): a group elsewhere gets none.
              derivedId: cs.y === state.root ? derivedId : null,

              gkey: ginfo.gkey,
              gsig: ginfo.gtype + '\u0000' + stableStringify(ginfo.gkey),
              gtype: ginfo.gtype,
              keys: [
                ...(ginfo.outer === null
                  ? new Array<null>(ginfo.level).fill(null)
                  : ginfo.outer.map(keyFromFields)),
                ginfo.gkey,
              ],
              level: ginfo.level,
              node: line,
              spec: ginfo.spec,
              wrappers:
                ginfo.outer === null
                  ? []
                  : ginfo.outer.map(o => {
                      const w = o[WRAPPER_FIELDS_KEY];
                      return w !== null &&
                        typeof w === 'object' &&
                        !Array.isArray(w)
                        ? (w as Attrs)
                        : null;
                    }),
            };
      pool.lines.add(line.getKey());
      entries.push({group, nodes: [line], unit});
      parsedPrevEnd = p.end;
    }
    // Tops: consecutive group items form groups.
    const tops: LexicalNode[] = [];
    for (let k = 0; k < entries.length; ) {
      const e = entries[k];
      if (e.group === null) {
        for (const n of e.nodes) {
          tops.push(n);
        }
        e.unit.first = e.nodes.length > 0 ? e.nodes[0].getKey() : null;
        e.unit.last =
          e.nodes.length > 0 ? e.nodes[e.nodes.length - 1].getKey() : null;
        k++;
        continue;
      }
      let m = k;
      const items: GroupItem[] = [];
      while (m < entries.length && entries[m].group !== null) {
        items.push(entries[m].group!);
        m++;
      }
      const groups = this.$buildGroups(items, 0, pool);
      const groupSet = new Set(groups.map(g => g.getKey()));
      for (let t = k; t < m; t++) {
        let n: LexicalNode = entries[t].group!.node;
        while (n.getParent() !== null && !groupSet.has(n.getKey())) {
          n = n.getParent()!;
        }
        entries[t].unit.first = entries[t].unit.last = n.getKey();
      }
      for (const g of groups) {
        tops.push(g);
      }
      k = m;
    }
    return {tops, units: entries.map(e => e.unit)};
  }

  private $buildGroups(
    items: GroupItem[],
    level: number,
    pool: Pool,
    ranges: [number, number][] = [],
    outerIds: ReadonlySet<string> = NO_IDS,
  ): ElementNode[] {
    const groups: ElementNode[] = [];
    // The key of a group at this level: an item's own key at its level, the
    // recorded outer key of a deeper item (null when not recorded).
    // Invariant: groups are told apart by their declared key fields only (a
    // list by its type). Why: Lexical merges adjacent lists of one type
    // whatever their start, so a tree read back never has two adjacent groups
    // Lexical would merge. Items whose other group fields differ (written
    // concurrently) share one group, whose fields come from its first item.
    const keyAt = (x: GroupItem): string | null => {
      const k = x.keys[level];
      if (k === null || k === undefined) {
        return null;
      }
      const key: Attrs = {};
      for (const f of x.spec.key) {
        const v = k[GROUP_FIELD_PREFIX + f];
        if (v !== undefined) {
          key[f] = v;
        }
      }
      return x.gtype + '\u0000' + stableStringify(key);
    };
    let i = 0;
    while (i < items.length) {
      let keyItem = items[i];
      let sig = keyAt(keyItem);
      let j = i + 1;
      while (j < items.length) {
        const s = keyAt(items[j]);
        if (
          items[j].level > level
            ? s !== null && sig !== null && s !== sig
            : s !== sig && sig !== null
        ) {
          break;
        }
        if (sig === null && s !== null) {
          // The first item that records this level's key decides it.
          sig = s;
          keyItem = items[j];
        }
        j++;
      }
      const k = keyItem.keys[level];
      const group = this.$createGroup(
        k === null || k === undefined ? items[i] : {...keyItem, gkey: k},
        pool,
        outerIds,
        level === 0 ? items[i].derivedId : null,
      );
      this.state.refresh.add(group.getKey());
      const kids = this.$groupChildren(
        items.slice(i, j),
        level,
        pool,
        $innerBlockIdsOf(outerIds, group, this.state.blockIds),
      );
      $detachFromKids(group, kids);
      this.$setChildren(group, kids);
      groups.push(group);
      ranges.push([i, j]);
      i = j;
    }
    return groups;
  }

  private $groupChildren(
    items: GroupItem[],
    level: number,
    pool: Pool,
    outerIds: ReadonlySet<string>,
  ): LexicalNode[] {
    const out: LexicalNode[] = [];
    let i = 0;
    while (i < items.length) {
      if (items[i].level <= level) {
        out.push(items[i].node);
        i++;
        continue;
      }
      let j = i;
      while (j < items.length && items[j].level > level) {
        j++;
      }
      const ranges: [number, number][] = [];
      const built = this.$buildGroups(
        items.slice(i, j),
        level + 1,
        pool,
        ranges,
        outerIds,
      );
      for (let gi = 0; gi < built.length; gi++) {
        const g = built[gi];
        const spec = items[i].spec;
        // The group keeps the wrapper that holds it, so that a full read of
        // an unchanged document gives back the same nodes and the selection in
        // them stays. Otherwise a pooled wrapper. Invariant: never a line of
        // this read, the group it will hold, or one of its ancestors. Why:
        // that would build a cycle.
        const own = g.getParent();
        let wrapper: ElementNode | undefined;
        if (
          own !== null &&
          pool.levelKeys.has(own.getKey()) &&
          !pool.lines.has(own.getKey()) &&
          klassOf(own) === spec.items[0]
        ) {
          wrapper = own;
        } else {
          do {
            wrapper = pool.levels.shift();
          } while (
            wrapper !== undefined &&
            (!pool.levelKeys.has(wrapper.getKey()) ||
              pool.lines.has(wrapper.getKey()) ||
              wrapper.is(g) ||
              wrapper.isParentOf(g) ||
              klassOf(wrapper) !== spec.items[0])
          );
        }
        if (wrapper !== undefined) {
          pool.levelKeys.delete(wrapper.getKey());
        }
        // The wrapper's fields, as the first item of its group records them.
        let fields: Attrs = {};
        for (let k = i + ranges[gi][0]; k < i + ranges[gi][1]; k++) {
          const w = items[k].wrappers[level];
          if (w !== null && w !== undefined) {
            fields = w;
            break;
          }
        }
        const clean: Attrs = {};
        for (const f in fields) {
          if (!isUnsafeKey(f)) {
            clean[f] = fields[f];
          }
        }
        // The wrapper item's block id, as stored (in its nested items' outer
        // keys), or derived from its first nested item when none is.
        const wrapperStoredId = this.settler.withDerivedWrapperId(
          clean,
          items[i + ranges[gi][0]].derivedId,
          level,
        );
        if (wrapper === undefined) {
          const type = spec.items[0].getType();
          wrapper = this.$readStored(
            type,
            () =>
              $parseSerializedNode({
                ...clean,
                children: [],
                type,
                version: 1,
              } as unknown as SerializedLexicalNode) as ElementNode,
            () => $storedDefault(type) as ElementNode,
          );
          $setTextFields(wrapper, clean);
        } else if (
          stableStringify($levelItemFields(wrapper, spec)) !==
          stableStringify(clean)
        ) {
          const json = $schemaJSON(wrapper);
          for (const f in $levelItemFields(wrapper, spec)) {
            delete json[f];
          }
          Object.assign(json, clean);
          json.$ = clean.$ || {};
          json.type = wrapper.getType();
          const node = wrapper;
          this.$updateStored(node, () => {
            node.updateFromJSON(
              json as Parameters<ElementNode['updateFromJSON']>[0],
            );
          });
          wrapper = node.getLatest();
        }
        $setTextFields(wrapper, clean);
        $detachFromKids(wrapper, [g]);
        this.$setChildren(wrapper, [g]);
        this.state.ids.noteStoredId(wrapper.getKey(), wrapperStoredId);
        out.push(wrapper);
      }
      i = j;
    }
    return out;
  }

  private $createGroup(
    item: GroupItem,
    pool: Pool,
    outerIds: ReadonlySet<string>,
    derivedId: string | null,
  ): ElementNode {
    const list = pool.groups.get(item.gtype);
    const fields: Attrs = {};
    for (const k in item.gkey) {
      const f = k.slice(GROUP_FIELD_PREFIX.length);
      if (!isUnsafeKey(f)) {
        fields[f] = item.gkey[k];
      }
    }
    // A group's state is its own level's: where the editor has block ids, a
    // nested group never takes the block id of a group it is inside (an
    // item's marker keys are written one by one, so concurrent writes at two
    // levels can leave an outer group's id on a nested item).
    const storedId = this.settler.withGroupId(fields, outerIds, derivedId);
    // Prefer a pooled group with the same fields, then the same key fields
    // (a list of the same type keeps its node).
    const want = stableStringify(fields);
    let reused: ElementNode | undefined;
    if (list !== undefined && list.length > 0) {
      let at = list.findIndex(
        g => stableStringify($groupFields(g, item.spec)) === want,
      );
      if (at < 0) {
        at = list.findIndex(g => {
          const json = $schemaJSON(g);
          return item.spec.key.every(
            f => stableStringify(json[f]) === stableStringify(fields[f]),
          );
        });
      }
      reused = list.splice(Math.max(0, at), 1)[0];
    }
    if (reused !== undefined) {
      const current = $groupFields(reused, item.spec);
      if (stableStringify(current) !== want) {
        const json = $schemaJSON(reused);
        for (const f in current) {
          delete json[f];
        }
        Object.assign(json, fields);
        json.$ = fields.$ || {};
        json.type = reused.getType();
        const group = reused;
        this.$updateStored(group, () => {
          group.updateFromJSON(
            json as Parameters<ElementNode['updateFromJSON']>[0],
          );
        });
        $setTextFields(reused, fields);
      }
      this.state.ids.noteStoredId(reused.getKey(), storedId);
      return reused.getLatest();
    }
    const created = this.$readStored(
      item.gtype,
      () =>
        $parseSerializedNode({
          children: [],
          type: item.gtype,
          version: 1,
          ...fields,
        } as unknown as SerializedLexicalNode) as ElementNode,
      () => $storedDefault(item.gtype) as ElementNode,
    );
    $setTextFields(created, fields);
    this.state.ids.noteStoredId(created.getKey(), storedId);
    return created;
  }

  private $lineFromMarker(
    attrs: Attrs,
    existing: ElementNode | null,
    derived: ReadonlySet<string> | null,
  ): ElementNode {
    let type = attrs[TYPE_KEY];
    const info =
      typeof type === 'string' ? this.state.editor._nodes.get(type) : undefined;
    if (info === undefined || getLineSpec(info.klass) === null) {
      this.state.unknownTypes.add(String(type));
      type = 'paragraph';
      attrs = {[TYPE_KEY]: 'paragraph'};
    }
    if (existing !== null && existing.getType() === type) {
      this.$applyLineAttrs(existing, attrs, derived);
      return existing.getLatest();
    }
    const json = lineJSON(attrs, derived, type as string);
    return this.$readStored(
      type as string,
      () =>
        $parseSerializedNode(
          json as unknown as SerializedLexicalNode,
        ) as ElementNode,
      // As a line of a type it does not register.
      () =>
        $parseSerializedNode(
          lineJSON(
            {[TYPE_KEY]: 'paragraph'},
            derived,
            'paragraph',
          ) as unknown as SerializedLexicalNode,
        ) as ElementNode,
    );
  }

  /**
   * Set a line's fields and NodeState from its marker. `force`: the marker's
   * attributes changed in this transaction, so the fields are set even when
   * exportJSON shows no difference (a field exportJSON hides in the node's
   * current context, like `checked` outside a check list, must still follow
   * the marker).
   */
  private $applyLineAttrs(
    node: ElementNode,
    attrs: Attrs,
    derived: ReadonlySet<string> | null,
    force = false,
  ): void {
    const spec = getLineSpec(klassOf(node));
    if (spec === null) {
      return;
    }
    const current = $lineAttrs(node, derived);
    let same = true;
    const incoming: Attrs = {};
    for (const k of Object.keys(attrs).sort()) {
      if (isLineFieldKey(k, spec.fields, derived)) {
        incoming[k] = attrs[k];
      }
    }
    for (const k in incoming) {
      if (stableStringify(incoming[k]) !== stableStringify(current[k])) {
        same = false;
      }
    }
    for (const k in current) {
      if (k !== TYPE_KEY && !(k in incoming)) {
        same = false;
      }
    }
    if (same && !force) {
      return;
    }
    const json = $schemaJSON(node.getLatest());
    for (const f of spec.fields) {
      if (derived === null || !derived.has(f)) {
        delete json[f];
      }
    }
    const state: Attrs = {};
    for (const k in incoming) {
      if (k.startsWith(STATE_PREFIX)) {
        state[k.slice(STATE_PREFIX.length)] = incoming[k];
      } else {
        json[k.slice(FIELD_PREFIX.length)] = incoming[k];
      }
    }
    // Always stored (see $lineAttrs): absent means the default.
    if (spec.fields.has('textFormat') && json.textFormat === undefined) {
      json.textFormat = 0;
    }
    if (spec.fields.has('textStyle') && json.textStyle === undefined) {
      json.textStyle = '';
    }
    json.type = node.getType();
    this.$updateStored(node, () =>
      $setStateInOrder(
        node.updateFromJSON(
          json as Parameters<ElementNode['updateFromJSON']>[0],
        ),
        state,
      ),
    );
  }

  private $applyNodeAttrs(node: LexicalNode, y: YNode, placed = true): void {
    if (storedTypeOf(y) !== node.getType()) {
      // Replaced in place by a node of another type: same shared node.
      this.$retypeStored(node, y);
      return;
    }
    // The id it stores, in the index of who stores what (a change of the
    // attribute alone is settled like any other: see
    // BlockIdSettler#$settleIds).
    this.state.ids.noteStoredId(
      node.getKey(),
      y.getAttr(STATE_PREFIX + blockIdState.key),
    );
    const attrs = this.settler.$withDerivedNodeId(
      node,
      y,
      y.getAttrs() as Attrs,
      placed,
    );
    // Compare in the stored encoding (compact, textFormat always kept), what
    // this editor owns of it (see ownsNodeAttr). A value holding an array
    // hole is stored as null, which the class parses its own way (colWidths:
    // 0): applied, so the node shows what every reader shows.
    const fields = ownedFields(
      this.state.editor,
      node.getType(),
      node.getType(),
      true,
    );
    const owned = (x: Attrs) => {
      const out: Attrs = {};
      for (const k of Object.keys(x).sort()) {
        if (ownsNodeAttr(k, fields)) {
          out[k] = x[k];
        }
      }
      return stableStringify(out);
    };
    const holes: string[] = [];
    const differs =
      owned($nodeAttrs(node, holes, false)) !== owned(attrs) ||
      holes.length > 0;
    if (differs) {
      this.$updateStored(node, () => $applyStoredAttrs(node, attrs));
      if (
        $isElementNode(node) &&
        getGroupSpec(klassOf(node.getLatest())) !== null
      ) {
        // A group's fields changed (a list's start or type): its items'
        // derived fields are recomputed in the refresh after the read.
        this.state.refresh.add(node.getKey());
      }
    }
  }

  /** Replace a stored node whose type changed; its content moves along. */
  private $retypeStored(node: LexicalNode, y: YNode): void {
    const type = storedTypeOf(y);
    const info = this.state.editor._nodes.get(type);
    if (info === undefined) {
      this.state.unknownTypes.add(type);
      return;
    }
    const attrs = y.getAttrs() as Attrs;
    const json = joinSetMembersInJSON(
      nodeJSONFromAttrs(type, attrs),
      this.state.editor,
    );
    if ($isElementNode(node)) {
      json.children = [];
    }
    const next = this.$readStored(
      type,
      () => $parseSerializedNode(json as unknown as SerializedLexicalNode),
      () => null,
    );
    if (next === null) {
      return;
    }
    if ($isElementNode(node) && $isElementNode(next)) {
      $appendAll(next, node.getChildren());
    }
    const oldKey = node.getKey();
    this.state.yByKey.delete(oldKey);
    this.state.csByKey.delete(oldKey);
    $replaceStored(node, next);
    this.state.mapNode(next.getKey(), y);
    this.state.ids.noteStoredId(
      next.getKey(),
      attrs[STATE_PREFIX + blockIdState.key],
    );
    // Lexical keeps a node's slots with it: the new node takes the stored ones.
    $readSlots(this, next, y, attrs);
  }

  /**
   * The node that shows a stored node, with its stored fields, NodeState and
   * named slots: a read shows a node as stored even where an update that was
   * not written changed it (a follow-up the binding refused, whose
   * containers are read again: BlockIdExtension may have named a block that
   * the refused change moved, a transform may have set a slot, and that node
   * keeps its key).
   */
  private $storedNode(y: YNode): LexicalNode | null {
    const key = this.state.keyByY.get(y);
    const node = key === undefined ? null : $getNodeByKey(key);
    if (node === null) {
      return null;
    }
    this.$applyNodeAttrs(node, y, false);
    const now = this.state.keyByY.get(y);
    const shown = now === undefined ? null : $getNodeByKey(now);
    if (shown !== null) {
      // And its named slots (an update not written may have set one).
      $readSlots(this, shown, y);
    }
    return shown;
  }

  /** Create a stored node (and read its container) from its Y.Node. */
  $createStored(y: YNode): LexicalNode | null {
    const type = storedTypeOf(y);
    const info = this.state.editor._nodes.get(type);
    if (info === undefined) {
      this.state.unknownTypes.add(type);
      return null;
    }
    const attrs = y.getAttrs() as Attrs;
    const json = joinSetMembersInJSON(
      nodeJSONFromAttrs(type, attrs),
      this.state.editor,
    );
    const isElement = typeof attrs[KIND_KEY] === 'string';
    if (isElement) {
      json.children = [];
    }
    const node = this.$readStored(
      type,
      () => $parseSerializedNode(json as unknown as SerializedLexicalNode),
      () => $storedDefault(type),
    );
    this.state.mapNode(node.getKey(), y);
    // It shows the id it stores: in the index of who stores what.
    this.state.ids.noteStoredId(
      node.getKey(),
      attrs[STATE_PREFIX + blockIdState.key],
    );
    if ($isElementNode(node)) {
      const kind: Kind = attrs[KIND_KEY] === 'i' ? 'i' : 'b';
      // One container state per Y.Node: a stored node made again (its
      // editor node was dropped by an update the binding did not write, say)
      // keeps the one its earlier node had, which mapNode moved to it. A
      // second one would leave two states claiming the same items, and a
      // read of the older one would take them from the one the binding
      // reads remote changes with.
      const known = this.state.containers.get(y);
      const cs =
        known === undefined ? this.state.newCS(y, node.getKey(), kind) : known;
      cs.kind = kind;
      this.$readFull(cs, node);
    }
    $readSlots(this, node, y, attrs);
    return node;
  }

  // -------------------------------------------------------------------------
  // Inline content

  private $pieces(
    start: Item | null,
    stop: Item | null,
    formats: Formats,
  ): Piece[] {
    const pieces: Piece[] = [];
    const current = new Map(formats);
    let tattrs: Attrs | null = null;
    let tsig = '';
    let wrappers: WrapperValue[] = [];
    const snapshot = () => {
      if (tattrs === null) {
        tattrs = {};
        const all: Attrs = {};
        current.forEach((v, k) => {
          all[k] = v;
          if (!k.startsWith(WRAPPER_PREFIX)) {
            tattrs![k] = v;
          }
        });
        tsig = stableStringify(tattrs);
        wrappers = wrappersFromAttrs(all, this.wrapperFields);
      }
    };
    // As the editor shows it: without what is held back (see Hidden).
    const hidden = this.state.hidden;
    for (let it = start; it !== null && it !== stop; it = it.right) {
      if (!isShown(it, hidden)) {
        continue;
      }
      const content = it.content;
      if (content instanceof ContentFormat) {
        if (content.value === null) {
          current.delete(content.key);
        } else {
          current.set(content.key, content.value);
        }
        tattrs = null;
        continue;
      }
      if (!it.countable) {
        continue;
      }
      snapshot();
      if (content instanceof ContentString) {
        const str =
          hidden === null ? content.str : shownText(content.str, it, hidden);
        const caret = this.caretIn(it, hidden);
        let pos = 0;
        str.split('\n').forEach((part, i) => {
          if (i > 0) {
            pieces.push({item: it, kind: 'br', tattrs: tattrs!, wrappers});
            pos++;
          }
          for (const run of tabRuns(part, tattrs!, tsig)) {
            const holds = caret >= pos && caret < pos + run.text.length;
            const inRun = caret - pos;
            pos += run.text.length;
            const last = pieces[pieces.length - 1];
            if (
              last !== undefined &&
              last.kind === 'text' &&
              last.tsig === run.tsig &&
              !isTabText(run.tattrs) &&
              sameWrappers(last.wrappers, wrappers)
            ) {
              if (holds) {
                last.caretAt = last.text.length + inRun;
              }
              last.text += run.text;
            } else {
              pieces.push({
                ...(holds ? {caretAt: inRun} : {}),
                item: it,
                kind: 'text',
                tattrs: run.tattrs,
                text: run.text,
                tsig: run.tsig,
                wrappers,
              });
            }
          }
        });
      } else if (content instanceof ContentType) {
        const name = (content.type.name as string) || '';
        if (name.startsWith(INLINE_PREFIX)) {
          pieces.push({item: it, kind: 'node', wrappers, y: content.type});
        }
      }
    }
    this.lastFormats = current;
    return pieces;
  }

  /**
   * Where the composition's character (see composedAt) is in the text the
   * editor shows of string item `it`, or -1.
   */
  private caretIn(it: Item, hidden: Hidden | null): number {
    const at = this.composedAt;
    if (
      at === null ||
      at.client !== it.id.client ||
      at.clock < it.id.clock ||
      at.clock >= it.id.clock + it.length
    ) {
      return -1;
    }
    const offset = at.clock - it.id.clock;
    if (hidden === null) {
      return offset;
    }
    let pos = 0;
    let shown = 0;
    for (const [len, isHidden] of hidden.runs(it)) {
      if (offset < pos + len) {
        return isHidden ? -1 : shown + offset - pos;
      }
      if (!isHidden) {
        shown += len;
      }
      pos += len;
    }
    return -1;
  }

  /**
   * Lexical inline nodes for the content between two items, reusing the
   * nodes currently under `el` (and `extraPool`) where possible.
   */
  $readInline(
    start: Item | null,
    stop: Item | null,
    formats: Formats,
    el: ElementNode | null,
    extraPool?: LexicalNode[],
  ): LexicalNode[] {
    const state = this.state;
    if (el !== null && state.hidden === null) {
      this.consumed.add(el.getKey());
    }
    // Whether `el` (a list item) holds a nested group first before the read:
    // the wrappers built below can move that child into a link before `el`'s
    // children are set (see the end).
    const firstWasGroup = el !== null && $isGroupNode(el.getFirstChild());
    const texts: TextNode[] = [];
    const brs: LexicalNode[] = [];
    const wrappersPool = new Map<string, ElementNode[]>();
    const collect = (nodes: LexicalNode[]) => {
      for (const n of nodes) {
        if ($isTextNode(n)) {
          texts.push(n);
        } else if ($isLineBreakNode(n)) {
          brs.push(n);
        } else if (
          $isElementNode(n) &&
          n.isInline() &&
          getWrapperSpec(klassOf(n)) !== null
        ) {
          let list = wrappersPool.get(n.getType());
          if (list === undefined) {
            list = [];
            wrappersPool.set(n.getType(), list);
          }
          list.push(n);
          collect(n.getChildren());
        } else if (
          $isParagraphNode(n) &&
          !state.yByKey.has(n.getKey()) &&
          !state.unitByKey.has(n.getKey()) &&
          !state.csByKey.has(n.getKey())
        ) {
          // A paragraph a read wrapped around inline content in a shadow
          // root (see $inShadowRoot), stored nowhere. A line of another
          // container that a refused change moved here is not one: reused
          // for the run, it went back to its own container on the re-read,
          // and the run was left without a paragraph.
          shown.push(n);
          collect(n.getChildren());
        }
      }
    };
    const shown: ElementNode[] = [];
    if (el !== null) {
      collect(el.getChildren());
    }
    if (extraPool !== undefined) {
      collect(extraPool);
    }
    // The nodes showing each segment, in order: several where a run's tab
    // characters are each a tab node (see tabRuns).
    const bySegment = new Map<string, TextNode[]>();
    for (const t of texts) {
      const s = state.segments.get(t.getKey());
      if (s !== undefined) {
        const list = bySegment.get(s);
        if (list === undefined) {
          bySegment.set(s, [t]);
        } else {
          list.push(t);
        }
      }
    }
    const usedTexts = new Set<TextNode>();
    let textPtr = 0;
    const takeText = (
      type: string,
      segment: string | null,
    ): TextNode | null => {
      if (segment !== null) {
        const t = (bySegment.get(segment) || []).find(
          n => !usedTexts.has(n) && n.getType() === type,
        );
        if (t !== undefined) {
          usedTexts.add(t);
          return t;
        }
        return null;
      }
      while (textPtr < texts.length) {
        const t = texts[textPtr++];
        if (
          !usedTexts.has(t) &&
          t.getType() === type &&
          !state.segments.has(t.getKey())
        ) {
          usedTexts.add(t);
          return t;
        }
      }
      return null;
    };
    const pieces = this.$pieces(start, stop, formats);
    // The node being composed (IME) keeps its key and its text: content a
    // remote change puts next to it (a join) goes into nodes of its own, so
    // the browser's composition stays in its DOM text node (Lexical does not
    // merge text into the composed node; they merge when it ends).
    const composedKey = state.editor._compositionKey;
    const found =
      composedKey === null
        ? undefined
        : texts.find(t => t.getKey() === composedKey);
    const composed = found === undefined ? null : found;
    let composedPlaced = false;
    if (composed !== null) {
      const ct = composed.getTextContent();
      const sameType = (piece: Piece): piece is Piece & {kind: 'text'} =>
        piece.kind === 'text' &&
        (piece.tattrs[TYPE_KEY] ?? 'text') === composed.getType();
      // Where the composition's character is known (see composedAt), the
      // node is the text around that character, with as many characters
      // before and after it as the node had: the browser goes on composing
      // at its offset in the node's DOM text, which stays right after that
      // character. Another occurrence of the node's text elsewhere holds
      // other characters (a collaborator's text, typed at the same place at
      // the same time, that came in before the composition's own) and is
      // not the node. Otherwise the node is the first occurrence of its
      // text.
      const caretAt = this.composedAt;
      const anchor =
        caretAt === null
          ? -1
          : pieces.findIndex(
              piece => sameType(piece) && piece.caretAt !== undefined,
            );
      for (let k = 0; ct !== '' && k < pieces.length; k++) {
        const piece = pieces[k];
        if (!sameType(piece) || (anchor >= 0 && k !== anchor)) {
          continue;
        }
        const text = piece.text;
        let at: number;
        let end: number;
        if (anchor >= 0) {
          const from = piece.caretAt! - (caretAt!.offset - 1);
          at = Math.max(0, from);
          end = Math.min(text.length, from + ct.length);
          // Never between the halves of a surrogate pair: where the start
          // would be, the node starts before the pair, and the browser's
          // offset then falls one unit before the character (a collaborator
          // put an astral character just there)
          if (at > 0 && isLowSurrogate(text.charCodeAt(at))) {
            at--;
          }
          if (end < text.length && isLowSurrogate(text.charCodeAt(end))) {
            end++;
          }
        } else {
          at = text.indexOf(ct);
          if (at < 0) {
            continue;
          }
          end = at + ct.length;
        }
        if (typeof piece.tattrs[SEGMENT_KEY] === 'string') {
          // A node kept apart from its neighbours (its run has a segment
          // key) is never split around the composition: its parts would be
          // nodes of one segment that Lexical does not merge when the
          // composition ends, and the editor would keep two nodes where the
          // document holds one. The composed node is the whole run.
          at = 0;
          end = text.length;
        }
        const parts: Piece[] = [];
        if (at > 0) {
          parts.push({...piece, text: text.slice(0, at)});
        }
        parts.push({...piece, composed: true, text: text.slice(at, end)});
        if (end < text.length) {
          parts.push({...piece, text: text.slice(end)});
        }
        pieces.splice(k, 1, ...parts);
        composedPlaced = true;
        break;
      }
      // Kept for its piece: no other piece reuses it, by position or by its
      // segment (a code token split by NodeState shares one segment).
      if (composedPlaced) {
        usedTexts.add(composed);
      }
    }
    // Reading nested inline nodes reads their own content: keep this
    // sequence's end formats for the caller.
    const endFormats = this.lastFormats;
    const top: LexicalNode[] = [];
    // The item each of `top` was read from first (see $inShadowRoot).
    const topItems: Item[] = [];
    type Frame = {
      value: WrapperValue;
      node: ElementNode;
      children: LexicalNode[];
    };
    const stack: Frame[] = [];
    const finish = (frame: Frame) => {
      this.$setChildren(frame.node, frame.children);
      // A wrapper that holds no text (any more: a collaborator deleted its
      // text around a line break) shows the textFormat and textStyle its
      // value stores, as a fresh reader does: they are stored exactly while
      // Lexical serializes them (see $wrapperAttrs), and one this client set
      // while the wrapper held text was not stored.
      const node = frame.node.getLatest();
      const {textFormat, textStyle} = frame.value.json;
      if (
        (node.getTextFormat() !==
          (typeof textFormat === 'number' ? textFormat : 0) ||
          node.getTextStyle() !==
            (typeof textStyle === 'string' ? textStyle : '')) &&
        node.shouldSerializeTextStyles()
      ) {
        this.$updateStored(node, () =>
          $setTextFields(node.getLatest(), frame.value.json),
        );
      }
    };
    const runLength = (from: number, sig: string) => {
      let n = 0;
      for (let k = from; k < pieces.length; k++) {
        if (!pieces[k].wrappers.some(w => w.sig === sig)) {
          break;
        }
        n++;
      }
      return n;
    };
    for (let k = 0; k < pieces.length; k++) {
      const piece = pieces[k];
      const want = piece.wrappers;
      // Close frames whose wrapper this piece does not have.
      let keepDepth = 0;
      while (
        keepDepth < stack.length &&
        want.some(w => w.sig === stack[keepDepth].value.sig)
      ) {
        keepDepth++;
      }
      while (stack.length > keepDepth) {
        finish(stack.pop()!);
      }
      // Open missing wrappers, longest run outermost.
      const missing = want
        .filter(w => !stack.some(f => f.value.sig === w.sig))
        .map(w => ({len: runLength(k, w.sig), w}))
        .sort(
          (a, b) =>
            b.len - a.len ||
            (a.w.type < b.w.type ? -1 : a.w.type > b.w.type ? 1 : 0),
        );
      for (const {w} of missing) {
        const node = this.$wrapperNode(w, wrappersPool);
        if (stack.length > 0) {
          stack[stack.length - 1].children.push(node);
        } else {
          top.push(node);
          topItems.push(piece.item);
        }
        stack.push({children: [], node, value: w});
      }
      const target = stack.length > 0 ? stack[stack.length - 1].children : top;
      const push = (node: LexicalNode) => {
        target.push(node);
        if (target === top) {
          topItems.push(piece.item);
        }
      };
      if (piece.kind === 'text') {
        let json = textJSONFromAttrs(piece.text, piece.tattrs);
        if (!state.editor._nodes.has(json.type as string)) {
          state.unknownTypes.add(json.type as string);
          json = {...json, type: 'text'};
        }
        json = joinSetMembersInJSON(json, state.editor);
        const segment =
          typeof piece.tattrs[SEGMENT_KEY] === 'string'
            ? (piece.tattrs[SEGMENT_KEY] as string)
            : null;
        let node: TextNode | null;
        if (piece.composed === true && composed !== null) {
          usedTexts.add(composed);
          node = composed;
        } else {
          node = takeText(json.type as string, segment);
        }
        if (node !== null) {
          // A comparison, not a write (see $splitSetMembers' `strict`).
          const currentSig = stableStringify($textAttrs(node, segment, false));
          // NodeState kept with another class's configuration (see
          // $foreignFlatKeys): built again as its own class reads it.
          const foreign = $foreignFlatKeys(node) !== null;
          if (foreign) {
            node.getWritable().__state = undefined;
          }
          if (foreign || currentSig !== piece.tsig) {
            const text = node;
            this.$updateStored(text, () => {
              $applyJSON(text, json);
            });
            node = text.getLatest();
          }
          if (node.getTextContent() !== piece.text) {
            node = node.setTextContent(piece.text);
          }
          $clampPointsIn(node);
        } else {
          node = this.$readStored(
            json.type as string,
            () =>
              $parseSerializedNode(
                json as unknown as SerializedLexicalNode,
              ) as TextNode,
            // As text of a type it does not register.
            () => $createTextNode(piece.text),
          );
        }
        // The node shows this piece, so it writes the piece's segment key
        // (the composed node keeps its key for a piece whose stored segment
        // a remote change made another).
        if (segment !== null) {
          state.setSegment(node.getKey(), segment);
        } else {
          state.segments.delete(node.getKey());
        }
        push(node);
      } else if (piece.kind === 'br') {
        let br = brs.shift() || $createLineBreakNode();
        const brState = lineBreakStateFromAttrs(piece.tattrs);
        if (
          stableStringify(
            lineBreakStateFromAttrs($lineBreakAttrs(br, {}, false)),
          ) !== stableStringify(brState)
        ) {
          br = br.getWritable();
          const info = state.editor._nodes.get(br.getType());
          const writable = br;
          this.$updateStored(writable, () =>
            $getWritableNodeState(writable).updateFromJSON(
              joinSetMembers(
                brState,
                info && info.sharedNodeState.sharedConfigMap,
                info && learnedSetKeys(info.sharedNodeState),
              ),
            ),
          );
        }
        push(br);
      } else {
        let node = this.$storedNode(piece.y);
        if (node === null) {
          node = this.$createStored(piece.y);
        }
        if (node !== null) {
          this.settler.noteInlineStored(node, piece.y);
        }
        // An inline element that cannot be empty (a mark whose text peers
        // deleted concurrently) is not shown, as Lexical would remove it.
        if (
          node !== null &&
          $isElementNode(node) &&
          !node.canBeEmpty() &&
          node.getChildrenSize() === 0
        ) {
          this.leftOut.add(node.getKey());
        } else if (node !== null) {
          push(node);
        }
      }
    }
    while (stack.length > 0) {
      finish(stack.pop()!);
    }
    this.lastFormats = endFormats;
    // An item that starts or stops holding a nested group first (a link put
    // around its nested list) is numbered differently by its group.
    const holder = el === null ? null : el.getParent();
    if (
      holder !== null &&
      $isGroupNode(holder) &&
      firstWasGroup !== $isGroupNode(top.length > 0 ? top[0] : null)
    ) {
      state.refresh.add(holder.getKey());
    }
    if (el !== null && el.isShadowRoot()) {
      return $inShadowRoot(top, topItems, shown, this.settler);
    }
    for (const p of shown) {
      // No longer a paragraph around inline content in a shadow root.
      this.settler.noteInlineRun(p, null);
    }
    return top;
  }

  private $wrapperNode(
    w: WrapperValue,
    pool: Map<string, ElementNode[]>,
  ): ElementNode {
    const node = this.$wrapperNodeFor(w, pool);
    if (w.instance !== null) {
      this.state.setSegment(node.getKey(), w.instance);
    } else {
      this.state.segments.delete(node.getKey());
    }
    return node;
  }

  private $wrapperNodeFor(
    w: WrapperValue,
    pool: Map<string, ElementNode[]>,
  ): ElementNode {
    const list = pool.get(w.type);
    const reused = list !== undefined ? list.shift() : undefined;
    if (reused !== undefined) {
      const own: Attrs = {};
      $wrapperAttrs(reused, own);
      const current = wrappersFromAttrs(own, this.wrapperFields)[0];
      // Without the text fields: they are stored only while the wrapper
      // holds no text, which its children, set after this, decide, and are
      // shown from the stored value then (see $readInline's `finish`).
      const sansText = (json: Attrs) => {
        const {textFormat: _f, textStyle: _s, ...rest} = json;
        return stableStringify(rest);
      };
      if (
        current === undefined ||
        sansText(current.json) !== sansText(w.json)
      ) {
        const spec = getWrapperSpec(klassOf(reused))!;
        const json = $schemaJSON(reused);
        for (const f of spec.fields) {
          delete json[f];
        }
        delete json.textFormat;
        delete json.textStyle;
        Object.assign(json, w.json);
        this.$updateStored(reused, () => {
          const writable = reused.updateFromJSON(
            json as Parameters<ElementNode['updateFromJSON']>[0],
          );
          $setTextFields(writable, w.json);
          $setStateInOrder(writable, (w.json.$ as Attrs) || {});
        });
        return reused.getLatest();
      }
      return reused;
    }
    return this.$readStored(
      w.type,
      () =>
        $parseSerializedNode({
          ...w.json,
          children: [],
        } as unknown as SerializedLexicalNode) as ElementNode,
      () => $storedDefault(w.type) as ElementNode,
    );
  }

  /**
   * The wrappers around a stored element (a link around a mark) whose
   * content this read changed, without reading the wrappers' line: one that
   * now holds no text shows the textFormat and textStyle its value stores,
   * as wrappers built by a read do (see $readInline's `finish`).
   */
  private $settleWrapperTextFields(): void {
    for (const [wrapper, json] of $unstoredWrapperTextFields(
      this.state,
      this.childrenSet,
      this.wrapperFields,
    )) {
      this.$updateStored(wrapper, () =>
        $setTextFields(wrapper.getLatest(), json),
      );
    }
    this.childrenSet.clear();
  }

  /** Make `el`'s children exactly `children`, keeping unchanged ends. */
  $setChildren(el: ElementNode, children: LexicalNode[]): void {
    if (this.state.yByKey.has(el.getKey())) {
      this.childrenSet.add(el.getKey());
    }
    const prev = el.getChildren();
    let left = 0;
    const max = Math.min(prev.length, children.length);
    while (left < max && prev[left].getKey() === children[left].getKey()) {
      left++;
    }
    let right = 0;
    while (
      right < max - left &&
      prev[prev.length - 1 - right].getKey() ===
        children[children.length - 1 - right].getKey()
    ) {
      right++;
    }
    if (left === prev.length && left === children.length) {
      return;
    }
    const middle = children.slice(left, children.length - right);
    const writable = el.getWritable();
    // Remote reads skip transforms: a group whose children change (or lose
    // a child to another element) recomputes its derived fields (list item
    // values) in the refresh that follows the read.
    const isGroup = (n: LexicalNode | null) =>
      $isElementNode(n) && getGroupSpec(klassOf(n)) !== null;
    if (isGroup(el)) {
      this.state.refresh.add(el.getKey());
    }
    for (const c of middle) {
      const parent = c.getParent();
      if (parent !== null && !parent.is(el) && isGroup(parent)) {
        this.state.refresh.add(parent.getKey());
      }
    }
    // An item whose first child changes between a nested group and other
    // content stops or starts being a wrapper item, which its group's
    // numbering counts differently (as a full read refreshes it).
    const holder = el.getParent();
    if (
      isGroup(holder) &&
      isGroup(prev.length > 0 ? prev[0] : null) !==
        isGroup(children.length > 0 ? children[0] : null)
    ) {
      this.state.refresh.add(holder!.getKey());
    }
    for (let i = left; i < prev.length - right; i++) {
      this.takenOut.add(prev[i].getKey());
    }
    // A reused node can hold `el` (concurrent edits moved a list into the
    // line of an item that list held): take `el` out first, or the tree
    // would get a cycle. Its own container's read places it again (see
    // $checkTakenOut).
    if (middle.some($isElementNode)) {
      const ancestors = new Set<NodeKey>();
      for (let p = el.getParent(); p !== null; p = p.getParent()) {
        ancestors.add(p.getKey());
      }
      if (middle.some(c => ancestors.has(c.getKey()))) {
        writable.remove(true);
        this.takenOut.add(el.getKey());
      }
    }
    const removeCount = prev.length - left - right;
    writable.splice(left, removeCount, middle);
  }

  private $repairSelection(): void {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      const a = $getNodeByKey(selection.anchor.key);
      const f = $getNodeByKey(selection.focus.key);
      if (a === null || f === null || !a.isAttached() || !f.isAttached()) {
        $setSelection(null);
      }
    }
  }
}

type GroupItemInfo = {
  gkey: Attrs;
  gtype: string;
  level: number;
  outer: Attrs[] | null;
  spec: GroupSpec;
};

/**
 * A new node of `type`'s class, as its constructor makes it: what a read
 * shows for stored content of `type` that its class throws on (see
 * Reader#$readStored). Not through the class's importJSON, which may reject
 * the values a node it exports always has.
 */
function $storedDefault(type: string): LexicalNode {
  const info = $getEditor()._nodes.get(type);
  if (info === undefined) {
    throw new Error(`@lexical/y: no node class of type ${type}`);
  }
  return $create(info.klass);
}

/**
 * Give `node` back the own properties `was` held (see Reader#$updateStored):
 * what its class changed before it threw is undone. Nothing is written where
 * it changed nothing.
 */
function $restoreNode(node: LexicalNode, was: Record<string, unknown>): void {
  const latest = node.getLatest() as unknown as Record<string, unknown>;
  const keys = Object.keys(latest);
  if (
    keys.length === Object.keys(was).length &&
    keys.every(k => hasOwn(was, k) && latest[k] === was[k])
  ) {
    return;
  }
  const writable = node.getWritable() as unknown as Record<string, unknown>;
  for (const k of Object.keys(writable)) {
    if (!hasOwn(was, k)) {
      delete writable[k];
    }
  }
  Object.assign(writable, was);
}

/**
 * Give a stored node the attributes `attrs` (see nodeJSONFromAttrs), as a
 * reader shows them.
 */
export function $applyStoredAttrs(node: LexicalNode, attrs: Attrs): void {
  const json = joinSetMembersInJSON(
    nodeJSONFromAttrs(node.getType(), attrs),
    $getEditor(),
  );
  if ($isElementNode(node)) {
    // Always stored (see $nodeAttrs): absent means the default.
    json.textFormat = json.textFormat ?? 0;
    json.textStyle = json.textStyle ?? '';
  }
  $applyJSON(node, json);
}

/**
 * A reused node about to take `kids` as children must not be inside one of
 * them (an old wrapper holding the reused group): detach it first, or the
 * tree would get a cycle.
 */
function $detachFromKids(node: ElementNode, kids: LexicalNode[]): void {
  for (const k of kids) {
    if ($isElementNode(k) && k.isParentOf(node)) {
      node.remove(true);
      return;
    }
  }
}

/**
 * Run a removal or move of the read's (see Reader#$readRegion) that Lexical
 * makes keep the selection where it was: where Lexical throws on a point of
 * the selection that is no longer valid (its node gone, detached in a
 * subtree the read took apart, or shorter than its offset), that point goes
 * to the other one (the selection is dropped when neither is valid), and the
 * change runs again. The first attempt may have made its change before
 * Lexical threw (insertBefore and insertAfter move the node, then update the
 * selection); each change is idempotent (it puts a node where it already
 * is, or removes one already removed), so running it again is right.
 *
 * Invariant: an invalid point of the selection never fails a read. Why: the
 * selection the read restores afterwards (see YBinding#$restoreSelection)
 * comes from relative positions wherever they resolve, and a failed read
 * rebuilds the editor (an undo or redo it was part of showed the old
 * content until then).
 */
function $keepingSelection(change: () => void): void {
  try {
    change();
  } catch (e) {
    if (!$dropInvalidPoints()) {
      throw e;
    }
    change();
  }
}

/**
 * Move each invalid point of the selection (see $keepingSelection) to the
 * other one, or drop the selection when neither is valid. Returns whether
 * anything changed.
 */
function $dropInvalidPoints(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return false;
  }
  const valid = (point: {key: NodeKey; offset: number}) => {
    const node = $getNodeByKey(point.key);
    if (node === null || !node.isAttached()) {
      return false;
    }
    const size = $isTextNode(node)
      ? node.getTextContentSize()
      : $isElementNode(node)
        ? node.getChildrenSize()
        : 0;
    return point.offset <= size;
  };
  const {anchor, focus} = selection;
  const anchorValid = valid(anchor);
  const focusValid = valid(focus);
  if (anchorValid && focusValid) {
    return false;
  }
  if (!anchorValid && !focusValid) {
    $setSelection(null);
  } else if (anchorValid) {
    focus.set(anchor.key, anchor.offset, anchor.type);
  } else {
    anchor.set(focus.key, focus.offset, focus.type);
  }
  return true;
}

/**
 * Keep the selection's points in a text node a read reused for other text
 * (see Reader#$readInline): a point past its new end goes to that end.
 *
 * Invariant: a read never leaves a point past its node's end. Why: Lexical
 * reads every point of the selection when the read removes or moves a node
 * (to keep the selection there), and throws on such a point, which fails the
 * whole read; the selection the read restores afterwards (see
 * YBinding#$restoreSelection) is resolved from relative positions, not from
 * these points, wherever it can be.
 */
function $clampPointsIn(node: TextNode): void {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return;
  }
  const key = node.getKey();
  const size = node.getTextContentSize();
  for (const point of [selection.anchor, selection.focus]) {
    if (point.type === 'text' && point.key === key && point.offset > size) {
      point.set(key, size, 'text');
    }
  }
}

/** Fields that tie a node into the tree, never copied between nodes. */
const TREE_FIELDS = new Set([
  '__key',
  '__parent',
  '__prev',
  '__next',
  '__first',
  '__last',
  '__size',
  '__type',
  '__state',
  '__slots',
  '__slotHost',
  '__cachedText',
]);

/**
 * Set a node's NodeState in the order of `state` (sorted by the reader):
 * NodeState keeps its keys in the order they were first set, so a node that
 * gained a key later would serialize its keys in another order than a peer
 * that read them at once.
 */
function $setStateInOrder(node: LexicalNode, state: Attrs): void {
  const current = node.__state;
  if (current !== undefined) {
    const json = current.toJSON() as Attrs;
    const nested = (json.$ as Attrs | undefined) || {};
    const have = Object.keys(nested).filter(k => k in state);
    const want = Object.keys(state).filter(k => k in nested);
    if (have.join('\u0000') !== want.join('\u0000')) {
      node.getWritable().__state = undefined;
    }
  }
  $getWritableNodeState(node).updateFromJSON(state);
}

/**
 * Apply serialized fields to a node. A class without a generated
 * updateFromJSON (a hand-written importJSON that reads fields of its own)
 * drops those fields in updateFromJSON: then the fields are taken from a
 * node its importJSON builds.
 */
function $applyJSON<T extends LexicalNode>(node: T, json: Attrs): T {
  if (json.$ !== undefined && node.__state !== undefined) {
    $setStateInOrder(node, json.$ as Attrs);
  }
  const w = node.updateFromJSON(
    json as Parameters<LexicalNode['updateFromJSON']>[0],
  ) as T;
  const after = w.exportJSON() as unknown as Attrs;
  let same = true;
  for (const k in json) {
    if (
      k !== 'children' &&
      k !== 'version' &&
      k !== '$' &&
      k !== 'textFormat' &&
      k !== 'textStyle' &&
      stableStringify(after[k]) !== stableStringify(json[k])
    ) {
      same = false;
      break;
    }
  }
  if (same) {
    return w;
  }
  const tmp = $parseSerializedNode({
    ...json,
    ...($isElementNode(w) ? {children: []} : {}),
  } as unknown as SerializedLexicalNode) as unknown as Record<string, unknown>;
  const target = w.getWritable() as unknown as Record<string, unknown>;
  for (const k of Object.keys(tmp)) {
    if (k.startsWith('__') && !TREE_FIELDS.has(k)) {
      target[k] = tmp[k];
    }
  }
  return target as unknown as T;
}

/**
 * The runs of `text` and the attributes each is read with. A tab's type
 * (`t: 'tab'`) and segment key apply to its `\t` only: other text inside
 * a tab's format range (left open there when the client that wrote the tab
 * removed it, while another client's content written inside it stays) is
 * read as plain text, never as tabs. Each `\t` is a run of its own (a tab
 * node holds one): two clients' `\t` can share one tab's range (one
 * written inside the other's run), and read as one tab node, one of them
 * was not shown.
 */
function tabRuns(
  text: string,
  tattrs: Attrs,
  tsig: string,
): {text: string; tattrs: Attrs; tsig: string}[] {
  if (text.length === 0) {
    return [];
  }
  if (decodeFormatValue(tattrs[TYPE_KEY]) !== 'tab') {
    return [{tattrs, text, tsig}];
  }
  const plain: Attrs = {...tattrs};
  delete plain[TYPE_KEY];
  delete plain[SEGMENT_KEY];
  const plainSig = stableStringify(plain);
  return (text.match(/\t|[^\t]+/g) || []).map(run =>
    run === '\t'
      ? {tattrs, text: run, tsig}
      : {tattrs: plain, text: run, tsig: plainSig},
  );
}

/** Whether text read with `tattrs` is a tab's (one node per `\t`). */
const isTabText = (tattrs: Attrs): boolean =>
  decodeFormatValue(tattrs[TYPE_KEY]) === 'tab';

function lineGroupSig(attrs: Attrs, group: GroupItemInfo | null): string {
  if (group === null) {
    return '';
  }
  return groupSig(
    attrs[TYPE_KEY] as string,
    groupKeySig({[GROUP_KEY]: group.gtype, ...group.gkey}, group.outer || []),
    group.level,
  );
}

/** Group attributes (g:<field>) from group fields. */
function keyFromFields(fields: Attrs): Attrs {
  const out: Attrs = {};
  for (const f in fields) {
    if (!isUnsafeKey(f) && f !== WRAPPER_FIELDS_KEY) {
      out[GROUP_FIELD_PREFIX + f] = fields[f];
    }
  }
  return out;
}

/**
 * The formats in effect after the live items from `start` up to `stop`
 * (exclusive), from `formats` in effect at `start`.
 */
function formatsAfter(
  start: Item | null,
  stop: Item | null,
  formats: Formats,
): Formats {
  const out = new Map(formats);
  for (let it = start; it !== null && it !== stop; it = it.right) {
    if (!it.deleted && it.content instanceof ContentFormat) {
      if (it.content.value === null) {
        out.delete(it.content.key);
      } else {
        out.set(it.content.key, it.content.value);
      }
    }
  }
  return out;
}

/**
 * Set the start formats of the units after the first of `from` from the
 * shared items, until they agree again past the last of `from`; returns the
 * units whose start changed (they must be read again).
 */
function recomputeUnitStarts(cs: CS, from: Unit[]): Unit[] {
  const units = cs.units;
  const changed: Unit[] = [];
  const index = new Map<Unit, number>();
  units.forEach((u, i) => index.set(u, i));
  let first = units.length;
  let last = -1;
  for (const u of from) {
    const i = index.get(u);
    if (i !== undefined) {
      first = Math.min(first, i);
      last = Math.max(last, i);
    }
  }
  if (first >= units.length) {
    return changed;
  }
  const formats = new Map<string, unknown>(units[first].start || EMPTY_FORMATS);
  const set = (u: Unit): boolean => {
    const next = formats.size > 0 ? new Map(formats) : null;
    const differs = !sameFormats(
      u.start || EMPTY_FORMATS,
      next || EMPTY_FORMATS,
    );
    if (differs) {
      changed.push(u);
    }
    u.start = next;
    return differs;
  };
  let k = first;
  let left: Item | null = null;
  for (let m = first - 1; m >= 0 && left === null; m--) {
    left = units[m].end;
  }
  for (
    let it = left === null ? cs.y._start : left.right;
    it !== null && k < units.length;
    it = it.right
  ) {
    if (!it.deleted && it.content instanceof ContentFormat) {
      const {key, value} = it.content;
      if (value === null) {
        formats.delete(key);
      } else {
        formats.set(key, value);
      }
    }
    // Text without an end item ends where the next unit (a block node)
    // starts.
    if (
      units[k].end === null &&
      k + 1 < units.length &&
      it === units[k + 1].end
    ) {
      k++;
      if (!set(units[k]) && k > last) {
        break;
      }
    }
    if (it === units[k].end) {
      k++;
      if (k < units.length && !set(units[k]) && k > last) {
        break;
      }
    }
  }
  return changed;
}

/** The formats in effect right after unit `k` (empty before the first). */
function formatsAfterUnit(units: Unit[], k: number): Formats {
  if (k < 0) {
    return EMPTY_FORMATS;
  }
  const u = units[k];
  const formats = new Map(u.start || EMPTY_FORMATS);
  if (u.end === null) {
    return formats;
  }
  let left: Item | null = null;
  for (let m = k - 1; m >= 0 && left === null; m--) {
    const e = units[m].end;
    if (e !== null && !e.deleted) {
      left = e;
    }
  }
  for (
    let it: Item | null = left === null ? u.cs.y._start : left.right;
    it !== null;
    it = it.right
  ) {
    if (!it.deleted && it.content instanceof ContentFormat) {
      const {key, value} = it.content;
      if (value === null) {
        formats.delete(key);
      } else {
        formats.set(key, value);
      }
    }
    if (it === u.end) {
      break;
    }
  }
  return formats;
}

/**
 * Marker `end`'s attributes as the editor shows them (see shownAttrs); a
 * marker without a type is a paragraph's.
 */
function shownMarkerAttrs(end: Item, hidden: Hidden | null): Attrs {
  const attrs = shownAttrs(end, hidden);
  if (typeof attrs[TYPE_KEY] !== 'string') {
    attrs[TYPE_KEY] = 'paragraph';
  }
  return attrs;
}

function isLineFieldKey(
  k: string,
  fields: ReadonlySet<string>,
  derived: ReadonlySet<string> | null,
): boolean {
  if (k.startsWith(STATE_PREFIX)) {
    return true;
  }
  if (k.startsWith(FIELD_PREFIX)) {
    const f = k.slice(FIELD_PREFIX.length);
    return (
      fields.has(f) && (derived === null || !derived.has(f)) && !isUnsafeKey(f)
    );
  }
  return false;
}

function lineJSON(
  attrs: Attrs,
  derived: ReadonlySet<string> | null,
  type: string,
): Attrs {
  const json: Attrs = {children: [], type, version: 1};
  const state: Attrs = {};
  let hasState = false;
  for (const k of Object.keys(attrs).sort()) {
    if (k.startsWith(STATE_PREFIX)) {
      const f = k.slice(STATE_PREFIX.length);
      if (!isUnsafeKey(f)) {
        state[f] = attrs[k];
        hasState = true;
      }
    } else if (k.startsWith(FIELD_PREFIX)) {
      const f = k.slice(FIELD_PREFIX.length);
      if (!isUnsafeKey(f) && (derived === null || !derived.has(f))) {
        json[f] = attrs[k];
      }
    }
  }
  if (hasState) {
    json.$ = state;
  }
  return json;
}

/**
 * The children a read gives a line that is a shadow root (a quote that holds
 * paragraphs): each run of inline content in it (text a collaborator typed
 * into a paragraph that another moved into the quote, which lands next to
 * the moved paragraph) shown in a paragraph of its own, as a shadow root
 * holds only blocks. Every reader shows it so; the next local edit there
 * stores it. Reuses the paragraphs an earlier read made (`shown`), in order.
 * `items`: the item each of `children` was read from first.
 *
 * Invariant: a block is what Lexical's shadow root transform leaves
 * unwrapped, an element or a decorator whose isInline() is false. Why: the
 * author's editor keeps a block decorator (an image) directly in the quote,
 * so every reader shows it there too.
 *
 * Invariant: such a paragraph gets the block id derived from the first item
 * of its run (see BlockIdSettler#noteInlineRun), as a line without a marker
 * does. Why: it is no unit, so it would have no id, and BlockIdExtension
 * would name it from each client's document of the moment, a name no one
 * stores (its update is a follow-up that changes the quote): clients and
 * fresh readers would each show their own.
 */
function $inShadowRoot(
  children: LexicalNode[],
  items: Item[],
  shown: ElementNode[],
  settler: BlockIdSettler,
): LexicalNode[] {
  const out: LexicalNode[] = [];
  let run: LexicalNode[] = [];
  let first: Item | null = null;
  let k = 0;
  const flush = () => {
    if (run.length > 0) {
      const p = k < shown.length ? shown[k++] : $createParagraphNode();
      // As a fresh read makes it: a refused follow-up's format, indent,
      // direction, text format or style, or NodeState of it is not kept;
      // its block id is derived again once it is in place (see
      // BlockIdSettler#noteInlineRun).
      const st = (p.exportJSON() as {$?: Record<string, unknown>}).$;
      const ownState =
        st !== undefined && Object.keys(st).some(s => s !== blockIdState.key);
      if (
        p.__format !== 0 ||
        p.__indent !== 0 ||
        p.__dir !== null ||
        p.__textFormat !== 0 ||
        p.__textStyle !== '' ||
        ownState
      ) {
        const w = p.getWritable();
        w.__format = 0;
        w.__indent = 0;
        w.__dir = null;
        w.__textFormat = 0;
        w.__textStyle = '';
        if (ownState) {
          w.__state = undefined;
        }
      }
      $detachFromKids(p, run);
      for (const c of p.getChildren()) {
        if (!run.includes(c)) {
          c.remove();
        }
      }
      p.splice(0, p.getChildrenSize(), run);
      settler.noteInlineRun(p, first);
      out.push(p);
      run = [];
    }
  };
  children.forEach((c, i) => {
    if (($isElementNode(c) || $isDecoratorNode(c)) && !c.isInline()) {
      flush();
      out.push(c);
    } else {
      if (run.length === 0) {
        first = items[i];
      }
      run.push(c);
    }
  });
  flush();
  for (; k < shown.length; k++) {
    settler.noteInlineRun(shown[k], null);
  }
  return out;
}

/**
 * The group nodes (and level wrappers) under a group read before, for the
 * read to reuse. An item whose only child is a group stored as its own node
 * (a list inside the item's line) is a line, not a level of the group.
 */
function collectPool(node: ElementNode, pool: Pool, state: State): void {
  const type = node.getType();
  const spec = getGroupSpec(klassOf(node));
  if (spec !== null) {
    let list = pool.groups.get(type);
    if (list === undefined) {
      list = [];
      pool.groups.set(type, list);
    }
    list.push(node);
    for (const c of node.getChildren()) {
      if ($isElementNode(c)) {
        const first = c.getFirstChild();
        if (
          first !== null &&
          first === c.getLastChild() &&
          $isElementNode(first) &&
          klassOf(first) === spec.klass &&
          !state.yByKey.has(first.getKey())
        ) {
          pool.levels.push(c);
          pool.levelKeys.add(c.getKey());
          collectPool(first, pool, state);
        }
      }
    }
  }
}

/**
 * The last child of `el` that the units before index `end` cover, or null
 * when they cover none that `el` holds.
 */
function $lastChildIn(
  el: ElementNode,
  units: readonly Unit[],
  end: number,
): LexicalNode | null {
  for (let k = end - 1; k >= 0; k--) {
    const key = units[k].last;
    const node = key === null ? null : $getNodeByKey(key);
    if (node !== null && el.is(node.getParent())) {
      return node;
    }
  }
  return null;
}

function sameWrappers(a: WrapperValue[], b: WrapperValue[]): boolean {
  return (
    a === b || (a.length === b.length && a.every((w, i) => w.sig === b[i].sig))
  );
}

function sameFormats(a: Formats, b: Formats): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [k, v] of a) {
    if (stableStringify(b.get(k)) !== stableStringify(v)) {
      return false;
    }
  }
  return true;
}

function isDeleted(y: YNode): boolean {
  for (let t: YNode | null = y; t !== null; t = t.parent) {
    if (t._item !== null && t._item.deleted) {
      return true;
    }
  }
  return false;
}

/**
 * The wrappers around the stored elements `keys` (a link around a mark, and
 * around that link's own stored ancestors up to the line) that hold no text
 * and show other text fields than their stored value, with that value's.
 * Lexical serializes a wrapper's textFormat and textStyle while it holds no
 * text, and the binding stores them exactly then (see $wrapperAttrs), so
 * every client must show the stored ones: one a client set while the
 * wrapper held text was not stored. The wrappers above a stored element are
 * formats in the sequence that holds its item; above the next stored
 * element, in that one's.
 */
export function $unstoredWrapperTextFields(
  state: State,
  keys: Iterable<NodeKey>,
  wrapperFields: (type: string) => OwnedFields | null,
  memo?: StoredFormatsMemo,
): [ElementNode, Attrs][] {
  const candidates: [ElementNode, Item][] = [];
  const seen = new Set<NodeKey>();
  for (const key of keys) {
    const el = $getNodeByKey(key);
    let anchor = state.yByKey.get(key);
    if (el === null || anchor === undefined) {
      continue;
    }
    for (
      let w: LexicalNode | null = el.getParent();
      $isElementNode(w);
      w = w.getParent()
    ) {
      const wy = state.yByKey.get(w.getKey());
      // Inline content ends at the line: a stored element that is not
      // inline (OverflowNode) still sits in it where its parent is inline.
      const parent = w.getParent();
      if (
        !w.isInline() &&
        !(wy !== undefined && $isElementNode(parent) && parent.isInline())
      ) {
        break;
      }
      if (wy !== undefined) {
        anchor = wy;
        continue;
      }
      if (
        anchor._item !== null &&
        !seen.has(w.getKey()) &&
        $isWrapper(w) &&
        w.shouldSerializeTextStyles()
      ) {
        seen.add(w.getKey());
        candidates.push([w, anchor._item]);
      }
    }
  }
  if (candidates.length === 0) {
    return [];
  }
  const attrs = attrsAtItems(
    candidates.map(([, item]) => item),
    memo,
  );
  const out: [ElementNode, Attrs][] = [];
  for (const [w, item] of candidates) {
    const value = wrappersFromAttrs(attrs.get(item)!, wrapperFields).find(
      v => v.type === w.getType(),
    );
    if (value === undefined) {
      continue;
    }
    const {textFormat, textStyle} = value.json;
    if (
      w.getTextFormat() !== (typeof textFormat === 'number' ? textFormat : 0) ||
      w.getTextStyle() !== (typeof textStyle === 'string' ? textStyle : '')
    ) {
      out.push([w, value.json]);
    }
  }
  return out;
}

/**
 * The formats stored in effect at the stored nodes (Y.Node items) of the
 * sequences read so far, by sequence: for lookups from several calls while
 * the document does not change (the transforms of one update).
 */
export type StoredFormatsMemo = Map<unknown, Map<Item, Attrs>>;

/**
 * The formats stored in effect at each of `items`: one pass along each
 * sequence that holds some of them (up to the last one, or, with `memo`,
 * along all of it once, noting them at every stored node).
 */
function attrsAtItems(
  items: Item[],
  memo?: StoredFormatsMemo,
): Map<Item, Attrs> {
  const bySequence = new Map<unknown, Set<Item>>();
  for (const item of items) {
    let set = bySequence.get(item.parent);
    if (set === undefined) {
      set = new Set();
      bySequence.set(item.parent, set);
    }
    set.add(item);
  }
  const out = new Map<Item, Attrs>();
  for (const [parent, wanted] of bySequence) {
    let known = memo === undefined ? undefined : memo.get(parent);
    if (memo !== undefined && known === undefined) {
      known = new Map();
      memo.set(parent, known);
      const formats = new Map<string, unknown>();
      for (
        let it = (parent as {_start: Item | null})._start;
        it !== null;
        it = it.right
      ) {
        if (it.content instanceof ContentType) {
          known.set(it, Object.fromEntries(formats) as Attrs);
        } else if (!isGone(it) && it.content instanceof ContentFormat) {
          if (it.content.value === null) {
            formats.delete(it.content.key);
          } else {
            formats.set(it.content.key, it.content.value);
          }
        }
      }
    }
    if (known !== undefined) {
      let all = true;
      for (const item of wanted) {
        const attrs = known.get(item);
        if (attrs === undefined) {
          all = false;
        } else {
          out.set(item, attrs);
        }
      }
      if (all) {
        continue;
      }
    }
    const formats = new Map<string, unknown>();
    let left = wanted.size;
    for (
      let it = (parent as {_start: Item | null})._start;
      it !== null && left > 0;
      it = it.right
    ) {
      if (wanted.has(it)) {
        out.set(it, Object.fromEntries(formats) as Attrs);
        left--;
      }
      if (!isGone(it) && it.content instanceof ContentFormat) {
        if (it.content.value === null) {
          formats.delete(it.content.key);
        } else {
          formats.set(it.content.key, it.content.value);
        }
      }
    }
  }
  return out;
}
