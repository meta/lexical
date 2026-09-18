/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Klass} from './LexicalEditor';
import type {
  GetStaticNodeOwnConfig,
  LexicalNode,
  NodeKey,
  SlotChildNode,
  SlotHostNode,
} from './LexicalNode';
import type {BaseSelection} from './LexicalSelection';
import type {DecoratorNode} from './nodes/LexicalDecoratorNode';
import type {ElementNode} from './nodes/LexicalElementNode';

import invariant from '@lexical/internal/invariant';

import {
  $getEditor,
  $getNodeByKey,
  $isDecoratorNode,
  $isElementNode,
  $isRangeSelection,
} from '.';
import {
  $markSlotsUsed,
  $removeFromParent,
  iterStaticNodeConfigChain,
} from './LexicalUtils';

const __DEV__ = process.env.NODE_ENV !== 'production';

/**
 * Shared empty slot map. Reads coalesce here when a host's `__slots` is null
 * (lazy allocation), so non-slot trees don't pay a per-node allocation cost.
 *
 * @internal
 */
export const EMPTY_SLOTS: ReadonlyMap<string, NodeKey> = new Map();

/**
 * Shape predicate: true when `node` carries the host's `__slots` field — i.e.
 * it is an {@link ElementNode} or a {@link DecoratorNode}. Narrows to
 * {@link SlotHostNode} so the mutation helpers' compile-time host requirement
 * is satisfied. This is a type guard only; the value-level invariant on what
 * may actually be slotted is enforced by {@link $setSlot} (shadow-root
 * ElementNode or non-inline DecoratorNode).
 *
 * @experimental
 */
export function $isSlotHost(
  node: LexicalNode,
): node is LexicalNode & SlotHostNode {
  return $isElementNode(node) || $isDecoratorNode(node);
}

/**
 * Shape predicate: true when `node` carries the child's `__slotHost` field —
 * i.e. it is an {@link ElementNode} or a {@link DecoratorNode}. Narrows to
 * {@link SlotChildNode}. This is a type guard only; {@link $setSlot} rejects
 * inline values at runtime. The slot link acts as a virtual shadow root, so
 * any non-inline block — shadow root or not — can occupy a slot.
 *
 * @experimental
 */
export function $isSlotChild(
  node: LexicalNode,
): node is LexicalNode & SlotChildNode {
  return $isElementNode(node) || $isDecoratorNode(node);
}

/**
 * Returns the key of the host this node is slotted into, or null when the node
 * is not slotted. Accepts any node and narrows internally so generic callers
 * (removal guard, up-walk, GC, caret) don't have to. Exposes a raw key, so it
 * stays internal to the package; public callers use {@link $getSlotHost}.
 *
 * @internal
 */
export function $getSlotHostKey(node: LexicalNode): null | NodeKey {
  const latest = node.getLatest();
  return $isSlotChild(latest) ? latest.__slotHost : null;
}

/**
 * Returns the host element when this node occupies one of its named slots,
 * or null if this node is not slotted. The up-link is kept separate from
 * {@link LexicalNode.getParent} so the slot boundary behaves like a shadow
 * root.
 *
 * @experimental
 */
export function $getSlotHost(
  node: LexicalNode,
): ElementNode | DecoratorNode<unknown> | null {
  const slotHostKey = $getSlotHostKey(node);
  if (slotHostKey === null) {
    return null;
  }
  const host = $getNodeByKey(slotHostKey);
  invariant(
    $isElementNode(host) || $isDecoratorNode(host),
    'slotHost must be an ElementNode or a DecoratorNode',
  );
  return host;
}

/**
 * Returns the slot name this node occupies on its host, or null when the node
 * is not a slot value. Mirrors {@link LexicalNode#getIndexWithinParent} for
 * slot children — answers "which named slot does this node sit in?".
 *
 * @experimental
 */
export function $getSlotNameWithinHost(slotChild: LexicalNode): string | null {
  const host = $getSlotHost(slotChild);
  if (host === null) {
    return null;
  }
  const childKey = slotChild.getLatest().__key;
  for (const [name, key] of $getSlotMap(host)) {
    if (key === childKey) {
      return name;
    }
  }
  return null;
}

/**
 * Returns the slot value (the "slot frame") whose isolated subtree contains
 * `node`, or `node` itself when it is a slot value, or null when the node is
 * not inside any slot. The walk follows `getParent()` and naturally stops at a
 * slot value because a slotted node's `__parent` is null. Non-slot trees have
 * `__slotHost === null` everywhere, so this always returns null there.
 *
 * Selection-driven exporters use this to find the isolated subtree a
 * RangeSelection lives in (a selection inside a slot never contains the host,
 * so a root-children walk alone would miss it).
 *
 * @experimental
 */
