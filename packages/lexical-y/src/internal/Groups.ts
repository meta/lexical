/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $isElementNode,
  type ElementNode,
  type LexicalNode,
  type NodeKey,
} from 'lexical';

import {$appendAll} from './Arrays';
import {$dropLevelId} from './BlockIds';
import {
  $groupFields,
  $isGroupNode,
  type Attrs,
  getGroupSpec,
  klassOf,
  stableStringify,
} from './Schema';

// Groups (lists) in the editor: the canonical shape the binding keeps them
// in (see $canonicalizeGroup), the item change that renumbers a group (see
// $switchesWrapper), and the signatures that place a group item in its
// groups, shared by the reader and the writer (see groupSig).
//
// Invariant: the editor holds groups in the shape a reader builds from what
// they store: no group without items, adjacent groups with equal key fields
// as one group, adjacent wrapper items holding equal groups as one wrapper,
// and each level's own block id only (see BlockIds' $dropLevelId). Why: the
// author's editor shows what every reader shows, and its next write stores
// that shape.

/**
 * Keep local groups in the shape readers rebuild: adjacent top-level groups
 * with equal key fields are one group.
 */
export function $canonicalizeGroup(
  node: ElementNode,
  isIdentified: ((block: LexicalNode) => boolean) | null,
): void {
  const spec = getGroupSpec(klassOf(node));
  if (spec === null || !node.isAttached()) {
    return;
  }
  // A group without items has no shared representation (its items carry
  // it): remove it, with a nested-level wrapper it leaves empty.
  if (node.getChildrenSize() === 0) {
    const parent = node.getParent();
    node.remove();
    if (
      parent !== null &&
      parent.getChildrenSize() === 0 &&
      spec.items.includes(klassOf(parent)) &&
      parent.getParent() !== null &&
      getGroupSpec(klassOf(parent.getParent()!)) === spec
    ) {
      parent.remove();
    }
    return;
  }
  // Each group level owns its state (see $dropLevelId).
  $dropLevelId(node, spec, isIdentified);
  // Equal when every declared key field is (see Reader#$buildGroups).
  const sameKey = (a: ElementNode, b: ElementNode) => {
    if (klassOf(a) !== klassOf(b)) {
      return false;
    }
    const fa = $groupFields(a, spec);
    const fb = $groupFields(b, spec);
    return spec.key.every(
      f => stableStringify(fa[f] ?? null) === stableStringify(fb[f] ?? null),
    );
  };
  // Its own items: two adjacent wrapper items each holding an equal group
  // read back as one wrapper (an item between them was moved away).
  const nestedIn = (w: LexicalNode | null): ElementNode | null => {
    if (
      !$isElementNode(w) ||
      w.getChildrenSize() !== 1 ||
      !spec.items.includes(klassOf(w))
    ) {
      return null;
    }
    const g = w.getFirstChild();
    return $isElementNode(g) && getGroupSpec(klassOf(g)) === spec ? g : null;
  };
  for (let child = node.getFirstChild(); child !== null; ) {
    const next = child.getNextSibling();
    const a = nestedIn(child);
    const b = nestedIn(next);
    if (a !== null && b !== null && sameKey(a, b)) {
      $appendMerging(a, b, sameKey);
      next!.remove();
      continue;
    }
    child = next;
  }
  // Nested levels: two adjacent wrapper items each holding an equal group
  // read back as one wrapper.
  const wrapper = node.getParent();
  if (
    wrapper !== null &&
    wrapper.getChildrenSize() === 1 &&
    spec.items.includes(klassOf(wrapper))
  ) {
    const nestedOf = (w: LexicalNode | null): ElementNode | null => {
      if (!$isElementNode(w) || w.getChildrenSize() !== 1) {
        return null;
      }
      const g = w.getFirstChild();
      return $isElementNode(g) && klassOf(g) === klassOf(node) ? g : null;
    };
    const before = nestedOf(wrapper.getPreviousSibling());
    if (before !== null && sameKey(before, node)) {
      $appendMerging(before, node, sameKey);
      wrapper.remove();
      return;
    }
    const after = nestedOf(wrapper.getNextSibling());
    if (after !== null && sameKey(node, after)) {
      const afterWrapper = after.getParent()!;
      $appendMerging(node, after, sameKey);
      afterWrapper.remove();
    }
  }
  const prev = node.getPreviousSibling();
  if (
    $isElementNode(prev) &&
    getGroupSpec(klassOf(prev)) !== null &&
    sameKey(prev, node)
  ) {
    $appendMerging(prev, node, sameKey);
    node.remove();
    return;
  }
  const next = node.getNextSibling();
  if (
    $isElementNode(next) &&
    getGroupSpec(klassOf(next)) !== null &&
    sameKey(node, next)
  ) {
    $appendMerging(node, next, sameKey);
    next.remove();
  }
}

/**
 * Move the children of `source` to the end of `target`. Where the two
 * meet, two wrapper items each holding an equal nested group are merged
 * too (recursively), as a reader builds them: consecutive deeper items share
 * one wrapper.
 */
function $appendMerging(
  target: ElementNode,
  source: ElementNode,
  sameKey: (a: ElementNode, b: ElementNode) => boolean,
): void {
  const last = target.getLastChild();
  const children = source.getChildren();
  $appendAll(target, children);
  const first = children[0];
  const nestedOf = (w: LexicalNode | null | undefined): ElementNode | null => {
    if (!$isElementNode(w) || w.getChildrenSize() !== 1) {
      return null;
    }
    const g = w.getFirstChild();
    return $isElementNode(g) && getGroupSpec(klassOf(g)) !== null ? g : null;
  };
  const a = nestedOf(last);
  const b = nestedOf(first);
  if (a !== null && b !== null && sameKey(a, b)) {
    $appendMerging(a, b, sameKey);
    first!.remove();
  }
}

/**
 * Whether an item starts or stops holding a nested group first in this
 * update (`prevMap`: the state before it): its group numbers it differently,
 * and Lexical does not mark the group dirty for it.
 */
export function $switchesWrapper(
  node: ElementNode,
  prevMap: ReadonlyMap<NodeKey, LexicalNode>,
): boolean {
  const prev = prevMap.get(node.getKey());
  const wasWrapper =
    prev !== undefined &&
    $isElementNode(prev) &&
    prev.__first !== null &&
    $isGroupNode(prevMap.get(prev.__first));
  return wasWrapper !== $isGroupNode(node.getFirstChild());
}

/** The signature of a group item's group: its key and its outer keys. */
export function groupKeySig(gattrs: Attrs, outer: Attrs[]): string {
  const sig = stableStringify(gattrs);
  return outer.length === 0 ? sig : sig + '\u0000' + stableStringify(outer);
}

/** The signature of a group item: what decides its place in the groups. */
export function groupSig(type: string, gsig: string, level: number): string {
  return type + '\u0000' + gsig + '\u0000' + level;
}
