/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Reader} from './Read';
import type {Roles} from './State';
import type {Writer} from './Write';

import invariant from '@lexical/internal/invariant';
import {Node as YNode} from '@y/y';
import {
  $getNodeByKey,
  $getSlot,
  $getSlotHost,
  $getSlotNames,
  $getSlotNameWithinHost,
  $isDecoratorNode,
  $isElementNode,
  $isRootNode,
  $isSlotHost,
  $removeSlot,
  $setSlot,
  type ElementNode,
  type LexicalNode,
  type NodeKey,
} from 'lexical';

import {type Attrs, BLOCK_PREFIX, isUnsafeKey} from './Schema';
import {deleteAttr, setAttr} from './Seen';

/*
 * Named slots ($setSlot). A node stored as its own Y.Node (a `b:<type>` or
 * `i:<type>` node: a nested element or a decorator) stores each of its slots
 * as an attribute `slot:<name>`, whose value is the slot's node: a
 * `b:<type>` Y.Node stored like any block stored as a node (fields and
 * NodeState as attributes, its content as a sequence of its own, its own
 * slots). Yjs keeps one value per attribute, so a slot holds one node on
 * every client, and typing inside it merges per character, as in any
 * container. A node without a Y.Node of its own cannot hold slots (see
 * $unstorableSlotHosts).
 */

/** Attribute prefix of a named slot on a stored node. */
export const SLOT_PREFIX = 'slot:';

function hasSlotAttrs(attrs: Attrs): boolean {
  for (const k in attrs) {
    if (k.startsWith(SLOT_PREFIX)) {
      return true;
    }
  }
  return false;
}

/**
 * Write `node`'s named slots to its stored node `y`, whose attributes are
 * `current`: a slot whose value is not stored there yet gets a new
 * `b:<type>` node, written in full; a stored slot that `node` no longer has
 * is deleted, with its content. A slot value that stays has its content and
 * attributes written by their own plan entries, as any container. A
 * follow-up adds, replaces and removes no slot: it only sets attributes (see
 * Writer#followUp), and `warn` reports the change it does not write.
 */
export function $writeSlots(
  writer: Writer,
  y: YNode,
  node: LexicalNode,
  current: Attrs,
  warn: (what: string, target: LexicalNode) => void,
): void {
  const names = $getSlotNames(node);
  if (names.length === 0 && !hasSlotAttrs(current)) {
    return;
  }
  const state = writer.state;
  const keep = new Set<string>();
  for (const name of names) {
    const value = $getSlot(node, name);
    if (value === null) {
      continue;
    }
    const attr = SLOT_PREFIX + name;
    keep.add(attr);
    const stored = current[attr];
    const key = value.getKey();
    if (
      stored instanceof YNode &&
      state.yByKey.get(key) === stored &&
      state.keyByY.get(stored) === key
    ) {
      continue;
    }
    if (writer.followUp) {
      warn('the slots of', node);
      continue;
    }
    // Inserted before it is filled, as every stored node.
    const slotY = new YNode(BLOCK_PREFIX + value.getType());
    setAttr(y, attr, slotY, writer.tr);
    writer.$fillNode(slotY, value);
  }
  for (const attr in current) {
    if (attr.startsWith(SLOT_PREFIX) && !keep.has(attr)) {
      if (writer.followUp) {
        warn('the slots of', node);
        continue;
      }
      deleteAttr(y, attr, writer.tr);
    }
  }
}

/**
 * Make `host`'s named slots the ones its stored node `y` holds (`attrs`, its
 * attributes): a slot whose stored node this editor has not read gets a new
 * node, and one that is no longer stored is removed. A slot value that is not
 * a `b:<type>` node of a block this editor registers is not shown, and the
 * binding opens read only (see State#unknownTypes), so nothing deletes it.
 */