export function $getSlotFrame(node: LexicalNode): LexicalNode | null {
  let current: LexicalNode | null = node.getLatest();
  while (current !== null) {
    if ($getSlotHostKey(current) !== null) {
      return current;
    }
    current = current.getParent();
  }
  return null;
}

/**
 * Returns the slot frame that `selection` lives in, or null when it is outside
 * any slot (or there is no selection). Thin wrapper over {@link $getSlotFrame}
 * that picks the node to anchor the walk on.
 *
 * Selection-driven exporters walk this frame instead of the root's children: a
 * selection wholly inside a slot subtree never includes its host (slots are
 * shadow-root isolated), so a root-children walk would miss the selected nodes
 * entirely and produce an empty payload (cut = data loss).
 *
 * Every selection type participates. A RangeSelection anchors on its anchor
 * point; anything else (NodeSelection, TableSelection, or an app-defined
 * BaseSelection) anchors on the first node it reports, which is where a click
 * that selects a decorator or a table nested in a slot is handled.
 *
 * `NodeSelection.getNodes()[0]` is the first node by insertion order (the
 * internal `_nodes` Set's iteration order), not document order. For the common
 * single-node case this is the only node and the frame is unambiguous. A
 * multi-node selection that straddles a slot boundary is currently undefined —
 * slots are shadow-isolated, so straddling is already invalid construction, and
 * we pick the first node's frame rather than asserting.
 *
 * @experimental
 */
export function $getSelectionSlotFrame(
  selection: null | BaseSelection,
): LexicalNode | null {
  if (selection === null) {
    return null;
  }
  const anchorNode = $isRangeSelection(selection)
    ? selection.anchor.getNode()
    : (selection.getNodes()[0] ?? null);
  return anchorNode === null ? null : $getSlotFrame(anchorNode);
}

/**
 * Returns the latest slot map (name -> child key, insertion order). Exposes raw
 * keys, so it stays internal to the package; public callers use
 * {@link $getSlotNames} / {@link $getSlot}.
 *
 * @internal
 */
export function $getSlotMap(node: LexicalNode): ReadonlyMap<string, NodeKey> {
  const latest = node.getLatest();
  return $isSlotHost(latest) && latest.__slots !== null
    ? latest.__slots
    : EMPTY_SLOTS;
}

/**
 * Returns the names of this node's occupied slots, in insertion order. Empty
 * when the node hosts no slots.
 *
 * @experimental
 */
export function $getSlotNames(node: LexicalNode): string[] {
  return Array.from($getSlotMap(node).keys());
}

// The slot names a host's class declares in `$config().slots`, as a literal
// union (only the node's own declaration is read, so a subclass that inherits
// slots without redeclaring resolves to `never`). Relies on the `const` type
// parameter on `LexicalNode.config` to preserve the declared array as a tuple.
type DeclaredSlotNames<T extends LexicalNode> =
  GetStaticNodeOwnConfig<T> extends {slots: infer S extends readonly string[]}
    ? S[number]
    : never;

/**
 * Slot-name hint for a host node's slot accessors: the names declared in the
 * host class's `$config().slots` (for editor autocomplete) unioned with `string`
 * — every string is still accepted (slots take undeclared names at runtime), the
 * declared names just surface as suggestions. A class declaring no slots, or a
 * subclass that inherits them without redeclaring, resolves to plain `string`.
 *
 * @experimental
 */
export type SlotName<T extends LexicalNode> =
  | DeclaredSlotNames<T>
  // `string & {}` keeps any string assignable without TS collapsing the union
  // (and erasing the literal suggestions) back into a bare `string`.
  | (string & {});

/**
 * Returns the node occupying the named slot, or null if the slot is empty.
 * Slots are a shadow-root-isolated channel kept separate from children; see
 * {@link $getSlotHost} for the reverse up-link.
 *
 * @experimental
 */
export function $getSlot<T extends LexicalNode>(
  node: T,
  name: SlotName<T>,
): LexicalNode | null {
  const key = $getSlotMap(node).get(name);
  return key === undefined ? null : $getNodeByKey(key);
}

const RESERVED_SLOT_NAMES = ['__proto__', 'constructor', 'prototype'];

