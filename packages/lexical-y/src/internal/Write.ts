/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Hidden} from './Hidden';

import invariant from '@lexical/internal/invariant';
import {
  ContentFormat,
  ContentString,
  ContentType,
  Item,
  iterateStructsByIdSet,
  Node as YNode,
  type Transaction,
} from '@y/y';
import {
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  type EditorState,
  type ElementNode,
  type LexicalNode,
  type NodeKey,
  type TextNode,
} from 'lexical';

import {pushAll} from './Arrays';
import {$withoutLevelId, innerBlockIds, NO_IDS} from './BlockIds';
import {Cursor, equalFormatValue, type Formats, isLiveContent} from './Cursor';
import {groupKeySig, groupSig} from './Groups';
import {
  $pushInline,
  Atoms,
  countLive,
  type DesiredContext,
  diffAtoms,
  PENDING_LINE_BREAK,
  readAtoms,
  type Run,
  setTextEnds,
  snapToWords,
} from './Inline';
import {
  $groupFields,
  $isInlineChild,
  $isWrapper,
  $levelItemFields,
  $lineAttrs,
  $nestedGroupOf,
  $nodeAttrs,
  $stateAttrs,
  $textAttrs,
  type Attrs,
  BLOCK_PREFIX,
  eachOuterLevel,
  equalValue,
  FIELD_PREFIX,
  getContainerGroupSpec,
  getGroupSpec,
  GROUP_FIELD_PREFIX,
  GROUP_KEY,
  groupAttrsOf,
  groupItemFields,
  type GroupSpec,
  INLINE_PREFIX,
  isMergeableText,
  isTextFieldKey,
  isTextHoldingWrapperValue,
  KIND_KEY,
  klassOf,
  LEVEL_KEY,
  MARKER,
  OUTER_KEY,
  outerWithoutTextFields,
  type OwnedFields,
  ownedFields,
  ownsFormat,
  ownsMarkerAttr,
  ownsMember,
  ownsNodeAttr,
  RUN_END,
  stableStringify,
  STATE_PREFIX,
  storedTypeOf,
  TEXT_FORMAT_PREFIX,
  TYPE_KEY,
  withUnownedMembers,
  WRAPPER_FIELDS_KEY,
  WRAPPER_PREFIX,
  wrapperFieldsOf,
} from './Schema';
import {
  attrOf,
  attrsBefore,
  attrsOf,
  deleteAttr,
  deleteItem,
  isGone,
  isHeld,
  isShownEnd,
  prevLiveEnd,
  setAttr,
  unheldLength,
} from './Seen';
import {$writeSlots} from './Slots';
import {
  type CS,
  EMPTY_FORMATS,
  isPartKey,
  nameOf,
  type Roles,
  type State,
  typeOf,
  type Unit,
} from './State';
import {$isHeldInline} from './Structure';
import {type Segment, type TextEditLog, TextReplay} from './TextEdits';

/** storedTypeOf, in the document the write sees (see Unread). */
const storedType = (y: YNode): string =>
  storedTypeOf({getAttr: (key: string) => attrOf(y, key), name: y.name});

// Writer: the editor to Yjs, for one commit. $plan finds what the commit
// changed (structure, inline content, lines, attributes); $run writes it
// into the shared sequences, from items the binding already knows (see
// Cursor), so a keystroke costs the line it changed, not the document.
//
// Invariant: what a commit did not change keeps its items, and text keeps an
// old item only if it comes from the same Lexical text node as before (see
// originOf). Why: a collaborator's concurrent edit of that content merges
// instead of being lost, and text a peer deleted is never resurrected from
// equal characters.
//
// Invariant: a follow-up (no one's edit) may set attributes or delete, never
// insert (see followUp). Why: every client that has the commit makes it, so
// an insert would be written once per client.

const __DEV__ = process.env.NODE_ENV !== 'production';

/** The fields a client owns on one marker (see Writer#markerOwners). */
export type MarkerOwners = {
  /** Of the line. */
  readonly fields: OwnedFields;
  /** Of its group, stored as `g:<field>` and in each outer level. */
  readonly groupFields: OwnedFields;
  /** Of its group's items, in each outer level's wrapper item. */
  readonly itemFields: OwnedFields;
};

type Desired = {
  kind: 'line' | 'node' | 'run';
  key: NodeKey | null;
  node: LexicalNode | null;
  nodes: LexicalNode[];
  marker: Attrs | null;
  /** Group context of a line, to compute its marker lazily. */
  ctx: {
    gattrs?: Attrs;
    level?: number;
    derived?: ReadonlySet<string>;
    outer?: Attrs[];
  } | null;
  sig: string;
  first: NodeKey;
  last: NodeKey;
  /**
   * For a part of a line that holds lines (see Writer#$pushLine): the
   * inline children of `node` this part holds. Its key is a part key.
   */
  part?: LexicalNode[];
};

/**
 * The key of part `i` of a line that holds lines (see Writer#$pushLine): no
 * Lexical node has it, so the line itself has no unit while it holds lines
 * and every write of it is a structure write of its container.
 */
const partKey = (key: NodeKey, i: number): NodeKey => key + '\u0001' + i;

/** The key of the line whose marker unit key `key` is (see partKey). */
const lineOfUnit = (key: NodeKey): NodeKey => {
  const at = key.indexOf('\u0001');
  return at === -1 ? key : key.slice(0, at);
};

/**
 * Whether a text node of a line stores the same attributes as a text node
 * next to it, both mergeable, not composing and not empty: every reader shows
 * them as one run (see DesiredContext.flattened). Lexical keeps two such nodes
 * apart while one is being composed, and where it compares their NodeState by
 * reference (equal objects parsed apart); the edit that ends the composition
 * changes the composed node alone, which the keystroke path (see
 * Writer#$writeTextEdit) would write without reading the author back.
 */
