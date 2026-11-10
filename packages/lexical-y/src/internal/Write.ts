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
  findIndexSS,
  Item,
  iterateStructsByIdSet,
  Node as YNode,
  type Transaction,
} from '@y/y';
import {
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isLexicalNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  type AnyStateConfig,
  type EditorState,
  type ElementNode,
  type LexicalNode,
  type NodeKey,
  type TextNode,
} from 'lexical';

import {pushAll} from './Arrays';
import {$withoutLevelId, innerBlockIds, NO_IDS} from './BlockIds';
import {
  Cursor,
  equalFormatValue,
  type Formats,
  isShownContent,
  type LeftOut,
} from './Cursor';
import {groupKeySig, groupSig} from './Groups';
import {$heldDecision, type HeldDecision, ownerTextKeys} from './HoldGuard';
import {isShadowKey} from './Ident';
import {
  $isLeftOutInline,
  $pushInline,
  Atoms,
  countLive,
  type DesiredContext,
  diffAtoms,
  diffStrings,
  hasLoneSurrogate,
  PENDING_LINE_BREAK,
  readAtoms,
  type Run,
  setTextStretches,
  snapToWords,
  toWellFormed,
} from './Inline';
import {asOwner} from './Owned';
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
  decodeFormatValue,
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
  isSetStateConfig,
  isStringArray,
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
  SEGMENT_KEY,
  SET_MEMBER_SEPARATOR,
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
  attrOfIn,
  attrsBeforeIn,
  attrsOfIn,
  copyStart,
  deleteAttrIn,
  deleteItemIn,
  deletions,
  Folder,
  frontierOf,
  isGoneIn,
  isShownEndIn,
  noteFolded,
  prevLiveEnd,
  setAttrIn,
  skipsProtected,
  unheldLength,
  withProtected,
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
import {type View} from './Unread';

/** storedTypeOf, in the document the write sees (see Unread). */
const storedType = (view: View | null, y: YNode): string =>
  storedTypeOf({
    getAttr: (key: string) => attrOfIn(view, y, key),
    name: y.name,
  });

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
  /**
   * The author's normalization of the lines that hold characters of a line
   * whose re-typing was not written, once its hold has ended (see
   * Writer#heldResult): what the update that ended the composition would
   * have written of those characters, and the lines holding them now. Only
   * what agrees with it is written (see Writer#$writeAgreedLine).
   */
  release?: {
    lines: ReadonlySet<NodeKey>;
    record: ReadonlyMap<string, Attrs>;
  } | null;
};