// Copy-on-write owner mark for slot maps, mirroring NodeState's scheme (its
// state object carries a backpointer to the owning node version; getWritable
// returns itself only for that version). afterCloneFrom shares the map
// reference across versions, so a host that is cloned without a slot change
// pays no per-version Map copy; the mutators below clone exactly once per
// writable version, the first time that version writes. The owner rides on a
// symbol property rather than a side table: it is stamped exactly once, on a
// freshly constructed map (copy-on-write means a shared or committed map is
// never written to, only replaced), and a plain `new Map(slots)` clone is
// born unowned because expandos don't copy.
const SLOT_MAP_OWNER = Symbol('slotMapOwner');

interface OwnedSlotMap extends Map<string, NodeKey> {
  [SLOT_MAP_OWNER]?: LexicalNode;
}

// @experimental named-slots. Returns a slot map that `writableHost` (the
// current writable version, from getWritable()) is allowed to mutate,
// cloning the shared map on the version's first write.
function $getWritableSlots(
  writableHost: LexicalNode & SlotHostNode,
): Map<string, NodeKey> {
  let slots: OwnedSlotMap | null = writableHost.__slots;
  if (slots === null || slots[SLOT_MAP_OWNER] !== writableHost) {
    // new Map(null) is the empty map, so first allocation and clone share it
    slots = new Map(slots);
    slots[SLOT_MAP_OWNER] = writableHost;
    writableHost.__slots = slots;
  }
  return slots;
}

const slotRankCache = new WeakMap<
  Klass<LexicalNode>,
  ReadonlyMap<string, number>
>();
const EMPTY_DECLARED_SLOTS: readonly string[] = [];

/**
 * Returns the canonical slot declaration for a node class: the `slots` array
 * from the nearest {@link StaticNodeConfigValue} in its prototype chain (a
 * subclass redeclaration overrides its ancestors'), or an empty array when
 * nothing is declared. The declaration is an ordering vocabulary, not a
 * schema — occupied names outside it are still valid and sort after the
 * declared names in code-unit order.
 *
 * @experimental named-slots
 */
export function getDeclaredSlots(klass: Klass<LexicalNode>): readonly string[] {
  // Walk the class hierarchy without a runtime LexicalNode import (a
  // module-initialization cycle): past the base class the chain reaches
  // Function.prototype, whose own `prototype` is undefined, ending the loop.
  for (const {ownNodeConfig} of iterStaticNodeConfigChain(klass)) {
    const declared = ownNodeConfig && ownNodeConfig.slots;
    if (declared) {
      return declared;
    }
  }
  return EMPTY_DECLARED_SLOTS;
}

/**
 * @internal
 *
 * Concatenated text of a node's named slots, read slots-first (in slot Map
 * order). Shared by the getTextContent implementations so ElementNode and
 * DecoratorNode hosts fold their slot text the same way; a node with no
 * slots returns the empty string. A free function (not a LexicalNode method)
 * so the framework-owned name cannot collide with a subclass's own members.
 */
export function $getSlotsTextContent(node: LexicalNode): string {
  let textContent = '';
  for (const name of $getSlotNames(node)) {
    const slot = $getSlot(node, name);
    if (slot !== null) {
      textContent += slot.getTextContent();
    }
  }
  return textContent;
}

/**
 * @internal
 *
 * Size counterpart to {@link $getSlotsTextContent}, summing each slot's
 * getTextContentSize (which a slot subtree may override independently of its
 * text length) slots-first.
 */
export function $getSlotsTextContentSize(node: LexicalNode): number {
  let textContentSize = 0;
  for (const name of $getSlotNames(node)) {
    const slot = $getSlot(node, name);
    if (slot !== null) {
      textContentSize += slot.getTextContentSize();
    }
  }
  return textContentSize;
}

// @experimental named-slots. Declared name -> declaration index, cached per
// class. Validates the declaration once: duplicates would make the order
// ambiguous and reserved names can never be set.
function getDeclaredSlotRank(
  klass: Klass<LexicalNode>,
): ReadonlyMap<string, number> {
  let rank = slotRankCache.get(klass);
  if (rank === undefined) {
    const declared = getDeclaredSlots(klass);
    const built = new Map<string, number>();
    for (const name of declared) {
      invariant(
        !RESERVED_SLOT_NAMES.includes(name),
        'getDeclaredSlotRank: %s declares reserved slot name "%s"; __proto__, constructor, and prototype break the plain-object serialization of slots',
        klass.name,
        name,
      );
      invariant(
        !built.has(name),
        'getDeclaredSlotRank: %s declares slot name "%s" more than once; the canonical order would be ambiguous',
        klass.name,
        name,
      );
      built.set(name, built.size);
    }
    rank = built;
    slotRankCache.set(klass, rank);
  }
  return rank;
}