function $runsWithNeighbour(node: TextNode): boolean {
  if (
    !isMergeableText(node) ||
    node.isComposing() ||
    node.getTextContentSize() === 0
  ) {
    return false;
  }
  let attrs: string | null = null;
  for (const other of [node.getPreviousSibling(), node.getNextSibling()]) {
    if (
      $isTextNode(other) &&
      other.__type === node.__type &&
      other.__format === node.__format &&
      other.__style === node.__style &&
      isMergeableText(other) &&
      !other.isComposing() &&
      other.getTextContentSize() > 0
    ) {
      if (attrs === null) {
        attrs = stableStringify($textAttrs(node, null));
      }
      if (stableStringify($textAttrs(other, null)) === attrs) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Whether a text node is below element `el`, at any depth. Its textFormat
 * and textStyle are then derived: Lexical's reconciler sets them from the
 * first text it renders under the element, on each client that renders it.
 * Otherwise (empty, or holding only inline decorators or line breaks) they
 * are its own, stored: no client derives them, and Lexical sets them where
 * a delete empties the element (from the text removed). See
 * Writer#keepsStored.
 */
function $holdsText(el: ElementNode): boolean {
  for (let c = el.getFirstChild(); c !== null; c = c.getNextSibling()) {
    if ($isTextNode(c) || ($isElementNode(c) && $holdsText(c))) {
      return true;
    }
  }
  return false;
}

/** Whether line `line` holds lines (see Writer#$pushLine). */
export function $holdsLines(roles: Roles, line: ElementNode): boolean {
  for (let c = line.getFirstChild(); c !== null; c = c.getNextSibling()) {
    if ($isElementNode(c) && roles.$role(c) === 'line') {
      return true;
    }
  }
  return false;
}

/**
 * Whether `c`, a child of the line `line` that holds lines, is a plain
 * paragraph the normalization joins into `line` (see isJoinableParagraph in
 * lexical's LexicalStructure.ts).
 */
function $isJoinedParagraph(
  line: ElementNode,
  c: LexicalNode,
): c is ElementNode {
  return (
    $isParagraphNode(c) &&
    !c.isShadowRoot() &&
    !line.isShadowRoot() &&
    c.getChildren().every($isHeldInline)
  );
}

/** The inline children a desired line holds. */
function $lineChildren(d: Desired): LexicalNode[] {
  return d.part ?? (d.node as ElementNode).getChildren();
}

/**
 * The text node right after `node` in its line, through the inline elements
 * around and after it, or null.
 */
function $nextText(node: LexicalNode): TextNode | null {
  let at: LexicalNode = node;
  let next = at.getNextSibling();
  while (next === null) {
    const parent = at.getParent();
    if (!$isElementNode(parent) || !parent.isInline()) {
      return null;
    }
    at = parent;
    next = at.getNextSibling();
  }
  while ($isElementNode(next) && next.isInline()) {
    next = next.getFirstChild();
  }
  return $isTextNode(next) ? next : null;
}

export type WritePlan = {
  structural: Set<NodeKey>;
  inline: Set<NodeKey>;
  lines: Set<NodeKey>;
  attrs: Set<NodeKey>;
  /** Text nodes removed in this update: their previous text. */
  removedText: Map<NodeKey, string>;
  /**
   * Nodes this update moved (Lexical's record of explicit moves): a reorder
   * rewrites these rather than the neighbours they passed.
   */
  moved?: ReadonlySet<NodeKey> | null;
  /**
   * Text nodes Lexical's normalization merged in this update, the node kept
   * and the nodes merged into it (the update's `normalizedNodes`): which
   * removed text nodes were merged rather than deleted (see $mergedOrigins).
   * Null when not known.
   */
  merged?: ReadonlySet<NodeKey> | null;
  /**
   * Text nodes a split made in this update (EditorState#_splitNodes): the
   * node each was split from and where in that node's text it starts (see
   * $splitTailOrigins). Null when not known.
   */
  splits?: ReadonlyMap<NodeKey, [NodeKey, number]> | null;
  /**
   * The text edits Lexical recorded in this update (EditorState#_textEdits):
   * where a text node's text was spliced, split, merged or set, and where
   * nodes were inserted and removed (see TextReplay). Null when not known.
   */
  textEdits?: TextEditLog | null;
  /**
   * Elements whose attributes this update changed where a follow-up cannot
   * write them (see Writer#$run): the textFormat or textStyle of a group, a
   * level or a wrapper item, and of a line or stored container with text
   * below it, where they are derived (see $holdsText, Writer#keepsStored),
   * and any field of a paragraph a read made around text in a quote that
   * holds paragraphs (stored nowhere).
   */
  unwritable?: Set<NodeKey>;
};

export class Writer {
  /** Containers fully written in this transaction. */
  readonly written = new Set<NodeKey>();
  /** Lines and runs whose content was written (for the self-check). */
  readonly touched: {unit: Unit; d: Desired}[] = [];
  /**
   * Rewrite every line, changed or not (recovery after a failed write: the
   * shared content may lag the editor anywhere).
   */
  rewriteAll = false;
  /**
   * A follow-up of a commit (the binding's refresh, BlockIdExtension's
   * naming, the update that runs a newly registered transform over the
   * document), which every client that has the commit makes: it may set
   * attributes (of markers and stored nodes) and delete (units, and
   * children of a line or inline container), never insert content or
   * structure, which every client would insert again. A line without a
   * marker (text left by concurrent edits) has nowhere to keep its fields:
   * a change of them or of its content is not written (only a marker, an
   * insert, could keep the line as the editor shows it); readers derive its
   * block id (see Reader#$materialize). Any other change is not written:
   * its container is in `refused` (the binding reads it again), with a
   * warning in development.
   */
  followUp = false;
  /**
   * Containers where a follow-up's change was not written (see followUp),
   * or where the editor holds a block id that is not written (see
   * $levelFields): read again.
   */
  readonly refused = new Set<CS>();
  /**
   * Groups whose items this write rewrote, for the refresh after it (see
   * YBinding#flushRefresh).
   */
  readonly refreshGroups = new Set<NodeKey>();
  /** Whether a group's fields left out an outer group's id (see $levelFields). */
  private droppedOuterId = false;

  /** Old document order of the text nodes being rewritten (see originOf). */
  private originOrder = new Map<string, number>();
  /** The keys of originOrder, in that order. */
  private originKeys: string[] = [];
  /** Removed text nodes already attributed in the current write. */
  private claimed = new Set<string>();
  /** See $splitTailOrigins: computed on first use. */
  private splitTails: Map<NodeKey, number> | null = null;
  /** See idsOf: computed on first use. */
  private replay: TextReplay | null | undefined = undefined;
  /**
   * The old atom of each line break and inline node of the content whose
   * old origins (see oldOrigins) are the key: see $exactAtoms.
   */
  private readonly oldNodeAtoms = new WeakMap<
    [number, number, string][],
    Map<NodeKey, number>
  >();
  /**
   * Removed nodes whose whole old text a part split off them holds, with
   * that part (see setOriginOrder).
   */
  private reservedFor = new Map<string, NodeKey>();
  /**
   * Text nodes removed in this update whose old text was in the content
   * being rewritten: the only candidates for the origin of merged text (text
   * from anywhere else has no old characters here to keep), so the cost per
   * merged node is proportional to what is rewritten, not to the update.
   */
  private localRemoved: [string, string][] = [];
  /** See $someLineHoldsLines. */
  private someHoldsLines: boolean | null = null;
  /** Containers where a group item's marker attributes were written. */
  readonly groupWrites = new Set<CS>();
  /**
   * Stored nodes written with a value that holds an array hole (see
   * hasArrayHole): stored as null, which readers parse as the class does
   * (see YBinding#$normalize).
   */
  readonly holed = new Set<NodeKey>();
  /**
   * The fields this editor owns in the value of a format wrapper, or null
   * where it does not store the type as one (see wrapperFieldsOf).
   */
  readonly wrapperFields: (type: string) => OwnedFields | null;
  /** Per item, the stored item found from it (see $groupSource). */
  private readonly storedBefore = new Map<NodeKey, LexicalNode | null>();
  private readonly storedAfter = new Map<NodeKey, LexicalNode | null>();
  /**
   * The end each line unit had before this write, and the unit key each end
   * had then, noted when this write changes a unit's end, drops the unit or
   * gives its key another (see noteEnd).
   */
  private readonly endsBefore = new Map<NodeKey, Item | null>();
  private readonly ownersBefore = new Map<Item, NodeKey>();
  /**
   * What a line's marker and a node's shared node stored before this write,
   * by key, kept once read (see $markerBefore, nodeBefore): a node this
   * write gives new storage twice (a node moved into a container that is
   * itself written anew) is written from what it had before the first.
   */
  private readonly markersBefore = new Map<NodeKey, Attrs | null>();
  private readonly nodesBefore = new Map<NodeKey, [string, Attrs] | null>();
  /** Per item, the item found from it as before (see $groupSource). */
  private readonly priorBefore = new Map<NodeKey, LexicalNode | null>();
  private readonly priorAfter = new Map<NodeKey, LexicalNode | null>();
  private readonly priorOfGroup = new Map<
    NodeKey,
    {asBefore: boolean; attrs: Attrs; key: NodeKey} | null
  >();
  constructor(
    readonly state: State,
    readonly roles: Roles,
    readonly tr: Transaction,
    readonly prevState: EditorState,
    readonly plan: WritePlan,
  ) {
    const editor = state.editor;
    this.wrapperFields = type => wrapperFieldsOf(editor, type);
  }

  // -------------------------------------------------------------------------
  // Plan

  static $plan(
    roles: Roles,
    dirtyElements: Map<NodeKey, boolean>,
    dirtyLeaves: Set<NodeKey>,
    prevState: EditorState,
  ): WritePlan {
    const plan: WritePlan = {
      attrs: new Set(),
      inline: new Set(),
      lines: new Set(),
      removedText: new Map(),
      structural: new Set(),
    };
    const prevMap = prevState._nodeMap;
    for (const key of dirtyLeaves) {
      const prev = prevMap.get(key);
      if (prev !== undefined && $isTextNode(prev) && prev.__text !== '') {
        const now = $getNodeByKey(key);
        if (now === null || !now.isAttached()) {
          plan.removedText.set(key, prev.__text);
        }
      }
    }
    // Lexical marks nodes dirty for many reasons (the root on every update,
    // siblings whose links change): structure is read from the links.
    const moved = (node: LexicalNode): boolean => {
      const prev = prevMap.get(node.getKey());
      const now = node.getLatest();
      return (
        prev === undefined ||
        prev.__parent !== now.__parent ||
        prev.__prev !== now.__prev ||
        prev.__next !== now.__next
      );
    };
    const childrenChanged = (node: ElementNode): boolean => {
      const prev = prevMap.get(node.getKey());
      const now = node.getLatest();
      return (
        prev === undefined ||
        !$isElementNode(prev) ||
        prev.__first !== now.__first ||
        prev.__last !== now.__last ||
        prev.__size !== now.__size
      );
    };
    const markContainerOf = (node: LexicalNode) => {
      const parent = node.getParent();
      if (parent === null) {
        return;
      }
      const r = roles.$role(parent);
      if (r === 'root' || r === 'container') {
        (roles.$kind(parent) === 'b' ? plan.structural : plan.inline).add(
          parent.getKey(),
        );
      } else if (r === 'line') {
        plan.lines.add(parent.getKey());
      } else if (r === 'wrapper') {
        markOwner(node);
      } else {
        plan.structural.add(roles.$containerOf(parent).getKey());
      }
    };
    // A paragraph a read made around inline content in a shadow root (see
    // Reader's $inShadowRoot) is not stored yet: its line is written.
    const unstored = (p: ElementNode): boolean =>
      roles.$role(p) === 'container' &&
      !roles.state.csByKey.has(p.getKey()) &&
      !roles.state.yByKey.has(p.getKey()) &&
      prevMap.has(p.getKey());
    const markOwner = (node: LexicalNode) => {
      let p = node.getParent();
      while (p !== null && (roles.$role(p) === 'wrapper' || unstored(p))) {
        p = p.getParent();
      }
      if (p === null) {
        return;
      }
      const r = roles.$role(p);
      if (r === 'line') {
        plan.lines.add(p.getKey());
      } else if (r === 'root' || r === 'container') {
        (roles.$kind(p) === 'b' ? plan.structural : plan.inline).add(
          p.getKey(),
        );
      } else {
        plan.structural.add(roles.$containerOf(p).getKey());
      }
    };
    for (const [key, intentional] of dirtyElements) {
      const node = $getNodeByKey(key);
      if (node === null || !node.isAttached()) {
        continue;
      }
      // Lexical marks an element unintentionally dirty when only a child
      // changed, but can leave that mark on an element that was also cloned
      // and changed (a list type change): skip only when it was not cloned.
      if (!intentional && prevMap.get(key) === node.getLatest()) {
        continue;
      }
      const role = roles.$role(node);
      if (role === 'root') {
        if (childrenChanged(node as ElementNode)) {
          plan.structural.add(key);
        }
        continue;
      }
      // A paragraph a read made around text in a quote that holds
      // paragraphs is stored nowhere: no unit, container or node.
      const runParagraph =
        $isParagraphNode(node) &&
        !roles.state.unitByKey.has(key) &&
        !roles.state.csByKey.has(key) &&
        !roles.state.yByKey.has(key);
      {
        const prev = prevMap.get(key);
        const now = node.getLatest();
        // A line's and a stored container's text fields are stored where no
        // text is below it, and derived elsewhere (see $holdsText): a
        // follow-up writes the stored ones (see Writer#keepsStored), not the
        // derived ones, nor those of a group, a level or a wrapper item.
        const storedText =
          ((role === 'line' && !runParagraph) || role === 'container') &&
          $isElementNode(now) &&
          !$holdsText(now);
        if (
          $isElementNode(prev) &&
          $isElementNode(now) &&
          (((prev.__textFormat !== now.__textFormat ||
            prev.__textStyle !== now.__textStyle) &&
            !storedText) ||
            (runParagraph && !sameAttrFields(prev, now)))
        ) {
          (plan.unwritable ??= new Set()).add(key);
        }
      }
      if (moved(node)) {
        markContainerOf(node);
      } else if (
        (role === 'wrapper' || role === 'container') &&
        (role === 'wrapper') === roles.state.yByKey.has(key)
      ) {
        // isInline() changed (a class may compute it from a field): a format
        // over its characters became a stored node or the reverse, so the
        // content that holds it is written again.
        markContainerOf(node);
      }
      if (role === 'container') {
        plan.attrs.add(key);
        if (childrenChanged(node as ElementNode)) {
          (roles.$kind(node as ElementNode) === 'b'
            ? plan.structural
            : plan.inline
          ).add(key);
        }
      } else if (role === 'line') {
        plan.lines.add(key);
        // A node that just became a line (an emptied list wrapper) has no
        // unit yet: its container's structure changed.
        if (
          !roles.state.unitByKey.has(key) ||
          $holdsLines(roles, node as ElementNode)
        ) {
          plan.structural.add(roles.$containerOf(node).getKey());
        }
      } else if (role === 'group' || role === 'level') {
        plan.structural.add(roles.$containerOf(node).getKey());
      } else if (role === 'wrapper') {
        markOwner(node);
      } else if (role === 'leaf') {
        plan.attrs.add(key);
      }
    }
    for (const key of dirtyLeaves) {
      const node = $getNodeByKey(key);
      if (node === null || !node.isAttached()) {
        continue;
      }
      const role = roles.$role(node);
      if (role === 'text') {
        markOwner(node);
      } else if (role === 'leaf') {
        plan.attrs.add(key);
        if (moved(node)) {
          markContainerOf(node);
        }
      }
    }
    return plan;
  }

  $run(): void {
    const {state, plan} = this;
    // A line without a unit (it holds lines, see $pushLine, or is one of
    // them) is written with its container's structure.
    for (const key of plan.lines) {
      const node = $getNodeByKey(key);
      if (
        $isElementNode(node) &&
        node.isAttached() &&
        this.roles.$role(node) === 'line' &&
        (!state.unitByKey.has(key) || $holdsLines(this.roles, node))
      ) {
        plan.structural.add(this.roles.$containerOf(node).getKey());
      }
    }
    for (const key of plan.structural) {
      const cs = state.csByKey.get(key);
      const node = $getNodeByKey(key);
      if (cs === undefined || !$isElementNode(node) || this.written.has(key)) {
        continue;
      }
      if (this.followUp && cs.kind === 'b') {
        this.written.add(key);
        this.$writeFollowUp(cs, node);
      } else if (this.followUp && !this.$deletesOnly(key)) {
        this.written.add(key);
        this.refuse(cs, 'the content of', node);
      } else {
        this.$writeContainer(cs, node);
      }
    }
    for (const key of plan.inline) {
      const cs = state.csByKey.get(key);
      const node = $getNodeByKey(key);
      if (cs === undefined || !$isElementNode(node) || this.written.has(key)) {
        continue;
      }
      if (this.followUp && !this.$deletesOnly(key)) {
        this.refuse(cs, 'the content of', node);
      } else {
        this.$writeContainer(cs, node);
      }
    }
    for (const key of plan.lines) {
      const unit = state.unitByKey.get(key);
      const node = $getNodeByKey(key);
      if (
        unit === undefined ||
        !$isElementNode(node) ||
        this.written.has(unit.cs.key) ||
        (unit.end !== null && isGone(unit.end))
      ) {
        continue;
      }
      if (this.followUp) {
        // A follow-up writes nothing of a line in a container whose change
        // it does not write, nor of a line it moved to another container:
        // its group fields there come from a structure that is not stored.
        const now = node.isAttached()
          ? state.csByKey.get(this.roles.$containerOf(node).getKey())
          : undefined;
        if (this.refused.has(unit.cs) || now !== unit.cs) {
          this.refuse(unit.cs, 'the structure of', node);
          if (now !== undefined) {
            this.refused.add(now);
          }
          continue;
        }
      }
      this.droppedOuterId = false;
      const d = this.$lineDesired(node);
      if (this.droppedOuterId) {
        this.refused.add(unit.cs);
      }
      if (unit.end === null) {
        // A line without a marker is written (given one) only when this
        // update changed it (see $implicitChanged). A follow-up's change of
        // its content is refused: only a marker (an insert) could keep it.
        if (!this.followUp) {
          if (this.$implicitChanged(key)) {
            this.$writeLineAlone(unit, d);
          }
        } else if (this.$contentChanged(key) || this.$fieldsChanged(key)) {
          this.refuse(unit.cs, 'the content of', node);
        }
      } else if (this.$contentChanged(key)) {
        if (!this.followUp || this.$deletesOnly(key)) {
          this.$writeLineAlone(unit, d);
        } else {
          this.refuse(unit.cs, 'the content of', node);
        }
      } else {
        this.$writeMarker(unit.end, d);
        unit.sig = d.sig;
        this.touched.push({d, unit});
      }
    }
    for (const key of plan.attrs) {
      const y = state.yByKey.get(key);
      const node = $getNodeByKey(key);
      if (y === undefined || node === null || (y._item && isGone(y._item))) {
        continue;
      }
      this.$writeNodeAttrs(y, node);
    }
    if (this.followUp && plan.unwritable !== undefined) {
      // A follow-up's change of the text format or style of an element where
      // they are derived (text below it), or that is not a line or stored
      // container, is not written (see keepsStored), and readers do not
      // derive them from the stored content; one of the paragraph a read
      // made around text in a quote would need that paragraph stored (an
      // insert): its container is read again, as for any change a follow-up
      // does not write. Why: the author otherwise kept them while every
      // reader showed none.
      for (const key of plan.unwritable) {
        const node = $getNodeByKey(key);
        if (node !== null && node.isAttached()) {
          const cs = state.csByKey.get(this.roles.$containerOf(node).getKey());
          if (cs !== undefined) {
            this.refuse(cs, 'the text format of', node);
          }
        }
      }
    }
    this.unmapDeleted();
  }

  /**
   * Stored nodes this write deleted and did not give a new shared node (a
   * node-stored list that became a level of its group, for example) lose
   * their mapping, so that no later write goes into a deleted shared node,
   * where Yjs drops everything inserted.
   */
  private unmapDeleted(): void {
    iterateStructsByIdSet(this.tr, this.tr.deleteSet, s => {
      if (s instanceof Item && s.content instanceof ContentType) {
        this.state.unmapTree(s.content.type as YNode);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Containers

  $writeContainer(cs: CS, node: ElementNode): void {
    this.written.add(cs.key);
    if (cs.kind === 'i') {
      this.$writeInline(cs, node);
    } else {
      this.$writeStructure(cs, node);
    }
  }

  private $writeInline(cs: CS, node: ElementNode): void {
    const atoms = new Atoms();
    const oldOrigins = this.oldInlineOrigins(cs.key);
    this.setOriginOrder(oldOrigins);
    const ctx = this.$ctx(true);
    $pushInline(atoms, node.getChildren(), ctx);
    if (ctx.flattened === true) {
      this.refused.add(cs);
    }
    this.$writeSeq(
      cs.y,
      null,
      EMPTY_FORMATS,
      null,
      atoms,
      ctx.cursorAt,
      oldOrigins,
    );
  }

  /**
   * The origins of the old atoms of `units` (their text nodes in the
   * previous state, in order), or null when they cannot be known.
   */
  private oldOrigins(units: Unit[]): [number, number, string][] | null {
    const map = this.prevState._nodeMap;
    const out: [number, number, string][] = [];
    const nodeAtoms = new Map<NodeKey, number>();
    let pos = 0;
    const visit = (key: NodeKey) => {
      const node = map.get(key);
      if (node === undefined || !$isElementNode(node)) {
        return;
      }
      for (let c = node.__first; c !== null; ) {
        const child = map.get(c);
        if (child === undefined) {
          break;
        }
        if ($isTextNode(child)) {
          const len = child.__text.length;
          if (len > 0) {
            out.push([pos, pos + len, c]);
          }
          pos += len;
        } else if (
          $isElementNode(child) &&
          !this.state.yByKey.has(c) &&
          $isWrapper(child)
        ) {
          visit(c);
        } else {
          nodeAtoms.set(c, pos);
          pos += 1;
        }
        c = child.__next;
      }
    };
    for (const u of units) {
      if (
        u.key === null ||
        isPartKey(u.key) ||
        (u.kind !== 'line' && u.kind !== 'implicit')
      ) {
        return null;
      }
      visit(u.key);
      if (u.end !== null) {
        pos += 1;
      }
    }
    out.push([pos, pos, '']);
    this.oldNodeAtoms.set(out, nodeAtoms);
    return out;
  }

  /** The origins of an inline container's old atoms (see oldOrigins). */
  private oldInlineOrigins(key: NodeKey): [number, number, string][] | null {
    const map = this.prevState._nodeMap;
    if (!map.has(key)) {
      return null;
    }
    const out: [number, number, string][] = [];
    const nodeAtoms = new Map<NodeKey, number>();
    let pos = 0;
    const visit = (k: NodeKey) => {
      const node = map.get(k);
      if (node === undefined || !$isElementNode(node)) {
        return;
      }
      for (let c = node.__first; c !== null; ) {
        const child = map.get(c);
        if (child === undefined) {
          break;
        }
        if ($isTextNode(child)) {
          const len = child.__text.length;
          if (len > 0) {
            out.push([pos, pos + len, c]);
          }
          pos += len;
        } else if (
          $isElementNode(child) &&
          !this.state.yByKey.has(c) &&
          $isWrapper(child)
        ) {
          visit(c);
        } else {
          nodeAtoms.set(c, pos);
          pos += 1;
        }
        c = child.__next;
      }
    };
    visit(key);
    out.push([pos, pos, '']);
    this.oldNodeAtoms.set(out, nodeAtoms);
    return out;
  }

  private setOriginOrder(origins: [number, number, string][] | null): void {
    this.claimed = new Set();
    this.originOrder = new Map();
    this.originKeys = [];
    this.localRemoved = [];
    this.reservedFor = new Map();
    if (origins !== null) {
      origins.forEach(([, , k], i) => {
        this.originOrder.set(k, i);
        this.originKeys.push(k);
        const t = this.plan.removedText.get(k);
        if (t !== undefined && t.length > 0) {
          this.localRemoved.push([k, t]);
        }
      });
    }
    // A part Lexical split off a removed node of this content that holds
    // that node's whole old text keeps its characters, whatever was done to
    // the node's other parts (text typed in front of the cut, merged into
    // another node): reserved for it before any node claims them. Why:
    // typing at the start of a commented run after an equal word (`da ` then
    // a commented `da t2z`) leaves the typed text, cut off the comment, in
    // the word before, and that node claimed the start of the removed text
    // (`da t`) it begins with, so the words were deleted and inserted again:
    // `del "da" ins "da t30z"` for `t30z ` typed, which undid a peer's
    // concurrent delete there or moved its typing. This and the
    // other attributions of originOf serve the diff of a line whose text
    // Lexical's record does not explain (see TextReplay).
    const splits = this.plan.splits;
    if (splits !== undefined && splits !== null && splits.size > 0) {
      const removed = new Map(this.localRemoved);
      const parts = new Map<string, NodeKey[]>();
      for (const [part, [from]] of splits) {
        const old = removed.get(from);
        if (old === undefined) {
          continue;
        }
        const node = $getNodeByKey(part);
        if (
          $isTextNode(node) &&
          node.isAttached() &&
          node.getTextContent() === old
        ) {
          let list = parts.get(from);
          if (list === undefined) {
            list = [];
            parts.set(from, list);
          }
          list.push(part);
        }
      }
      for (const [from, list] of parts) {
        // One such part only (two equal ones cannot both be the old text).
        if (list.length === 1) {
          this.reservedFor.set(from, list[0]);
          this.claimed.add(from);
        }
      }
    }
  }

  /**
   * The identities of a text node's characters (see TextReplay): null where
   * Lexical's record does not explain the text of its line.
   */
  private idsOf(node: TextNode): readonly Segment[] | null {
    const replay = this.textReplay();
    return replay === null ? null : replay.idsOf(node.getKey());
  }

  /** This update's identities (see idsOf), for an editor that records. */
  private textReplay(): TextReplay | null {
    if (this.replay === undefined) {
      const editor = this.state.editor;
      const selection = $getSelection();
      this.replay = editor._recordTextEdits
        ? new TextReplay(
            this.plan.textEdits ?? null,
            this.prevState,
            $isRangeSelection(selection) &&
              selection.isCollapsed() &&
              selection.anchor.type === 'text'
              ? {key: selection.anchor.key, offset: selection.anchor.offset}
              : null,
            editor._compositionKey !== null,
          )
        : null;
    }
    return this.replay;
  }

  /**
   * The edits of a text node's own old text that give its text, from its
   * identities: [offset in the old text, characters deleted there, text
   * inserted there], in order. Null where its line's text is not explained
   * (see TextReplay), false where it holds another node's characters or its
   * own out of order (the line is written whole).
   */
  private exactEdits(
    node: TextNode,
    oldLength: number,
  ): [number, number, string][] | null | false {
    const ids = this.idsOf(node);
    if (ids === null) {
      return null;
    }
    const key = node.getKey();
    const out: [number, number, string][] = [];
    let at = 0;
    let ins = '';
    for (const s of ids) {
      if (s.key === null) {
        ins += s.text;
        continue;
      }
      if (s.key !== key || s.start < at || s.end > oldLength) {
        return false;
      }
      if (s.start > at || ins !== '') {
        out.push([at, s.start - at, ins]);
      }
      ins = '';
      at = s.end;
    }
    if (at < oldLength || ins !== '') {
      out.push([at, oldLength - at, ins]);
    }
    return out;
  }

  /**
   * Origin ranges of a text node's text (see Atoms.origins). Lexical merges
   * adjacent text nodes (a join, an unlink), so the text of a node that
   * existed before can hold the text of nodes removed in this update. A
   * merge that changed no text is found exactly (see $mergedOrigins).
   * Otherwise, from the end, a removed node takes the part its old text
   * ends with when that part is longer than what the node's own old text
   * ends with there (or equal, at the very end, if it is the removed node's
   * whole text and it came later before); then the same from the start; the
   * rest is the node's own.
   */
  private originOf(node: TextNode): [number, number, string][] {
    const key = node.getKey();
    const text = node.getTextContent();
    const prev = this.prevState._nodeMap.get(key);
    if (prev === undefined || !$isTextNode(prev)) {
      if (text.length === 0) {
        return [];
      }
      // New in this update (typed, or a split): free to keep old characters
      // (see $writeSeq), except a part split off a node this update deleted
      // (see $splitTailOrigins), which keeps that node's characters, not
      // equal ones of another node (`extract()` of `ab t7z l` from
      // `ab`|`t7z `|`la `: the `a ` left keeps the one of `la `).
      const rec = this.plan.splits ? this.plan.splits.get(key) : undefined;
      if (rec !== undefined && this.reservedFor.get(rec[0]) === key) {
        // The whole old text of the node it was split from (see
        // setOriginOrder).
        return [[0, text.length, rec[0]]];
      }
      if (rec !== undefined) {
        const [from, offset] = rec;
        const old = this.plan.removedText.get(from);
        const merged = this.plan.merged;
        if (
          old !== undefined &&
          !(merged && merged.has(from)) &&
          old.startsWith(text, offset)
        ) {
          return [[0, text.length, from]];
        }
      }
      return [[0, text.length, key]];
    }
    const own = prev.__text;
    const merged = this.$mergedOrigins(node, text, own);
    if (merged !== null) {
      return merged;
    }
    const removed = this.localRemoved.filter(([k]) => k !== key);
    const order = (k: string) => this.originOrder.get(k) ?? -1;
    // A removed node's text goes to one node only.
    const used = this.claimed;
    const commonSuffix = (a: number, b: number, t: string) => {
      let n = 0;
      while (
        n < b - a &&
        n < t.length &&
        text[b - 1 - n] === t[t.length - 1 - n]
      ) {
        n++;
      }
      return n;
    };
    const commonPrefix = (a: number, b: number, t: string) => {
      let n = 0;
      while (n < b - a && n < t.length && text[a + n] === t[n]) {
        n++;
      }
      return n;
    };
    // After a deletion that joined text (a range delete, Backspace or
    // Delete across lines) the caret sits at the join: the node's own text
    // stops there and a removed node's text follows.
    const sel = $getSelection();
    if (
      $isRangeSelection(sel) &&
      sel.isCollapsed() &&
      sel.anchor.key === key &&
      sel.anchor.type === 'text'
    ) {
      const cut = sel.anchor.offset;
      const rest = text.slice(cut);
      if (
        cut <= own.length &&
        rest.length > 0 &&
        text.startsWith(own.slice(0, cut)) &&
        !own.slice(cut).endsWith(rest)
      ) {
        let from: string | null = null;
        let len = -1;
        for (const [k, t] of this.localRemoved) {
          if (k !== key && !this.claimed.has(k) && t.endsWith(rest)) {
            // Prefer the removed text that is the most of what follows.
            if (len < 0 || t.length < len) {
              from = k;
              len = t.length;
            }
          }
        }
        if (
          from === null &&
          this.plan.removedText.size > this.localRemoved.length
        ) {
          // Text removed elsewhere follows the join (no old characters of
          // it here).
          from = FOREIGN_ORIGIN;
        }
        if (from !== null) {
          this.claimed.add(from);
          return [
            ...(cut > 0 ? ([[0, cut, key]] as [number, number, string][]) : []),
            [cut, text.length, from],
          ];
        }
      }
    }
    const head: [number, number, string][] = [];
    const tail: [number, number, string][] = [];
    let start = 0;
    let end = text.length;
    const claim = (atEnd: boolean, edge: boolean): boolean => {
      const common = atEnd ? commonSuffix : commonPrefix;
      const mine = common(start, end, own);
      if (
        commonSuffix(start, end, own) === end - start ||
        commonPrefix(start, end, own) === end - start
      ) {
        // The node's own old text explains all that is left.
        return false;
      }
      let best = 0;
      let at: string | null = null;
      let whole = false;
      for (const [k, t] of removed) {
        if (used.has(k)) {
          continue;
        }
        const n = common(start, end, t);
        if (
          n > best ||
          (n === best &&
            n > 0 &&
            at !== null &&
            (atEnd ? order(k) > order(at) : order(k) < order(at)))
        ) {
          best = n;
          at = k;
          whole = n === t.length;
        }
      }
      if (at === null || best === 0) {
        return false;
      }
      const wins =
        best > mine ||
        (edge &&
          whole &&
          best === mine &&
          (atEnd ? order(at) > order(key) : order(at) < order(key)));
      if (!wins) {
        return false;
      }
      used.add(at);
      if (atEnd) {
        tail.unshift([end - best, end, at]);
        end -= best;
      } else {
        head.push([start, start + best, at]);
        start += best;
      }
      return true;
    };
    for (let edge = true; end > start && claim(true, edge); edge = false) {
      // keep claiming from the end
    }
    for (let edge = true; end > start && claim(false, edge); edge = false) {
      // keep claiming from the start
    }
    const middle: [number, number, string][] = [];
    if (end > start) {
      // Text removed elsewhere (another line or container than the one
      // being rewritten) can have been merged in too: it has no old
      // characters here. What the node's own old text does not explain at
      // either end is then new text, never built from equal old characters.
      const foreign = this.plan.removedText.size > this.localRemoved.length;
      const p = foreign ? commonPrefix(start, end, own) : end - start;
      const q =
        foreign && p < end - start ? commonSuffix(start + p, end, own) : 0;
      if (p + q >= end - start) {
        middle.push([start, end, key]);
      } else {
        if (p > 0) {
          middle.push([start, start + p, key]);
        }
        middle.push([start + p, end - q, FOREIGN_ORIGIN]);
        if (q > 0) {
          middle.push([end - q, end, key]);
        }
      }
    }
    return [...head, ...middle, ...tail];
  }

  /**
   * The origins of a text node's text when it is its own old text followed
   * by the old texts of the text nodes that Lexical's normalization merged
   * into it in this update (see WritePlan#merged), in the old order, the last
   * one possibly cut where its rest starts the next text, a node new in this
   * update (Lexical split it there): what the normalization leaves when it
   * merges neighbours that store the same attributes into the first of them
   * (a comment, format or link removed, or the start of a node given the
   * formats of the run before it). A text node removed between them that the
   * normalization did not merge was deleted, and is skipped. Null when the
   * text is not that, or when which nodes were merged is not known. Why: such
   * a change touches formats only, so every character keeps its item; the
   * claims from the ends (see originOf) miss a removed text that the node's
   * own old text also ends with (" " after "…redanox " merged with
   * "…redapex"), and one that was cut, and the text was then deleted and
   * inserted again.
   *
   * Invariant: a removed node counts as merged only when the normalization
   * merged it, never because its text matches. Why: a node deleted in the
   * same update as its equal neighbour is unformatted ("same " deleted, the
   * next "same " merged) would keep the deleted node's items, and a
   * collaborator's edits of the surviving text would be lost or moved.
   */
  private $mergedOrigins(
    node: TextNode,
    text: string,
    own: string,
  ): [number, number, string][] | null {
    const key = node.getKey();
    const merged = this.plan.merged;
    const at = this.originOrder.get(key);
    if (
      merged === undefined ||
      merged === null ||
      !merged.has(key) ||
      at === undefined
    ) {
      return null;
    }
    const split = this.$splitTailOrigins(text, own, key, merged, at);
    if (split !== null) {
      return split;
    }
    if (text.length <= own.length || !text.startsWith(own)) {
      return this.$cutMergedOrigins(node, text, own, merged, at);
    }
    const out: [number, number, string][] = [[0, own.length, key]];
    let pos = own.length;
    for (let i = at + 1; pos < text.length; i++) {
      const k = this.originKeys[i];
      const old =
        k === undefined || this.claimed.has(k)
          ? undefined
          : this.plan.removedText.get(k);
      if (old === undefined) {
        return null;
      }
      if (!merged.has(k)) {
        // Deleted, not merged: none of its text is here.
        continue;
      }
      const n = Math.min(old.length, text.length - pos);
      if (!text.startsWith(old.slice(0, n), pos)) {
        return this.$cutMergedOrigins(node, text, own, merged, at);
      }
      if (n < old.length) {
        const next = $nextText(node);
        if (
          next === null ||
          this.prevState._nodeMap.has(next.getKey()) ||
          !next.getTextContent().startsWith(old.slice(n))
        ) {
          return this.$cutMergedOrigins(node, text, own, merged, at);
        }
      }
      out.push([pos, pos + n, k]);
      pos += n;
    }
    // Every node the record has merged into it is in its text: one merged in
    // an update and deleted in a later one of the same commit is not, and
    // another node's equal text there is not its own.
    for (let i = at + 1; i < this.originKeys.length; i++) {
      const k = this.originKeys[i];
      const old = this.claimed.has(k)
        ? undefined
        : this.plan.removedText.get(k);
      if (old === undefined) {
        break;
      }
      if (merged.has(k) && !out.some(o => o[2] === k)) {
        return null;
      }
    }
    for (let j = 1; j < out.length; j++) {
      this.claimed.add(out[j][2]);
    }
    return out;
  }

  /**
   * See $mergedOrigins: the part of a removed text node that Lexical split
   * off in this update and its normalization then merged into this node
   * (`t6z ` | *`t7z `* | `t8z `: `extract()` cuts `t8z ` into `t8` and a
   * new `z `, the app removes `t7z ` and `t8`, and `z ` is merged into
   * `t6z `). Lexical records the split (WritePlan#splits), so the merged
   * text is the removed node's old text from where the split cut it: the
   * node keeps a prefix of its own old text, then that rest, which keeps the
   * removed node's characters, then the whole old texts of the nodes merged
   * after it. Null when no such part was merged into this node, or the text
   * is not that. Why: the part is a node new in this update, with no old
   * text of its own, so the merged characters were written as new text
   * (`t7z t8z ` deleted, `z ` inserted), which undid or moved a peer's
   * concurrent edit of them (through `extract()`).
   */
  private $splitTailOrigins(
    text: string,
    own: string,
    key: NodeKey,
    merged: ReadonlySet<NodeKey>,
    at: number,
  ): [number, number, string][] | null {
    const splits = this.plan.splits;
    if (splits === undefined || splits === null || splits.size === 0) {
      return null;
    }
    if (this.splitTails === null) {
      // For each node split in this update, where its first part that the
      // normalization merged away (into another node) starts.
      this.splitTails = new Map();
      for (const [k, [from, offset]] of splits) {
        const now = $getNodeByKey(k);
        if (merged.has(k) && (now === null || !now.isAttached())) {
          const first = this.splitTails.get(from);
          if (first === undefined || offset < first) {
            this.splitTails.set(from, offset);
          }
        }
      }
    }
    const tails = this.splitTails;
    if (tails.size === 0) {
      return null;
    }
    // The removed nodes after it, up to the first one kept: the split one
    // (deleted, not merged: its own part was removed), then the merged ones.
    let source: [NodeKey, string] | null = null;
    const after: [NodeKey, string][] = [];
    for (let i = at + 1; i < this.originKeys.length; i++) {
      const k = this.originKeys[i];
      const old = this.claimed.has(k)
        ? undefined
        : this.plan.removedText.get(k);
      if (old === undefined) {
        break;
      }
      if (merged.has(k)) {
        if (source === null) {
          return null;
        }
        after.push([k, old]);
      } else if (source === null && tails.has(k)) {
        source = [k, old];
      }
    }
    if (source === null) {
      return null;
    }
    const rest = source[1].slice(tails.get(source[0])!);
    if (rest.length === 0) {
      return null;
    }
    let fit: [number, number] | null = null;
    let whole = '';
    for (let m = 0; m <= after.length; m++) {
      if (m > 0) {
        whole += after[m - 1][1];
      }
      const x = text.length - rest.length - whole.length;
      if (
        x >= 1 &&
        x <= own.length &&
        text.startsWith(own.slice(0, x)) &&
        text.startsWith(rest, x) &&
        text.endsWith(whole)
      ) {
        if (fit !== null) {
          return null;
        }
        fit = [x, m];
      }
    }
    // Every node the record merged after the split one is in the text (as
    // $mergedOrigins checks): one merged in an update and deleted in a
    // later one of the same commit, or by a transform, is not, and the
    // split tail there may be that node's equal text. Then this
    // path declines, and the other attributions (with the caret) decide.
    // Nor when the node's own old text explains all that is left and a
    // caret in it is elsewhere than at the join: a split tail merged and
    // deleted again by a later caret delete leaves that (`x z z ` |
    // `cut ` | `q z `, the tail `z ` of `q z ` merged, then removed, the
    // caret at the tail's end), and the deleted tail kept the items of the
    // node's own equal text, and deleted those. Without a caret (app code,
    // `extract()`), the split is taken.
    const sel = $getSelection();
    const caret =
      $isRangeSelection(sel) &&
      sel.isCollapsed() &&
      sel.anchor.key === key &&
      sel.anchor.type === 'text'
        ? sel.anchor.offset
        : -1;
    // And where the fit keeps only part of the node's own old text, Lexical
    // cut the node there in this update (a split record, its tail gone), as
    // `extract()` does at the start of its range: without that cut, the
    // node's own text was never cut, and a tail merged after it and deleted
    // again would take the node's equal characters (`x ` |
    // `t7z ` | `t8 `, the tail ` ` merged and deleted again by node edits,
    // kept the deleted space and deleted `x `'s).
    const cut =
      fit === null ||
      fit[0] >= own.length ||
      [...splits].some(
        ([part, [from, offset]]) =>
          from === key &&
          offset === fit![0] &&
          !(() => {
            const n = $getNodeByKey(part);
            return n !== null && n.isAttached();
          })(),
      );
    if (
      fit === null ||
      fit[1] < after.length ||
      !cut ||
      (own.startsWith(text) && caret >= 0 && caret !== fit[0])
    ) {
      return null;
    }
    const [x, m] = fit;
    const out: [number, number, string][] = [
      [0, x, key],
      [x, x + rest.length, source[0]],
    ];
    this.claimed.add(source[0]);
    let pos = x + rest.length;
    for (let f = 0; f < m; f++) {
      const [k, old] = after[f];
      out.push([pos, pos + old.length, k]);
      pos += old.length;
      this.claimed.add(k);
    }
    return out;
  }

  /**
   * See $mergedOrigins: a range delete across text nodes that Lexical then
   * merged (`t6z ` | *`t7z `* | `t8z `, `t7z t8` deleted: `t6z ` and `z `
   * merged into `t6z z `). The node keeps a part its old text starts with,
   * the first node merged into it a part its old text ends with, and the
   * nodes merged after that their whole old texts, which together make up
   * the text; the removed nodes between were deleted. Where more than one
   * split fits, the caret at the join (where a range delete leaves it)
   * picks one; with none, null (the diff decides). Why: from the text
   * alone, the merged characters went to the node's own old ones, or to an
   * equal run of another node, and the delete was written as a replacement
   * of the merged text, or deleted the wrong equal run, which undid a
   * peer's concurrent delete there, or moved its typing.
   */
  private $cutMergedOrigins(
    node: TextNode,
    text: string,
    own: string,
    merged: ReadonlySet<NodeKey>,
    at: number,
  ): [number, number, string][] | null {
    const key = node.getKey();
    // The nodes merged into it, in order (a node kept between ends them).
    const followers: [NodeKey, string][] = [];
    for (let i = at + 1; i < this.originKeys.length; i++) {
      const k = this.originKeys[i];
      const old = this.claimed.has(k)
        ? undefined
        : this.plan.removedText.get(k);
      if (old === undefined) {
        break;
      }
      if (merged.has(k)) {
        followers.push([k, old]);
      }
    }
    if (followers.length === 0) {
      return null;
    }
    const firstOld = followers[0][1];
    // Every split: [x, the length taken from the first merged node, how
    // many merged nodes]. Lexical removes a node it emptied before it
    // merges, so the node keeps at least one character of its own.
    const splits: [number, number, number][] = [];
    for (let m = 1; m <= followers.length; m++) {
      let whole = '';
      for (let f = 1; f < m; f++) {
        whole += followers[f][1];
      }
      if (!text.endsWith(whole)) {
        break;
      }
      for (
        let x = Math.min(own.length, text.length - whole.length);
        x >= 1;
        x--
      ) {
        const part = text.length - whole.length - x;
        if (
          part >= 1 &&
          part <= firstOld.length &&
          text.startsWith(own.slice(0, x)) &&
          text.startsWith(firstOld.slice(firstOld.length - part), x)
        ) {
          splits.push([x, part, m]);
        }
      }
    }
    // Of several splits, the caret a range delete leaves at the join picks
    // one. Without one there, a split is not taken when the node's own old
    // text explains all that is left: the record spans every update of a
    // commit, so a node merged in one update and deleted again in a later
    // one (or by a transform) is in it too, and a split of the text alone
    // credited it with characters it never held (`x ` | **`la `**
    // unbolded, then `la ` deleted, kept the deleted node's space and
    // deleted `x `'s).
    const sel = $getSelection();
    const caret =
      $isRangeSelection(sel) &&
      sel.isCollapsed() &&
      sel.anchor.key === key &&
      sel.anchor.type === 'text'
        ? sel.anchor.offset
        : -1;
    const atCaret = splits.filter(([x]) => x === caret);
    const chosen =
      atCaret.length === 1
        ? atCaret[0]
        : splits.length === 1 && caret < 0 && !own.startsWith(text)
          ? splits[0]
          : null;
    if (chosen === null) {
      return null;
    }
    const [x, part, m] = chosen;
    const out: [number, number, string][] = [
      [0, x, key],
      [x, x + part, followers[0][0]],
    ];
    let pos = x + part;
    for (let f = 1; f < m; f++) {
      const [k, old] = followers[f];
      out.push([pos, pos + old.length, k]);
      pos += old.length;
    }
    for (let f = 0; f < m; f++) {
      this.claimed.add(followers[f][0]);
    }
    return out;
  }

  $ctx(withOrigins = false): DesiredContext {
    const selection = $getSelection();
    let cursor: DesiredContext['cursor'] = null;
    if ($isRangeSelection(selection) && selection.isCollapsed()) {
      cursor = {
        key: selection.anchor.key,
        offset: selection.anchor.offset,
        type: selection.anchor.type,
      };
    }
    const state = this.state;
    return {
      cursor,
      cursorAt: -1,
      originOf: withOrigins ? node => this.originOf(node) : null,
      segments: {
        create: key => state.newSegment(key),
        get: key => state.segments.get(key),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Desired units

  $desiredUnits(container: ElementNode): Desired[] {
    const out: Desired[] = [];
    let run: LexicalNode[] = [];
    const flush = () => {
      if (run.length > 0) {
        out.push({
          ctx: null,
          first: run[0].getKey(),
          key: null,
          kind: 'run',
          last: run[run.length - 1].getKey(),
          marker: null,
          node: null,
          nodes: run,
          sig: '',
        });
        run = [];
      }
    };
    for (
      let child = container.getFirstChild();
      child !== null;
      child = child.getNextSibling()
    ) {
      const role = this.roles.$role(child);
      if (role === 'line') {
        flush();
        if (this.$someLineHoldsLines()) {
          this.$pushLine(out, this.$lineDesired(child as ElementNode));
        } else {
          out.push(this.$lineDesired(child as ElementNode));
        }
      } else if (role === 'group') {
        flush();
        this.$flattenGroup(child as ElementNode, 0, child.getKey(), out);
      } else if (!$isInlineChild(child)) {
        flush();
        const key = child.getKey();
        out.push({
          ctx: null,
          first: key,
          key,
          kind: 'node',
          last: key,
          marker: null,
          node: child,
          nodes: [],
          sig: '',
        });
      } else {
        run.push(child);
      }
    }
    flush();
    return out;
  }

  private $flattenGroup(
    group: ElementNode,
    level: number,
    top: NodeKey,
    out: Desired[],
    outer: Attrs[] = [],
    outerIds: ReadonlySet<string> = NO_IDS,
  ): void {
    const spec = getGroupSpec(klassOf(group))!;
    const fields = this.$levelFields(group, spec, outerIds);
    const gattrs = groupAttrsOf(group, fields);
    const gsig = groupKeySig(gattrs, outer);
    const innerIds = innerBlockIds(outerIds, fields);
    for (
      let item = group.getFirstChild();
      item !== null;
      item = item.getNextSibling()
    ) {
      const nested = $nestedGroupOf(item, spec);
      if (nested !== null && this.roles.$role(item) === 'level') {
        this.$flattenGroup(
          nested,
          level + 1,
          top,
          out,
          [
            ...outer,
            {
              ...fields,
              [WRAPPER_FIELDS_KEY]: $levelItemFields(item as ElementNode, spec),
            },
          ],
          innerIds,
        );
      } else {
        const d = this.$lineDesired(
          item as ElementNode,
          gattrs,
          level,
          spec.derived,
          top,
          gsig,
          outer,
        );
        if (this.$someLineHoldsLines()) {
          this.$pushLine(out, d);
        } else {
          out.push(d);
        }
      }
    }
  }

  /**
   * Whether a line of the editor may hold lines (see $pushLine): one this
   * write changes does, or one a write stored as the lines it holds still
   * does. Computed once per write: most writes have none.
   */
  private $someLineHoldsLines(): boolean {
    if (this.someHoldsLines === null) {
      const holders = this.state.holders;
      for (const key of holders) {
        const node = $getNodeByKey(key);
        if (
          !$isElementNode(node) ||
          !node.isAttached() ||
          !$holdsLines(this.roles, node)
        ) {
          holders.delete(key);
        }
      }
      this.someHoldsLines = holders.size > 0;
      for (const key of this.plan.lines) {
        if (this.someHoldsLines) {
          break;
        }
        const node = $getNodeByKey(key);
        this.someHoldsLines =
          $isElementNode(node) &&
          node.isAttached() &&
          this.roles.$role(node) === 'line' &&
          $holdsLines(this.roles, node);
      }
    }
    return this.someHoldsLines;
  }

  /**
   * Push desired line `d`. A line that holds lines (an update without the
   * normalization wrote a heading inside a list item) is pushed as the
   * lines the normalization leaves: a plain paragraph it holds is joined
   * into it with line breaks, its inline children are split around each
   * other line it holds (empty runs left out), every run a part with the
   * line's marker, and each held line in its place (recursively). Its text keeps
   * its items when the normalization then lifts the held lines out (the
   * structure it writes is the same lines), and a held line is never stored
   * as a node of its own (see Roles).
   */
  private $pushLine(out: Desired[], d: Desired): void {
    const line = d.node as ElementNode;
    const key = line.getKey();
    // A line with a unit was written whole (a line holding lines has none,
    // its parts have part keys): unless its content changed, it holds none.
    if (
      (this.state.unitByKey.has(key) && !this.plan.lines.has(key)) ||
      !$holdsLines(this.roles, line)
    ) {
      out.push(d);
      return;
    }
    this.state.holders.add(key);
    let run: LexicalNode[] = [];
    let i = 0;
    const flush = () => {
      if (run.length > 0) {
        out.push({...d, key: partKey(line.getKey(), i++), part: run});
        run = [];
      }
    };
    // A plain paragraph becomes lines of the line holding it, joined to its
    // neighbours with line breaks (see isJoinableParagraph in lexical's
    // LexicalStructure.ts): its content goes into the part it is in, with
    // the line breaks the normalization inserts, so that the normalization
    // then writes nothing new there. Whatever follows each child, as the
    // normalization sees it.
    let prev: 'none' | 'inline' | 'paragraph' | 'block' = 'none';
    for (const c of line.getChildren()) {
      if ($isJoinedParagraph(line, c)) {
        if (prev === 'inline' || prev === 'paragraph') {
          run.push(PENDING_LINE_BREAK);
        }
        pushAll(run, c.getChildren());
        const next = c.getNextSibling();
        if (next !== null && $isHeldInline(next)) {
          run.push(PENDING_LINE_BREAK);
        }
        prev = 'paragraph';
      } else if ($isElementNode(c) && this.roles.$role(c) === 'line') {
        flush();
        this.$pushLine(out, {
          ...this.$lineDesired(c),
          first: d.first,
          last: d.last,
        });
        prev = 'block';
      } else {
        run.push(c);
        prev = $isHeldInline(c) ? 'inline' : 'block';
      }
    }
    flush();
  }

  /**
   * A group's fields as stored on its items (see $withoutLevelId), as
   * readers read them (see BlockIdSettler#$placeUnit). An editor that holds
   * an id they leave out (set by an update that ran no transforms, see
   * $canonicalizeGroup) is read again where it was written (see
   * droppedOuterId), so that it shows what readers show.
   */
  private $levelFields(
    group: ElementNode,
    spec: GroupSpec,
    outerIds: ReadonlySet<string>,
  ): Attrs {
    const fields = $groupFields(group, spec);
    if ($withoutLevelId(fields, group, outerIds, this.state.blockIds)) {
      this.droppedOuterId = true;
    }
    return fields;
  }

  /** The desired unit of a line, its group context found from its parents. */
  $lineDesired(
    line: ElementNode,
    gattrs?: Attrs,
    level?: number,
    derived?: ReadonlySet<string>,
    top?: NodeKey,
    gsig?: string,
    outer?: Attrs[],
  ): Desired {
    if (gattrs === undefined) {
      // Find the group context by walking up.
      const parent = line.getParent();
      if (parent !== null && this.roles.$role(parent) === 'group') {
        const spec = getGroupSpec(klassOf(parent))!;
        // The outer levels, innermost first.
        const chain: [ElementNode, ElementNode][] = [];
        let g: ElementNode = parent;
        for (;;) {
          const levelItem = g.getParent();
          if (levelItem === null || this.roles.$role(levelItem) !== 'level') {
            break;
          }
          g = levelItem.getParent() as ElementNode;
          chain.push([g, levelItem]);
        }
        const outers: Attrs[] = [];
        let ids = NO_IDS;
        for (let c = chain.length - 1; c >= 0; c--) {
          const [og, levelItem] = chain[c];
          const gspec = getGroupSpec(klassOf(og)) || spec;
          const fields = this.$levelFields(og, gspec, ids);
          ids = innerBlockIds(ids, fields);
          outers.push({
            ...fields,
            [WRAPPER_FIELDS_KEY]: $levelItemFields(levelItem, gspec),
          });
        }
        return this.$lineDesired(
          line,
          groupAttrsOf(parent, this.$levelFields(parent, spec, ids)),
          chain.length,
          spec.derived,
          (chain.length > 0 ? chain[chain.length - 1][0] : parent).getKey(),
          undefined,
          outers,
        );
      }
      if (parent !== null) {
        const pspec = getContainerGroupSpec(klassOf(parent));
        if (pspec !== null) {
          derived = pspec.derived;
        }
      }
    }
    const sig =
      gattrs === undefined
        ? ''
        : groupSig(
            line.getType(),
            gsig ?? groupKeySig(gattrs, outer || []),
            level || 0,
          );
    const key = line.getKey();
    return {
      ctx: {derived, gattrs, level, outer},
      first: top || key,
      key,
      kind: 'line',
      last: top || key,
      marker: null,
      node: line,
      nodes: [],
      sig,
    };
  }

  /** The marker attributes of a desired line (computed when needed). */
  $marker(d: Desired): Attrs {
    if (d.marker === null) {
      const ctx = d.ctx || {};
      const marker = $lineAttrs(d.node as ElementNode, ctx.derived || null);
      if (ctx.gattrs !== undefined) {
        Object.assign(marker, ctx.gattrs);
        marker[LEVEL_KEY] = ctx.level || 0;
        if (ctx.outer !== undefined && ctx.outer.length > 0) {
          marker[OUTER_KEY] = ctx.outer;
        }
      }
      d.marker = marker;
    }
    return d.marker;
  }

  // -------------------------------------------------------------------------
  // Structure

  private $writeStructure(cs: CS, container: ElementNode): void {
    this.droppedOuterId = false;
    const desired = this.$desiredUnits(container);
    if (this.droppedOuterId) {
      this.refused.add(cs);
    }
    const old = cs.units;
    const oldIndex = new Map<NodeKey, number>();
    old.forEach((u, i) => {
      if (u.key !== null) {
        oldIndex.set(u.key, i);
      }
    });
    const matches: [number, number][] = [];
    desired.forEach((d, di) => {
      if (d.key === null) {
        return;
      }
      const oi = oldIndex.get(d.key);
      if (oi === undefined) {
        return;
      }
      const o = old[oi];
      if (
        (d.kind === 'line' && (o.kind === 'line' || o.kind === 'implicit')) ||
        (d.kind === 'node' &&
          o.kind === 'node' &&
          o.end !== null &&
          nameOf(o.end).startsWith(BLOCK_PREFIX) &&
          storedType(typeOf(o.end)) === d.node!.getType())
      ) {
        matches.push([di, oi]);
      }
    });
    // Anchors keep their items; every other unit is deleted and written
    // again, and what peers write in it meanwhile is lost (in a block node)
    // or stays at its old place. So what this update moved (Lexical's record
    // of explicit moves, see $movedUnit) is rewritten, not the units it
    // passed: those keep their order (only a move changes it), so all of them
    // can stay in place. A moved unit stays too where it is still in order
    // between them (put back where it was, indented). With no record (an
    // editor state set whole), and among moved units, the cheaper rewrite
    // wins: as many blocks as possible stay in place (a list counts as one
    // block, however many lines it has), then what costs most to rewrite (a
    // block node, whose whole subtree is copied, outweighs lines).
    const groupSize = new Map<NodeKey, number>();
    for (const d of desired) {
      groupSize.set(d.first, (groupSize.get(d.first) ?? 0) + 1);
    }
    const raw = matches.map(([di]) => unitCost(desired[di]));
    const lineTotal =
      raw.reduce(
        (a, c, k) => (desired[matches[k][0]].kind === 'node' ? a : a + c),
        0,
      ) + 1;
    const costs = raw.map((c, k) =>
      desired[matches[k][0]].kind === 'node' ? lineTotal + c : c,
    );
    const big = costs.reduce((a, b) => a + b, 0) + 1;
    const weightOf = new Map<number, number>();
    matches.forEach(([di], k) =>
      weightOf.set(di, big / groupSize.get(desired[di].first)! + costs[k]),
    );
    const weight = ([di]: [number, number]) => weightOf.get(di)!;
    const moved = this.plan.moved ?? null;
    const unmoved: [number, number][] = [];
    const movedMatches: [number, number][] = [];
    for (const m of matches) {
      if (
        moved !== null &&
        moved.size > 0 &&
        $movedUnit(desired[m[0]], container, moved)
      ) {
        movedMatches.push(m);
      } else {
        unmoved.push(m);
      }
    }
    const anchors = addInOrder(
      longestIncreasing(unmoved, weight),
      movedMatches,
      weight,
    );
    const n = anchors.length;
    // Changed line anchors join a neighbouring gap (the following one first)
    // so that a split or join diffs their characters with it.
    const gapNonEmpty = (k: number) => {
      const [pd, po] = k > 0 ? anchors[k - 1] : [-1, -1];
      const [nd, no] = k < n ? anchors[k] : [desired.length, old.length];
      return nd - pd > 1 || no - po > 1;
    };
    // A line without a marker that this update did not change, and right
    // after which it writes nothing (the end of the container, or the block
    // node it runs up to, kept as it is), stays without one (see
    // $implicitChanged); any other is given one. Why nothing right after it:
    // a segment written there starts at the end of the unit before it, which
    // is a marker only when one ends this line (with none, it started at the
    // container's start, and deleted everything before).
    const keepsImplicit = (k: number) => {
      const [di, oi] = anchors[k];
      return (
        old[oi].kind === 'implicit' &&
        !gapNonEmpty(k + 1) &&
        !this.$implicitChanged(desired[di].key!)
      );
    };
    const changed = (k: number) => {
      const [di, oi] = anchors[k];
      const d = desired[di];
      const o = old[oi];
      return (
        d.kind === 'line' &&
        (o.kind === 'implicit'
          ? !keepsImplicit(k)
          : d.part !== undefined ||
            (this.plan.lines.has(d.key!) && this.$contentChanged(d.key!)))
      );
    };
    const attach: ('alone' | 'next' | 'prev')[] = [];
    for (let k = 0; k < n; k++) {
      attach.push(
        !changed(k)
          ? 'alone'
          : gapNonEmpty(k + 1)
            ? 'next'
            : gapNonEmpty(k)
              ? 'prev'
              : 'alone',
      );
    }
    const newUnits: Unit[] = [];
    let lastEnd: Item | null = null;
    const used = new Set<Unit>();
    for (let k = 0; k <= n; k++) {
      const [pd, po] = k > 0 ? anchors[k - 1] : [-1, -1];
      const [nd, no] = k < n ? anchors[k] : [desired.length, old.length];
      if (gapNonEmpty(k)) {
        const oldSeg: number[] = [];
        const newSeg: number[] = [];
        if (k > 0 && attach[k - 1] === 'next') {
          oldSeg.push(po);
          newSeg.push(pd);
        }
        for (let i = po + 1; i < no; i++) {
          oldSeg.push(i);
        }
        for (let i = pd + 1; i < nd; i++) {
          newSeg.push(i);
        }
        if (k < n && attach[k] === 'prev') {
          oldSeg.push(no);
          newSeg.push(nd);
        }
        lastEnd = this.$writeSegment(
          cs,
          old,
          oldSeg,
          desired,
          newSeg,
          lastEnd,
          newUnits,
          used,
        );
      }
      if (k < n && attach[k] === 'alone') {
        const [di, oi] = anchors[k];
        const d = desired[di];
        const u = old[oi];
        used.add(u);
        if (d.kind === 'line') {
          if (u.kind === 'implicit' ? !keepsImplicit(k) : this.$changed(d)) {
            this.$writeLineAlone(u, d);
          } else if (u.kind === 'implicit') {
            // Left without a marker.
          } else if (u.sig !== d.sig || this.plan.lines.has(d.key!)) {
            // Only its attributes (or a derived field) may have changed.
            this.$writeMarker(u.end!, d);
            u.sig = d.sig;
            this.touched.push({d, unit: u});
          }
        }
        u.first = d.first;
        u.last = d.last;
        u.sig = d.sig;
        newUnits.push(u);
        lastEnd = u.end;
      }
    }
    for (const u of old) {
      if (!used.has(u)) {
        this.noteEnd(u);
        this.state.dropUnit(u);
      }
    }
    for (const u of newUnits) {
      const was = u.key === null ? undefined : this.state.unitByKey.get(u.key);
      if (was !== undefined && was !== u) {
        this.noteEnd(was);
      }
      this.state.setUnit(u);
    }
    cs.units = newUnits;
    this.$recomputeStarts(cs);
  }

  /**
   * Set every unit's start formats (the formats in effect where it starts)
   * from the shared items: deletes and inserts start from them, and a stale
   * value would leave a format open or close one early. A locally split
   * unit still covered by a hold keeps its shown start until release, with
   * the stored start recorded separately (see Hidden#starts).
   */
  private $recomputeStarts(cs: CS): void {
    const formats = new Map<string, unknown>();
    let it: Item | null = cs.y._start;
    for (const u of cs.units) {
      u.start = formats.size > 0 ? new Map(formats) : null;
      const hidden = this.state.hidden;
      const held = hidden === null ? undefined : hidden.starts.get(u);
      if (held !== undefined) {
        held.stored = u.start;
        u.start = held.shown;
      }
      if (u.end === null) {
        break;
      }
      for (; it !== null; it = it.right) {
        if (!isGone(it) && it.content instanceof ContentFormat) {
          const {key, value} = it.content;
          if (value === null) {
            formats.delete(key);
          } else {
            formats.set(key, value);
          }
        }
        if (it === u.end) {
          it = it.right;
          break;
        }
      }
    }
  }

  /** After a line's own write, the start formats of the units after it. */
  private $fixStartsAfter(u: Unit): void {
    let unit: Unit | undefined = u;
    // Stops where the next unit's start already agrees (usually at once).
    while (unit !== undefined) {
      if (unit.end === null || isGone(unit.end)) {
        return;
      }
      const left = prevLiveEnd(unit.end, this.state.hidden);
      const formats = new Map(unit.start || EMPTY_FORMATS);
      for (
        let it: Item | null = left === null ? unit.cs.y._start : left.right;
        it !== null;
        it = it.right
      ) {
        if (!isGone(it) && it.content instanceof ContentFormat) {
          const {key, value} = it.content;
          if (value === null) {
            formats.delete(key);
          } else {
            formats.set(key, value);
          }
        }
        if (it === unit.end) {
          break;
        }
      }
      let next: Item | null = unit.end.right;
      while (next !== null && !isShownEnd(next, this.state.hidden)) {
        next = next.right;
      }
      const nextUnit: Unit | undefined =
        next === null ? undefined : this.state.unitByEnd.get(next);
      if (nextUnit === undefined || sameFormatMaps(nextUnit.start, formats)) {
        return;
      }
      nextUnit.start = formats.size > 0 ? formats : null;
      unit = nextUnit;
    }
  }

  /**
   * Whether desired line `d` has content to write: its line changed, or it
   * is a part of a line that holds lines (written in full, see $pushLine).
   */
  private $changed(d: Desired): boolean {
    return (
      d.part !== undefined ||
      (this.plan.lines.has(d.key!) && this.$contentChanged(d.key!))
    );
  }

  /**
   * Whether a line's inline content differs from the previous state (node
   * identity, so a line cloned only because a sibling moved is unchanged).
   * In a follow-up, a node stored as its own shared node is unchanged while
   * it stays in place: its attributes are written on their own (plan.attrs).
   */
  $contentChanged(key: NodeKey): boolean {
    return this.rewriteAll || !this.$sameContent(key, true);
  }

  /**
   * Whether node `k` is unchanged since the previous state: its own fields
   * (`top`: a line or container, compared by content only, as its fields
   * are elsewhere) and its children, recursively.
   */
  private $sameContent(k: NodeKey, top: boolean): boolean {
    const prevMap = this.prevState._nodeMap;
    const before = prevMap.get(k);
    const now = $getNodeByKey(k);
    if (before === undefined || now === null) {
      return false;
    }
    if (!top && this.followUp && this.state.yByKey.has(k)) {
      return true;
    }
    if (!$isElementNode(before) || !$isElementNode(now)) {
      return before === now.getLatest();
    }
    // An inline element (a link) is cloned when its own properties change;
    // a change to its children alone does not clone it. The line itself is
    // compared by content only (its fields are on the marker).
    if (!top && before !== now.getLatest()) {
      return false;
    }
    let a = before.__first;
    let b = now.getLatest().__first;
    while (a !== null || b !== null) {
      if (a !== b || a === null || !this.$sameContent(a, false)) {
        return false;
      }
      const pa = prevMap.get(a)!;
      a = pa.__next;
      b = $getNodeByKey(b!)!.getLatest().__next;
    }
    return true;
  }

  /**
   * Whether the content of a line or inline container changed only by
   * losing children: each child it has now was its child before, in the
   * same order, and is unchanged. A follow-up may write such a change (its
   * diff only deletes).
   */
  private $deletesOnly(key: NodeKey): boolean {
    const prevMap = this.prevState._nodeMap;
    const before = prevMap.get(key);
    const now = $getNodeByKey(key);
    if (!$isElementNode(before) || !$isElementNode(now)) {
      return false;
    }
    let a = before.__first;
    for (let b = now.getLatest().__first; b !== null; ) {
      while (a !== null && a !== b) {
        if (!this.$removedFromDocument(a)) {
          return false;
        }
        a = prevMap.get(a)!.__next;
      }
      if (a === null || !this.$sameContent(b, false)) {
        return false;
      }
      a = prevMap.get(a)!.__next;
      b = $getNodeByKey(b)!.getLatest().__next;
    }
    for (; a !== null; a = prevMap.get(a)!.__next) {
      if (!this.$removedFromDocument(a)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Whether a node of the previous state left the document with everything
   * it held: a child an update moved elsewhere (adjacent lists merged, a
   * line lifted out of an item) was not deleted, so a follow-up that moved
   * it deletes nothing (its insert at the new place would not be written,
   * and the content would be lost for every reader).
   */
  private $removedFromDocument(key: NodeKey): boolean {
    const prevMap = this.prevState._nodeMap;
    const stack: NodeKey[] = [key];
    while (stack.length > 0) {
      const k = stack.pop()!;
      const node = $getNodeByKey(k);
      if (node !== null && node.isAttached()) {
        return false;
      }
      const prev = prevMap.get(k);
      if ($isElementNode(prev)) {
        for (let c = prev.__first; c !== null; ) {
          stack.push(c);
          const pc = prevMap.get(c);
          c = pc === undefined ? null : pc.__next;
        }
      }
    }
    return true;
  }

  /**
   * Whether this update changed a line without a marker (text concurrent
   * edits left without one, see Unit): its content, or its own fields or
   * NodeState, its block id included (the id a reader derives for it is set
   * by the read, so an id this update changed is one set on it).
   * Invariant: an unchanged one is not written. Why: it reads the same
   * without a marker, while each structural edit in its container would
   * otherwise give it one, so two clients making one at once would add two
   * (and an empty line).
   */
  $implicitChanged(key: NodeKey): boolean {
    if (this.$contentChanged(key)) {
      return true;
    }
    const now = $getNodeByKey(key);
    const prev = this.prevState._nodeMap.get(key);
    if (now === null || prev === undefined) {
      return true;
    }
    const latest = now.getLatest();
    if (prev === latest) {
      return false;
    }
    const state = (n: LexicalNode) => {
      const attrs: Attrs = {};
      $stateAttrs(n, attrs);
      return stableStringify(attrs);
    };
    return !sameOwnFields(prev, latest) || state(prev) !== state(latest);
  }

  /**
   * Whether this update changed a node's own fields (its format, indent or
   * direction, not its children or NodeState): for a line without a marker,
   * which keeps them nowhere, a follow-up's change of them is refused (see
   * followUp).
   */
  private $fieldsChanged(key: NodeKey): boolean {
    const prev = this.prevState._nodeMap.get(key);
    const now = $getNodeByKey(key);
    return (
      prev !== undefined &&
      now !== null &&
      prev !== now.getLatest() &&
      !sameAttrFields(prev, now.getLatest())
    );
  }

  private $refreshGroupsOf(line: LexicalNode): void {
    for (let p = line.getParent(); p !== null; p = p.getParent()) {
      const role = this.roles.$role(p);
      if (role === 'group') {
        this.refreshGroups.add(p.getKey());
      } else if (role !== 'level') {
        break;
      }
    }
  }

  /**
   * Delete exactly the content of an old unit, starting from its start
   * formats, and give the unit after it those as its own: it now starts
   * where the deleted unit started. Invariant: a unit's start (see
   * Unit.start) is the formats in effect after the live end item before it,
   * also after the units between were deleted, so every write that starts
   * there (this delete, a later unit's delete or diff, see $writeSegment
   * and $writeLineAlone) starts from the formats in effect there. Why: a
   * write computes the format items it writes from the formats it starts
   * from; from the start of a unit after a deleted block node (inside a
   * format run around that node), a delete, which then removed the format
   * items it found redundant (before deletes kept them, see Cursor#delete), removed the opener
   * of a run that goes on after the deleted content, and every reader
   * showed that text without the format while the author kept it (also on
   * a follow-up's delete).
   */
  private $deleteUnit(old: Unit[], idx: number): void {
    const u = old[idx];
    if (u.kind === 'node') {
      if (u.end !== null && !isGone(u.end)) {
        deleteItem(u.end, this.tr);
      }
    } else {
      const left = unitLeft(old, idx, this.state.hidden);
      const stop = unitStop(old, idx);
      const startItem = left === null ? u.cs.y._start : left.right;
      const cursor = this.cursor(u.cs.y, left, u.start || EMPTY_FORMATS);
      // Its own content starts at its first item, right after the end item
      // of the unit before it, also once this write deleted that one (a line
      // without a marker always follows one, see parseRange): live text
      // between (a line without a marker before a block node this write
      // deleted) is stepped over, never deleted with it (also where the
      // deleted unit is a line without a marker).
      const own = idx > 0 ? old[idx - 1].end : null;
      const from = own !== null && own !== left ? own.right : startItem;
      if (from !== startItem) {
        cursor.advance(countLive(startItem, from, this.state.hidden));
      }
      cursor.delete(countLive(from, stop, this.state.hidden));
    }
    if (idx + 1 < old.length) {
      old[idx + 1].start = u.start;
    }
  }

  private $writeSegment(
    cs: CS,
    old: Unit[],
    oldSeg: number[],
    desired: Desired[],
    newSeg: number[],
    left: Item | null,
    newUnits: Unit[],
    used: Set<Unit>,
  ): Item | null {
    const remaining: number[] = [];
    for (const oi of oldSeg) {
      const u = old[oi];
      if (u.kind === 'node') {
        this.$deleteUnit(old, oi);
        continue;
      }
      // Every other unit of the segment is diffed with the new lines, by
      // identity of its items: text that moved to another line (a join, a
      // range delete across lines) keeps its items, so a peer's concurrent
      // edits and formats in it stay with it, and text a peer deleted is
      // not re-inserted. A removed line diffs to a deletion.
      remaining.push(oi);
    }
    const lines = newSeg.filter(di => desired[di].kind !== 'node');
    const hidden = this.state.hidden;
    const heldSegment =
      hidden !== null &&
      remaining.some(
        oi => old[oi].key === hidden.ownerKey || hidden.starts.has(old[oi]),
      );
    // The formats in effect at `left`, where the content is diffed from: the
    // first remaining unit's start, also when node units before it were
    // deleted above (see $deleteUnit).
    const startFormats =
      remaining.length > 0
        ? old[remaining[0]].start || EMPTY_FORMATS
        : this.formatsAfter(left);
    // A previously split successor already has distinct inherited starts.
    // Keep its shown start for the diff/cursor, but seed raw scans from its
    // stored start: the held opener may be before this segment's first item.
    const inherited =
      hidden === null || remaining.length === 0
        ? undefined
        : hidden.starts.get(old[remaining[0]]);
    const storedStartFormats =
      inherited === undefined
        ? startFormats
        : inherited.stored || EMPTY_FORMATS;
    const startItem = left === null ? cs.y._start : left.right;
    const lineItems = new Map<number, Item>();
    if (remaining.length > 0 || lines.length > 0) {
      const oldStop =
        remaining.length > 0
          ? unitStop(old, remaining[remaining.length - 1])
          : startItem;
      const atoms = new Atoms();
      const oldOrigins = this.oldOrigins(remaining.map(oi => old[oi]));
      this.setOriginOrder(oldOrigins);
      const ctx = this.$ctx(true);
      const markerAt: number[] = [];
      // Old content that ends without a marker (text left before a block by
      // a concurrent edit) diffs against the new content without its last
      // end item, which is inserted after it: a trailing end item would
      // defeat the common suffix and rewrite that text.
      const openTail =
        remaining.length > 0 &&
        old[remaining[remaining.length - 1]].end === null &&
        lines.length > 0;
      lines.forEach((di, i) => {
        const d = desired[di];
        const last = openTail && i === lines.length - 1;
        if (d.kind === 'line') {
          $pushInline(atoms, $lineChildren(d), ctx);
          markerAt.push(atoms.length);
          if (!last) {
            atoms.pushSpecial({kind: 'marker', ref: d}, null);
          }
        } else {
          $pushInline(atoms, d.nodes, ctx);
          markerAt.push(atoms.length);
          if (!last) {
            atoms.pushSpecial({kind: 'runEnd', ref: d}, null);
          }
        }
      });
      if (ctx.flattened === true) {
        this.refused.add(cs);
      }
      const items = this.$writeSeq(
        cs.y,
        left,
        startFormats,
        oldStop,
        atoms,
        ctx.cursorAt,
        oldOrigins,
      );
      if (openTail) {
        const c = this.cursor(cs.y, left, startFormats);
        c.advance(atoms.length);
        const lastD = desired[lines[lines.length - 1]];
        items.set(
          atoms.length,
          c.insertPlain(
            new ContentType(
              new YNode(lastD.kind === 'line' ? MARKER : RUN_END),
            ),
          ),
        );
      }
      lines.forEach((di, i) => lineItems.set(di, items.get(markerAt[i])!));
    }
    // Units, in desired order, and new nodes after the preceding unit.
    const reuse = new Map<NodeKey, Unit>();
    for (const oi of remaining) {
      const u = old[oi];
      if (u.key !== null) {
        reuse.set(u.key, u);
      }
    }
    let after = left;
    for (const di of newSeg) {
      const d = desired[di];
      let end: Item;
      if (d.kind === 'node') {
        const cursor = this.cursor(cs.y, after, EMPTY_FORMATS);
        const y = new YNode(BLOCK_PREFIX + d.node!.getType());
        end = cursor.insertPlain(new ContentType(y));
        this.$fillNode(y, d.node!);
      } else {
        end = lineItems.get(di)!;
        if (d.kind === 'line') {
          this.$writeMarker(end, d);
        }
      }
      let u = d.key !== null ? reuse.get(d.key) : undefined;
      if (u !== undefined && !used.has(u)) {
        this.noteEnd(u);
        this.state.dropUnit(u);
        u.kind = d.kind;
        u.end = end;
        u.sig = d.sig;
      } else {
        u = {
          cs,
          end,
          first: d.first,
          key: d.key,
          kind: d.kind,
          last: d.last,
          sig: d.sig,
          start: startFormats.size > 0 ? startFormats : null,
        };
      }
      u.first = d.first;
      u.last = d.last;
      u.sig = d.sig;
      if (d.sig !== '') {
        // Groups whose items changed: let every client renumber them.
        this.$refreshGroupsOf(d.node!);
      }
      used.add(u);
      newUnits.push(u);
      if (d.kind !== 'node') {
        this.touched.push({d, unit: u});
      }
      after = end;
    }
    // Formats in effect at each unit start (a format can span a marker).
    // New halves of the held line inherit the shown lane, not evidence that
    // they already rendered a held opener in an earlier half.
    if (lines.length > 0) {
      const byEnd = new Map<Item, Unit>();
      const segUnits = newUnits.slice(newUnits.length - newSeg.length);
      for (const u of segUnits) {
        if (u.end !== null) {
          byEnd.set(u.end, u);
        }
      }
      const current = new Map(storedStartFormats);
      const shown = new Map(startFormats);
      let pendingStart: Formats = new Map(current);
      let pendingShown: Formats = new Map(shown);
      let k = 0;
      for (
        let it = startItem;
        it !== null && k < segUnits.length;
        it = it.right
      ) {
        if (isGone(it)) {
          continue;
        }
        if (it.content instanceof ContentFormat) {
          applyFormat(current, it.content);
          if (!isHeld(it, hidden)) {
            applyFormat(shown, it.content);
          }
          continue;
        }
        const u = byEnd.get(it);
        if (u !== undefined) {
          u.start = pendingStart.size > 0 ? pendingStart : null;
          if (heldSegment && !sameFormatMaps(pendingStart, pendingShown)) {
            hidden!.starts.set(u, {
              shown: pendingShown.size > 0 ? pendingShown : null,
              stored: u.start,
            });
          }
          pendingStart = new Map(current);
          pendingShown = new Map(shown);
          k++;
        }
      }
    }
    // The unit after the segment starts with the formats in effect after it:
    // the segment's deletions and inserts may have removed or added format
    // items that span into it, and later writes start from that value. Its
    // own format items are its content, as a reader takes them (see
    // Reader#$readLineInPlace and $fixStartsAfter): before, its start took
    // them up to its end item, so a closer an outside writer left in it
    // could be judged redundant and deleted.
    const formats = new Map(storedStartFormats);
    let it: Item | null = startItem;
    if (after !== left) {
      for (; it !== null; it = it.right) {
        if (!isGone(it) && it.content instanceof ContentFormat) {
          applyFormat(formats, it.content);
        }
        if (it === after) {
          it = it.right;
          break;
        }
      }
    }
    for (; it !== null; it = it.right) {
      if (isShownEnd(it, this.state.hidden)) {
        const next = this.state.unitByEnd.get(it);
        if (
          next !== undefined &&
          !used.has(next) &&
          !sameFormatMaps(next.start, formats)
        ) {
          next.start = formats.size > 0 ? formats : null;
          this.$fixStartsAfter(next);
        }
        break;
      }
    }
    return after;
  }

  /** A write cursor after `left` that skips content the editor hides. */
  private cursor(y: YNode, left: Item | null, formats: Formats): Cursor {
    const c = new Cursor(this.tr, y, left, new Map(formats));
    c.hidden = this.state.hidden;
    return c;
  }

  /** Formats in effect right after `item` (an end item, or null). */
  private formatsAfter(item: Item | null): Formats {
    if (item === null) {
      return EMPTY_FORMATS;
    }
    const unit = this.state.unitByEnd.get(item);
    const start = prevLiveEnd(item, this.state.hidden);
    const atoms = new Atoms();
    return readAtoms(
      start === null ? (item.parent as YNode)._start : start.right,
      item.right,
      unit !== undefined && unit.start !== null ? unit.start : EMPTY_FORMATS,
      atoms,
      this.state.hidden,
    );
  }

  /** A follow-up's change that is not written (see followUp). */
  private refuse(cs: CS, what: string, node: LexicalNode): void {
    this.refused.add(cs);
    followUpWarning(what, node);
  }

  /**
   * A follow-up's write of a block container (see followUp): the units it
   * removed are deleted, and the lines it kept are written where only their
   * attributes changed or their content only lost children (a line without
   * a marker: where its content did not change). Invariant: when it changed
   * anything else (a unit added, moved or rewritten), nothing of the
   * container is written, and the container is read again. Why: the
   * attributes a transform derived from that change (the start of a list it
   * split) would not fit what is stored, and a change of a line without a
   * marker that is not written left the author showing what no reader shows.
   */
  private $writeFollowUp(cs: CS, container: ElementNode): void {
    this.droppedOuterId = false;
    const desired = this.$desiredUnits(container);
    if (this.droppedOuterId) {
      this.refused.add(cs);
    }
    const old = cs.units;
    // The old units it kept, in order: each desired unit is a later old
    // unit (the old units passed over were removed).
    const kept = new Map<Unit, Desired>();
    let ok = true;
    let oi = 0;
    for (const d of desired) {
      let j = oi;
      while (j < old.length && !this.$keeps(d, old[j])) {
        j++;
      }
      if (j === old.length) {
        ok = false;
        break;
      }
      kept.set(old[j], d);
      oi = j + 1;
    }
    const rewrite: [Unit, Desired][] = [];
    const markers: [Unit, Desired][] = [];
    for (const d of ok ? desired : []) {
      const unit =
        d.kind === 'line' && d.part === undefined && d.key !== null
          ? this.state.unitByKey.get(d.key)
          : undefined;
      if (unit === undefined || unit.cs !== cs) {
        continue;
      }
      if (unit.end === null) {
        // A line without a marker whose content or fields changed is
        // refused (see followUp), as in $run.
        if (this.$changed(d) || this.$fieldsChanged(d.key!)) {
          ok = false;
          break;
        }
        continue;
      }
      if (isGone(unit.end)) {
        continue;
      }
      if (this.$changed(d)) {
        if (kept.has(unit) && this.$deletesOnly(d.key!)) {
          rewrite.push([unit, d]);
        } else {
          ok = false;
          break;
        }
      } else if (unit.sig !== d.sig || this.plan.lines.has(d.key!)) {
        markers.push([unit, d]);
      }
    }
    // A unit it removed is deleted only if its content left the document
    // (see $removedFromDocument).
    if (
      ok &&
      old.some(
        u =>
          !kept.has(u) &&
          ((u.key !== null && !this.$removedFromDocument(u.key)) ||
            (u.kind === 'run' && !this.$runRemoved(u))),
      )
    ) {
      ok = false;
    }
    // A line without a marker ends where the block node after it starts:
    // with that node deleted, it would run into the line kept after it,
    // which only a marker (an insert) keeps apart, so every reader would
    // show the two joined.
    if (ok) {
      for (let j = 0; j < old.length && ok; j++) {
        if (old[j].kind === 'implicit' && kept.has(old[j])) {
          let k = j + 1;
          while (k < old.length && !kept.has(old[k])) {
            k++;
          }
          if (k < old.length && old[k].kind !== 'node') {
            ok = false;
          }
        }
      }
    }
    if (!ok) {
      this.refuse(cs, 'the structure of', container);
      return;
    }
    for (const [unit, d] of markers) {
      this.$writeMarker(unit.end!, d);
      unit.sig = d.sig;
      this.touched.push({d, unit});
    }
    old.forEach((u, idx) => {
      if (!kept.has(u)) {
        this.$deleteUnit(old, idx);
      }
    });
    for (const [unit, d] of rewrite) {
      this.$writeLineAlone(unit, d);
    }
    if (kept.size !== old.length) {
      const units: Unit[] = [];
      for (const u of old) {
        const d = kept.get(u);
        if (d === undefined) {
          this.noteEnd(u);
          this.state.dropUnit(u);
        } else {
          u.first = d.first;
          u.last = d.last;
          units.push(u);
        }
      }
      cs.units = units;
      this.$recomputeStarts(cs);
    }
  }

  /** Whether every inline node of a run left the document. */
  private $runRemoved(u: Unit): boolean {
    const prevMap = this.prevState._nodeMap;
    for (let k = u.first; k !== null; ) {
      if (!this.$removedFromDocument(k)) {
        return false;
      }
      if (k === u.last) {
        break;
      }
      const prev = prevMap.get(k);
      k = prev === undefined ? null : prev.__next;
    }
    return true;
  }

  /** Whether desired unit `d` is old unit `o`, as a follow-up kept it. */
  private $keeps(d: Desired, o: Unit): boolean {
    if (d.part !== undefined) {
      return false;
    }
    if (d.kind === 'line') {
      return o.key === d.key && (o.kind === 'line' || o.kind === 'implicit');
    }
    if (d.kind === 'node') {
      return (
        o.key === d.key &&
        o.kind === 'node' &&
        o.end !== null &&
        nameOf(o.end).startsWith(BLOCK_PREFIX) &&
        storedType(typeOf(o.end)) === d.node!.getType()
      );
    }
    // A run: the same inline children as before, unchanged.
    if (o.kind !== 'run' || o.first === null || d.first !== o.first) {
      return false;
    }
    const prevMap = this.prevState._nodeMap;
    let k: NodeKey | null = o.first;
    for (const node of d.nodes) {
      if (k !== node.getKey() || !this.$sameContent(k, false)) {
        return false;
      }
      const prev = prevMap.get(k);
      k = k === o.last || prev === undefined ? null : prev.__next;
    }
    return k === null;
  }

  /** Rewrite one line (its content and marker) on its own. */
  $writeLineAlone(u: Unit, d: Desired): void {
    if (this.$writeTextEdit(u, d)) {
      return;
    }
    const old = u.cs.units;
    let left: Item | null;
    let stop: Item | null;
    if (u.end !== null) {
      left = prevLiveEnd(u.end, this.state.hidden);
      stop = u.end.right;
    } else {
      const idx = old.indexOf(u);
      left = unitLeft(old, idx, this.state.hidden);
      stop = unitStop(old, idx);
    }
    const atoms = new Atoms();
    const oldOrigins = this.oldOrigins([u]);
    this.setOriginOrder(oldOrigins);
    const ctx = this.$ctx(true);
    $pushInline(atoms, $lineChildren(d), ctx);
    if (ctx.flattened === true) {
      this.refused.add(u.cs);
    }
    const at = atoms.length;
    let end: Item;
    if (u.end === null) {
      // Text without a marker (left by a concurrent edit): diff the content
      // alone (a trailing marker would defeat the common suffix), then end
      // it with a marker.
      this.$writeSeq(
        u.cs.y,
        left,
        u.start || EMPTY_FORMATS,
        stop,
        atoms,
        ctx.cursorAt,
        oldOrigins,
      );
      const c = this.cursor(u.cs.y, left, u.start || EMPTY_FORMATS);
      c.advance(at);
      end = c.insertPlain(new ContentType(new YNode(MARKER)));
    } else {
      atoms.pushSpecial({kind: 'marker', ref: d}, null);
      const items = this.$writeSeq(
        u.cs.y,
        left,
        u.start || EMPTY_FORMATS,
        stop,
        atoms,
        ctx.cursorAt,
        oldOrigins,
      );
      end = items.get(at)!;
    }
    if (end !== u.end) {
      this.noteEnd(u);
      this.state.dropUnit(u);
      u.end = end;
      u.kind = 'line';
      this.state.setUnit(u);
    }
    this.$writeMarker(end, d);
    u.sig = d.sig;
    this.touched.push({d, unit: u});
    this.$fixStartsAfter(u);
  }

  /**
   * Fast path for the common keystroke: the line's children are the same
   * nodes as before except one plain text node of the line whose formats did
   * not change. Its edits, as Lexical recorded them (see exactEdits), or a
   * diff of its old and new text where the record does not explain them,
   * are written at its offset, so the cost is in the line's items and the
   * changed text, not in the line's length.
   */
  private $writeTextEdit(u: Unit, d: Desired): boolean {
    if (
      u.kind !== 'line' ||
      u.end === null ||
      isGone(u.end) ||
      d.part !== undefined
    ) {
      return false;
    }
    const line = d.node as ElementNode;
    const prevMap = this.prevState._nodeMap;
    const before = prevMap.get(line.getKey());
    if (before === undefined || !$isElementNode(before)) {
      return false;
    }
    let changed: TextNode | null = null;
    let changedBefore: TextNode | null = null;
    let offset = 0;
    let a: NodeKey | null = before.__first;
    let b: LexicalNode | null = line.getFirstChild();
    while (a !== null || b !== null) {
      if (a === null || b === null || a !== b.getKey()) {
        return false;
      }
      const prev = prevMap.get(a);
      const now = b.getLatest();
      if (prev === undefined) {
        return false;
      }
      if (prev !== now) {
        if (
          changed !== null ||
          !$isTextNode(prev) ||
          !$isTextNode(now) ||
          prev.__type !== now.__type ||
          prev.__format !== now.__format ||
          prev.__style !== now.__style ||
          prev.__mode !== now.__mode ||
          prev.__detail !== now.__detail ||
          prev.__state !== now.__state ||
          !sameOwnFields(prev, now)
        ) {
          return false;
        }
        changed = now;
        changedBefore = prev;
      } else {
        // An element child (a link) is the same object when only its
        // children changed: its subtree must be unchanged too.
        if ($isElementNode(now) && !sameSubtree(now, prevMap)) {
          return false;
        }
        if (changed === null) {
          offset += $atomSize(now);
        }
      }
      a = prev.__next;
      b = b.getNextSibling();
    }
    if (
      changed === null ||
      changedBefore === null ||
      $runsWithNeighbour(changed)
    ) {
      return false;
    }
    const oldText = changedBefore.__text;
    const newText = changed.__text;
    // The node's segment key as stored: one read without a key (a code
    // highlight a client stored without one) keeps none, or the text
    // inserted here would be stored, and read, as a node of its own.
    const segment = isMergeableText(changed)
      ? null
      : (this.state.segments.get(changed.getKey()) ?? null);
    // The edits Lexical recorded, exactly where they were made (see
    // TextReplay), and as made: a replacement is not widened to whole
    // words (see snapToWords), which a diff's guess at shared letters
    // needs, and a record does not. A diff where the record does not
    // explain the line; the line written whole where the node holds
    // characters of another.
    const edits = this.exactEdits(changed, oldText.length);
    if (edits === false) {
      return false;
    }
    if (edits !== null) {
      if (edits.length > 0) {
        this.$writeEdits(
          u,
          offset,
          edits,
          oldText,
          newText,
          $textAttrs(changed, segment),
        );
      }
    } else {
      const selection = $getSelection();
      let cursor = -1;
      if ($isRangeSelection(selection) && selection.isCollapsed()) {
        if (selection.anchor.key === changed.getKey()) {
          cursor = selection.anchor.offset;
        } else {
          // A caret right before or after the changed node (in a link
          // ending there) anchors the diff at that edge.
          const at = selection.anchor.getNode();
          if (at.isBefore(changed)) {
            cursor = 0;
          } else if (changed.isBefore(at)) {
            cursor = newText.length;
          }
        }
      }
      const {prefix, suffix} = setTextEnds(
        oldText,
        newText,
        cursor,
        this.state.editor._compositionKey !== null,
      );
      const del = oldText.length - prefix - suffix;
      const to = newText.length - suffix;
      if (del > 0 || to > prefix) {
        this.$writeEdits(
          u,
          offset,
          [[prefix, del, newText.slice(prefix, to)]],
          oldText,
          newText,
          $textAttrs(changed, segment),
        );
      }
    }
    this.$writeMarker(u.end, d);
    u.sig = d.sig;
    this.touched.push({d, unit: u});
    return true;
  }

  /**
   * Write a text node's edits (see exactEdits), which make its text `now`
   * of its old text `old`, in line `u`, where the node starts at atom
   * `offset`, with the node's attributes `attrs`.
   */
  private $writeEdits(
    u: Unit,
    offset: number,
    edits: [number, number, string][],
    old: string,
    now: string,
    attrs: Attrs,
  ): void {
    const c = this.cursor(
      u.cs.y,
      prevLiveEnd(u.end!, this.state.hidden),
      u.start || EMPTY_FORMATS,
    );
    c.advance(offset);
    const hunks: Hunk[] = [];
    let shift = 0;
    for (const [at, del, ins] of edits) {
      hunks.push([at, del, at + shift, at + shift + ins.length]);
      shift += ins.length - del;
    }
    this.$writeHunks(c, old, now, hunks, (cursor, from, to) => {
      cursor.insert(
        new ContentString(now.slice(from, to)),
        this.inheritUnknown(cursor, attrs),
      );
    });
  }

  /**
   * The one place a write deletes and inserts text: `hunks` of old atoms
   * `old` (counted from the cursor) and desired atoms `now` (see Hunk), in
   * order, each widened to whole code points first (see codePointHunks);
   * `insert` writes desired atoms `from` to `to` at the cursor. Every text
   * write goes through here: the fast path's recorded edits and its diff,
   * and a sequence's prefix, suffix and islands (see $writeSeq). Invariant:
   * no delete or insert starts or ends between the two halves of a
   * surrogate pair. Why: Yjs replaces both halves of a pair it splits with
   * U+FFFD under their ids (and a lone half reads as U+FFFD), so the
   * author's editor showed `😀` while every reader showed `��` (a splice of
   * one half; a pair kept by two islands, stepped over one atom at a
   * time).
   */
  private $writeHunks(
    c: Cursor,
    old: string,
    now: string,
    hunks: readonly Hunk[],
    insert: (cursor: Cursor, from: number, to: number) => void,
  ): void {
    let pos = 0;
    for (const [at, del, from, to] of codePointHunks(hunks, old, now)) {
      if (__DEV__) {
        invariant(
          !splitsPair(old, at) &&
            !splitsPair(old, at + del) &&
            !splitsPair(now, from) &&
            !splitsPair(now, to),
          '@lexical/y: a write splits a surrogate pair',
        );
      }
      c.advance(at - pos);
      if (del > 0) {
        c.delete(del);
      }
      if (to > from) {
        insert(c, from, to);
      }
      pos = at + del;
    }
  }

  // -------------------------------------------------------------------------
  // Sequences

  /**
   * Make the items after `left` up to `oldStop` (exclusive) hold `atoms`:
   * the deletes and inserts between the common prefix and suffix of the old
   * and desired atoms, separated by the old atoms kept there (see islands),
   * then the formats that differ. Returns the items of the marker and
   * run-end atoms.
   */
  private $writeSeq(
    y: YNode,
    left: Item | null,
    startFormats: Formats,
    oldStop: Item | null,
    atoms: Atoms,
    cursorAt: number,
    oldOrigins: [number, number, string][] | null = null,
  ): Map<number, Item> {
    const startItem = left === null ? y._start : left.right;
    const old = new Atoms();
    readAtoms(startItem, oldStop, startFormats, old, this.state.hidden);
    const state = this.state;
    // Types of the new inline nodes (those without a shared node yet): a
    // replaced node of one of these types is kept by the new node of its own
    // type, not by another. A sibling that keeps its own shared node competes
    // for nothing.
    const newTypes = new Set<string>();
    atoms.specials.forEach(sp => {
      if (sp.kind === 'inline' && !state.yByKey.has(sp.key)) {
        newTypes.add(sp.node.getType());
      }
    });
    const matchSpecial = (i: number, j: number): boolean => {
      const a = old.specials.get(i)!;
      const b = atoms.specials.get(j)!;
      if (a.kind === 'marker' || a.kind === 'runEnd') {
        return a.kind === b.kind;
      }
      if (a.kind === 'oldNode' && b.kind === 'inline') {
        if (!a.name.startsWith(INLINE_PREFIX)) {
          return false;
        }
        const oy = typeOf(a.item);
        const oldKey = state.keyByY.get(oy);
        if (oldKey === b.key) {
          return storedType(oy) === b.node.getType();
        }
        // A node Lexical replaced in place by a new one ($setBlocksType, a
        // split that recreates it): keep the shared node (and its content,
        // where a peer may be typing). A node of another type records its
        // type in `t`; what it holds (inline or blocks) must not change.
        const prev = oldKey === undefined ? null : $getNodeByKey(oldKey);
        if (state.yByKey.has(b.key) || (prev !== null && prev.isAttached())) {
          return false;
        }
        const cs = state.containers.get(oy);
        if (
          storedType(oy) !== b.node.getType() &&
          newTypes.has(storedType(oy))
        ) {
          return false;
        }
        if ($isElementNode(b.node)) {
          return cs !== undefined && cs.kind === this.roles.$kind(b.node);
        }
        return cs === undefined && storedType(oy) === b.node.getType();
      }
      return false;
    };
    let {prefix, suffix} = diffAtoms(old, atoms, matchSpecial, cursorAt);
    let exact: {of: Int32Array; kept: Int32Array} | null = null;
    // Whether old character `i` may be kept for character `j` (see below).
    let keeps: ((i: number, j: number) => boolean) | null = null;
    // An old character is kept only for text of the same origin (the same
    // text node before this update, or a node new in it): text that moved
    // between nodes or lines is written as new text, never built from old
    // characters that happen to be equal.
    if (
      oldOrigins !== null &&
      (atoms.origins.length > 0 || atoms.nodes.length > 0)
    ) {
      const total = oldOrigins[oldOrigins.length - 1][1];
      if (total === old.length) {
        exact = this.$exactAtoms(oldOrigins, atoms, old);
        const oldKey = keysAt(oldOrigins, old.length);
        const newKey = this.$sameTextLineage(old, atoms, oldOrigins)
          ? oldKey
          : keysAt(atoms.origins, atoms.length);
        const prevMap = this.prevState._nodeMap;
        // Where each origin last shows in the new atoms.
        const lastAt = new Map<string, number>();
        newKey.forEach((k, j) => {
          if (k !== undefined) {
            lastAt.set(k, j);
          }
        });
        const same = (i: number, j: number): boolean => {
          if (exact !== null) {
            // Where the record says which old atom an atom is, exactly that
            // one; an old atom it gives another is not kept for this one.
            const x = exact.of[j];
            if (x !== UNKNOWN_ATOM) {
              return x === i;
            }
            if (exact.kept[i] !== -1) {
              return false;
            }
          }
          const b = newKey[j];
          if (b === undefined) {
            return true;
          }
          const a = oldKey[i];
          if (a === b) {
            return true;
          }
          if (b === FOREIGN_ORIGIN || prevMap.has(b)) {
            return false;
          }
          // Invariant: text of a node new in this update keeps an old
          // character only when that character's node is gone or ends before
          // it (the tail a split of the node made): while the old node still
          // shows later on, its characters are its own. Why: a new node with
          // equal text at its start (a paragraph typed in front of a line)
          // that took them would lose part of its text to a peer's concurrent
          // rewrite of the old node's text.
          if (a === undefined) {
            return true;
          }
          const last = lastAt.get(a);
          return last === undefined || last < j;
        };
        for (let i = 0; i < prefix; i++) {
          if (!same(i, i)) {
            prefix = i;
            break;
          }
        }
        for (let t = 0; t < suffix; t++) {
          if (!same(old.length - 1 - t, atoms.length - 1 - t)) {
            suffix = t;
            break;
          }
        }
        // A cut on one side can let the other side grow back.
        const plain = (i: number, j: number) => {
          const si = old.specials.has(i);
          const sj = atoms.specials.has(j);
          if (si || sj) {
            return si && sj && matchSpecial(i, j) && same(i, j);
          }
          return (
            old.text.charCodeAt(i) === atoms.text.charCodeAt(j) && same(i, j)
          );
        };
        keeps = (i, j) =>
          !old.specials.has(i) && !atoms.specials.has(j) && plain(i, j);
        const room = () => Math.min(old.length, atoms.length) - prefix - suffix;
        while (room() > 0 && plain(prefix, prefix)) {
          prefix++;
        }
        while (
          room() > 0 &&
          plain(old.length - 1 - suffix, atoms.length - 1 - suffix)
        ) {
          suffix++;
        }
        // Never split a surrogate pair.
        if (prefix > 0 && isHighSurrogate(atoms.text.charCodeAt(prefix - 1))) {
          prefix--;
        }
        if (
          suffix > 0 &&
          isHighSurrogate(atoms.text.charCodeAt(atoms.length - suffix - 1))
        ) {
          suffix--;
        }
      }
    }
    // A rewrite replaces whole words (see snapToWords): not where the
    // record of text edits says what the replaced text is (see
    // $exactAtoms), which is then written as made, keeping the old
    // characters it says are kept between the edits (see islands).
    let kept: [number, number][] = [];
    const composing = this.state.editor._compositionKey !== null;
    const anchors =
      exact === null
        ? []
        : islands(exact, old, atoms, prefix, suffix, matchSpecial);
    if (exact !== null && exactRange(exact, prefix, atoms.length - suffix)) {
      kept = anchors;
    } else if (anchors.length > 0 && keeps !== null) {
      // Where the record says which atoms some are and not others (a node
      // the record does not cover, text a node new in this update was made
      // with next to a removed node, see $exactAtoms), the atoms it says
      // are kept stay, and only what lies between them is diffed, each gap
      // on its own as a rewrite is (whole words, see snapToWords). Why: the
      // whole range between the first change and the last was diffed as one
      // rewrite, which wrote again the text and the inline nodes the record
      // keeps between them (a node removed and another made in one update,
      // as app code replaces one).
      kept = gapIslands(anchors, old, atoms, prefix, suffix, keeps, composing);
    } else {
      const [p0, s0] = [prefix, suffix];
      ({prefix, suffix} = snapToWords(
        old.text,
        atoms.text,
        prefix,
        suffix,
        composing,
      ));
      // Never over characters the record says are kept, where they are.
      if (exact !== null) {
        for (let j = p0 - 1; j >= prefix; j--) {
          if (exact.of[j] === j) {
            prefix = j + 1;
            break;
          }
        }
        for (let t = s0 - 1; t >= suffix; t--) {
          if (exact.of[atoms.length - 1 - t] === old.length - 1 - t) {
            suffix = t + 1;
            break;
          }
        }
      }
    }
    const items = new Map<number, Item>();
    for (let i = 0; i < prefix; i++) {
      const it = old.items.get(i);
      if (it !== undefined && atoms.specials.has(i)) {
        items.set(i, it);
      }
    }
    for (let t = 0; t < suffix; t++) {
      const ni = atoms.length - suffix + t;
      const it = old.items.get(old.length - suffix + t);
      if (it !== undefined && atoms.specials.has(ni)) {
        items.set(ni, it);
      }
    }
    // Adopt shared nodes kept for replaced Lexical nodes.
    for (const [i, it] of items) {
      const special = atoms.specials.get(i);
      if (
        special !== undefined &&
        special.kind === 'inline' &&
        state.keyByY.get(typeOf(it)) !== special.key
      ) {
        this.$adoptNode(typeOf(it), special.node);
      }
    }
    // Between the prefix and the suffix, each old atom kept there (an
    // island) ends a delete and an insert.
    const hunks: Hunk[] = [];
    let i = prefix;
    let j = prefix;
    kept.push([old.length - suffix, atoms.length - suffix]);
    for (const [ki, kj] of kept) {
      if (ki > i || kj > j) {
        hunks.push([i, ki - i, j, kj]);
      }
      i = ki + 1;
      j = kj + 1;
    }
    this.$writeHunks(
      this.cursor(y, left, startFormats),
      old.text,
      atoms.text,
      hunks,
      (cursor, from, to) => this.$insertAtoms(cursor, atoms, from, to, items),
    );
    this.$formatPass(y, left, startFormats, atoms);
    return items;
  }

  /**
   * Which old atom each desired atom is, by the identities Lexical's record
   * gives (see TextReplay): `of[j]` is the old atom desired atom `j` keeps,
   * NEW_ATOM where it is new (typed, made, or text whose old characters are
   * outside this content), UNKNOWN_ATOM for a marker or a run end; `kept[i]`
   * is the desired atom that keeps old atom `i`, or -1. Null where the record
   * does not explain the text of every line of the content: the diff writes
   * it, as before the record. Why: a diff of the old and new text cannot
   * tell where an insert or delete next to equal text was made (`t5z `
   * typed before `t4z ` diffs as `5z t` inserted after its `t`), nor which
   * characters a node made again holds, so a peer's concurrent edit of the
   * characters a write took for others moved or came back.
   */
  private $exactAtoms(
    oldOrigins: [number, number, string][],
    atoms: Atoms,
    old: Atoms,
  ): {of: Int32Array; kept: Int32Array} | null {
    const replay = this.textReplay();
    if (replay === null) {
      return null;
    }
    const range = new Map<string, [number, number]>();
    for (const [a, b, k] of oldOrigins) {
      if (k !== '') {
        range.set(k, [a, b]);
      }
    }
    const nodeAtoms = this.oldNodeAtoms.get(oldOrigins);
    const of = new Int32Array(atoms.length).fill(UNKNOWN_ATOM);
    const kept = new Int32Array(old.length).fill(-1);
    // Desired atoms `j` on (`n` of them) are the characters `ids` give. An
    // old node that is not the same atom of this content (a block's own
    // node, a node from elsewhere) is left to the match below.
    const place = (
      j: number,
      n: number,
      key: NodeKey,
      node: boolean,
    ): boolean => {
      const ids = replay.idsOf(key);
      if (ids === null) {
        return false;
      }
      let at = j;
      for (const s of ids) {
        const r = s.key === null ? undefined : range.get(s.key);
        const atom =
          s.key === null || r !== undefined || nodeAtoms === undefined
            ? undefined
            : nodeAtoms.get(s.key);
        for (let t = s.start; t < s.end; t++, at++) {
          const i =
            r !== undefined && t < r[1] - r[0]
              ? r[0] + t
              : atom !== undefined && this.sameAtom(old, atom, atoms, at)
                ? atom
                : -1;
          if (at >= j + n || (i >= 0 && kept[i] !== -1)) {
            return false;
          }
          of[at] =
            i >= 0 ? i : node && s.key !== null ? UNKNOWN_ATOM : NEW_ATOM;
          if (i >= 0) {
            kept[i] = at;
          }
        }
      }
      return at === j + n;
    };
    for (const [start, end, key] of atoms.textNodes) {
      if (!place(start, end - start, key, false)) {
        return null;
      }
    }
    for (const [j, key] of atoms.nodes) {
      if (!place(j, 1, key, true)) {
        return null;
      }
    }
    return {kept, of};
  }

  /**
   * Whether old atom `i` is the stored line break or inline node that
   * desired atom `j` shows (see $exactAtoms).
   */
  private sameAtom(old: Atoms, i: number, atoms: Atoms, j: number): boolean {
    const a = old.specials.get(i);
    const b = atoms.specials.get(j);
    if (a === undefined || b === undefined) {
      return (
        a === undefined &&
        b === undefined &&
        old.text.charCodeAt(i) === 10 &&
        atoms.text.charCodeAt(j) === 10
      );
    }
    if (a.kind !== 'oldNode' || b.kind !== 'inline') {
      return false;
    }
    const oy = typeOf(a.item);
    return (
      this.state.keyByY.get(oy) === b.key && storedType(oy) === b.node.getType()
    );
  }

  /**
   * Whether the desired content holds the old text unchanged, cut and joined
   * again by this update's splits and merges alone (formats changed by one
   * or several formatText calls, or a comment set and removed): its text is
   * the old text, every text node holding it is a node of this content
   * before or a part Lexical split off one (WritePlan#splits), and starts
   * where its text did (a split part where it was in the node first cut:
   * so none moved), every node of this content no longer shown was merged
   * by the normalization (WritePlan#merged), and a node holds more
   * than its own old text only when the normalization merged others into
   * it. Then each character keeps the item at its own place, and the update
   * writes formats alone. Why: from each node's text alone, a node merged
   * into another after a split could be taken for an equal run of another
   * node, and the words were deleted and inserted again
   * (`<u>ab` `<i>la ` `la la `, italic over [3,9) and underline over [7,8),
   * wrote `del "abla " ins "abla "`), which undid a peer's concurrent delete
   * there or moved its typing. A text edit, an insert or a delete, makes
   * the text differ or a node start elsewhere, and is diffed as before.
   */
  private $sameTextLineage(
    old: Atoms,
    atoms: Atoms,
    oldOrigins: [number, number, string][],
  ): boolean {
    if (old.text !== atoms.text || atoms.textNodes.length === 0) {
      return false;
    }
    const {merged, splits} = this.plan;
    const prevMap = this.prevState._nodeMap;
    const oldRange = new Map<string, [number, number]>();
    for (const [a, b, k] of oldOrigins) {
      if (k !== '') {
        oldRange.set(k, [a, b]);
      }
    }
    for (const k of oldRange.keys()) {
      const now = $getNodeByKey(k);
      if (
        (now === null || !now.isAttached()) &&
        (merged === undefined || merged === null || !merged.has(k))
      ) {
        // Deleted, not merged.
        return false;
      }
    }
    for (const [start, end, key] of atoms.textNodes) {
      let at: number;
      if (prevMap.has(key)) {
        const range = oldRange.get(key);
        if (range === undefined) {
          return false;
        }
        at = range[0];
        if (
          end - start > range[1] - range[0] &&
          (merged === undefined || merged === null || !merged.has(key))
        ) {
          return false;
        }
      } else {
        const rec =
          splits === undefined || splits === null ? undefined : splits.get(key);
        const range = rec === undefined ? undefined : oldRange.get(rec[0]);
        if (rec === undefined || range === undefined) {
          return false;
        }
        at = range[0] + rec[1];
      }
      if (at !== start) {
        return false;
      }
    }
    return true;
  }

  /**
   * The fields this editor owns in the formats of text whose type keys
   * (TYPE_KEY, absent for `text`) are `a` and `b` (see ownsFormat): its
   * classes' of those text node types.
   */
  textFields(a: unknown, b: unknown): OwnedFields {
    return ownedFields(this.state.editor, a ?? 'text', b ?? 'text', true);
  }

  /**
   * Format `key`'s value `value`, as this editor writes it, as stored where
   * `stored` is: a format wrapper's value keeps the members of `stored`
   * this editor does not own (see ownsMember). With `same`, only where
   * `stored` is the same wrapper as this editor shows it: its owned members
   * (but the text fields Lexical derives, see stripGroupText) are `value`'s.
   */
  formatAsStored(
    key: string,
    value: unknown,
    stored: unknown,
    same = false,
  ): unknown {
    const fields = key.startsWith(WRAPPER_PREFIX)
      ? this.wrapperFields(key.slice(WRAPPER_PREFIX.length))
      : null;
    if (
      fields === null ||
      value === null ||
      typeof value !== 'object' ||
      stored === null ||
      typeof stored !== 'object'
    ) {
      return value;
    }
    // A wrapper that holds text writes no text fields (Lexical does not
    // serialize them), and does not remove ones stored there either: when a
    // wrapper with no text that stores them gets text (a line break in a
    // link, then text appended), its value is not written again over the
    // content it kept, over a collaborator's concurrent removal or change
    // of it (see $wrapperAttrs).
    const keepsText = isTextHoldingWrapperValue(value);
    const owns = (m: string) =>
      ownsMember(m, fields) &&
      !(keepsText && (m === 'textFormat' || m === 'textStyle'));
    if (same) {
      const a = value as Attrs;
      const b = stored as Attrs;
      for (const m of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (
          m !== 'textFormat' &&
          m !== 'textStyle' &&
          owns(m) &&
          !equalValue(a[m], b[m])
        ) {
          return value;
        }
      }
    }
    return withUnownedMembers(value as Attrs, stored, owns);
  }

  /**
   * `attrs`, the formats of content inserted at `cursor`, with the formats
   * there that this editor does not own (see ownsFormat): the content
   * continues what is before it, which its formats must not cut. A field
   * goes only into text of the same type (it is that node's: of another
   * type, every field is owned), and neither a field nor a text format into
   * an inline node (`wrappersOnly`), which holds wrappers only; a wrapper's
   * value keeps the members it does not own of the same wrapper there (see
   * formatAsStored).
   */
  private inheritUnknown(
    cursor: Cursor,
    attrs: Attrs,
    wrappersOnly = false,
  ): Attrs {
    let result = attrs;
    const fields = this.textFields(
      cursor.formats.get(TYPE_KEY),
      attrs[TYPE_KEY],
    );
    cursor.formats.forEach((v, k) => {
      let value = v;
      if (k in attrs) {
        value = this.formatAsStored(k, attrs[k], v, true);
        if (value === attrs[k]) {
          return;
        }
      } else if (
        ownsFormat(k, fields, this.wrapperFields) ||
        (wrappersOnly &&
          (k.startsWith(FIELD_PREFIX) || k.startsWith(TEXT_FORMAT_PREFIX)))
      ) {
        return;
      }
      if (result === attrs) {
        result = {...attrs};
      }
      result[k] = value;
    });
    return result;
  }

  private $insertAtoms(
    cursor: Cursor,
    atoms: Atoms,
    from: number,
    to: number,
    items: Map<number, Item>,
  ): void {
    const runs = atoms.runs;
    let r = 0;
    let i = from;
    while (i < to) {
      const special = atoms.specials.get(i);
      while (r < runs.length && runs[r].end <= i) {
        r++;
      }
      const run: Run | undefined =
        r < runs.length && runs[r].start <= i ? runs[r] : undefined;
      if (special !== undefined) {
        if (special.kind === 'marker' || special.kind === 'runEnd') {
          const y = new YNode(special.kind === 'marker' ? MARKER : RUN_END);
          items.set(i, cursor.insertPlain(new ContentType(y)));
        } else if (special.kind === 'inline') {
          const y = new YNode(INLINE_PREFIX + special.node.getType());
          cursor.insert(
            new ContentType(y),
            this.inheritUnknown(
              cursor,
              wrapperOnly(run ? run.attrs : {}),
              true,
            ),
          );
          this.$fillNode(y, special.node);
        }
        i++;
        continue;
      }
      let j = run ? Math.min(run.end, to) : i + 1;
      for (let k = i + 1; k < j; k++) {
        if (atoms.specials.has(k)) {
          j = k;
          break;
        }
      }
      cursor.insert(
        new ContentString(atoms.text.slice(i, j)),
        this.inheritUnknown(cursor, run ? run.attrs : {}),
      );
      i = j;
    }
  }

  /** Format the atoms after `left` whose owned formats differ. */
  private $formatPass(
    y: YNode,
    left: Item | null,
    startFormats: Formats,
    atoms: Atoms,
  ): void {
    const startItem = left === null ? y._start : left.right;
    const actual = new Atoms();
    readAtomsLimited(
      startItem,
      startFormats,
      atoms.length,
      actual,
      this.state.hidden,
    );
    const ops: {start: number; end: number; formats: Attrs; sig: string}[] = [];
    // A line break carries wrapper formats and its own NodeState; a child
    // node carries wrapper formats only. Of those, what this editor owns
    // (see ownsFormat).
    const owned = (
      k: string,
      wrappersOnly: boolean,
      isBreak: boolean,
      fields: OwnedFields,
    ) =>
      (!wrappersOnly ||
        k.startsWith(WRAPPER_PREFIX) ||
        (isBreak && k.startsWith(STATE_PREFIX))) &&
      ownsFormat(k, fields, this.wrapperFields);
    // Walk segments between run boundaries, child nodes and line breaks
    // (where only wrapper formats apply), not characters: the cost is in
    // runs, so a keystroke in a long line stays cheap.
    const text = atoms.text;
    const cuts: number[] = [0, atoms.length];
    for (const r of atoms.runs) {
      cuts.push(r.start, r.end);
    }
    for (const r of actual.runs) {
      cuts.push(r.start, r.end);
    }
    for (const at of atoms.specials.keys()) {
      cuts.push(at, at + 1);
    }
    for (
      let at = text.indexOf('\n');
      at !== -1;
      at = text.indexOf('\n', at + 1)
    ) {
      cuts.push(at, at + 1);
    }
    cuts.sort((a, b) => a - b);
    let ra = 0;
    let rb = 0;
    for (let c = 0; c < cuts.length - 1; c++) {
      const start = cuts[c];
      const end = Math.min(cuts[c + 1], atoms.length);
      if (end <= start) {
        continue;
      }
      const special = atoms.specials.get(start);
      if (
        special !== undefined &&
        (special.kind === 'marker' || special.kind === 'runEnd')
      ) {
        continue;
      }
      while (ra < atoms.runs.length && atoms.runs[ra].end <= start) {
        ra++;
      }
      while (rb < actual.runs.length && actual.runs[rb].end <= start) {
        rb++;
      }
      const want =
        ra < atoms.runs.length && atoms.runs[ra].start <= start
          ? atoms.runs[ra].attrs
          : {};
      const have =
        rb < actual.runs.length && actual.runs[rb].start <= start
          ? actual.runs[rb].attrs
          : {};
      const isBreak = special === undefined && text.charCodeAt(start) === 10;
      const wrappersOnly = special !== undefined || isBreak;
      const fields = this.textFields(want[TYPE_KEY], have[TYPE_KEY]);
      let diff: Attrs | null = null;
      for (const k in want) {
        if (owned(k, wrappersOnly, isBreak, fields)) {
          const value = this.formatAsStored(k, want[k] ?? null, have[k]);
          if (!equalFormatValue(value, have[k] ?? null)) {
            (diff || (diff = {}))[k] = value;
          }
        }
      }
      for (const k in have) {
        if (
          !(k in want) &&
          owned(k, wrappersOnly, isBreak, fields) &&
          have[k] !== null
        ) {
          (diff || (diff = {}))[k] = null;
        }
      }
      if (diff !== null) {
        const sig = stableStringify(diff);
        const prev = ops[ops.length - 1];
        if (prev !== undefined && prev.end === start && prev.sig === sig) {
          prev.end = end;
        } else {
          ops.push({end, formats: diff, sig, start});
        }
      }
    }
    if (ops.length === 0) {
      return;
    }
    const cursor = this.cursor(y, left, startFormats);
    let pos = 0;
    for (const op of ops) {
      cursor.advance(op.start - pos);
      cursor.format(op.end - op.start, {...op.formats});
      pos = op.end;
    }
  }

  // -------------------------------------------------------------------------
  // Markers and nodes

  /** Write the marker attributes of desired line `d` on marker `item`. */
  private $writeMarker(item: Item, d: Desired): void {
    let desired = this.$marker(d);
    const line = d.node;
    const hidden = this.state.hidden;
    const held = hidden === null ? null : hidden.marker;
    if (
      held !== null &&
      line !== null &&
      ((held.ends.has(item) && !this.prevState._nodeMap.has(line.getKey())) ||
        this.$isComposedLine(line))
    ) {
      // Attributes of the composed line a collaborator changed are held
      // back (see Hidden#marker): one this edit left as the editor shows it
      // keeps the collaborator's value; one it changed takes its value, and
      // is no longer held. So does the line a split of it makes while
      // composing (the composed line ends at a new marker, the new line
      // holding the rest of it at the old one). A line it was joined into
      // keeps its own, though it ends at the old marker; an empty line
      // Enter makes at its end has the attributes the editor shows.
      const composed = this.$isComposedLine(line);
      desired = {...desired};
      for (const [k, was] of [...held.was]) {
        if (equalValue(desired[k], was)) {
          const now = held.now.get(k);
          if (now === undefined) {
            delete desired[k];
          } else {
            desired[k] = now;
          }
        } else if (composed) {
          held.was.delete(k);
          held.now.delete(k);
        }
      }
      held.ends.add(item);
      if (composed) {
        hidden!.ownerKey = line.getKey();
      }
      if (held.was.size === 0) {
        hidden!.marker = null;
      }
    }
    const y = typeOf(item);
    const current = attrsOf(y) as Attrs;
    const storedText = $isElementNode(line) && !$holdsText(line);
    // A marker this write made, or one another line had that a diff of their
    // container gave this line: where this line had a marker of its own,
    // what that one stored is the line's, and what the other line's marker
    // stores is not (see $markerAsStored). A line new in this write keeps
    // what the marker it is given stores, as a line that keeps its marker
    // does: it may be a copy of the other line (a split).
    const made = this.tr.insertSet.hasId(item.id);
    const owner = made ? null : this.ownerBefore(item);
    const before =
      line !== null &&
      d.key !== null &&
      (made || (owner !== null && lineOfUnit(owner) !== lineOfUnit(d.key)))
        ? this.$markerBefore(d.key, line.getKey())
        : null;
    const taken = !made && before !== null;
    const owners = this.markerOwners(desired, before ?? current);
    const want = this.$markerAsStored(desired, current, owners, line, before);
    let changed = false;
    for (const k in want) {
      if (
        !equalValue(current[k], want[k]) &&
        !this.keepsStored(k, current[k], want[k], storedText)
      ) {
        setAttr(y, k, want[k], this.tr);
        changed = true;
      }
    }
    for (const k in current) {
      if (
        !(k in want) &&
        (taken || ownsMarkerAttr(k, owners.fields, owners.groupFields)) &&
        !this.keepsStored(k, current[k], undefined, storedText)
      ) {
        deleteAttr(y, k, this.tr);
        changed = true;
      }
    }
    if (changed && (GROUP_KEY in desired || GROUP_KEY in current)) {
      const cs = this.state.containers.get(item.parent as YNode);
      if (cs !== undefined) {
        this.groupWrites.add(cs);
      }
    }
  }

  /**
   * Whether `line` is the line being composed that a held change is for
   * (see Hidden): that line, or a line this edit made to replace it (a
   * change of its type) holding the composition, not one it was joined
   * into.
   */
  private $isComposedLine(line: LexicalNode): boolean {
    const ownerKey = this.state.hidden!.ownerKey;
    if (line.getKey() === ownerKey) {
      return true;
    }
    const owner = $getNodeByKey(ownerKey);
    if (
      (owner !== null && owner.isAttached()) ||
      this.prevState._nodeMap.has(line.getKey())
    ) {
      return false;
    }
    const key = this.state.editor._compositionKey;
    const composed = key === null ? null : $getNodeByKey(key);
    return (
      composed !== null &&
      $isElementNode(line) &&
      (composed.is(line) || line.isParentOf(composed))
    );
  }

  /**
   * Whether this write leaves attribute `key` as stored although the editor
   * has another value: a follow-up (no one's edit) does not write an
   * element's textFormat/textStyle where they are derived, which Lexical's
   * reconciler does from the first text it renders under the element on
   * each client (see isTextFieldKey, $holdsText); a user's edit of that
   * line writes them. Where no text is below the element (`storedText`: a
   * line or stored node, empty or holding only inline decorators or line
   * breaks) they are its own, and a follow-up writes them as any update
   * does (a follow-up that sets them, or a delete that empties the element,
   * which sets them from the text removed). Why: the author otherwise kept
   * them while every reader showed the stored ones. A follow-up's
   * change of derived ones is not written (see WritePlan#unwritable).
   */
  keepsStored(
    key: string,
    current: unknown,
    desired: unknown,
    storedText = false,
  ): boolean {
    return (
      this.followUp &&
      ((isTextFieldKey(key) &&
        !(
          storedText &&
          (key === FIELD_PREFIX + 'textFormat' ||
            key === FIELD_PREFIX + 'textStyle')
        )) ||
        (key === OUTER_KEY &&
          outerWithoutTextFields(current) === outerWithoutTextFields(desired)))
    );
  }

  /**
   * The fields this editor owns on a marker that is stored as `current` and
   * written as `desired` (see ownsMarkerAttr): its classes' of the line's
   * type, of its group's type and of that group's items (whose fields an
   * outer level's wrapper item stores), each stored and written.
   */
  markerOwners(desired: Attrs, current: Attrs): MarkerOwners {
    const editor = this.state.editor;
    const group = current[GROUP_KEY];
    const info =
      group === desired[GROUP_KEY] && typeof group === 'string'
        ? editor._nodes.get(group)
        : undefined;
    const spec = info === undefined ? null : getGroupSpec(info.klass);
    const groupFields = ownedFields(editor, group, desired[GROUP_KEY], false);
    return {
      fields: ownedFields(
        editor,
        current[TYPE_KEY] ?? 'paragraph',
        desired[TYPE_KEY] ?? 'paragraph',
        false,
      ),
      groupFields,
      itemFields: spec === null ? groupFields : groupItemFields(spec),
    };
  }

  /**
   * What a write of marker attributes `desired` (what this editor owns of
   * them, see $marker) stores where `current` is stored (see ownsMarkerAttr,
   * `owners`): the members of the outer levels (OUTER_KEY) it does not own
   * kept as stored, and, for an item new to its group (`line`), the group's
   * fields it does not own taken from another item of the group, as every
   * item stores them, or as an item of the group stored them before this
   * write (see $groupSource). Where this write made the marker anew for a line that
   * had one (`before`, what that one stored, see $markerBefore), the line's
   * fields it does not own are those, and its group's are found as for an
   * item new to its group.
   */
  $markerAsStored(
    desired: Attrs,
    current: Attrs,
    owners: MarkerOwners,
    line: LexicalNode | null,
    before: Attrs | null = null,
  ): Attrs {
    let want = desired;
    const keepOuter = (stored: unknown, of: MarkerOwners) => {
      const outer = want[OUTER_KEY];
      if (Array.isArray(outer) && stored !== undefined) {
        const kept = eachOuterLevel(
          outer,
          stored,
          of.groupFields,
          of.itemFields,
          withUnownedMembers,
        );
        if (kept !== outer) {
          want = {...want, [OUTER_KEY]: kept};
        }
      }
    };
    // The fields `from` stores that this editor does not own (`of`) and
    // `want` leaves out: the group's (`group`), or the line's.
    const keepFields = (from: Attrs, of: MarkerOwners, group: boolean) => {
      const prefix = group ? GROUP_FIELD_PREFIX : FIELD_PREFIX;
      for (const k in from) {
        if (
          k.startsWith(prefix) &&
          !(k in want) &&
          !ownsMarkerAttr(k, of.fields, of.groupFields)
        ) {
          want = {...want, [k]: from[k]};
        }
      }
    };
    if (
      line !== null &&
      GROUP_KEY in desired &&
      (before !== null || current[GROUP_KEY] === undefined)
    ) {
      const source = this.$groupSource(line, desired[GROUP_KEY]);
      if (source !== null) {
        // Owned as at the other item, whose group has the item's type.
        const of = this.markerOwners(desired, source.attrs);
        keepFields(source.attrs, of, true);
        keepOuter(
          this.$alignedOuter(
            line,
            source.key,
            source.attrs[OUTER_KEY],
            source.asBefore,
          ),
          of,
        );
      }
    }
    if (before === null) {
      keepOuter(
        line === null
          ? current[OUTER_KEY]
          : this.$alignedOuter(line, line.getKey(), current[OUTER_KEY]),
        owners,
      );
    } else {
      keepFields(before, owners, false);
    }
    return want;
  }

  /**
   * `stored`, the outer levels (OUTER_KEY) the marker of item `key` stores,
   * aligned with the outer levels `line` is written with: at each, the
   * level stored for the same group (see $outerLevels), or none. Matched
   * by group, not by depth: an edit that removes or adds an outer group
   * shifts the depths, and a level keeps the members of its own group only;
   * the fields of its wrapper item (WRAPPER_FIELDS_KEY) are those stored for
   * the same item, wherever it is now. With `asBefore`, `stored` is what the
   * marker stored before this write. Undefined where the stored levels
   * cannot be matched to groups.
   */
  private $alignedOuter(
    line: LexicalNode,
    key: NodeKey,
    stored: unknown,
    asBefore = false,
  ): Attrs[] | undefined {
    if (!Array.isArray(stored)) {
      return undefined;
    }
    // The levels the item's marker was written for: those before this
    // update, unless this write already wrote its outer levels.
    let was: OuterLevel[] | null;
    if (asBefore) {
      was = this.outerLevelsBefore(key);
    } else {
      const unit = this.state.unitByKey.get(key);
      const attr =
        unit === undefined || unit.end === null
          ? undefined
          : typeOf(unit.end)._map.get(OUTER_KEY);
      const item = $getNodeByKey(key);
      was =
        attr !== undefined && this.tr.insertSet.hasId(attr.id) && item !== null
          ? this.$outerLevels(item)
          : this.outerLevelsBefore(key);
    }
    if (was === null || was.length !== stored.length) {
      return undefined;
    }
    const levels = was;
    return this.$outerLevels(line).map(([group, wrapper]) => {
      const byGroup = levels.findIndex(([g]) => g === group);
      const byItem = levels.findIndex(([, w]) => w === wrapper);
      if (byGroup !== -1 && byItem === byGroup) {
        return stored[byGroup];
      }
      const level =
        byGroup === -1 ? undefined : withoutWrapperFields(stored[byGroup]);
      const fields =
        byItem === -1 ? undefined : wrapperFieldsIn(stored[byItem]);
      return fields === undefined
        ? level
        : {...(level as Attrs | undefined), [WRAPPER_FIELDS_KEY]: fields};
    });
  }

  /**
   * The levels the marker of `line` stores as its outer levels (OUTER_KEY),
   * outermost first: the groups that hold its group through level items, as
   * $lineDesired finds them, each with that level item.
   */
  private $outerLevels(line: LexicalNode): OuterLevel[] {
    const levels: OuterLevel[] = [];
    for (let g = line.getParent(); g !== null; ) {
      const levelItem = g.getParent();
      if (levelItem === null || this.roles.$role(levelItem) !== 'level') {
        break;
      }
      g = levelItem.getParent();
      if (g !== null) {
        levels.push([g.getKey(), levelItem.getKey()]);
      }
    }
    return levels.reverse();
  }

  /**
   * $outerLevels for the node of `key` in the editor state before this
   * update (a level item there holds only the nested group, see
   * $nestedGroupOf), or null where it had no such node.
   */
  private outerLevelsBefore(key: NodeKey): OuterLevel[] | null {
    const map = this.prevState._nodeMap;
    const node = map.get(key);
    if (node === undefined) {
      return null;
    }
    const parentOf = (n: LexicalNode) =>
      n.__parent === null ? undefined : map.get(n.__parent);
    const levels: OuterLevel[] = [];
    for (let g = parentOf(node); g !== undefined; ) {
      const levelItem = parentOf(g) as ElementNode | undefined;
      const outer = levelItem === undefined ? undefined : parentOf(levelItem);
      const spec = outer === undefined ? null : getGroupSpec(klassOf(outer));
      if (
        outer === undefined ||
        levelItem === undefined ||
        spec === null ||
        !spec.nested ||
        klassOf(g) !== spec.klass ||
        levelItem.__first !== g.__key ||
        levelItem.__last !== g.__key
      ) {
        break;
      }
      levels.push([outer.__key, levelItem.__key]);
      g = outer;
    }
    return levels.reverse();
  }

  /**
   * Where item `line`, new to its group (of type `gtype`) or with a marker
   * this write made anew, takes the group's fields it does not own from: the
   * first of these, in this order, with what it stores (`asBefore`: what it
   * stored before this write), or null.
   *
   * 1. The item of the group nearest before it, else after it, that was in
   *    the group before this update and whose stored marker this write did
   *    not make (see storedItemAttrs). Its neighbor, not any item: a client
   *    that does not own a group field shows one group where another client
   *    shows two that differ in it, and the item goes into the one it is
   *    next to.
   * 2. Where no item kept its marker, an item of the group whose marker
   *    before this write held the group's fields: `line` itself where it
   *    was in the same group then (its group moved with it),
   * 3. else the item nearest before it, else after it, that was (the group
   *    moved, and `line` is new to it),
   * 4. else the first item the group had then whose marker held them (its
   *    items replaced).
   *
   * Null where none was (a group new in this write). The order matters: a
   * nearest-item rule alone takes another source where a group moves or
   * its items are replaced, and stores other values of the fields.
   */
  private $groupSource(
    line: LexicalNode,
    gtype: unknown,
  ): {asBefore: boolean; attrs: Attrs; key: NodeKey} | null {
    const stored = this.$nearestItem(
      line,
      c => this.$inGroupBefore(c) && this.storedItemAttrs(c, gtype) !== null,
      this.storedBefore,
      this.storedAfter,
    );
    const ref = stored === null ? null : this.storedItemAttrs(stored, gtype);
    if (stored !== null && ref !== null) {
      return {asBefore: false, attrs: ref, key: stored.getKey()};
    }
    const own = this.$priorItemAttrs(line, gtype);
    if (own !== null) {
      return {asBefore: true, attrs: own, key: line.getKey()};
    }
    const item = this.$nearestItem(
      line,
      c => this.$priorItemAttrs(c, gtype) !== null,
      this.priorBefore,
      this.priorAfter,
    );
    if (item !== null) {
      return {
        asBefore: true,
        attrs: this.$priorItemAttrs(item, gtype)!,
        key: item.getKey(),
      };
    }
    const group = line.getParent();
    return group === null ? null : this.priorGroupMarker(group.getKey(), gtype);
  }

  /**
   * What the marker of the first item group `key` had before this write
   * stored then, where that held the group's fields (of type `gtype`), with
   * that item's key, or null.
   */
  private priorGroupMarker(
    key: NodeKey,
    gtype: unknown,
  ): {asBefore: boolean; attrs: Attrs; key: NodeKey} | null {
    let found = this.priorOfGroup.get(key);
    if (found === undefined) {
      found = null;
      const map = this.prevState._nodeMap;
      const group = map.get(key) as ElementNode | undefined;
      for (
        let child = group === undefined ? null : group.__first;
        child !== null;
        child = map.get(child)!.__next
      ) {
        const attrs = this.$markerBefore(child, child);
        if (attrs !== null && attrs[GROUP_KEY] === gtype) {
          found = {asBefore: true, attrs, key: child};
          break;
        }
      }
      this.priorOfGroup.set(key, found);
    }
    return found;
  }

  /**
   * What the marker of item `item` stored before this write, where `item`
   * was in the same group then, of type `gtype` (see $markerBefore), or
   * null.
   */
  private $priorItemAttrs(item: LexicalNode, gtype: unknown): Attrs | null {
    if (!this.$inGroupBefore(item)) {
      return null;
    }
    const attrs = this.$markerBefore(item.getKey(), item.getKey());
    return attrs !== null && attrs[GROUP_KEY] === gtype ? attrs : null;
  }

  /**
   * Whether item `item` was in the group it is in before this update: what
   * its marker stores of the group is that group's.
   */
  private $inGroupBefore(item: LexicalNode): boolean {
    const prev = this.prevState._nodeMap.get(item.getKey());
    const parent = item.getParent();
    return (
      prev !== undefined && parent !== null && prev.__parent === parent.getKey()
    );
  }

  /**
   * The sibling item of `line` nearest before it, else after it, that
   * `accepts`, or null. Noted (`before`, `after`) for each item walked: a
   * run of new items finds it at once.
   */
  private $nearestItem(
    line: LexicalNode,
    accepts: (item: LexicalNode) => boolean,
    before: Map<NodeKey, LexicalNode | null>,
    after: Map<NodeKey, LexicalNode | null>,
  ): LexicalNode | null {
    const walk = (
      from: LexicalNode | null,
      noted: Map<NodeKey, LexicalNode | null>,
      step: (node: LexicalNode) => LexicalNode | null,
    ) => {
      const walked: NodeKey[] = [];
      let ref: LexicalNode | null = null;
      for (let c = from; c !== null; c = step(c)) {
        const known = noted.get(c.getKey());
        if (known !== undefined) {
          ref = known;
          break;
        }
        walked.push(c.getKey());
        if (accepts(c)) {
          ref = c;
          break;
        }
      }
      for (const key of walked) {
        noted.set(key, ref);
      }
      return ref;
    };
    return (
      walk(line.getPreviousSibling(), before, n => n.getPreviousSibling()) ??
      walk(line.getNextSibling(), after, n => n.getNextSibling())
    );
  }

  /**
   * Note the end line unit `u` has before this write changes it, drops the
   * unit or gives its key another (see $markerBefore, ownerBefore): the
   * end's unit key the first time the end is noted, and the unit's end the
   * first time the unit's key is, where that end was its own.
   */
  private noteEnd(u: Unit): void {
    const end = u.end;
    if (
      u.key === null ||
      (u.kind !== 'line' && u.kind !== 'implicit') ||
      (end !== null && this.tr.insertSet.hasId(end.id))
    ) {
      return;
    }
    if (end !== null && !this.ownersBefore.has(end)) {
      this.ownersBefore.set(end, u.key);
    }
    if (
      !this.endsBefore.has(u.key) &&
      (end === null || this.ownersBefore.get(end) === u.key)
    ) {
      this.endsBefore.set(u.key, end);
    }
  }

  /**
   * The key of the unit whose end item `item` was before this write, or
   * null where none was.
   */
  private ownerBefore(item: Item): NodeKey | null {
    const noted = this.ownersBefore.get(item);
    if (noted !== undefined) {
      return noted;
    }
    const unit = this.state.unitByEnd.get(item);
    return unit === undefined ? null : unit.key;
  }

  /**
   * The attributes of the marker unit `key` (a line's, or a part's of line
   * `whole` that holds lines, see $pushLine) ended with before this write,
   * as they were then (see attrsBefore): for a part that had none, the
   * marker of the whole line. Null where neither had one.
   */
  private $markerBefore(key: NodeKey, whole: NodeKey): Attrs | null {
    let attrs = this.markersBefore.get(key);
    if (attrs === undefined) {
      const unit = this.state.unitByKey.get(key);
      const end = this.endsBefore.has(key)
        ? this.endsBefore.get(key)!
        : unit === undefined
          ? null
          : unit.end;
      attrs =
        end === null ||
        this.tr.insertSet.hasId(end.id) ||
        this.ownerBefore(end) !== key
          ? null
          : attrsBefore(typeOf(end), this.tr);
      if (attrs === null && key !== whole) {
        attrs = this.$markerBefore(whole, whole);
      }
      this.markersBefore.set(key, attrs);
    }
    return attrs;
  }

  /**
   * The type and attributes the shared node of node `key` had before this
   * write, as they were then (see attrsBefore), or null where it had none:
   * read the first time this write gives the node new storage (see
   * $fillNode), from the one it had then.
   */
  private nodeBefore(key: NodeKey): [string, Attrs] | null {
    let found = this.nodesBefore.get(key);
    if (found === undefined) {
      const y = this.state.yByKey.get(key);
      found = y === undefined ? null : nodeBeforeTransaction(y, this.tr);
      this.nodesBefore.set(key, found);
    }
    return found;
  }

  /**
   * The stored marker attributes of item `item` of a group of type `gtype`,
   * in the document the write sees (see Unread), or null where this write
   * made its marker (or it has none).
   */
  private storedItemAttrs(item: LexicalNode, gtype: unknown): Attrs | null {
    const unit = this.state.unitByKey.get(item.getKey());
    const end = unit === undefined ? null : unit.end;
    if (end === null || isGone(end) || this.tr.insertSet.hasId(end.id)) {
      return null;
    }
    const marker = typeOf(end);
    return attrOf(marker, GROUP_KEY) === gtype
      ? (attrsOf(marker) as Attrs)
      : null;
  }

  $writeNodeAttrs(y: YNode, node: LexicalNode): void {
    const holes: string[] = [];
    const desired = $nodeAttrs(node, holes);
    if (holes.length > 0) {
      this.holed.add(node.getKey());
    }
    const current = attrsOf(y) as Attrs;
    // The fields this editor owns here (see ownsNodeAttr): its classes' of
    // the type stored and of the node's.
    const fields = ownedFields(
      this.state.editor,
      storedType(y),
      node.getType(),
      true,
    );
    if (String(y.name).slice(2) !== node.getType()) {
      desired[TYPE_KEY] = node.getType();
    } else if (TYPE_KEY in current) {
      deleteAttr(y, TYPE_KEY, this.tr);
    }
    const storedText = $isElementNode(node) && !$holdsText(node);
    for (const k in desired) {
      if (
        !equalValue(current[k], desired[k]) &&
        !this.keepsStored(k, current[k], desired[k], storedText)
      ) {
        setAttr(y, k, desired[k], this.tr);
      }
    }
    for (const k in current) {
      if (
        !(k in desired) &&
        ownsNodeAttr(k, fields) &&
        !this.keepsStored(k, current[k], undefined, storedText)
      ) {
        deleteAttr(y, k, this.tr);
      }
    }
    $writeSlots(this, y, node, current, followUpWarning);
  }

  /** Map a kept shared node to the Lexical node that replaced its node. */
  private $adoptNode(y: YNode, node: LexicalNode): void {
    const state = this.state;
    const oldKey = state.keyByY.get(y);
    if (oldKey !== undefined) {
      state.yByKey.delete(oldKey);
      state.csByKey.delete(oldKey);
    }
    state.mapNode(node.getKey(), y);
    this.$writeNodeAttrs(y, node);
    const cs = state.containers.get(y);
    if ($isElementNode(node) && cs !== undefined) {
      this.written.add(node.getKey());
      if (cs.kind === 'i') {
        this.$writeInline(cs, node);
      } else {
        this.$writeStructure(cs, node);
      }
    }
  }

  /**
   * Write a new stored node: attributes, and its container. Where the node
   * had a shared node before (a node moved, or written again), the fields
   * that one stored that this editor does not own (see ownsNodeAttr) go
   * into the new one.
   */
  $fillNode(y: YNode, node: LexicalNode): void {
    const key = node.getKey();
    const holes: string[] = [];
    const attrs = $nodeAttrs(node, holes);
    if (holes.length > 0) {
      this.holed.add(key);
    }
    const prev = this.nodeBefore(key);
    if (prev !== null) {
      const [type, before] = prev;
      const fields = ownedFields(this.state.editor, type, node.getType(), true);
      for (const k in before) {
        if (
          k.startsWith(FIELD_PREFIX) &&
          !(k in attrs) &&
          !ownsNodeAttr(k, fields)
        ) {
          attrs[k] = before[k];
        }
      }
    }
    for (const k in attrs) {
      setAttr(y, k, attrs[k], this.tr);
    }
    this.state.mapNode(key, y);
    if ($isElementNode(node)) {
      const kind = this.roles.$kind(node);
      setAttr(y, KIND_KEY, kind, this.tr);
      const cs = this.state.newCS(y, key, kind);
      this.written.add(key);
      if (kind === 'i') {
        this.$writeInline(cs, node);
      } else {
        this.$writeStructure(cs, node);
      }
    }
    $writeSlots(this, y, node, {}, followUpWarning);
  }
}

/** Whether an element's descendants are the objects of the previous state. */
function sameSubtree(
  node: ElementNode,
  prevMap: Map<NodeKey, LexicalNode>,
): boolean {
  for (const c of node.getChildren()) {
    const now = c.getLatest();
    if (prevMap.get(c.getKey()) !== now) {
      return false;
    }
    if ($isElementNode(now) && !sameSubtree(now, prevMap)) {
      return false;
    }
  }
  const prev = prevMap.get(node.getKey());
  return (
    prev !== undefined &&
    $isElementNode(prev) &&
    prev.__size === node.getChildrenSize()
  );
}

/** Atoms a node occupies in its line (wrappers are transparent). */
function $atomSize(node: LexicalNode): number {
  if ($isTextNode(node)) {
    return node.getTextContentSize();
  }
  if ($isElementNode(node) && $isWrapper(node)) {
    let n = 0;
    for (const c of node.getChildren()) {
      n += $atomSize(c);
    }
    return n;
  }
  return 1;
}

const NOT_FIELDS = new Set([
  '__text',
  '__key',
  '__parent',
  '__prev',
  '__next',
  '__state',
  '__cachedText',
]);

/** Whether two versions of a node have the same own fields (but text). */
function sameOwnFields(prev: LexicalNode, now: LexicalNode): boolean {
  const a = prev as unknown as Record<string, unknown>;
  const b = now as unknown as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (k.startsWith('__') && !NOT_FIELDS.has(k) && a[k] !== b[k]) {
      return false;
    }
  }
  return true;
}

/** sameOwnFields, but children too are not fields (an element's links). */
function sameAttrFields(prev: LexicalNode, now: LexicalNode): boolean {
  const a = prev as unknown as Record<string, unknown>;
  const b = now as unknown as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (
      k.startsWith('__') &&
      !NOT_FIELDS.has(k) &&
      k !== '__first' &&
      k !== '__last' &&
      k !== '__size' &&
      a[k] !== b[k]
    ) {
      return false;
    }
  }
  return true;
}

function sameFormatMaps(a: Formats | null, b: Formats): boolean {
  const x = a || EMPTY_FORMATS;
  if (x.size !== b.size) {
    return false;
  }
  for (const [k, v] of x) {
    if (!b.has(k) || !equalFormatValue(v, b.get(k))) {
      return false;
    }
  }
  return true;
}

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * An edit of a write (see Writer#$writeHunks): old atoms `at` to
 * `at + del` are replaced with desired atoms `from` to `to`. The atoms
 * between two hunks are kept, and equal in both.
 */
type Hunk = [at: number, del: number, from: number, to: number];

/** Whether a cut of `s` at `at` falls between the halves of a pair. */
const splitsPair = (s: string, at: number): boolean =>
  at > 0 &&
  at < s.length &&
  isHighSurrogate(s.charCodeAt(at - 1)) &&
  isLowSurrogate(s.charCodeAt(at));

/**
 * The hunks of a write of old atoms `old` as desired atoms `now` (see
 * Writer#$writeHunks), each widened so that it neither starts nor ends
 * between the two halves of a surrogate pair: a kept high half right before
 * a hunk, or a kept low half right after one, is replaced with itself, and
 * written again with the hunk's inserted atoms. Hunks that then touch are
 * joined, so that a pair is never written as two items.
 */
function codePointHunks(
  hunks: readonly Hunk[],
  old: string,
  now: string,
): Hunk[] {
  const join = (list: Hunk[]): Hunk[] => {
    const out: Hunk[] = [];
    for (const h of list) {
      const last = out[out.length - 1];
      if (last !== undefined && h[0] <= last[0] + last[1]) {
        out[out.length - 1] = [
          last[0],
          Math.max(last[0] + last[1], h[0] + h[1]) - last[0],
          last[2],
          Math.max(last[3], h[3]),
        ];
      } else {
        out.push(h);
      }
    }
    return out;
  };
  let out = join(hunks.slice());
  for (let changed = true; changed; ) {
    changed = false;
    out = out.map(([at, del, from, to], k) => {
      // The kept atoms around the hunk: up to the hunks before and after.
      const lo = k > 0 ? out[k - 1][0] + out[k - 1][1] : 0;
      const hi = k + 1 < out.length ? out[k + 1][0] : old.length;
      if (
        at > lo &&
        from > 0 &&
        (isHighSurrogate(old.charCodeAt(at - 1)) ||
          isHighSurrogate(now.charCodeAt(from - 1)))
      ) {
        at--;
        del++;
        from--;
        changed = true;
      }
      if (
        at + del < hi &&
        to < now.length &&
        (isLowSurrogate(old.charCodeAt(at + del)) ||
          isLowSurrogate(now.charCodeAt(to)))
      ) {
        del++;
        to++;
        changed = true;
      }
      return [at, del, from, to];
    });
    out = join(out);
  }
  return out;
}

function wrapperOnly(attrs: Attrs): Attrs {
  const out: Attrs = {};
  for (const k in attrs) {
    if (k.startsWith(WRAPPER_PREFIX)) {
      out[k] = attrs[k];
    }
  }
  return out;
}

/** The live end item before an old unit (after earlier deletions too). */
function unitLeft(
  units: Unit[],
  idx: number,
  hidden: Hidden | null,
): Item | null {
  const u = units[idx];
  if (u.end !== null) {
    return prevLiveEnd(u.end, hidden);
  }
  let e = idx > 0 ? units[idx - 1].end : null;
  while (e !== null && isGone(e)) {
    e = prevLiveEnd(e, hidden);
  }
  return e;
}

/** The item right after an old unit (exclusive stop), or null. */
function unitStop(units: Unit[], idx: number): Item | null {
  const u = units[idx];
  if (u.end !== null) {
    return u.end.right;
  }
  const next = units[idx + 1];
  return next !== undefined && next.end !== null && next.kind === 'node'
    ? next.end
    : null;
}

/** Read exactly `limit` atoms from `start`. */
function readAtomsLimited(
  start: Item | null,
  formats: Formats,
  limit: number,
  out: Atoms,
  hidden: Hidden | null,
): void {
  let stop: Item | null = start;
  let n = 0;
  while (stop !== null && n < limit) {
    if (isLiveContent(stop)) {
      n += unheldLength(stop, hidden);
    }
    stop = stop.right;
  }
  readAtoms(start, stop, formats, out, hidden);
}

/** The origin key at each atom position (undefined outside text). */
function keysAt(
  ranges: [number, number, string][],
  length: number,
): (string | undefined)[] {
  const out = new Array<string | undefined>(length);
  for (const [a, b, k] of ranges) {
    if (k === '') {
      continue;
    }
    for (let i = a; i < b && i < length; i++) {
      out[i] = k;
    }
  }
  return out;
}

/**
 * The type and attributes shared node `y` had before transaction `tr` (see
 * attrsBefore), or null where `tr` made it.
 */
function nodeBeforeTransaction(
  y: YNode,
  tr: Transaction,
): [string, Attrs] | null {
  if (y._item !== null && tr.insertSet.hasId(y._item.id)) {
    return null;
  }
  const attrs = attrsBefore(y, tr);
  return [storedTypeOf({getAttr: k => attrs[k], name: y.name}), attrs];
}

/** An outer level of a marker: its group's key, and its level item's. */
type OuterLevel = [group: NodeKey, item: NodeKey];

/** The fields of the wrapper item outer level `level` stores, if any. */
function wrapperFieldsIn(level: unknown): unknown {
  return level === null ||
    typeof level !== 'object' ||
    Array.isArray(level) ||
    !(WRAPPER_FIELDS_KEY in level)
    ? undefined
    : (level as Attrs)[WRAPPER_FIELDS_KEY];
}

/** Outer level `level` (see OUTER_KEY) without its wrapper item's fields. */
function withoutWrapperFields(level: unknown): unknown {
  if (
    level === null ||
    typeof level !== 'object' ||
    Array.isArray(level) ||
    !(WRAPPER_FIELDS_KEY in level)
  ) {
    return level;
  }
  const out = {...(level as Attrs)};
  delete out[WRAPPER_FIELDS_KEY];
  return out;
}

/** What rewriting a unit costs, roughly (its text and nodes). */
function unitCost(d: Desired): number {
  if (d.node === null || d.node === undefined) {
    return 1;
  }
  let n = 1 + d.node.getTextContentSize();
  if (d.kind === 'node' && $isElementNode(d.node)) {
    const stack: LexicalNode[] = [d.node];
    while (stack.length > 0) {
      const e = stack.pop()!;
      n++;
      if ($isElementNode(e)) {
        pushAll(stack, e.getChildren());
      }
    }
  }
  return n;
}

/**
 * Whether this update moved desired unit `d` of `container`: Lexical
 * recorded its node, or an element between it and the container (the list
 * of a list item, the item holding a nested list), as detached and inserted
 * again (EditorState#_movedNodes).
 */
function $movedUnit(
  d: Desired,
  container: ElementNode,
  moved: ReadonlySet<NodeKey>,
): boolean {
  for (
    let node: LexicalNode | null = d.node;
    node !== null && !node.is(container);
    node = node.getParent()
  ) {
    if (moved.has(node.getKey())) {
      return true;
    }
  }
  return false;
}

/**
 * `anchors` (pairs whose both indices increase) and the heaviest
 * subsequence of `pairs` (in order of their first index) that fits in order
 * between them: each pair added lies, by both indices, in one gap between
 * two consecutive anchors.
 */
function addInOrder(
  anchors: [number, number][],
  pairs: [number, number][],
  weight: (pair: [number, number]) => number,
): [number, number][] {
  if (pairs.length === 0) {
    return anchors;
  }
  const fits: [number, number][] = [];
  let next = 0;
  for (const pair of pairs) {
    while (next < anchors.length && anchors[next][0] < pair[0]) {
      next++;
    }
    if (
      (next === 0 || anchors[next - 1][1] < pair[1]) &&
      (next === anchors.length || pair[1] < anchors[next][1])
    ) {
      fits.push(pair);
    }
  }
  const kept = longestIncreasing(fits, weight);
  const out: [number, number][] = [];
  let a = 0;
  let k = 0;
  while (a < anchors.length || k < kept.length) {
    if (
      k === kept.length ||
      (a < anchors.length && anchors[a][0] < kept[k][0])
    ) {
      out.push(anchors[a++]);
    } else {
      out.push(kept[k++]);
    }
  }
  return out;
}

/**
 * The heaviest subsequence of `pairs` (in order of their first index) whose
 * second indices increase: O(n log n) with a Fenwick tree of maxima.
 */
function longestIncreasing(
  pairs: [number, number][],
  weight: (pair: [number, number]) => number = () => 1,
): [number, number][] {
  const n = pairs.length;
  if (n === 0) {
    return [];
  }
  let size = 0;
  for (const [, v] of pairs) {
    size = Math.max(size, v + 1);
  }
  const treeBest = new Array<number>(size + 1).fill(0);
  const treeAt = new Array<number>(size + 1).fill(-1);
  const best = new Array<number>(n).fill(0);
  const prev = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const v = pairs[i][1];
    // Best chain ending at a second index < v.
    let b = 0;
    let at = -1;
    for (let k = v; k > 0; k -= k & -k) {
      if (treeBest[k] > b) {
        b = treeBest[k];
        at = treeAt[k];
      }
    }
    best[i] = b + weight(pairs[i]);
    prev[i] = at;
    for (let k = v + 1; k <= size; k += k & -k) {
      if (best[i] > treeBest[k]) {
        treeBest[k] = best[i];
        treeAt[k] = i;
      }
    }
  }
  let end = 0;
  for (let i = 1; i < n; i++) {
    if (best[i] > best[end]) {
      end = i;
    }
  }
  const out: [number, number][] = [];
  for (let i = end; i !== -1; i = prev[i]) {
    out.push(pairs[i]);
  }
  return out.reverse();
}

/** The origin of merged text whose old characters are not in the rewrite. */
const FOREIGN_ORIGIN = '\u0000foreign';

/** See Writer#$exactAtoms: an atom of new text, and one not known. */
const NEW_ATOM = -1;
const UNKNOWN_ATOM = -2;

/**
 * The old atoms the record of text edits says are kept between `prefix` and
 * the `suffix` (see Writer#$exactAtoms), with the desired atoms that keep
 * them, both in order: characters of the old text that the edits of one
 * write left between them (`ab ` | _`t7z `_ | `t8z ` | **`la `** | _`zz`_ |
 * `la `, `t7z t8` and `la zz` deleted, so `z ` is kept between the two
 * deletes), and the line breaks and inline nodes kept between them. A
 * surrogate half kept without its pair is written again with it (see
 * Writer#$writeHunks).
 */
function islands(
  exact: {of: Int32Array; kept: Int32Array},
  old: Atoms,
  atoms: Atoms,
  prefix: number,
  suffix: number,
  matchSpecial: (i: number, j: number) => boolean,
): [number, number][] {
  const out: [number, number][] = [];
  let last = prefix - 1;
  for (let j = prefix; j < atoms.length - suffix; j++) {
    const i = exact.of[j];
    if (i <= last || i >= old.length - suffix) {
      continue;
    }
    const si = old.specials.has(i);
    const sj = atoms.specials.has(j);
    if (
      si || sj
        ? si && sj && matchSpecial(i, j)
        : old.text.charCodeAt(i) === atoms.text.charCodeAt(j)
    ) {
      out.push([i, j]);
      last = i;
    }
  }
  return out;
}

/**
 * The old atoms kept between `prefix` and the `suffix` where the record of
 * text edits says which some of them are (see Writer#$writeSeq): the
 * `anchors` it keeps (see islands), and in each gap between them, the
 * common prefix and suffix of the gap's old and desired atoms that `keeps`
 * allows, snapped to whole words (see snapToWords). Both in order.
 */
function gapIslands(
  anchors: [number, number][],
  old: Atoms,
  atoms: Atoms,
  prefix: number,
  suffix: number,
  keeps: (i: number, j: number) => boolean,
  composing: boolean,
): [number, number][] {
  const out: [number, number][] = [];
  let i0 = prefix;
  let j0 = prefix;
  const ends: [number, number][] = [
    ...anchors,
    [old.length - suffix, atoms.length - suffix],
  ];
  ends.forEach(([i1, j1], k) => {
    let p = 0;
    while (i0 + p < i1 && j0 + p < j1 && keeps(i0 + p, j0 + p)) {
      p++;
    }
    let q = 0;
    while (
      q < i1 - i0 - p &&
      q < j1 - j0 - p &&
      keeps(i1 - 1 - q, j1 - 1 - q)
    ) {
      q++;
    }
    if (p > 0 || q > 0) {
      ({prefix: p, suffix: q} = snapToWords(
        old.text.slice(i0, i1),
        atoms.text.slice(j0, j1),
        p,
        q,
        composing,
      ));
    }
    for (let t = 0; t < p; t++) {
      out.push([i0 + t, j0 + t]);
    }
    for (let t = q; t > 0; t--) {
      out.push([i1 - t, j1 - t]);
    }
    if (k < anchors.length) {
      out.push([i1, j1]);
    }
    i0 = i1 + 1;
    j0 = j1 + 1;
  });
  return out;
}

/**
 * Whether the record of text edits says which atoms from `from` to `to` (of
 * the desired atoms) are (see Writer#$exactAtoms).
 */
function exactRange(
  exact: {of: Int32Array; kept: Int32Array} | null,
  from: number,
  to: number,
): boolean {
  if (exact === null) {
    return false;
  }
  for (let j = from; j < to; j++) {
    if (exact.of[j] === UNKNOWN_ATOM) {
      return false;
    }
  }
  return true;
}

function applyFormat(formats: Map<string, unknown>, f: ContentFormat): void {
  if (f.value === null) {
    formats.delete(f.key);
  } else {
    formats.set(f.key, f.value);
  }
}

/**
 * A follow-up update (see Writer#followUp) inserted or rewrote content or
 * structure: the change is not written, and the binding reads that content
 * again. Whatever made the follow-up (a transform it ran) changed content a
 * collaborator wrote.
 */
function followUpWarning(what: string, node: LexicalNode): void {
  if (__DEV__) {
    console.warn(
      `@lexical/y: a follow-up update changed ${what} a ${node.getType()} node; follow-ups (the binding's refresh, BlockIdExtension's naming, the update that runs a newly registered transform over the document) may only set attributes or delete, so this change is not written and the editor reads that content again.`,
    );
  }
}