export function $readSlots(
  reader: Reader,
  host: LexicalNode,
  y: YNode,
  attrs: Attrs = y.getAttrs() as Attrs,
): void {
  if (
    !$isSlotHost(host) ||
    (!hasSlotAttrs(attrs) && $getSlotNames(host).length === 0)
  ) {
    return;
  }
  const state = reader.state;
  const stored = new Set<string>();
  for (const attr in attrs) {
    if (!attr.startsWith(SLOT_PREFIX)) {
      continue;
    }
    const name = attr.slice(SLOT_PREFIX.length);
    stored.add(name);
    const slotY = attrs[attr];
    if (
      isUnsafeKey(name) ||
      !(slotY instanceof YNode) ||
      typeof slotY.name !== 'string' ||
      !slotY.name.startsWith(BLOCK_PREFIX)
    ) {
      state.unknownTypes.add(attr);
      state.malformedSlots.add(attr);
      continue;
    }
    const key = state.keyByY.get(slotY);
    let value =
      key !== undefined && state.yByKey.get(key) === slotY
        ? $getNodeByKey(key)
        : null;
    if (value === null) {
      // Null for a type this editor does not register (read only).
      value = reader.$createStored(slotY);
    }
    if (value === null) {
      continue;
    }
    if (
      !($isElementNode(value) || $isDecoratorNode(value)) ||
      value.isInline()
    ) {
      state.unknownTypes.add(value.getType());
      state.malformedSlots.add(value.getType());
      continue;
    }
    const current = $getSlot(host, name);
    if (current === null || !current.is(value)) {
      // A node an unwritten update moved can hold its host by now.
      invariant(
        !$holds(value, host),
        '@lexical/y: a read would place a node inside itself',
      );
      $setSlot(host, name, value);
    }
  }
  for (const name of $getSlotNames(host)) {
    if (!stored.has(name)) {
      $removeSlot(host, name);
    }
  }
}

/**
 * Whether `node` is `target` or holds it, through children or named slots
 * (the way Lexical walks up the tree): placed in `target`, it would end up
 * inside itself, and that walk would never end.
 */
export function $holds(node: LexicalNode, target: LexicalNode): boolean {
  for (
    let n: LexicalNode | null = target;
    n !== null;
    n = n.getParent() ?? $getSlotHost(n)
  ) {
    if (n.is(node)) {
      return true;
    }
  }
  return false;
}

/**
 * Put `next` where `node` is: in its parent, or in the slot it fills (a slot
 * value cannot be replaced through the tree API).
 */
export function $replaceStored(node: LexicalNode, next: LexicalNode): void {
  const host = $getSlotHost(node);
  const name = host === null ? null : $getSlotNameWithinHost(node);
  if (host !== null && name !== null) {
    $setSlot(host, name, next);
  } else {
    node.replace(next);
  }
}

/**
 * The types of the nodes among `keys` (every node of `nodeMap` when null)
 * that hold named slots where the document cannot store them: on a node
 * without a Y.Node of its own (a line, a format, a group or one of its
 * levels, the root). The binding writes no such change and opens read only.
 */
export function $unstorableSlotHosts(
  roles: Roles,
  keys: Iterable<NodeKey> | null,
  nodeMap: ReadonlyMap<NodeKey, LexicalNode>,
): string[] {
  const types = new Set<string>();
  for (const key of keys === null ? nodeMap.keys() : keys) {
    const node = $getNodeByKey(key);
    if (
      node === null ||
      $getSlotNames(node).length === 0 ||
      !node.isAttached()
    ) {
      continue;
    }
    const role = roles.$role(node);
    if (role !== 'container' && role !== 'leaf') {
      types.add(node.getType());
    }
  }
  return [...types].sort();
}

/**
 * Whether a node is inside a named slot: its topmost ancestor is a slot's
 * value, not the root.
 */
export function $inNamedSlot(node: LexicalNode): boolean {
  let top: LexicalNode = node;
  for (let p = top.getParent(); p !== null; p = top.getParent()) {
    top = p;
  }
  return !$isRootNode(top);
}

/**
 * The binding's transform on every element class: a shadow root inside a
 * named slot holds its inline children (text, inline nodes) in the block
 * Lexical wraps them in, a paragraph, as core's shadow root transform does.
 *
 * Invariant: no shadow root in a named slot holds inline children once an
 * update's transforms ran. Why: the binding enforces node structure (see
 * YBinding#registerTransforms), which turns core's shadow root transform off
 * and normalizes from the root down, so it never reaches a named slot; such
 * children are stored as a line without a marker, which every reader shows
 * in a paragraph, and apps throw on a shadow root holding text.
 */
export function $wrapSlotShadowRootInline(node: LexicalNode): void {
  if (!$isElementNode(node) || !node.isShadowRoot() || !$inNamedSlot(node)) {
    return;
  }
  let block: ElementNode | null = null;
  for (const child of node.getChildren()) {
    block = child.isInline()
      ? (block || child.replace(child.createParentElementNode())).append(child)
      : null;
  }
}