// @experimental named-slots. Canonical comparison: declared names first (in
// declaration order), then undeclared names in code-unit order — a pure
// function of (class, name) so every client orders identically.
function compareSlotNames(
  a: string,
  b: string,
  rank: ReadonlyMap<string, number>,
): number {
  const rankA = rank.get(a);
  const rankB = rank.get(b);
  if (rankA !== undefined) {
    return rankB !== undefined ? rankA - rankB : -1;
  }
  if (rankB !== undefined) {
    return 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

// @experimental named-slots. Restores canonical order on a writable host's
// slot map after an insertion. Order is derived, never stored: every
// ingestion path (local $setSlot, JSON import, clipboard, collab sync)
// funnels through $setSlot, so documents re-canonicalize on load and
// concurrent collaborative additions converge without any order metadata in
// the document. The already-sorted check keeps the common case allocation
// free; slot maps are tiny, so the rebuild is O(n log n) over a handful of
// names.
function $canonicalizeSlotOrder(host: LexicalNode & SlotHostNode): void {
  const slots = host.__slots;
  if (slots === null || slots.size < 2) {
    return;
  }
  const rank = getDeclaredSlotRank(host.constructor as Klass<LexicalNode>);
  let previous: string | null = null;
  let sorted = true;
  for (const name of slots.keys()) {
    if (previous !== null && compareSlotNames(previous, name, rank) > 0) {
      sorted = false;
      break;
    }
    previous = name;
  }
  if (sorted) {
    return;
  }
  const entries = Array.from(slots).sort(([a], [b]) =>
    compareSlotNames(a, b, rank),
  );
  slots.clear();
  for (const [name, key] of entries) {
    slots.set(name, key);
  }
}

/**
 * Places `node` into the named slot of `host`, replacing any existing value
 * under that name. Move semantics, mirroring `ElementNode.append` /
 * `insertBefore`: the value is detached from wherever it currently lives —
 * a child of another element, or a slot on this or another host (a node's two
 * up-links, `__parent` and `__slotHost`, are mutually exclusive, so it holds
 * exactly one) — before linking, so re-slotting never requires an explicit
 * remove first. The replaced value, if any, is detached.
 *
 * A slot value must be a non-inline {@link ElementNode} or a non-inline
 * {@link DecoratorNode}: the slot link itself acts as a virtual shadow root
 * between the host and the value, so the value does not need to be a shadow
 * root — a plain block (e.g. a ParagraphNode subclass serving as a
 * single-line field) is a valid slot value, and selection, traversal, and
 * editing treat its slot boundary exactly like a shadow-root boundary.
 *
 * `host` is constrained to {@link SlotHostNode} so a non-host is rejected at
 * compile time.
 *
 * @experimental
 */
export function $setSlot<T extends LexicalNode & SlotHostNode>(
  host: T,
  name: SlotName<T>,
  node: LexicalNode,
): T {
  invariant(
    name !== '__proto__' && name !== 'constructor' && name !== 'prototype',
    '$setSlot: "%s" is a reserved slot name; __proto__, constructor, and prototype break the plain-object serialization of slots',
    name,
  );
  // Re-setting the value a name already holds is a no-op rather than a trip
  // over the "already slotted" invariant below, so idempotent callers (sync
  // layers, import rules) don't have to special-case it.
  const latestHost = host.getLatest();
  if (
    latestHost.__slots !== null &&
    latestHost.__slots.get(name) === node.getLatest().__key
  ) {
    return latestHost;
  }
  invariant(
    ($isElementNode(node) || $isDecoratorNode(node)) && !node.isInline(),
    '$setSlot: node %s is not a valid slot value; a slot value must be a non-inline ElementNode or DecoratorNode (the slot link itself is the shadow boundary).',
    node.__key,
  );
  // The ancestor/self check is the slot analog of appending a node into its
  // own descendant through the children channel: a programmer error that
  // forms an up-chain cycle and hangs isAttached/GC at commit. The children
  // channel has no production guard for its equivalent (collab/JSON can't
  // express the cycle — slot values are always freshly materialized, never
  // aliased to an existing ancestor — so only a direct local call can reach
  // it), so this guard matches: the O(depth) up-walk runs in __DEV__ only,
  // and production behaves like the unguarded children channel.
  if (__DEV__) {
    invariant(
      !$isSlotAncestorOrSelf(node, host),
      '$setSlot: node %s cannot be slotted into %s; a node may not host itself or an ancestor reached through children or slot up-links — the slot up-link would form a cycle that loops isAttached/GC.',
      node.__key,
      host.__key,
    );
  }
  const writableSelf = host.getWritable();
  const slots = $getWritableSlots(writableSelf);
  const previousKey = slots.get(name);
  if (previousKey !== undefined) {
    $detachSlottedNode(previousKey);
  }
  const writableNode = node.getWritable();
  // Move semantics: a value slotted elsewhere (or under another name on this
  // same host) is unlinked from its current host's map without destroying the
  // moving subtree — the up-link is rewritten below. The cycle guard above
  // already rejected any placement that would loop the up-chain.
  const previousHost = $getSlotHost(writableNode);
  if (previousHost !== null) {
    const previousName = $getSlotNameWithinHost(writableNode);
    if (previousName !== null) {
      $getWritableSlots(previousHost.getWritable()).delete(previousName);
    }
    writableNode.__slotHost = null;
  }
  // $removeFromParent (not node.remove()) so the host survives even when it
  // would otherwise cascade on becoming empty (e.g. a third-party host with
  // canBeEmpty()=false whose single shadow-root child is being slotted in).
  // Mirrors the patterns in ElementNode.append / replace / insertBefore.
  $removeFromParent(writableNode);
  writableNode.__slotHost = writableSelf.__key;
  slots.set(name, writableNode.__key);
  $canonicalizeSlotOrder(writableSelf);
  $markSlotsUsed();
  return writableSelf;
}

/**
 * Removes the named slot from `host`, detaching its value (its slot up-link is
 * cleared). No-op if the slot is empty. `host` is constrained to
 * {@link SlotHostNode} so a non-host is rejected at compile time.
 *
 * @experimental
 */
export function $removeSlot<T extends LexicalNode & SlotHostNode>(
  host: T,
  name: SlotName<T>,
): T {
  const writableSelf = host.getWritable();
  if (writableSelf.__slots === null) {
    return writableSelf;
  }
  const previousKey = writableSelf.__slots.get(name);
  if (previousKey !== undefined) {
    $detachSlottedNode(previousKey);
    $getWritableSlots(writableSelf).delete(name);
  }
  return writableSelf;
}

// @experimental named-slots. True when `node` is `host` itself or any ancestor
// of `host` reachable by walking up the combined parent/slot up-link chain (the
// same traversal isAttached uses). isParentOf only follows __parent, so it can't
// see a host that sits above `node` through slot up-links; slotting `node` there
// would close a cycle that loops isAttached/GC.
function $isSlotAncestorOrSelf(node: LexicalNode, host: LexicalNode): boolean {
  let key: NodeKey | null = host.__key;
  while (key !== null) {
    if (key === node.__key) {
      return true;
    }
    const current: LexicalNode | null = $getNodeByKey(key);
    if (current === null) {
      break;
    }
    key =
      current.__parent !== null ? current.__parent : $getSlotHostKey(current);
  }
  return false;
}

/**
 * @internal
 *
 * Reverse guard of {@link $setSlot}'s cycle invariant for the children
 * channel: inserting `child` under `parent` must not close a cycle through a
 * slot up-link (e.g. `slotValue.append(host)` would make `host.__parent`
 * reach `slotValue` while `slotValue.__slotHost` reaches `host`, looping
 * isAttached/GC — and hanging the commit itself). Called from the child
 * attachment points (ElementNode.splice, insertBefore/insertAfter/replace).
 * __DEV__-only and gated on the editor slot latch: the up-walk is an O(depth)
 * cost on the hot children path, and like {@link $setSlot}'s direct guard it
 * only catches direct local programmer error (collab/JSON can't alias a host
 * into its own slot value), so production matches the unguarded children
 * channel's own ancestor-append behavior.
 */
export function $errorOnSlotCycleChild(
  parent: LexicalNode,
  child: LexicalNode,
): void {
  if (!__DEV__ || !$getEditor()._slotsUsed) {
    return;
  }
  invariant(
    !$isSlotAncestorOrSelf(child, parent),
    'insert: node %s cannot become a child of %s; the parent is reachable from the node through slot up-links, so the insertion would form a cycle that loops isAttached/GC.',
    child.__key,
    parent.__key,
  );
}

// @experimental named-slots. Detaches the node currently slotted under a key,
// clearing its slot up-link before remove() so it isn't reprocessed as a
// still-slotted node. Shared by $setSlot (replacing an occupant) and
// $removeSlot.
function $detachSlottedNode(slotKey: NodeKey): void {
  const previous = $getNodeByKey(slotKey);
  if (previous === null) {
    return;
  }
  const writablePrevious = previous.getWritable();
  invariant(
    $isSlotChild(writablePrevious),
    'detach: slotted node %s must be an ElementNode or a DecoratorNode',
    slotKey,
  );
  writablePrevious.__slotHost = null;
  writablePrevious.remove();
}