export class Writer {
  /** What the write sees of the document now (see liveView). */
  get view(): View | null {
    return this.liveView();
  }
  /** The last format pass's fold (see $fixStartsAfter). */
  private passFold: {clock: number; deletions: number; fold: PassFold} | null =
    null;
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
    /**
     * The binding's view (see View), read at each step, as the reader's
     * (see Reader#liveView).
     */
    private readonly liveView: () => View | null,
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
    const hidden = this.state.hidden;
    let held: Set<YNode> | null = null;
    if (hidden !== null) {
      // Not decided before it runs (a recovered write): decided now.
      this.heldDecided ??= $heldDecision(
        this.state,
        hidden,
        this.prevState,
        this.remoteUnread,
      );
      if (this.heldDecided.quiet) {
        // The line composed in, which a transform re-typed (see
        // $heldDecision), is not written as a line; the binding reads it
        // again. What the update changed on its characters that kept their
        // type is written (see $writeSkippedLine).
        this.plan.lines.delete(hidden.ownerKey);
        this.skippedLine = hidden.ownerKey;
      }
      held = this.heldTypes(hidden);
      for (const key of this.heldDecided.allow) {
        const y = this.state.yByKey.get(key);
        if (y !== undefined) {
          held.delete(y);
        }
      }
    }
    asOwner(this.state, () =>
      withProtected(
        held,
        this.skipProtected
          ? 'skip'
          : this.neverStop ||
              (this.heldDecided !== null && this.heldDecided.inserts),
        () => {
          const release = this.plan.release;
          if (release !== undefined && release !== null) {
            // Nothing but what agrees is written (the binding reads the rest
            // of the update again).
            for (const key of release.lines) {
              this.$writeAgreedLine(key, release.record);
            }
            return;
          }
          this.$runWrites();
          if (this.skippedLine !== null) {
            this.$writeSkippedLine(this.skippedLine);
          }
        },
        hidden === null ? null : item => hidden.overlaps(item),
      ),
    );
  }

  /**
   * The shared nodes that hold what `hidden` holds back (its items' and its
   * kept items' parents, up to the root): deleting or replacing one would
   * delete what the composition holds back (see withProtected).
   */
  private heldTypes(hidden: Hidden): Set<YNode> {
    const out = new Set<YNode>();
    const root = this.state.root;
    const note = (item: Item) => {
      for (
        let y: YNode | null = item.parent instanceof YNode ? item.parent : null;
        y !== null && y !== root && !out.has(y);
        y = y._item === null ? null : (y._item.parent as YNode)
      ) {
        out.add(y);
      }
    };
    const doc = this.tr.doc;
    hidden.forEachRange((client, start, end) => {
      const structs = doc.store.clients.get(client);
      if (structs === undefined) {
        return;
      }
      for (
        let i = findIndexSS(structs, start);
        i < structs.length && structs[i].id.clock < end;
        i++
      ) {
        const it = structs[i];
        if (it instanceof Item) {
          note(it);
        }
      }
    });
    for (const it of hidden.keptItems()) {
      note(it);
    }
    return out;
  }

  private $runWrites(): void {
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
        (unit.end !== null && isGoneIn(this.view, unit.end))
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
      if (
        y === undefined ||
        node === null ||
        (y._item && isGoneIn(this.view, y._item))
      ) {
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
    this.checkHeldKept();
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
    if (ctx.flattened === true || ctx.unpaired === true) {
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
      compositionKey: state.editor._compositionKey,
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
          storedType(this.view, typeOf(o.end)) === d.node!.getType())
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
   * from the shared items as they are stored (a held insertion counts, a
   * kept deletion does not, see isStoredIn): deletes and inserts start from
   * them, and a stale value would leave a format open or close one early. A
   * locally split unit still covered by a hold keeps its shown start until
   * release, with the stored start recorded separately (see Hidden#starts).
   */
  private $recomputeStarts(cs: CS): void {
    const formats = new Map<string, unknown>();
    const folder = new Folder(
      formats,
      this.view,
      'stored',
      this.state.hidden,
      null,
    );
    let it: Item | null = cs.y._start;
    let after: Item | null = null;
    for (const u of cs.units) {
      const hidden = this.state.hidden;
      u.start = formats.size > 0 ? new Map(formats) : null;
      folder.note(u.start, after);
      const held = hidden === null ? undefined : hidden.starts.get(u);
      if (held !== undefined) {
        held.stored = u.start;
        u.start = held.shown;
      }
      if (u.end === null) {
        break;
      }
      for (; it !== null; it = it.right) {
        folder.step(it);
        if (it === u.end) {
          after = it;
          it = it.right;
          break;
        }
      }
    }
  }

  /**
   * After a line's own write, the start formats of the units after it, folded
   * from the items as they are stored (see isStoredIn).
   */
  private $fixStartsAfter(u: Unit): void {
    // The binding's view, once: these folds write nothing.
    const view = this.view;
    let unit: Unit | undefined = u;
    // Stops where the next unit's start already agrees (usually at once).
    while (unit !== undefined) {
      if (unit.end === null || isGoneIn(view, unit.end)) {
        return;
      }
      // The next unit first: without one, the fold below would
      // set nothing.
      let next: Item | null = unit.end.right;
      while (next !== null && !isShownEndIn(view, next, this.state.hidden)) {
        next = next.right;
      }
      const nextUnit: Unit | undefined =
        next === null ? undefined : this.state.unitByEnd.get(next);
      if (nextUnit === undefined) {
        return;
      }
      const left = prevLiveEnd(view, unit.end, this.state.hidden);
      // From the unit's stored start (a split half of the line being
      // composed shows another, see Hidden#starts). (Before the copy: a
      // stale start is folded again, see frontierOf.)
      const start = this.storedStart(unit);
      let folded = frontierOf(view, start, left, unit.cs.y, null);
      let formats = new Map(start || EMPTY_FORMATS);
      let from: Item | null = left === null ? unit.cs.y._start : left.right;
      // The format pass's fold of this line, where nothing was written since:
      // go on from where it stopped.
      const pf = this.passFold;
      if (
        pf !== null &&
        this.state.hidden === null &&
        pf.deletions === deletions &&
        pf.clock === this.tr.doc.store.getClock(this.tr.doc.clientID) &&
        pf.fold.start === from &&
        pf.fold.startFormats === (start || EMPTY_FORMATS) &&
        pf.fold.frontier === folded &&
        pf.fold.stop !== null &&
        reaches(pf.fold.stop, unit.end)
      ) {
        formats = new Map(pf.fold.after);
        folded = pf.fold.folded;
        from = pf.fold.stop;
      }
      const folder = new Folder(
        formats,
        view,
        'stored',
        this.state.hidden,
        null,
        folded,
      );
      for (let it: Item | null = from; it !== null; it = it.right) {
        folder.step(it);
        if (it === unit.end) {
          break;
        }
      }
      if (sameFormatMaps(this.storedStart(nextUnit), formats)) {
        return;
      }
      this.setStoredStart(nextUnit, formats, unit.end);
      unit = nextUnit;
    }
  }

  /**
   * Unit `u`'s stored start formats: its start, or, for a half of the line
   * being composed that a local split made (see Hidden#starts), the stored
   * one kept beside the start it shows.
   */
  private storedStart(u: Unit): Formats | null {
    const hidden = this.state.hidden;
    const split = hidden === null ? undefined : hidden.starts.get(u);
    return split === undefined ? u.start : split.stored;
  }

  /**
   * Set unit `u`'s stored start formats to `formats`, folded up to `at`
   * (see storedStart): a split half of the line being composed keeps the
   * start it shows.
   */
  private setStoredStart(u: Unit, formats: Formats, at: Item | null): void {
    const hidden = this.state.hidden;
    const start = formats.size > 0 ? formats : null;
    noteFolded(start, at, 'stored', hidden);
    const split = hidden === null ? undefined : hidden.starts.get(u);
    if (split === undefined) {
      u.start = start;
    } else {
      split.stored = start;
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
   * items it found redundant (before deletes kept them, see Cursor#delete),
   * removed the opener of a run that goes on after the deleted content, and
   * every reader showed that text without the format while the author
   * kept it (also on a follow-up's delete).
   */
  private $deleteUnit(old: Unit[], idx: number): void {
    const u = old[idx];
    if (u.kind === 'node') {
      if (u.end !== null && !isGoneIn(this.view, u.end)) {
        deleteItemIn(this.view, u.end, this.tr);
      }
    } else {
      const left = unitLeft(this.view, old, idx, this.state.hidden);
      const stop = unitStop(old, idx);
      const startItem = left === null ? u.cs.y._start : left.right;
      this.frontier = frontierOf(this.view, u.start, left, u.cs.y, null);
      const cursor = this.cursor(u.cs.y, left, u.start || EMPTY_FORMATS);
      this.frontier = null;
      // Its own content starts at its first item, right after the end item
      // of the unit before it, also once this write deleted that one (a line
      // without a marker always follows one, see parseRange): live text
      // between (a line without a marker before a block node this write
      // deleted) is stepped over, never deleted with it (also where the
      // deleted unit is a line without a marker).
      const own = idx > 0 ? old[idx - 1].end : null;
      const from = own !== null && own !== left ? own.right : startItem;
      if (from !== startItem) {
        cursor.advance(
          countLive(
            this.view,
            startItem,
            from,
            this.state.hidden,
            this.leftOut,
          ),
        );
      }
      // Sized as the cursor moves: without what readers leave out (see
      // leftOut), which it does not count (and deletes with the line, see
      // Cursor#delete).
      cursor.delete(
        countLive(this.view, from, stop, this.state.hidden, this.leftOut),
      );
    }
    if (idx + 1 < old.length) {
      old[idx + 1].start = copyStart(u.start);
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
    // Where the start formats were folded up to, when past `left` (see
    // Seen.frontierOf): node units this write deleted before the first
    // remaining one, or a gone or held end before it.
    const frontier =
      frontierOf(this.view, storedStartFormats, left, cs.y, null) ??
      frontierOf(this.view, startFormats, left, cs.y, null);
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
      if (ctx.flattened === true || ctx.unpaired === true) {
        this.refused.add(cs);
      }
      this.frontier = frontier;
      let items: Map<number, Item>;
      try {
        items = this.$writeSeq(
          cs.y,
          left,
          startFormats,
          oldStop,
          atoms,
          ctx.cursorAt,
          oldOrigins,
        );
      } finally {
        this.frontier = null;
      }
      if (openTail) {
        this.frontier = frontier;
        const c = this.cursor(cs.y, left, startFormats);
        this.frontier = null;
        c.advance(atoms.length);
        // The old content's elements no editor shows after its last unit go
        // (as a rewrite of the line deleted them): left there, they would
        // follow the end item, as a line of their own the editor does not
        // have.
        c.deleteLeftOutBefore(oldStop);
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
      if (
        d.kind === 'node' &&
        skipsProtected(this.state.yByKey.get(d.node!.getKey()))
      ) {
        // Left where it is stored (see skipsProtected): no copy here.
        continue;
      }
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
    // The binding's view, once for the folds below: they write nothing.
    const view = this.view;
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
      // Where the pending starts were folded up to (see Seen.noteFolded).
      let pendingAt: Item | null = frontier ?? left;
      let k = 0;
      // Stored (a held insertion counts, a kept deletion does not) and
      // shown (the reverse): the halves of the held line show the shown
      // lane, what they hand on is stored (see isStoredIn).
      const stored = new Folder(
        current,
        view,
        'stored',
        hidden,
        null,
        frontier,
      );
      const showing = new Folder(shown, view, 'shown', hidden, null, frontier);
      for (
        let it = startItem;
        it !== null && k < segUnits.length;
        it = it.right
      ) {
        stored.step(it);
        showing.step(it);
        if (isGoneIn(view, it) || it.content instanceof ContentFormat) {
          continue;
        }
        const u = byEnd.get(it);
        if (u !== undefined) {
          u.start = pendingStart.size > 0 ? pendingStart : null;
          stored.note(u.start, pendingAt);
          if (heldSegment && !sameFormatMaps(pendingStart, pendingShown)) {
            const shownStart = pendingShown.size > 0 ? pendingShown : null;
            showing.note(shownStart, pendingAt);
            hidden!.starts.set(u, {
              shown: shownStart,
              stored: u.start,
            });
            u.start = shownStart;
          } else if (hidden !== null && hidden.starts.has(u)) {
            // A half the hold already shows: its starts agree now.
            hidden.starts.set(u, {shown: u.start, stored: u.start});
          }
          pendingStart = new Map(current);
          pendingShown = new Map(shown);
          pendingAt = it;
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
      const folder = new Folder(
        formats,
        view,
        'stored',
        this.state.hidden,
        null,
        frontier,
      );
      for (; it !== null; it = it.right) {
        folder.step(it);
        if (it === after) {
          it = it.right;
          break;
        }
      }
    }
    for (; it !== null; it = it.right) {
      if (isShownEndIn(view, it, this.state.hidden)) {
        const next = this.state.unitByEnd.get(it);
        if (
          next !== undefined &&
          !used.has(next) &&
          !sameFormatMaps(this.storedStart(next), formats)
        ) {
          this.setStoredStart(next, formats, after);
          this.$fixStartsAfter(next);
        }
        break;
      }
    }
    return after;
  }

  /**
   * Where the start formats the running write seeds its folds and cursors
   * with were folded up to, when that is past their `left` (see
   * Seen.frontierOf); null otherwise. Set around the calls that use it.
   */
  private frontier: Item | null = null;

  /** A write cursor after `left` that skips content the editor hides. */
  private cursor(y: YNode, left: Item | null, formats: Formats): Cursor {
    const c = new Cursor(
      this.tr,
      y,
      left,
      new Map(formats),
      this.frontier,
      this.view,
    );
    c.hidden = this.state.hidden;
    c.leftOut = this.leftOut;
    return c;
  }

  /**
   * Whether live item `it` is a stored inline element the editor does not
   * show (see $isLeftOutInline): one this write did not make. Invariant: the
   * writer counts exactly what the reader counts: it does not count such an
   * element, and deletes one only where a delete meets it before its last
   * unit (see Cursor#delete) or past the end of content it ends (see
   * Cursor#deleteLeftOutBefore). Why: text
   * written beside such an element was placed by positions that counted it
   * while the editor's did not. The self-check reads with it too (see
   * $checkWrite).
   */
  readonly leftOut = (it: Item): boolean =>
    $isLeftOutInline(
      this.view,
      it,
      this.state.keyByY,
      this.prevState._nodeMap,
      this.made,
    );

  /** Whether this write inserted `it` (never left out, see leftOut). */
  private readonly made = (it: Item): boolean => this.tr.insertSet.hasId(it.id);

  /** Formats in effect right after `item` (an end item, or null). */
  private formatsAfter(item: Item | null): Formats {
    if (item === null) {
      return EMPTY_FORMATS;
    }
    const unit = this.state.unitByEnd.get(item);
    const start = prevLiveEnd(this.view, item, this.state.hidden);
    const atoms = new Atoms();
    // The stored formats after it (see readAtoms), from the unit's stored
    // start (see storedStart).
    const stored = unit === undefined ? null : this.storedStart(unit);
    return readAtoms(
      this.view,
      start === null ? (item.parent as YNode)._start : start.right,
      item.right,
      unit !== undefined && unit.start !== null ? unit.start : EMPTY_FORMATS,
      atoms,
      this.state.hidden,
      frontierOf(this.view, stored, start, item.parent, null) ??
        frontierOf(
          this.view,
          unit !== undefined ? unit.start : null,
          start,
          item.parent,
          null,
        ),
      null,
      stored || EMPTY_FORMATS,
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
      if (isGoneIn(this.view, unit.end)) {
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
        storedType(this.view, typeOf(o.end)) === d.node!.getType()
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

  /**
   * The line composed in, left out of the write because a transform re-typed
   * its text (see skippedLine): of what the update changed there, only what
   * it changed on the nodes it kept (and the parts split off one) is written,
   * as formats of their characters: a NodeState value or a format the user or
   * the app set on an existing token in the update that ends the composition.
   * The characters in nodes the update made (the transform's tokens) keep
   * what is stored, as do the line's marker and its text, which the update
   * did not change. Nothing is written where the line's content does not
   * match what is stored (its characters, inline nodes and line breaks, in
   * order).
   */
  private $writeSkippedLine(key: NodeKey): void {
    const unit = this.state.unitByKey.get(key);
    const node = $getNodeByKey(key);
    if (
      unit === undefined ||
      unit.end === null ||
      isGoneIn(this.view, unit.end) ||
      !$isElementNode(node) ||
      !node.isAttached() ||
      this.roles.$role(node) !== 'line'
    ) {
      return;
    }
    const atoms = new Atoms();
    $pushInline(atoms, $lineChildren(this.$lineDesired(node)), this.$ctx(true));
    const left = prevLiveEnd(this.view, unit.end, this.state.hidden);
    const startFormats = unit.start || EMPTY_FORMATS;
    const frontier = frontierOf(this.view, unit.start, left, unit.cs.y, null);
    const old = new Atoms();
    const ids: string[] = [];
    old.ids = ids;
    readAtoms(
      this.view,
      left === null ? unit.cs.y._start : left.right,
      unit.end,
      startFormats,
      old,
      this.state.hidden,
      frontier,
      // Without what readers leave out, as the desired atoms and the
      // format pass (see leftOut).
      null,
      startFormats,
      this.leftOut,
    );
    if (old.text !== atoms.text) {
      return;
    }
    // What the update changes on each character, as the editor shows it
    // (see heldResult): what main writes of it.
    let shownAt = 0;
    for (const r of atoms.runs) {
      for (let at = r.start; at < r.end; at++) {
        if (atoms.specials.has(at) || old.specials.has(at)) {
          continue;
        }
        while (shownAt < old.runs.length && old.runs[shownAt].end <= at) {
          shownAt++;
        }
        const shown =
          shownAt < old.runs.length && old.runs[shownAt].start <= at
            ? old.runs[shownAt].attrs
            : {};
        const changed = changedAttrs(shown, r.attrs);
        if (changed !== null) {
          this.heldResult.set(ids[at], changed);
        }
      }
    }
    // The nodes holding the line's atoms that the update kept (or split off
    // one it kept), with their type: what changed on them is the update's
    // own. The transform's tokens are nodes it made.
    const prevMap = this.prevState._nodeMap;
    const splits = this.plan.splits;
    const kept = (k: NodeKey): boolean => {
      const now = $getNodeByKey(k);
      const from =
        prevMap.get(k) ??
        (splits === undefined || splits === null
          ? undefined
          : (() => {
              const split = splits.get(k);
              return split === undefined ? undefined : prevMap.get(split[0]);
            })());
      return (
        now !== null && from !== undefined && from.getType() === now.getType()
      );
    };
    const ranges: [number, number, boolean][] = [];
    for (const [a, b, k] of atoms.textNodes) {
      ranges.push([a, b, kept(k)]);
    }
    for (const [at, k] of atoms.nodes) {
      ranges.push([at, at + 1, kept(k)]);
    }
    ranges.sort((x, y) => x[0] - y[0]);
    // How the class of the type of `attrs` stores a NodeState key: flat (at
    // the top level of its JSON, stored as a field `p:<key>`, see
    // $textAttrs; another field of the same name is an ordinary one), and
    // with what StateConfig.
    const nodes = this.state.editor._nodes;
    const infoOf = (attrs: Attrs) => {
      const type = attrs[TYPE_KEY];
      return nodes.get(typeof type === 'string' ? type : 'text');
    };
    const layout: StateLayout = {
      config: (attrs, k) => {
        const info = infoOf(attrs);
        return info === undefined
          ? undefined
          : info.sharedNodeState.sharedConfigMap.get(k);
      },
      flat: (attrs, k) => {
        const info = infoOf(attrs);
        return info !== undefined && info.sharedNodeState.flatKeys.has(k);
      },
    };
    // The NodeState and formats of each character of the line in the editor
    // before this update (the line held the same atoms then): on the nodes
    // the transform made, a value that changed in this update is the
    // update's own (a value the user or the app set, which a tokenizer
    // carried onto its tokens), see keepMadeAsStored. In the atoms' terms
    // (see $pushInline): a text node's text, a line break's newline, a
    // wrapper's content, one atom for any other node (an inline decorator).
    const before = this.prevState.read(() => {
      const prev = $getNodeByKey(key);
      if (!$isElementNode(prev)) {
        return null;
      }
      const runs: Run[] = [];
      let text = '';
      const visit = (children: readonly LexicalNode[]) => {
        for (const n of children) {
          if ($isTextNode(n)) {
            const shown = toWellFormed(n.getTextContent());
            if (shown.length > 0) {
              runs.push({
                attrs: carriedState($textAttrs(n, null), layout),
                end: text.length + shown.length,
                start: text.length,
              });
              text += shown;
            }
          } else if ($isLineBreakNode(n)) {
            text += '\n';
          } else if ($isWrapper(n)) {
            visit((n as ElementNode).getChildren());
          } else {
            text += '\ufffc';
          }
        }
      };
      visit(prev.getChildren());
      return {runs, text};
    });
    atoms.runs = keepMadeAsStored(
      atoms.runs,
      old.runs,
      ranges,
      atoms.length,
      before !== null && before.text === atoms.text ? before.runs : null,
      layout,
    );
    this.frontier = frontier;
    try {
      this.$formatPass(unit.cs.y, left, startFormats, atoms);
    } finally {
      this.frontier = null;
    }
  }

  /**
   * A line that holds characters of a line whose re-typing was not written
   * (see skippedLine), once the hold has ended and Lexical's transforms ran
   * on it as stored (see YBinding#$normalize): of what they made, only what
   * agrees with what the update that ended the composition would have
   * written (see heldResult) is written, as formats of those characters,
   * attribute by attribute (see agreedAttrs). Text is never written
   * (characters whose text a transform changed keep what is stored), nor is
   * any other character. Nothing is written where a transform restructured
   * the line: replaced it, or moved a node holding one of its characters
   * into another line (see $movedOut).
   */
  private $writeAgreedLine(
    key: NodeKey,
    record: ReadonlyMap<string, Attrs>,
  ): void {
    const unit = this.state.unitByKey.get(key);
    const node = $getNodeByKey(key);
    if (
      unit === undefined ||
      unit.end === null ||
      isGoneIn(this.view, unit.end) ||
      !$isElementNode(node) ||
      !node.isAttached() ||
      this.roles.$role(node) !== 'line'
    ) {
      return;
    }
    const atoms = new Atoms();
    $pushInline(atoms, $lineChildren(this.$lineDesired(node)), this.$ctx());
    const left = prevLiveEnd(this.view, unit.end, this.state.hidden);
    const startFormats = unit.start || EMPTY_FORMATS;
    const frontier = frontierOf(this.view, unit.start, left, unit.cs.y, null);
    const old = new Atoms();
    const ids: string[] = [];
    old.ids = ids;
    readAtoms(
      this.view,
      left === null ? unit.cs.y._start : left.right,
      unit.end,
      startFormats,
      old,
      this.state.hidden,
      frontier,
      // Without what readers leave out, as the desired atoms and the
      // format pass (see leftOut).
      null,
      startFormats,
      this.leftOut,
    );
    // A transform that restructured the line (moved a node holding one of
    // its characters into another line): nothing is written for it (an
    // accepted limit, see DECISIONS.md D115).
    if (this.$movedOut(key, node, ids, record)) {
      return;
    }
    // The characters the transforms left where they are: the common prefix
    // and suffix of the stored text and theirs.
    const {prefix, suffix} = diffStrings(old.text, atoms.text, -1);
    const delta = atoms.length - old.length;
    const runs: Run[] = [];
    let agrees = false;
    let stored = 0;
    let made = 0;
    for (let at = 0; at < old.length; at++) {
      while (stored < old.runs.length && old.runs[stored].end <= at) {
        stored++;
      }
      let attrs: Attrs =
        stored < old.runs.length && old.runs[stored].start <= at
          ? old.runs[stored].attrs
          : {};
      const to = at < prefix ? at : at >= old.length - suffix ? at + delta : -1;
      const held = record.get(ids[at]);
      if (
        held !== undefined &&
        to >= 0 &&
        !old.specials.has(at) &&
        !atoms.specials.has(to)
      ) {
        while (made < atoms.runs.length && atoms.runs[made].end <= to) {
          made++;
        }
        if (made < atoms.runs.length && atoms.runs[made].start <= to) {
          const agreed = agreedAttrs(attrs, atoms.runs[made].attrs, held);
          if (agreed !== attrs) {
            attrs = agreed;
            agrees = true;
          }
        }
      }
      const last = runs[runs.length - 1];
      if (last !== undefined && last.end === at && last.attrs === attrs) {
        last.end = at + 1;
      } else {
        runs.push({attrs, end: at + 1, start: at});
      }
    }
    if (!agrees) {
      return;
    }
    old.runs = runs;
    this.frontier = frontier;
    try {
      this.$formatPass(unit.cs.y, left, startFormats, old);
    } finally {
      this.frontier = null;
    }
  }

  /**
   * Whether a text node that held one of the characters `record` names in
   * line `key` before the transforms ran (the update's previous state, read
   * as stored, so a collaborator's split or join is already there) is now in
   * a line other than `line`. A node the transforms replaced in place (a
   * hashtag made of the whole node) moved nowhere.
   */
  private $movedOut(
    key: NodeKey,
    line: ElementNode,
    ids: readonly string[],
    record: ReadonlyMap<string, Attrs>,
  ): boolean {
    const holders = this.prevState.read(() => {
      const out: NodeKey[] = [];
      const prev = $getNodeByKey(key);
      if (!$isElementNode(prev)) {
        return out;
      }
      let at = 0;
      const visit = (children: readonly LexicalNode[]) => {
        for (const n of children) {
          if ($isTextNode(n)) {
            const size = toWellFormed(n.getTextContent()).length;
            for (let k = at; k < at + size; k++) {
              if (record.has(ids[k])) {
                out.push(n.getKey());
                break;
              }
            }
            at += size;
          } else if ($isWrapper(n)) {
            visit((n as ElementNode).getChildren());
          } else {
            // A line break or an inline node: one atom (see $pushInline).
            at += 1;
          }
        }
      };
      visit(prev.getChildren());
      return out;
    });
    for (const k of holders) {
      const now = $getNodeByKey(k);
      if (now !== null && now.isAttached()) {
        let at = now.getParent();
        while (at !== null && this.roles.$role(at) !== 'line') {
          at = at.getParent();
        }
        if (at === null || at.getKey() !== line.getKey()) {
          return true;
        }
      }
    }
    return false;
  }

  /** Rewrite one line (its content and marker) on its own. */
  $writeLineAlone(u: Unit, d: Desired): void {
    // A rewrite after a failed write diffs the line against the document:
    // the edits Lexical recorded may be stored already (the failed write
    // stored part of its change), and writing them again would repeat them.
    if (!this.rewriteAll && this.$writeTextEdit(u, d)) {
      return;
    }
    const old = u.cs.units;
    let left: Item | null;
    let stop: Item | null;
    let frontier: Item | null;
    if (u.end !== null) {
      left = prevLiveEnd(this.view, u.end, this.state.hidden);
      stop = u.end.right;
      frontier = frontierOf(this.view, u.start, left, u.cs.y, null);
    } else {
      const idx = old.indexOf(u);
      left = unitLeft(this.view, old, idx, this.state.hidden);
      stop = unitStop(old, idx);
      frontier = frontierOf(this.view, u.start, left, u.cs.y, null);
    }
    const atoms = new Atoms();
    const oldOrigins = this.oldOrigins([u]);
    this.setOriginOrder(oldOrigins);
    const ctx = this.$ctx(true);
    $pushInline(atoms, $lineChildren(d), ctx);
    if (ctx.flattened === true || ctx.unpaired === true) {
      this.refused.add(u.cs);
    }
    const at = atoms.length;
    let end: Item;
    if (u.end === null) {
      // Text without a marker (left by a concurrent edit): diff the content
      // alone (a trailing marker would defeat the common suffix), then end
      // it with a marker.
      this.frontier = frontier;
      try {
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
        // As for a sequence's open tail: the elements no editor shows after
        // the content's last unit go, or they would follow the marker.
        c.deleteLeftOutBefore(stop);
        end = c.insertPlain(new ContentType(new YNode(MARKER)));
      } finally {
        this.frontier = null;
      }
    } else {
      atoms.pushSpecial({kind: 'marker', ref: d}, null);
      this.frontier = frontier;
      try {
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
      } finally {
        this.frontier = null;
      }
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
   * changed text, not in the line's length. Not for text holding a
   * surrogate half without its pair, which the line's write stores as U+FFFD
   * and reads again (see DesiredContext.unpaired).
   */
  private $writeTextEdit(u: Unit, d: Desired): boolean {
    if (
      u.kind !== 'line' ||
      u.end === null ||
      isGoneIn(this.view, u.end) ||
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
    // The changed text nodes, each with its old version and the atom its
    // old text starts at.
    const changes: [TextNode, TextNode, number][] = [];
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
        changes.push([now, prev, offset]);
        offset += prev.__text.length;
      } else {
        // An element child (a link) is the same object when only its
        // children changed: its subtree must be unchanged too.
        if ($isElementNode(now) && !sameSubtree(now, prevMap)) {
          return false;
        }
        offset += $atomSize(now);
      }
      a = prev.__next;
      b = b.getNextSibling();
    }
    // Several changed nodes only where text edits are not recorded (the
    // record's own path writes those as it did, through the line).
    if (
      changes.length === 0 ||
      (changes.length > 1 && this.state.editor._recordTextEdits) ||
      changes.some(
        ([changed]) =>
          $runsWithNeighbour(changed) || hasLoneSurrogate(changed.__text),
      )
    ) {
      return false;
    }
    // Every node's edits first (nothing is written where one cannot be),
    // then written in one pass from the first node to the last, with one
    // cursor (each node starts at its old offset moved by the edits written
    // before it).
    const writes: [TextNode, TextNode, number, [number, number, string][]][] =
      [];
    for (const [changed, changedBefore, at] of changes) {
      const edits = this.$textEdits(changed, changedBefore);
      if (edits === false) {
        return false;
      }
      if (edits.length > 0) {
        writes.push([changed, changedBefore, at, edits]);
      }
    }
    if (writes.length > 0) {
      const left = prevLiveEnd(this.view, u.end!, this.state.hidden);
      this.frontier = frontierOf(this.view, u.start, left, u.cs.y, null);
      const c = this.cursor(u.cs.y, left, u.start || EMPTY_FORMATS);
      this.frontier = null;
      // Where the cursor stands, in atoms of the line as written so far,
      // and how far the edits written so far moved what comes after them.
      let pos = 0;
      let moved = 0;
      for (const [changed, changedBefore, at, edits] of writes) {
        // The node's segment key as stored: one read without a key (a code
        // highlight a client stored without one) keeps none, or the text
        // inserted here would be stored, and read, as a node of its own.
        const segment = isMergeableText(changed)
          ? null
          : (this.state.segments.get(changed.getKey()) ?? null);
        const start = at + moved;
        c.advance(start - pos);
        const old = changedBefore.__text;
        const now = changed.__text;
        const attrs = $textAttrs(changed, segment);
        pos = start + this.$writeEdits(c, edits, old, now, attrs);
        moved += now.length - old.length;
      }
    }
    this.$writeMarker(u.end, d);
    u.sig = d.sig;
    this.touched.push({d, unit: u});
    return true;
  }

  /**
   * The edits that make text node `changed` of its old version
   * `changedBefore`: as Lexical recorded them, exactly where they were made
   * (see TextReplay), and as made: a replacement is not widened to whole
   * words (see snapToWords), which a diff's guess at shared letters needs,
   * and a record does not. Else a diff (see setTextStretches): its common
   * start and end, anchored at the caret, and every run of unchanged words
   * between its changes. False where the node holds characters of another
   * (the line is written whole).
   */
  private $textEdits(
    changed: TextNode,
    changedBefore: TextNode,
  ): [number, number, string][] | false {
    const oldText = changedBefore.__text;
    const newText = changed.__text;
    const edits = this.exactEdits(changed, oldText.length);
    if (edits !== null) {
      return edits;
    }
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
    // What it keeps of the old text, and the edits between.
    const kept = setTextStretches(
      oldText,
      newText,
      cursor,
      this.state.editor._compositionKey !== null,
    );
    const diff: [number, number, string][] = [];
    let lastA = 0;
    let lastB = 0;
    for (const [x0, x1, dx] of kept) {
      if (x0 + dx > lastA || x0 > lastB) {
        diff.push([lastA, x0 + dx - lastA, newText.slice(lastB, x0)]);
      }
      lastA = x1 + dx;
      lastB = x1;
    }
    return diff;
  }

  /**
   * Write a text node's edits (see exactEdits), which make its text `now`
   * of its old text `old`, with the cursor at the node's start and the
   * node's attributes `attrs`. Returns how far past the node's start the
   * cursor ends, in atoms of its new text.
   */
  private $writeEdits(
    c: Cursor,
    edits: [number, number, string][],
    old: string,
    now: string,
    attrs: Attrs,
  ): number {
    const hunks: Hunk[] = [];
    let shift = 0;
    for (const [at, del, ins] of edits) {
      hunks.push([at, del, at + shift, at + shift + ins.length]);
      shift += ins.length - del;
    }
    return this.$writeHunks(c, old, now, hunks, (cursor, from, to) => {
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
   * time). Returns where the cursor ends: the desired atom after the last
   * hunk.
   */
  private $writeHunks(
    c: Cursor,
    old: string,
    now: string,
    hunks: readonly Hunk[],
    insert: (cursor: Cursor, from: number, to: number) => void,
    oldStop?: Item | null,
  ): number {
    let pos = 0;
    let end = 0;
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
        if (oldStop !== undefined && at + del === old.length) {
          // A delete that reaches the end of the old content (a line
          // without a marker, before a block node) takes the elements no
          // editor shows after its last unit, up to that end, along: no end
          // item follows for it to meet (see Cursor#delete).
          c.deleteLeftOutBefore(oldStop);
        }
      }
      if (to > from) {
        insert(c, from, to);
      }
      pos = at + del;
      end = to;
    }
    return end;
  }

  // -------------------------------------------------------------------------
  // Sequences

  /**
   * Which old line markers a desired line may keep, where a sequence holds
   * more than one marker on either side (one line written on its own keeps
   * its marker): null where there is no choice. Invariant: an old marker is
   * kept only by the line that continues the line it ended (see D118), the
   * first of:
   * - the line whose last atom is the old line's last atom (a character, or
   *   an inline node kept), by Lexical's record of text edits (`record`, see
   *   $exactAtoms): the tail of a split (Enter in the middle of a line: the
   *   new line keeps the marker after the tail and the old line, holding the
   *   head, gets a new one, so no character moves), or the line a join or a
   *   range delete across lines ends with the joined text (it keeps the
   *   marker after that text, and its own goes);
   * - where the old line stays: a new line ending with what it lost from its
   *   end (a split the record does not explain: app code that sets the
   *   head's text and adds a line holding the tail), else that line itself;
   * - where it is gone: the lines holding a node it held before this update
   *   (a line Lexical replaced, `$setBlocksType`, or one joined into another),
   *   else the lines ending with all of its text (a paste over it);
   * - else, where no line continues it, any line that was there before (or
   *   one without a key), by position as before, never a line new in this
   *   update.
   * Why: a marker matched any marker, so where a collaborator replaced a
   * line and added another after it, the common suffix gave the old marker
   * to the new line; every reader keys a line by its marker, so the old
   * line's node, and a composition in it, moved to the new line (and the
   * composer's highlighter re-tokenized it, or its typing landed there).
   */
  private $markerContinues(
    old: Atoms,
    atoms: Atoms,
    record: {of: Int32Array; kept: Int32Array} | null,
  ): {
    match: (i: number, j: number) => boolean;
    anchored: Set<number>;
  } | null {
    const oldAt: number[] = [];
    const newAt: number[] = [];
    old.specials.forEach((sp, i) => {
      if (sp.kind === 'marker') {
        oldAt.push(i);
      }
    });
    atoms.specials.forEach((sp, j) => {
      if (sp.kind === 'marker') {
        newAt.push(j);
      }
    });
    if (oldAt.length <= 1 && newAt.length <= 1) {
      return null;
    }
    oldAt.sort((x, y) => x - y);
    newAt.sort((x, y) => x - y);
    const prevMap = this.prevState._nodeMap;
    // The text of the line ending at the `k`th marker (from the one before),
    // and the atom before that marker where it is in that line (else -1).
    const textOf = (a: Atoms, at: number[], k: number) =>
      a.text.slice(k === 0 ? 0 : at[k - 1] + 1, at[k]);
    const lastOf = (at: number[], k: number) =>
      at[k] - 1 >= (k === 0 ? 0 : at[k - 1] + 1) ? at[k] - 1 : -1;
    const newLines = newAt.map((j, k) => {
      const d = (atoms.specials.get(j) as {ref: unknown}).ref as Desired;
      const to = d.key === null ? null : lineOfUnit(d.key);
      return {
        isNew: to !== null && !prevMap.has(to),
        j,
        now: textOf(atoms, newAt, k),
        to,
      };
    });
    // The desired lines (or parts of one, see $pushLine) of each line key.
    const lines = new Map<NodeKey, number[]>();
    // Which desired lines hold each node, and end with each short text.
    const holders = new Map<NodeKey, number[]>();
    const enders = new Map<string, number[]>();
    const add = <K>(m: Map<K, number[]>, k: K, v: number) => {
      const l = m.get(k);
      if (l === undefined) {
        m.set(k, [v]);
      } else if (l[l.length - 1] !== v) {
        l.push(v);
      }
    };
    const ENDING = 8;
    newLines.forEach((n, k) => {
      if (n.to !== null) {
        add(lines, n.to, k);
      }
    });
    // The desired line whose last character Lexical's record says is old
    // atom `i`.
    const recorded = new Map<number, number>();
    if (record !== null) {
      newAt.forEach((_, k) => {
        const nj = lastOf(newAt, k);
        if (nj >= 0 && record.of[nj] >= 0) {
          recorded.set(record.of[nj], k);
        }
      });
    }
    // Built when a line that is gone is looked for (see below).
    let indexed = false;
    const $indexHolders = () => {
      indexed = true;
      newLines.forEach((n, k) => {
        const d = (atoms.specials.get(n.j) as {ref: unknown}).ref as Desired;
        const stack: (LexicalNode | null | undefined)[] = [...$lineChildren(d)];
        while (stack.length > 0) {
          const node = stack.pop();
          if (!$isLexicalNode(node)) {
            continue;
          }
          add(holders, node.getKey(), k);
          if ($isElementNode(node)) {
            stack.push(...node.getChildren());
          }
        }
      });
    };
    const $heldBefore = (line: NodeKey): NodeKey[] => {
      const out: NodeKey[] = [];
      const stack = [line];
      while (stack.length > 0) {
        const n = prevMap.get(stack.pop()!);
        if (n !== undefined && $isElementNode(n)) {
          let c = n.__first;
          while (c !== null) {
            out.push(c);
            stack.push(c);
            const next = prevMap.get(c);
            c = next === undefined ? null : next.__next;
          }
        }
      }
      return out;
    };
    // The desired lines ending with `text` (all of it).
    const endingWith = (text: string): number[] => {
      if (enders.size === 0) {
        newLines.forEach((n, k) => {
          for (let len = 1; len <= ENDING && len <= n.now.length; len++) {
            add(enders, n.now.slice(-len), k);
          }
        });
      }
      const l = enders.get(text.slice(-ENDING)) ?? [];
      return text.length <= ENDING
        ? l
        : l.filter(k => newLines[k].now.endsWith(text));
    };
    const ANY = null;
    // Lines without a key: kept as before by a marker no line claims.
    // A marker no line continues (its line is gone, and no line holds what
    // it held) is kept as before, by position, but only by a line that was
    // there before this update or one without a key, never by a new line.
    // Why: deleted with its line, text a collaborator typed into that line
    // at the same time lost the marker after it and joined the next line's
    // text or showed as a line of its own (the previous rule kept it at the
    // end of the line before, as an edit there does); a new line that took
    // it is the case D118 fixes.
    const orphanable = new Set<number>();
    newLines.forEach((n, k) => {
      if (n.to === null || !n.isNew) {
        orphanable.add(k);
      }
    });
    // The desired lines with the strongest claim on each old marker (ANY:
    // every line, where the marker's line is not known), see the rules
    // above. A line that stays keeps its marker unless the record gives its
    // last character to another line (the tail of a split).
    const best = new Map<number, Set<number> | null>();
    // Old markers the record gives a line (see withMarkerIslands).
    const anchored = new Set<number>();
    oldAt.forEach((i, ki) => {
      const owner = this.ownerBefore(
        (old.specials.get(i) as {ref: unknown}).ref as Item,
      );
      if (owner === null) {
        best.set(i, ANY);
        return;
      }
      const oi = lastOf(oldAt, ki);
      // A character, or an inline node kept (an equation the line ends
      // with), see $exactAtoms.
      const lastSpecial = oi < 0 ? undefined : old.specials.get(oi);
      const lastKind =
        oi < 0
          ? null
          : lastSpecial === undefined
            ? undefined
            : lastSpecial.kind;
      const byRecord =
        oi >= 0 && (lastKind === undefined || lastKind === 'oldNode')
          ? recorded.get(oi)
          : undefined;
      const from = lineOfUnit(owner);
      let set = new Set<number>();
      if (byRecord !== undefined) {
        set.add(byRecord);
        anchored.add(i);
      } else if (lines.has(from)) {
        // The line stays: it keeps its marker, unless a new line ends with
        // what it lost from its end (a split the record does not explain,
        // app code that sets the head's text and adds a line holding the
        // tail), which keeps the marker after that text.
        const own = lines.get(from)!;
        const was = textOf(old, oldAt, ki);
        const head = newLines[own[0]].now;
        let n = 0;
        while (n < was.length && n < head.length && was[n] === head[n]) {
          n++;
        }
        const tail = was.slice(n);
        const tails =
          tail.length > 0 && head.length < was.length
            ? endingWith(tail).filter(k => newLines[k].isNew)
            : [];
        set = new Set(tails.length > 0 ? tails : own);
      } else {
        if (!indexed) {
          $indexHolders();
        }
        for (const key of $heldBefore(from)) {
          for (const k of holders.get(key) ?? []) {
            set.add(k);
          }
        }
        if (set.size === 0) {
          const was = textOf(old, oldAt, ki);
          if (was.length > 0) {
            set = new Set(endingWith(was));
          }
        }
      }
      best.set(i, set.size > 0 ? set : orphanable);
    });
    return {
      anchored,
      match: (i, j) => {
        const set = best.get(i)!;
        if (set === ANY) {
          return true;
        }
        for (const k of set) {
          if (newLines[k].j === j) {
            return true;
          }
        }
        return false;
      },
    };
  }

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
    readAtoms(
      this.view,
      startItem,
      oldStop,
      startFormats,
      old,
      this.state.hidden,
      this.frontier,
      null,
      startFormats,
      this.leftOut,
    );
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
    // Lexical's record of which old atom each desired atom is (see
    // $exactAtoms), where it explains the whole content.
    const record =
      oldOrigins !== null &&
      (atoms.origins.length > 0 || atoms.nodes.length > 0) &&
      oldOrigins[oldOrigins.length - 1][1] === old.length
        ? this.$exactAtoms(oldOrigins, atoms, old)
        : null;
    const continues = this.$markerContinues(old, atoms, record);
    const matchSpecial = (i: number, j: number): boolean => {
      const a = old.specials.get(i)!;
      const b = atoms.specials.get(j)!;
      if (a.kind === 'marker') {
        return (
          b.kind === 'marker' && (continues === null || continues.match(i, j))
        );
      }
      if (a.kind === 'runEnd') {
        return a.kind === b.kind;
      }
      if (a.kind === 'oldNode' && b.kind === 'inline') {
        if (!a.name.startsWith(INLINE_PREFIX)) {
          return false;
        }
        const oy = typeOf(a.item);
        const oldKey = state.keyByY.get(oy);
        if (oldKey === b.key) {
          return storedType(this.view, oy) === b.node.getType();
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
          storedType(this.view, oy) !== b.node.getType() &&
          newTypes.has(storedType(this.view, oy))
        ) {
          return false;
        }
        if ($isElementNode(b.node)) {
          return cs !== undefined && cs.kind === this.roles.$kind(b.node);
        }
        return (
          cs === undefined && storedType(this.view, oy) === b.node.getType()
        );
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
        exact = record;
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
    // Invariant: a shared node whose key is in the old atoms and the desired
    // ones, in the same order among such nodes, is kept (its item stays),
    // with or without a record of text edits. Why: without one (an app's
    // edit inside a read, a recovered write, a follow-up) the range from the
    // first change to the last was one rewrite, which deleted a shared node
    // between two edits and made it again from what the editor shows:
    // everything in it the editor does not show (a peer's concurrent edit,
    // what a composition holds back) was lost.
    const keyed = keyedIslands(
      old,
      atoms,
      prefix,
      suffix,
      i => {
        const a = old.specials.get(i);
        return a !== undefined && a.kind === 'oldNode'
          ? state.keyByY.get(typeOf(a.item))
          : undefined;
      },
      matchSpecial,
    );
    const anchors = withKeyed(
      exact === null
        ? []
        : islands(exact, old, atoms, prefix, suffix, matchSpecial),
      keyed,
    );
    if (exact !== null && exactRange(exact, prefix, atoms.length - suffix)) {
      kept = anchors;
    } else if (anchors.length > 0) {
      keeps ??= (i, j) =>
        !old.specials.has(i) &&
        !atoms.specials.has(j) &&
        old.text.charCodeAt(i) === atoms.text.charCodeAt(j);
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
    // A marker the record gives the line that continues its line (see
    // $markerContinues: the line ending with its line's last character),
    // where that line is between the prefix and the suffix (a join or a
    // split with a line added after it): kept as an island where it falls
    // between the atoms kept there, in order. Only these: a client that
    // diffs the same content with a concurrent edit keeps the same marker
    // with the same text (a marker a line kept by its key alone, kept
    // here while that client keeps another, would leave both deleted). Why:
    // only the prefix and the suffix kept markers, so a marker whose line
    // was not at either end was deleted and written again, and a
    // collaborator's concurrent change of the line's attributes was lost.
    if (continues !== null && continues.anchored.size > 0) {
      kept = this.withMarkerIslands(
        kept,
        old,
        atoms,
        prefix,
        suffix,
        (i, j) => continues.anchored.has(i) && matchSpecial(i, j),
      );
    }
    const items = new Map<number, Item>();
    for (const [ki, kj] of kept) {
      const it = old.items.get(ki);
      const a = old.specials.get(ki);
      const b = atoms.specials.get(kj);
      if (
        it !== undefined &&
        a !== undefined &&
        a.kind === 'marker' &&
        b !== undefined &&
        b.kind === 'marker'
      ) {
        items.set(kj, it);
      }
    }
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
      oldStop,
    );
    this.$formatPass(y, left, startFormats, atoms);
    return items;
  }

  /**
   * `kept` (old and desired atoms kept between the prefix and the suffix,
   * in order) with the markers `matchSpecial` keeps for a line there added
   * where each falls between two kept atoms on both sides.
   */
  private withMarkerIslands(
    kept: [number, number][],
    old: Atoms,
    atoms: Atoms,
    prefix: number,
    suffix: number,
    matchSpecial: (i: number, j: number) => boolean,
  ): [number, number][] {
    const oldEnd = old.length - suffix;
    const newEnd = atoms.length - suffix;
    const newMarkers: number[] = [];
    atoms.specials.forEach((sp, j) => {
      if (sp.kind === 'marker' && j >= prefix && j < newEnd) {
        newMarkers.push(j);
      }
    });
    if (newMarkers.length === 0) {
      return kept;
    }
    newMarkers.sort((x, y) => x - y);
    const oldMarkers: number[] = [];
    old.specials.forEach((sp, i) => {
      if (sp.kind === 'marker' && i >= prefix && i < oldEnd) {
        oldMarkers.push(i);
      }
    });
    oldMarkers.sort((x, y) => x - y);
    const used = new Set<number>();
    for (const [, kj] of kept) {
      used.add(kj);
    }
    // One pass over the old markers and the kept atoms, in order.
    const added: [number, number][] = [];
    let at = 0;
    let last = prefix - 1;
    for (const i of oldMarkers) {
      while (at < kept.length && kept[at][0] < i) {
        at++;
      }
      if (at < kept.length && kept[at][0] === i) {
        continue;
      }
      const lo = Math.max(at === 0 ? prefix - 1 : kept[at - 1][1], last);
      const hi = at === kept.length ? newEnd : kept[at][1];
      // The first desired marker after `lo` (binary search).
      let l = 0;
      let h = newMarkers.length;
      while (l < h) {
        const m = (l + h) >> 1;
        if (newMarkers[m] <= lo) {
          l = m + 1;
        } else {
          h = m;
        }
      }
      for (let k = l; k < newMarkers.length && newMarkers[k] < hi; k++) {
        const j = newMarkers[k];
        if (!used.has(j) && matchSpecial(i, j)) {
          added.push([i, j]);
          used.add(j);
          last = j;
          break;
        }
      }
    }
    if (added.length === 0) {
      return kept;
    }
    const out: [number, number][] = [];
    let x = 0;
    for (const pair of added) {
      while (x < kept.length && kept[x][0] < pair[0]) {
        out.push(kept[x++]);
      }
      out.push(pair);
    }
    while (x < kept.length) {
      out.push(kept[x++]);
    }
    return out;
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
          let i =
            r !== undefined && t < r[1] - r[0]
              ? r[0] + t
              : atom !== undefined && this.sameAtom(old, atom, atoms, at)
                ? atom
                : -1;
          // A character stored otherwise than it was (a surrogate half
          // without its pair, written as U+FFFD: DesiredContext.unpaired)
          // is new text.
          if (
            i >= 0 &&
            !node &&
            atoms.text.charCodeAt(at) !== old.text.charCodeAt(i)
          ) {
            i = -1;
          }
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
      this.state.keyByY.get(oy) === b.key &&
      storedType(this.view, oy) === b.node.getType()
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
      if (isShadowKey(k)) {
        return;
      }
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
        } else if (
          special.kind === 'inline' &&
          skipsProtected(this.state.yByKey.get(special.node.getKey()))
        ) {
          // Left where it is stored (see skipsProtected): no copy here.
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
      const attrs = run ? run.attrs : {};
      // While a composition holds changes back: text of a node new in this
      // update (see freshTextNode), written apart from the text around it.
      let fresh = false;
      if (this.state.hidden !== null) {
        const nodes = atoms.textNodes;
        let k = textNodeAfter(nodes, i);
        if (k < nodes.length && nodes[k][0] <= i) {
          // The node `i` is in: fresh text stops where it ends.
          fresh = this.freshTextNode(atoms, k);
          if (fresh) {
            j = Math.min(j, nodes[k][1]);
          }
          k++;
        }
        // Then up to the first node after `i` that is not as fresh (only the
        // nodes that start before `j`).
        for (; k < nodes.length && nodes[k][0] < j; k++) {
          if (this.freshTextNode(atoms, k) !== fresh) {
            j = nodes[k][0];
            break;
          }
        }
      }
      cursor.insert(
        new ContentString(atoms.text.slice(i, j)),
        this.inheritUnknown(cursor, attrs),
        fresh,
      );
      i = j;
    }
  }

  /**
   * The characters of text this update removed or cut from text nodes that
   * existed before it (see freshTextNode): the whole old text of each one it
   * removed; of each one it kept, the ranges its record of text edits says
   * were deleted, and its whole old text where that is not all of it (its
   * old text no longer in it in order). Computed once per write, while a
   * composition holds changes back only. Conservative by construction: what
   * may have been removed is counted.
   */
  private removedChars: Set<string> | null = null;

  private $removedChars(): Set<string> {
    if (this.removedChars === null) {
      const out = new Set<string>();
      const add = (text: string) => {
        for (const ch of text) {
          out.add(ch);
        }
      };
      for (const e of this.plan.textEdits ?? []) {
        if (e[0] === 'splice' && e[3] > 0) {
          add(e[5].slice(e[2], e[2] + e[3]));
        } else if (e[0] === 'set' && e[2] !== '' && e[2] !== e[3]) {
          add(e[2]);
        } else if (e[0] === 'move') {
          add(e[4].slice(0, e[3]));
        }
      }
      for (const [key, prev] of this.prevState._nodeMap) {
        if (!$isTextNode(prev) || prev.__text === '') {
          continue;
        }
        const old = prev.__text;
        const now = $getNodeByKey(key);
        if (now === null || !now.isAttached() || !$isTextNode(now)) {
          add(old);
        } else if (!isSubsequence(old, now.getTextContent())) {
          add(old);
        }
      }
      this.removedChars = out;
    }
    return this.removedChars;
  }

  /**
   * Whether text node `k` of desired atoms `atoms` (its entry in
   * atoms.textNodes) is a node new in this update that carries no old text
   * on: not a node that existed (merged into or not), not a part split off
   * one, and sharing no character with text the update removed or cut (see
   * removedChars), so a node replaced by one with a new key, a copy, a
   * split's tail, text cut out into a node of its own, an app's re-keying in
   * a read are never fresh, whatever text they add. When in doubt, not
   * fresh: written as before.
   */
  private freshTextNode(atoms: Atoms, k: number): boolean {
    const [a, b, key] = atoms.textNodes[k];
    const splits = this.plan.splits;
    if (
      this.prevState._nodeMap.has(key) ||
      (splits !== undefined && splits !== null && splits.has(key)) ||
      this.splitPart(key)
    ) {
      return false;
    }
    const removed = this.$removedChars();
    for (const ch of atoms.text.slice(a, b)) {
      if (removed.has(ch)) {
        return false;
      }
    }
    return true;
  }

  /**
   * The nodes the update's record of text edits says were split off (each
   * part of a split but the node split), computed once per write, while a
   * composition holds changes back only (see freshTextNode).
   */
  private splitParts: Set<NodeKey> | null = null;

  /** Whether the update's record of text edits says `key` was split off. */
  private splitPart(key: NodeKey): boolean {
    if (this.splitParts === null) {
      const out = new Set<NodeKey>();
      for (const e of this.plan.textEdits ?? []) {
        if (e[0] === 'split') {
          for (const part of e[2]) {
            if (part !== e[1]) {
              out.add(part);
            }
          }
        }
      }
      this.splitParts = out;
    }
    return this.splitParts.has(key);
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
    const fold = readAtomsLimited(
      this.view,
      this.frontier,
      startItem,
      startFormats,
      atoms.length,
      actual,
      this.state.hidden,
      this.leftOut,
    );
    // Kept for $fixStartsAfter while nothing is written.
    this.passFold =
      this.state.hidden === null
        ? {
            clock: this.tr.doc.store.getClock(this.tr.doc.clientID),
            deletions,
            fold,
          }
        : null;
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
    const current = attrsOfIn(this.view, y) as Attrs;
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
        setAttrIn(this.view, y, k, want[k], this.tr);
        changed = true;
      }
    }
    for (const k in current) {
      if (
        !(k in want) &&
        (taken || ownsMarkerAttr(k, owners.fields, owners.groupFields)) &&
        !this.keepsStored(k, current[k], undefined, storedText)
      ) {
        deleteAttrIn(this.view, y, k, this.tr);
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
   * as they were then (see attrsBeforeIn): for a part that had none, the
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
          : attrsBeforeIn(this.view, typeOf(end), this.tr);
      if (attrs === null && key !== whole) {
        attrs = this.$markerBefore(whole, whole);
      }
      this.markersBefore.set(key, attrs);
    }
    return attrs;
  }

  /**
   * The type and attributes the shared node of node `key` had before this
   * write, as they were then (see attrsBeforeIn), or null where it had none:
   * read the first time this write gives the node new storage (see
   * $fillNode), from the one it had then.
   */
  private nodeBefore(key: NodeKey): [string, Attrs] | null {
    let found = this.nodesBefore.get(key);
    if (found === undefined) {
      const y = this.state.yByKey.get(key);
      found =
        y === undefined ? null : nodeBeforeTransaction(this.view, y, this.tr);
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
    if (
      end === null ||
      isGoneIn(this.view, end) ||
      this.tr.insertSet.hasId(end.id)
    ) {
      return null;
    }
    const marker = typeOf(end);
    return attrOfIn(this.view, marker, GROUP_KEY) === gtype
      ? (attrsOfIn(this.view, marker) as Attrs)
      : null;
  }

  $writeNodeAttrs(y: YNode, node: LexicalNode): void {
    const holes: string[] = [];
    const desired = $nodeAttrs(node, holes);
    if (holes.length > 0) {
      this.holed.add(node.getKey());
    }
    const current = attrsOfIn(this.view, y) as Attrs;
    // The fields this editor owns here (see ownsNodeAttr): its classes' of
    // the type stored and of the node's.
    const fields = ownedFields(
      this.state.editor,
      storedType(this.view, y),
      node.getType(),
      true,
    );
    if (String(y.name).slice(2) !== node.getType()) {
      desired[TYPE_KEY] = node.getType();
    } else if (TYPE_KEY in current) {
      deleteAttrIn(this.view, y, TYPE_KEY, this.tr);
    }
    const storedText = $isElementNode(node) && !$holdsText(node);
    for (const k in desired) {
      if (
        !equalValue(current[k], desired[k]) &&
        !this.keepsStored(k, current[k], desired[k], storedText)
      ) {
        setAttrIn(this.view, y, k, desired[k], this.tr);
      }
    }
    for (const k in current) {
      if (
        !(k in desired) &&
        ownsNodeAttr(k, fields) &&
        !this.keepsStored(k, current[k], undefined, storedText)
      ) {
        deleteAttrIn(this.view, y, k, this.tr);
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
   * Before the write runs, while a composition's hold holds a collaborator's
   * change: whether the update is refused, as one that would delete or
   * write anew a shared node around it and changes no text (see
   * $heldDecision). Such a write is refused before it changes anything (see
   * YBinding#$runWriter): the editor reads the document again, the local
   * change undone.
   */
  $endangersHeld(): boolean {
    const hidden = this.state.hidden;
    if (hidden === null) {
      return false;
    }
    const decision = $heldDecision(
      this.state,
      hidden,
      this.prevState,
      this.remoteUnread,
      this.heldLog,
    );
    this.heldDecided = decision;
    return decision.refuse;
  }

  /**
   * What the preflight decided for this write while a hold is on (see
   * $heldDecision): the shared nodes it may delete or write anew though
   * they hold what the hold keeps, and whether it inserts characters.
   */
  private heldDecided: HeldDecision | null = null;

  /** The decision this write was taken under, if a hold was on. */
  get heldDecision(): HeldDecision | null {
    return this.heldDecided;
  }

  /**
   * The line composed in, where the hold shows it as a block its shared
   * counterpart no longer is and the update only re-typed its text (see
   * $heldDecision): not written, so that what a transform made of the shown
   * line does not land on what is stored there. The binding reads it again,
   * ends the hold, and runs its transforms again on what is stored (see
   * heldResult).
   */
  skippedLine: NodeKey | null = null;

  /**
   * What the update would have written of each character of the skipped
   * line (see skippedLine), by the character's stored id (see Atoms.ids):
   * the attributes the update changes on it, as the editor shows it (what
   * main writes of it). Once the hold ends, the line is
   * read as stored and its transforms run again; of what they make, only
   * what agrees with this is written (see $writeAgreedLine).
   */
  readonly heldResult = new Map<string, Attrs>();

  /**
   * Decide as `decision` (the recovery of a write taken under it): an update
   * that inserts no character stays one, whatever the failed write left.
   */
  decideAs(decision: HeldDecision): void {
    this.heldDecided = decision;
  }

  /**
   * Whether a remote change is not read yet as this write runs (deferred,
   * or unread): what the editor showed before is then not what is stored
   * (see $heldDecision).
   */
  remoteUnread: boolean | ReadonlySet<YNode> = false;

  /**
   * The recovery of a write that failed part way: never stopped by the
   * hold's guard (see withProtected), which only reports, so that the
   * change is written whole and nothing it made is lost to a re-read of
   * what the failed write left.
   */
  neverStop = false;

  /**
   * The recovery of an update that inserts no character, after a write the
   * guard stopped part way: what the hold keeps is skipped, never deleted
   * (see withProtected), and the rest of the change written.
   */
  skipProtected = false;

  /** The update's text edits, evidence for the hold's decision. */
  heldLog: TextEditLog | null = null;

  /**
   * Write a new stored node: attributes, and its container. Where the node
   * had a shared node before (a node moved, or written again), the fields
   * that one stored that this editor does not own (see ownsNodeAttr) go
   * into the new one.
   */

  /**
   * After the write, while a composition's hold is on: no item the hold hides
   * was deleted by this write, but where it deleted the node composed in
   * with its text (I4, see $endangersHeld). Where one
   * was, the hold ends (the editor reads what is stored), and development
   * builds warn: a collaborator's text was lost without the composer seeing
   * it.
   */
  private checkHeldKept(): void {
    const hidden = this.state.hidden;
    if (hidden === null) {
      return;
    }
    const doc = this.tr.doc;
    let lost = false;
    hidden.forEachRange((client, start, end) => {
      const structs = doc.store.clients.get(client);
      if (lost || structs === undefined) {
        return;
      }
      for (
        let i = findIndexSS(structs, start);
        i < structs.length && structs[i].id.clock < end;
        i++
      ) {
        const it = structs[i];
        if (
          it instanceof Item &&
          it.deleted &&
          this.tr.deleteSet.hasId(it.id)
        ) {
          lost = true;
          return;
        }
      }
    });
    if (!lost) {
      return;
    }
    // The node composed in deleted with its text: its held items go with it.
    const owner = $getNodeByKey(hidden.ownerKey);
    const textKept =
      (owner !== null && owner.isAttached()) ||
      ownerTextKeys(this.prevState, hidden.ownerKey).some(key => {
        const text = $getNodeByKey(key);
        return text !== null && text.isAttached();
      });
    hidden.missed = true;
    if (__DEV__ && textKept) {
      console.warn(
        '@lexical/y: a write deleted text a collaborator wrote while a composition held it back; the hold ends.',
      );
    }
  }

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
      setAttrIn(this.view, y, k, attrs[k], this.tr);
    }
    this.state.mapNode(key, y);
    if ($isElementNode(node)) {
      const kind = this.roles.$kind(node);
      setAttrIn(this.view, y, KIND_KEY, kind, this.tr);
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

/**
 * The attributes `want` changes of `shown` (a character's attributes as the
 * editor shows it, and as an update makes it), each with its new value (null
 * where the update takes it off), or null where it changes none: what the
 * update writes of that character.
 */
function changedAttrs(shown: Attrs, want: Attrs): Attrs | null {
  let out: Attrs | null = null;
  for (const k of new Set([...Object.keys(shown), ...Object.keys(want)])) {
    const value = want[k] ?? null;
    if (!equalValue(shown[k] ?? null, value)) {
      if (out === null) {
        out = {};
      }
      out[k] = value;
    }
  }
  return out;
}

/**
 * A character's attributes as written by Writer#$writeAgreedLine: what is
 * stored (`stored`), but for each attribute the update that ended the
 * composition changed (`held`, see Writer#heldResult) to the value the
 * transforms that ran on the stored line gave it too (`made`): that value.
 * An attribute that update did not change (one the hold kept from showing,
 * such as a collaborator's bold) is never written.
 * The segment key (see SEGMENT_KEY), which tells a node apart from its
 * neighbours, goes with the node's type. Returns `stored` itself where
 * nothing is written.
 */
function agreedAttrs(stored: Attrs, made: Attrs, held: Attrs): Attrs {
  const typed =
    TYPE_KEY in held &&
    !equalValue(stored[TYPE_KEY] ?? null, held[TYPE_KEY] ?? null) &&
    equalValue(made[TYPE_KEY] ?? null, held[TYPE_KEY] ?? null);
  let out: Attrs | null = null;
  for (const k in held) {
    const value = held[k] ?? null;
    if (
      (k === SEGMENT_KEY ? typed : equalValue(made[k] ?? null, value)) &&
      !equalValue(stored[k] ?? null, value)
    ) {
      if (out === null) {
        out = {...stored};
      }
      if (value === null) {
        delete out[k];
      } else {
        out[k] = value;
      }
    }
  }
  return out ?? stored;
}

/** The live end item before an old unit (after earlier deletions too). */
function unitLeft(
  view: View | null,
  units: Unit[],
  idx: number,
  hidden: Hidden | null,
): Item | null {
  const u = units[idx];
  if (u.end !== null) {
    return prevLiveEnd(view, u.end, hidden);
  }
  let e = idx > 0 ? units[idx - 1].end : null;
  while (e !== null && isGoneIn(view, e)) {
    e = prevLiveEnd(view, e, hidden);
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
  view: View | null,
  frontier: Item | null,
  start: Item | null,
  formats: Formats,
  limit: number,
  out: Atoms,
  hidden: Hidden | null,
  leftOut: LeftOut = null,
): PassFold {
  let stop: Item | null = start;
  let n = 0;
  while (stop !== null && n < limit) {
    if (isShownContent(view, stop, leftOut)) {
      n += unheldLength(stop, hidden);
    }
    stop = stop.right;
  }
  const end = {folded: frontier};
  const after = readAtoms(
    view,
    start,
    stop,
    formats,
    out,
    hidden,
    frontier,
    end,
    formats,
    leftOut,
  );
  return {
    after,
    folded: end.folded,
    frontier,
    start,
    startFormats: formats,
    stop,
  };
}

/**
 * Whether `end` is `from` or lies after it, walking right. Walks right from
 * both items in step: where `from` lies after `end`, the walk from `end`
 * meets it, so the answer costs about twice the distance between them, not
 * a walk to the end of the container (a document's root holds every deleted
 * item a long history left between its lines). Never more than twice the
 * items the walk from `from` alone reads. Exported for its tests.
 */
export function reaches(from: Item, end: Item): boolean {
  let a: Item | null = from;
  let b: Item | null = end;
  while (a !== null) {
    if (a === end) {
      return true;
    }
    if (b !== null) {
      // `from` lies after `end`: the walk from `from` never meets it.
      if (b === from) {
        return false;
      }
      b = b.right;
    }
    a = a.right;
  }
  return false;
}

/** What a format pass folded (see Writer#$fixStartsAfter). */
type PassFold = {
  start: Item | null;
  startFormats: Formats;
  frontier: Item | null;
  stop: Item | null;
  after: Formats;
  folded: Item | null;
};

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
 * attrsBeforeIn), or null where `tr` made it.
 */
function nodeBeforeTransaction(
  view: View | null,
  y: YNode,
  tr: Transaction,
): [string, Attrs] | null {
  if (y._item !== null && tr.insertSet.hasId(y._item.id)) {
    return null;
  }
  const attrs = attrsBeforeIn(view, y, tr);
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
 * The shared nodes kept between `prefix` and the `suffix` by their key (see
 * Writer#$writeSeq): pairs of an old atom whose shared node's key
 * (`oldKey`) a desired inline atom has, as the same node (`matchSpecial`),
 * in order; of those, the longest run in order in both (a node moved past
 * another is not kept).
 */
function keyedIslands(
  old: Atoms,
  atoms: Atoms,
  prefix: number,
  suffix: number,
  oldKey: (i: number) => NodeKey | undefined,
  matchSpecial: (i: number, j: number) => boolean,
): [number, number][] {
  const oldAt = new Map<NodeKey, number>();
  old.specials.forEach((_sp, i) => {
    if (i >= prefix && i < old.length - suffix) {
      const key = oldKey(i);
      if (key !== undefined) {
        oldAt.set(key, i);
      }
    }
  });
  if (oldAt.size === 0) {
    return [];
  }
  const pairs: [number, number][] = [];
  atoms.specials.forEach((sp, j) => {
    if (j < prefix || j >= atoms.length - suffix || sp.kind !== 'inline') {
      return;
    }
    const i = oldAt.get(sp.key);
    if (i !== undefined && matchSpecial(i, j)) {
      pairs.push([i, j]);
    }
  });
  pairs.sort((x, y) => x[1] - y[1]);
  return longestInOrder(pairs);
}

/** Of `pairs` (in order of their second), the longest run in order of both. */
function longestInOrder(pairs: [number, number][]): [number, number][] {
  const tails: number[] = [];
  const back: number[] = [];
  for (let k = 0; k < pairs.length; k++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][0] < pairs[k][0]) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    back[k] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = k;
  }
  const out: [number, number][] = [];
  for (
    let k = tails.length > 0 ? tails[tails.length - 1] : -1;
    k !== -1;
    k = back[k]
  ) {
    out.push(pairs[k]);
  }
  return out.reverse();
}

/**
 * The shared nodes kept by key (`keyed`), with the `anchors` the record
 * keeps that fit between them in order of both. A shared node kept by key
 * wins over an anchor of the record that does not fit: text that moved
 * around a shared node (two text nodes beside it swapped) is written anew,
 * never the shared node.
 */
function withKeyed(
  anchors: [number, number][],
  keyed: [number, number][],
): [number, number][] {
  if (keyed.length === 0) {
    return anchors;
  }
  const out = [...keyed];
  for (const [i, j] of anchors) {
    let at = 0;
    while (at < out.length && out[at][1] < j) {
      at++;
    }
    const before = at > 0 ? out[at - 1] : null;
    const after = at < out.length ? out[at] : null;
    if (
      (after === null || (after[1] > j && after[0] > i)) &&
      (before === null || (before[0] < i && before[1] < j))
    ) {
      out.splice(at, 0, [i, j]);
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

/**
 * The index of the first of the text nodes of desired atoms (in order and
 * apart, see Atoms#textNodes) that ends after atom `i`: the node `i` is in,
 * or else the first node after it.
 */
function textNodeAfter(
  nodes: readonly (readonly [number, number, NodeKey])[],
  i: number,
): number {
  let lo = 0;
  let hi = nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (nodes[mid][1] <= i) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** Whether `a`'s characters are in `b`, in order (not necessarily together). */
function isSubsequence(a: string, b: string): boolean {
  let j = 0;
  for (let i = 0; i < b.length && j < a.length; i++) {
    if (b[i] === a[j]) {
      j++;
    }
  }
  return j === a.length;
}

/**
 * Whether a character in `[from, to)` had value `value` for key `key` before
 * the update (`before`: the runs of the characters' NodeState entries).
 */
function hadValue(
  before: readonly Run[],
  from: number,
  to: number,
  key: string,
  value: unknown,
): boolean {
  // The first run that ends after `from` (the runs are in order).
  let lo = 0;
  let hi = before.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (before[mid].end <= from) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  let covered = from;
  for (let i = lo; i < before.length && before[i].start < to; i++) {
    const run = before[i];
    if (run.start > covered) {
      // Characters no run holds (none here before): no value.
      if (value === null || value === undefined) {
        return true;
      }
    }
    covered = Math.max(covered, run.end);
    if (equalFormatValue(run.attrs[key] ?? null, value)) {
      return true;
    }
  }
  return false;
}

/** How text classes store NodeState keys (see scalarState). */
interface StateLayout {
  /** The StateConfig the class of the type of `attrs` has for `key`. */
  config(attrs: Attrs, key: string): AnyStateConfig | undefined;
  /** Whether the class of the type of `attrs` reads `key` flat (a field). */
  flat(attrs: Attrs, key: string): boolean;
}

/**
 * The scalar NodeState values of a text node's attributes (see $textAttrs),
 * whatever the layout its class stores them in, as `s:<key>` = value: a key
 * its class reads flat (`p:<key>`, see StateLayout) included, and a key
 * whose name holds U+001F that is registered whole. A set-valued state (one
 * entry per member, `s:<key>\u001f<member>`, see setMemberEntry, or an
 * array) and an object are left out: they are not written onto a node the
 * update made (see keepMadeAsStored). Its ordinary fields are not NodeState.
 */
function scalarState(attrs: Attrs, layout: StateLayout): Attrs {
  const state: Attrs = {};
  for (const k in attrs) {
    let key: string;
    if (k.startsWith(STATE_PREFIX)) {
      key = k.slice(STATE_PREFIX.length);
    } else if (
      k.startsWith(FIELD_PREFIX) &&
      layout.flat(attrs, k.slice(FIELD_PREFIX.length))
    ) {
      key = k.slice(FIELD_PREFIX.length);
    } else {
      continue;
    }
    const value = attrs[k];
    if (k.startsWith(STATE_PREFIX) && isSetMember(attrs, key, layout)) {
      continue;
    }
    const plain = decodeFormatValue(value);
    if (typeof plain === 'object' && plain !== null) {
      continue;
    }
    state[STATE_PREFIX + key] = value;
  }
  return state;
}

/**
 * What of a text node's attributes (see $textAttrs) a node a transform made
 * can carry onto what is stored (see keepMadeAsStored): its scalar NodeState
 * values (see scalarState) and its format bits (`f:<name>` = true).
 */
function carriedState(attrs: Attrs, layout: StateLayout): Attrs {
  const state = scalarState(attrs, layout);
  for (const k in attrs) {
    if (k.startsWith(TEXT_FORMAT_PREFIX) && attrs[k] === true) {
      state[k] = true;
    }
  }
  return state;
}

/**
 * Whether nested entry `key` of `attrs` is a member of a set-valued state,
 * read as joinSetMembers reads it (see namesSetMember).
 */
function isSetMember(attrs: Attrs, key: string, layout: StateLayout): boolean {
  return (
    attrs[STATE_PREFIX + key] === true && namesSetMember(attrs, key, layout)
  );
}

/**
 * Whether the class of the type of `attrs` reads `true` under nested name
 * `key` as a member of a set-valued state, as joinSetMembers does: a name
 * holding U+001F that no StateConfig of the class has whole, after the key of
 * a set its class has (or, with no StateConfig for that key, one that is no
 * other value).
 */
function namesSetMember(
  attrs: Attrs,
  key: string,
  layout: StateLayout,
): boolean {
  const i = key.indexOf(SET_MEMBER_SEPARATOR);
  if (i < 0 || layout.config(attrs, key) !== undefined) {
    return false;
  }
  const base = key.slice(0, i);
  const config = layout.config(attrs, base);
  if (config !== undefined) {
    return isSetStateConfig(config);
  }
  const whole = attrs[STATE_PREFIX + base];
  return whole === undefined || isStringArray(decodeFormatValue(whole));
}

/**
 * Whether the class of the stored type of `attrs` would read scalar `value`
 * under NodeState `key` as part of a set-valued state instead: `key` is a set
 * there, the entries stored under it include members it reads of a set no
 * StateConfig of the class knows (see isSetMember: which a value of another
 * kind would end), or `value` is `true` under a name it reads as a set's
 * member (see namesSetMember). Such a value cannot be written there without
 * changing the set, and stays as stored.
 */
function readsAsSet(
  attrs: Attrs,
  key: string,
  value: unknown,
  layout: StateLayout,
): boolean {
  const config = layout.config(attrs, key);
  if (config !== undefined) {
    return isSetStateConfig(config);
  }
  if (key.indexOf(SET_MEMBER_SEPARATOR) < 0) {
    // A member's set is its name up to the first U+001F, so only a key
    // without one holds members.
    const prefix = STATE_PREFIX + key + SET_MEMBER_SEPARATOR;
    for (const n in attrs) {
      if (
        n.startsWith(prefix) &&
        isSetMember(attrs, n.slice(STATE_PREFIX.length), layout)
      ) {
        return true;
      }
    }
  }
  return value === true && namesSetMember(attrs, key, layout);
}

/**
 * Write in `attrs` (a stored run's attributes, of its type's class) the
 * scalar value `value` of NodeState `key`, which an update set on a node it
 * made, as the stored type's class reads the key: a field where it reads
 * the key flat, its nested entry removed; else the nested entry. A field of
 * the same name the class does not read flat is an ordinary one, and stays.
 */
function putScalarAsStored(
  attrs: Attrs,
  key: string,
  value: unknown,
  layout: StateLayout,
): void {
  if (layout.flat(attrs, key)) {
    attrs[FIELD_PREFIX + key] = value;
    delete attrs[STATE_PREFIX + key];
  } else {
    attrs[STATE_PREFIX + key] = value;
  }
}

/**
 * Runs of desired atoms (`runs`) where the atoms of each node the update made
 * (`ranges`: the atom range of each node holding the line's atoms, and
 * whether the update kept it, see Writer#$writeSkippedLine) take the stored
 * attributes instead (`stored`, the same atoms as stored): what a transform
 * made of the line is left as stored, and what changed on the nodes the
 * update kept is written. On a node the update made, a scalar NodeState
 * value that is not a default and that none of its characters had before
 * the update, and a format bit its characters did not have before it
 * (`before`, their NodeState entries and format bits, or null where not
 * known), are written too: what the user or the app set in this update,
 * which the tokenizer carried onto its tokens; a format bit the node no
 * longer has stays as stored. A value is compared
 * whatever layout each class stores it in (see scalarState: flat or nested),
 * and written as the stored type's class reads it (see putScalarAsStored). A
 * set-valued or object value stays as stored there, as does a value the
 * stored type's class would read as part of a set (see readsAsSet) and an
 * ordinary field (a node's style, a property of its JSON), which is never
 * taken for NodeState.
 */
function keepMadeAsStored(
  runs: readonly Run[],
  stored: readonly Run[],
  ranges: readonly [number, number, boolean][],
  length: number,
  before: readonly Run[] | null,
  layout: StateLayout,
): Run[] {
  const cuts = new Set<number>([0, length]);
  for (const list of before === null
    ? [runs, stored]
    : [runs, stored, before]) {
    for (const r of list) {
      cuts.add(r.start);
      cuts.add(r.end);
    }
  }
  for (const [a, b] of ranges) {
    cuts.add(a);
    cuts.add(b);
  }
  const sorted = [...cuts].filter(c => c <= length).sort((x, y) => x - y);
  const out: Run[] = [];
  let a = 0;
  let b = 0;
  let r = 0;
  let hadRange = -1;
  const had = new Map<string, boolean>();
  // What each run's attributes can carry, once (see carriedState).
  const scalars = new Map<Attrs, Attrs>();
  const scalarsOf = (of: Attrs): Attrs => {
    let found = scalars.get(of);
    if (found === undefined) {
      found = carriedState(of, layout);
      scalars.set(of, found);
    }
    return found;
  };
  for (let c = 0; c < sorted.length - 1; c++) {
    const start = sorted[c];
    const end = sorted[c + 1];
    while (a < runs.length && runs[a].end <= start) {
      a++;
    }
    while (b < stored.length && stored[b].end <= start) {
      b++;
    }
    while (r < ranges.length && ranges[r][1] <= start) {
      r++;
    }
    const run = a < runs.length && runs[a].start <= start ? runs[a] : null;
    if (run === null) {
      // No desired run (a special atom without attributes): none written.
      continue;
    }
    const was =
      b < stored.length && stored[b].start <= start ? stored[b] : null;
    const made = r < ranges.length && ranges[r][0] <= start && !ranges[r][2];
    let attrs = made && was !== null ? was.attrs : run.attrs;
    if (made && was !== null && before !== null) {
      // On a node the transform made: what is stored, but for each scalar
      // NodeState value (not a default, which JSON leaves out) that no
      // character of that node had before this update, and each format bit
      // these characters did not have before it: set in this update, by the
      // user or the app, and carried by the tokenizer. A value some of its
      // characters had before may have been spread over the others by the
      // transform (a token made of several nodes), and is left as stored, as
      // is a set-valued or object value, and a format bit the node no longer
      // has. The node's type and style stay as stored (the highlighter's).
      const [ra, rb] = ranges[r];
      // Once per node, entry and value: a node the transform made of many
      // nodes is cut at each of their ends.
      if (r !== hadRange) {
        hadRange = r;
        had.clear();
      }
      const desired = scalarsOf(run.attrs);
      const kept = scalarsOf(was.attrs);
      for (const name in desired) {
        const value = desired[name];
        if (name in kept && equalFormatValue(kept[name], value)) {
          continue;
        }
        if (name.startsWith(TEXT_FORMAT_PREFIX)) {
          // A format bit these characters did not have before this update:
          // set in it, by the user or the app (a transform's token keeps the
          // format of the text it replaces, or has none, as a code
          // highlighter's does). Judged per character, as main writes it.
          if (!hadValue(before, start, end, name, value)) {
            if (attrs === was.attrs) {
              attrs = {...was.attrs};
            }
            attrs[name] = true;
          }
          continue;
        }
        const id = name + '\u0000' + JSON.stringify(value);
        let wasThere = had.get(id);
        if (wasThere === undefined) {
          wasThere = hadValue(before, ra, rb, name, value);
          had.set(id, wasThere);
        }
        if (wasThere) {
          continue;
        }
        const key = name.slice(STATE_PREFIX.length);
        if (!readsAsSet(was.attrs, key, value, layout)) {
          if (attrs === was.attrs) {
            attrs = {...was.attrs};
          }
          putScalarAsStored(attrs, key, value, layout);
        }
      }
    }
    const last = out[out.length - 1];
    if (last !== undefined && last.end === start && last.attrs === attrs) {
      last.end = end;
    } else {
      out.push({attrs, end, start});
    }
  }
  return out;
}
