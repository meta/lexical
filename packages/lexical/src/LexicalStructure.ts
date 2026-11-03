/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Klass, LexicalEditor, Transform} from './LexicalEditor';
import type {EditorState} from './LexicalEditorState';
import type {
  LexicalNode,
  MergeAdjacentConfig,
  NodeChildrenConfig,
  NodeKey,
} from './LexicalNode';
import type {PointType} from './LexicalSelection';

import invariant from '@lexical/internal/invariant';

import {
  $create,
  $createLineBreakNode,
  $getEditor,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getState,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  $isRootNode,
  $isRootOrShadowRoot,
  $isTextNode,
  DecoratorNode,
  ElementNode,
  getComposedSchemaFields,
  iterStaticNodeConfigChain,
} from '.';
import {$insertSibling} from './caret/LexicalCaretTree';
import {$removeNode} from './LexicalNode';
import {StateConfig} from './LexicalNodeState';
import {internalGetActiveEditor} from './LexicalUpdates';
import {
  $copyNode,
  isSynthesizedIsInline,
  markNodesWithTypesAsDirty,
} from './LexicalUtils';

/**
 * @experimental node-structure
 *
 * The structural facts a node class declares in `$config()` (`inline`,
 * `children`, `mergeAdjacent`), each from the nearest class in its config
 * chain that declares it, and the values it declares `derived`. Keys no class
 * declares are absent; a `mergeAdjacent: false` declaration reads as absent
 * too. The object is frozen, and `derived` is a fresh copy on every call.
 */
export interface DeclaredNodeStructure {
  readonly inline?: boolean;
  readonly children?: NodeChildrenConfig;
  readonly mergeAdjacent?: MergeAdjacentConfig;
  /**
   * The schema fields and NodeState keys of the class declared `derived`:
   * the node's own code recomputes them, so tools that copy or compare a
   * node's data can leave them out.
   */
  readonly derived: ReadonlySet<string>;
  /** The class each key came from (for tools that check completeness). */
  readonly declaredBy: {
    readonly inline?: Klass<LexicalNode>;
    readonly children?: Klass<LexicalNode>;
    readonly mergeAdjacent?: Klass<LexicalNode>;
  };
}

interface CachedNodeStructure extends DeclaredNodeStructure {
  readonly derivedNames: ReadonlySet<string>;
}

const structureCache = /* @__PURE__ */ new WeakMap<
  Klass<LexicalNode>,
  CachedNodeStructure
>();

/**
 * What the class's own `isInline()` returns on a bare prototype: `undefined`
 * when the class writes none of its own (or the one it has was synthesized
 * from a declaration), `null` when it cannot be evaluated without an instance
 * (it reads instance fields and throws, or returns a non-boolean).
 */
function probeOwnIsInline(
  klass: Klass<LexicalNode>,
  until: Klass<LexicalNode> | null,
): boolean | null | undefined {
  for (
    let k: Klass<LexicalNode> | null = klass;
    k !== null && k !== until;
    k = Object.getPrototypeOf(k) as Klass<LexicalNode> | null
  ) {
    const proto = k.prototype as {isInline?: unknown} | undefined;
    if (
      proto !== undefined &&
      Object.prototype.hasOwnProperty.call(proto, 'isInline') &&
      typeof proto.isInline === 'function' &&
      !isSynthesizedIsInline(proto.isInline)
    ) {
      try {
        const value = (
          klass.prototype as {isInline: () => unknown}
        ).isInline.call(Object.create(klass.prototype));
        return typeof value === 'boolean' ? value : null;
      } catch (_e) {
        return null;
      }
    }
  }
  return undefined;
}

/** Why `config.by` is invalid for `klass`, or null when it is valid. */
function invalidMergeBy(
  klass: Klass<LexicalNode>,
  config: MergeAdjacentConfig,
  derived: ReadonlySet<string>,
): null | {entry: string; reason: 'unknown' | 'derived' | 'derived-state'} {
  const fields = getComposedSchemaFields(klass);
  for (const entry of config.by) {
    if (typeof entry === 'string') {
      if (!(entry in fields)) {
        return {entry, reason: 'unknown'};
      }
      if (derived.has(entry)) {
        return {entry, reason: 'derived'};
      }
    } else if (entry.derived) {
      return {entry: String(entry.key), reason: 'derived-state'};
    }
  }
  return null;
}

/**
 * The nearest `children` declaration, read without
 * {@link getDeclaredNodeStructure} (which calls this while it builds a
 * result, possibly for the class that is asking).
 */
function declaredChildren(
  klass: Klass<LexicalNode>,
): NodeChildrenConfig | undefined {
  for (const {ownNodeConfig} of iterStaticNodeConfigChain(klass)) {
    if (ownNodeConfig && ownNodeConfig.children !== undefined) {
      return ownNodeConfig.children;
    }
  }
  return undefined;
}

/**
 * For a merging class that lists child classes (no `'inline'`): the first
 * listed class that does not hold inline content (possibly with a nested
 * instance of `klass`), or null.
 */
function mergingChildNotInline(
  klass: Klass<LexicalNode>,
  children: NodeChildrenConfig | undefined,
): null | Klass<LexicalNode> {
  if (!Array.isArray(children) || children.includes('inline')) {
    return null;
  }
  for (const entry of children) {
    if (entry === 'inline') {
      continue;
    }
    const item = declaredChildren(entry as Klass<LexicalNode>);
    const ok =
      item === 'inline' ||
      (Array.isArray(item) &&
        item.includes('inline') &&
        item.every(
          e => e === 'inline' || e === klass || klass.prototype instanceof e,
        ));
    if (!ok) {
      return entry as Klass<LexicalNode>;
    }
  }
  return null;
}

/** The names of the schema fields and NodeState keys declared derived. */
function derivedNamesOf(klass: Klass<LexicalNode>): Set<string> {
  const derived = new Set<string>();
  const fields = getComposedSchemaFields(klass);
  for (const name of Object.keys(fields)) {
    if (fields[name].derived === true) {
      derived.add(name);
    }
  }
  for (const {ownNodeConfig} of iterStaticNodeConfigChain(klass)) {
    const states = ownNodeConfig && ownNodeConfig.stateConfigs;
    if (states) {
      for (const entry of states) {
        const config = entry instanceof StateConfig ? entry : entry.stateConfig;
        if (config.derived) {
          derived.add(config.key);
        }
      }
    }
  }
  return derived;
}

function cachedNodeStructure(klass: Klass<LexicalNode>): CachedNodeStructure {
  let result = structureCache.get(klass);
  if (result === undefined) {
    const out: {
      inline?: boolean;
      children?: NodeChildrenConfig;
      mergeAdjacent?: MergeAdjacentConfig;
    } = {};
    const by: {
      inline?: Klass<LexicalNode>;
      children?: Klass<LexicalNode>;
      mergeAdjacent?: Klass<LexicalNode>;
    } = {};
    let mergeSeen = false;
    for (const {klass: k, ownNodeConfig} of iterStaticNodeConfigChain(klass)) {
      if (!ownNodeConfig) {
        continue;
      }
      if (by.inline === undefined && ownNodeConfig.inline !== undefined) {
        out.inline = ownNodeConfig.inline;
        by.inline = k;
      }
      if (by.children === undefined && ownNodeConfig.children !== undefined) {
        out.children = ownNodeConfig.children;
        by.children = k;
      }
      if (!mergeSeen && ownNodeConfig.mergeAdjacent !== undefined) {
        mergeSeen = true;
        if (ownNodeConfig.mergeAdjacent !== false) {
          out.mergeAdjacent = ownNodeConfig.mergeAdjacent;
          by.mergeAdjacent = k;
        }
      }
    }
    const derivedNames = derivedNamesOf(klass);
    // A declaration the class only inherits never makes it invalid: a
    // subclass written before these keys existed reads as not declaring a key
    // it contradicts, or may contradict, so tools fall back to what the class
    // itself says. For `inline`, an own isInline() keeps the inherited value
    // only when it returns that value on the bare prototype.
    if (
      by.inline !== undefined &&
      by.inline !== klass &&
      probeOwnIsInline(klass, by.inline) !== undefined &&
      probeOwnIsInline(klass, by.inline) !== out.inline
    ) {
      delete out.inline;
      delete by.inline;
    }
    if (
      by.mergeAdjacent !== undefined &&
      by.mergeAdjacent !== klass &&
      (invalidMergeBy(klass, out.mergeAdjacent!, derivedNames) !== null ||
        mergingChildNotInline(klass, out.children) !== null)
    ) {
      delete out.mergeAdjacent;
      delete by.mergeAdjacent;
    }
    result = Object.freeze({
      ...out,
      declaredBy: Object.freeze(by),
      derived: derivedNames,
      derivedNames,
    });
    structureCache.set(klass, result);
  }
  return result;
}

/**
 * @experimental node-structure
 *
 * Returns the structural declarations of a node class. See
 * {@link DeclaredNodeStructure}. Depends on the class only.
 */
export function getDeclaredNodeStructure(
  klass: Klass<LexicalNode>,
): DeclaredNodeStructure {
  const {derivedNames, ...rest} = cachedNodeStructure(klass);
  return Object.freeze({...rest, derived: new Set(derivedNames)});
}

/**
 * Whether a class is `OverflowNode` (`@lexical/overflow`), a subclass of it,
 * or whatever class an editor registers under its type `'overflow'` (types
 * are unique per editor, so such a class takes its place). Core cannot import
 * the class, so it is matched on its ancestry: a class in the chain whose own
 * `$config()` names the type `'overflow'` and extends `ElementNode`.
 *
 * The character limit wraps it around the overflowing part of a paragraph's
 * text. It is inline content although its `isInline()` is false (it keeps a
 * block's caret and deletion behaviour, see #6535), so it is allowed
 * wherever inline content or blocks are, and a paragraph keeps it rather than
 * being split around it.
 */
function isOverflowClass(klass: Klass<LexicalNode>): boolean {
  let result = overflowCache.get(klass);
  if (result === undefined) {
    result = false;
    for (const {ownNodeConfig, ownNodeType} of iterStaticNodeConfigChain(
      klass,
    )) {
      if (
        ownNodeConfig !== undefined &&
        ownNodeType === 'overflow' &&
        ownNodeConfig.extends === ElementNode
      ) {
        result = true;
        break;
      }
    }
    overflowCache.set(klass, result);
  }
  return result;
}

const overflowCache = /* @__PURE__ */ new WeakMap<
  Klass<LexicalNode>,
  boolean
>();

function isOverflowNode(node: LexicalNode): boolean {
  return isOverflowClass(node.constructor as Klass<LexicalNode>);
}

function isInlineChild(node: LexicalNode): boolean {
  if ($isTextNode(node) || $isLineBreakNode(node) || isOverflowNode(node)) {
    return true;
  }
  try {
    return node.isInline();
  } catch (_e) {
    // A class outside the Text/Element/Decorator contract: left alone.
    return true;
  }
}

/**
 * @internal For Lexical's own code; not public API.
 *
 * Whether the node structure normalization treats `node` as inline content
 * (what a holder of `'inline'` keeps in its line): text, line breaks, inline
 * elements and decorators, and the character limit's `OverflowNode`, which
 * is inline content although its `isInline()` is false.
 */
export function INTERNAL_isInlineContent(node: LexicalNode): boolean {
  return isInlineChild(node);
}

/** A leaf the normalization never removes and that sits in a line. */
function isInlineLeaf(node: LexicalNode): boolean {
  return (
    $isTextNode(node) ||
    $isLineBreakNode(node) ||
    ($isDecoratorNode(node) && isInlineChild(node))
  );
}

function allows(children: NodeChildrenConfig, child: LexicalNode): boolean {
  if (isOverflowNode(child)) {
    return true;
  }
  if (children === 'inline') {
    return isInlineChild(child);
  }
  if (children === 'block') {
    return !isInlineChild(child);
  }
  if (isInlineChild(child)) {
    return children.includes('inline');
  }
  for (const entry of children) {
    if (entry !== 'inline' && child instanceof entry) {
      return true;
    }
  }
  return false;
}

/**
 * What `node` may hold: a root or shadow root holds blocks whatever its class
 * declares (exactly what core's own shadow root transform enforces), any
 * other node what its class declares.
 */
function effectiveChildren(node: ElementNode): NodeChildrenConfig | undefined {
  return $isRootOrShadowRoot(node)
    ? 'block'
    : cachedNodeStructure(node.constructor as Klass<LexicalNode>).children;
}

/**
 * Whether `node` is a plain paragraph whose content `holderChildren` allows:
 * a line of inline content with no type of its own.
 */
function isJoinableParagraph(
  holderChildren: NodeChildrenConfig,
  node: LexicalNode,
): node is ElementNode {
  return (
    $isParagraphNode(node) &&
    !node.isShadowRoot() &&
    node.getChildren().every(c => allows(holderChildren, c))
  );
}

/** A selection point, as a position next to a node that survives repairs. */
type Anchor =
  | {readonly keys: readonly NodeKey[]; readonly after: boolean}
  | {readonly inside: NodeKey}
  | {readonly text: NodeKey; readonly offset: number};

/**
 * `node` and its last (or first) descendants down to a leaf: an anchor next
 * to them survives `node` being removed or split, since a leaf is only moved.
 */
function descend(node: LexicalNode, last: boolean): NodeKey[] {
  const keys: NodeKey[] = [];
  for (
    let n: LexicalNode | null = node;
    n !== null;
    n = $isElementNode(n) ? (last ? n.getLastChild() : n.getFirstChild()) : null
  ) {
    keys.push(n.getKey());
  }
  return keys;
}

/**
 * An element point as the node next to it (preferably a leaf in the same
 * line, which is never removed), so that it keeps its place among the
 * content when its element is split, unwrapped or merged.
 */
function $saveAnchor(point: PointType): Anchor | null {
  if (point.type === 'text') {
    // Text nodes are moved, never removed, but detaching one moves a point
    // in it to its parent: it is put back afterwards.
    return {offset: point.offset, text: point.key};
  }
  const node = point.getNode();
  if (!$isElementNode(node)) {
    return null;
  }
  // A point past the end is at the end: a transform that ran before this
  // one moved children out from before it without moving it (the list item
  // transform moves an orphan into a new list that way).
  const offset = Math.min(point.offset, node.getChildrenSize());
  const prevNode = offset > 0 ? node.getChildAtIndex(offset - 1) : null;
  const nextNode = node.getChildAtIndex(offset);
  if (prevNode !== null && isInlineLeaf(prevNode)) {
    return {after: true, keys: [prevNode.getKey()]};
  }
  if (nextNode !== null && isInlineLeaf(nextNode)) {
    return {after: false, keys: [nextNode.getKey()]};
  }
  let prev = prevNode;
  let next = nextNode;
  const rule = effectiveChildren(node);
  if (rule === 'inline' || (Array.isArray(rule) && rule.includes('inline'))) {
    // In a node that holds lines, a block with nothing in it (an empty list
    // item) is passed over: a point on either side of it is at the same
    // place in the content, so it is anchored to what is beyond it, which
    // keeps it in its line.
    while (prev !== null && isPassedOver(prev)) {
      prev = prev.getPreviousSibling();
    }
    while (next !== null && isPassedOver(next)) {
      next = next.getNextSibling();
    }
    if (prev === null && next === null) {
      prev = prevNode;
      next = nextNode;
    }
  }
  if (prev !== null && isInlineLeaf(prev)) {
    return {after: true, keys: [prev.getKey()]};
  }
  if (next !== null && isInlineLeaf(next)) {
    return {after: false, keys: [next.getKey()]};
  }
  if (next !== null) {
    return {after: false, keys: descend(next, false)};
  }
  if (prev !== null) {
    return {after: true, keys: descend(prev, true)};
  }
  return {inside: node.getKey()};
}

/**
 * A block a point is passed over (see `$saveAnchor`): an element that is not
 * inline, not a paragraph (an empty one becomes an empty line, which keeps a
 * point of its own) and holds no leaf at any depth.
 */
function isPassedOver(node: LexicalNode): boolean {
  if (!$isElementNode(node) || $isParagraphNode(node) || isInlineChild(node)) {
    return false;
  }
  const holdsLeaf = (n: ElementNode): boolean =>
    n.getChildren().some(c => !$isElementNode(c) || holdsLeaf(c));
  return !holdsLeaf(node);
}

class Normalization {
  /**
   * The dirty nodes and all their ancestors, and what the repairs put in a
   * parent: the only nodes visited (unless `full`).
   */
  readonly path = new Set<NodeKey>();
  /** The keys in `path` by the parent they were added under. */
  readonly pathByParent = new Map<NodeKey, Set<NodeKey>>();
  /** Nodes the repairs put in a parent (lifted blocks, copies, wrappers). */
  readonly touched = new Set<NodeKey>();
  /** Where a removed childless element's caret goes. */
  readonly substitutes = new Map<NodeKey, Anchor>();
  /** Elements whose children the repairs changed. */
  readonly written = new Set<NodeKey>();
  changed = false;
  /** Whether every descendant is visited, not only those in `path`. */
  full = false;
  /**
   * Whether this is `INTERNAL_$normalizeNodeStructure`'s normalization of
   * what code changed without transforms, rather than the transform's of an
   * update (see liftsFromStructure).
   */
  explicit = false;
  /**
   * The roots and shadow roots whose inline children are all wrapped, as
   * core's own shadow root transform wraps them every time it runs (on the
   * root in every update, on a shadow root when it is written).
   */
  readonly wrapsAll = new Set<NodeKey>();
  /** Add `node`, under its current parent, to the nodes visited. */
  addPath(node: LexicalNode): void {
    const key = node.getKey();
    this.path.add(key);
    const parent = node.getLatest().__parent;
    if (parent !== null) {
      let keys = this.pathByParent.get(parent);
      if (keys === undefined) {
        keys = new Set();
        this.pathByParent.set(parent, keys);
      }
      keys.add(key);
    }
  }
  /**
   * The children of `parent` to visit: all of them when `full`, otherwise
   * those in `path` (a child no transform wrote and no repair moved holds
   * what the previous pass left, which is normalized).
   */
  $children(parent: ElementNode): readonly LexicalNode[] {
    if (this.full) {
      return parent.getChildren();
    }
    const parentKey = parent.getKey();
    const keys = this.pathByParent.get(parentKey);
    if (keys === undefined) {
      return [];
    }
    // The keys of a parent only grow: the same count is the same keys. A node
    // that has left the parent since is skipped by the callers.
    const cached = this.childrenCache.get(parentKey);
    if (cached !== undefined && cached.size === keys.size) {
      return cached.nodes;
    }
    const nodes: LexicalNode[] = [];
    for (const key of keys) {
      const node = $getNodeByKey(key);
      if (node !== null && node.getLatest().__parent === parentKey) {
        nodes.push(node);
      }
    }
    this.childrenCache.set(parentKey, {nodes, size: keys.size});
    return nodes;
  }
  private readonly childrenCache = new Map<
    NodeKey,
    {readonly size: number; readonly nodes: readonly LexicalNode[]}
  >();
  /**
   * Add `node`, and its ancestors up to one already visited under its current
   * parent, to the nodes visited.
   */
  addPathChain(node: LexicalNode): void {
    for (let n: LexicalNode | null = node; n !== null; n = n.getParent()) {
      const parent = n.getLatest().__parent;
      const keys = parent === null ? undefined : this.pathByParent.get(parent);
      if (keys !== undefined && keys.has(n.getKey())) {
        return;
      }
      this.addPath(n);
    }
  }
  /**
   * After a class's own seam hook (which moves children from nodes it then
   * removes): the entries of every removed parent go to where its children
   * are now, so that they are still visited.
   */
  repath(): void {
    for (const [parentKey, keys] of Array.from(this.pathByParent)) {
      const parent = $getNodeByKey(parentKey);
      if (parent !== null && parent.isAttached()) {
        continue;
      }
      this.pathByParent.delete(parentKey);
      for (const key of keys) {
        const node = $getNodeByKey(key);
        if (node !== null && node.isAttached()) {
          this.addPathChain(node);
        }
      }
    }
  }
  /** `from`'s children were moved to `to` (a merge): so are their entries. */
  movePath(from: NodeKey, to: ElementNode): void {
    const keys = this.pathByParent.get(from);
    if (keys !== undefined) {
      this.pathByParent.delete(from);
      for (const key of keys) {
        const node = $getNodeByKey(key);
        if (node !== null) {
          this.addPath(node);
        }
      }
    }
    this.addPath(to);
  }
  $resolve(
    anchor: Anchor,
    depth = 0,
  ): null | [NodeKey, number, 'text' | 'element'] {
    if ('text' in anchor) {
      const node = $getNodeByKey(anchor.text);
      return node !== null && node.isAttached()
        ? [anchor.text, anchor.offset, 'text']
        : null;
    }
    if ('inside' in anchor) {
      const node = $getNodeByKey(anchor.inside);
      if (node !== null && node.isAttached()) {
        return [anchor.inside, 0, 'element'];
      }
      const substitute = this.substitutes.get(anchor.inside);
      return substitute !== undefined && depth < 16
        ? this.$resolve(substitute, depth + 1)
        : null;
    }
    // From the innermost key out: the leaf the point was next to is moved,
    // never removed, while an outer key may now be the first piece of a node
    // the repair split, which no longer ends (or starts) with that leaf.
    const {keys, after} = anchor;
    for (let i = keys.length - 1; i >= 0; i--) {
      const node = $getNodeByKey(keys[i]);
      if (node === null || !node.isAttached() || node.getParent() === null) {
        // A node the repairs removed (an empty paragraph joined as a line, a
        // merged sibling) says where its place went.
        const substitute = this.substitutes.get(keys[i]);
        if (substitute !== undefined && depth < 16) {
          return this.$resolve(substitute, depth + 1);
        }
        continue;
      }
      // Climb back out (at most as many levels as the point was above the
      // leaf, and never out of a root or shadow root) while the node is
      // still the last child (or first, for a point before it): a point
      // after the node is then at the same place in the content as a point
      // after the leaf, and it stays between the same blocks.
      let at: LexicalNode = node;
      for (let level = 0; level < i; level++) {
        const parent = at.getParent();
        if (
          parent === null ||
          $isRootOrShadowRoot(parent) ||
          (after ? at.getNextSibling() : at.getPreviousSibling()) !== null
        ) {
          break;
        }
        at = parent;
      }
      if ($isTextNode(at)) {
        // Next to a text node in its own parent: a point in it, which text
        // normalization keeps in place when it merges that node with a
        // neighbour (an element point there would shift).
        return [at.getKey(), after ? at.getTextContentSize() : 0, 'text'];
      }
      return [
        at.getParentOrThrow().getKey(),
        at.getIndexWithinParent() + (after ? 1 : 0),
        'element',
      ];
    }
    return null;
  }
}

function $append(parent: ElementNode, nodes: readonly LexicalNode[]): void {
  if (nodes.length > 0) {
    // ElementNode's own splice: an override (ListNode.splice wraps every
    // child in a list item) must not rewrite what the repair moves.
    ElementNode.prototype.splice.call(
      parent,
      parent.getChildrenSize(),
      0,
      nodes as LexicalNode[],
    );
  }
}

function $detach(node: LexicalNode): void {
  // Never through an override (ListItemNode.remove merges the lists around
  // it), never removing a parent it empties, never moving the selection
  // (the normalization restores it).
  $removeNode(node, false, true);
}

/**
 * Whether `a` and its next sibling `b` are the same thing under the
 * `mergeAdjacent` of `a`'s class: same class, that class declares it itself
 * (a subclass that inherits it merges by its own code, so an override of a
 * merge method such as `shouldMergeAdjacentLink` stays the authority), and
 * every named value equal (strict or JSON equality for schema fields, the
 * state's `isEqual` for NodeState).
 */
function $canMergeAdjacent(a: LexicalNode, b: LexicalNode): boolean {
  if (
    a.constructor !== b.constructor ||
    !$isElementNode(a) ||
    !$isElementNode(b)
  ) {
    return false;
  }
  const klass = a.constructor as Klass<LexicalNode>;
  const declared = cachedNodeStructure(klass);
  const config = declared.mergeAdjacent;
  if (config === undefined || declared.declaredBy.mergeAdjacent !== klass) {
    return false;
  }
  let ja: Record<string, unknown> | undefined;
  let jb: Record<string, unknown> | undefined;
  for (const entry of config.by) {
    if (typeof entry === 'string') {
      ja = ja || (a.exportJSON() as unknown as Record<string, unknown>);
      jb = jb || (b.exportJSON() as unknown as Record<string, unknown>);
      const va = ja[entry];
      const vb = jb[entry];
      if (va !== vb && JSON.stringify(va) !== JSON.stringify(vb)) {
        return false;
      }
    } else if (!entry.isEqual($getState(a, entry), $getState(b, entry))) {
      return false;
    }
  }
  return true;
}

/**
 * Append `b`'s children to `a` (its previous sibling) and remove `b`; `a`'s
 * values win. Children that meet at the seam merge in turn.
 */
function $mergeInto(a: ElementNode, b: ElementNode, ctx: Normalization): void {
  const aLast = a.getLastChild();
  const bFirst = b.getFirstChild();
  ctx.substitutes.set(
    b.getKey(),
    aLast !== null
      ? {after: true, keys: descend(aLast, true)}
      : {inside: a.getKey()},
  );
  $append(a, b.getChildren());
  $detach(b);
  ctx.movePath(b.getKey(), a);
  ctx.changed = true;
  ctx.written.add(a.getKey());
  if (aLast === null || bFirst === null) {
    return;
  }
  if ($isElementNode(aLast) && $canMergeAdjacent(aLast, bFirst)) {
    $mergeInto(aLast, bFirst as ElementNode, ctx);
    return;
  }
  // A class may join what meets at the seam itself (a list joins two items
  // that only wrap nested lists, as its own mergeLists does). The hooks are
  // INTERNAL_ methods found by name: this package cannot import the class
  // that implements them.
  const hook = (
    a as unknown as {
      INTERNAL_$afterStructureMerge?: (
        last: LexicalNode,
        first: LexicalNode,
      ) => void;
    }
  ).INTERNAL_$afterStructureMerge;
  if (typeof hook === 'function') {
    hook.call(a, aLast, bFirst);
    if (!ctx.full) {
      // The hook moves nodes the normalization may not have visited yet
      // (the items of a nested list it joins) out of nodes it removes.
      ctx.repath();
    }
  }
}

/**
 * Merge the run of mutually equal siblings around `node` into its first
 * node, and return that node.
 */
function $mergeRun(node: LexicalNode, ctx: Normalization): LexicalNode {
  let first = node;
  for (
    let prev = first.getPreviousSibling();
    prev !== null && $canMergeAdjacent(prev, first);
    prev = first.getPreviousSibling()
  ) {
    first = prev;
  }
  for (
    let next = first.getNextSibling();
    next !== null && $canMergeAdjacent(first, next);
    next = first.getNextSibling()
  ) {
    $mergeInto(first as ElementNode, next as ElementNode, ctx);
  }
  return first;
}

/**
 * Merge the equal adjacent children of `parent`: every one when `all` (or the
 * normalization is `full`), otherwise those around the children to visit
 * (two children neither of which was written or moved were not adjacent and
 * equal after the previous pass, which merged them; whatever makes two
 * children adjacent, or changes a value they compare, writes them).
 */
function $mergeChildren(
  parent: ElementNode,
  ctx: Normalization,
  all = false,
): void {
  if (all || ctx.full) {
    for (let c = parent.getFirstChild(); c !== null; ) {
      c = $mergeRun(c, ctx).getNextSibling();
    }
    return;
  }
  for (const child of ctx.$children(parent)) {
    // Only nodes of one class that declares mergeAdjacent itself merge.
    const klass = child.constructor as Klass<LexicalNode>;
    if (
      cachedNodeStructure(klass).declaredBy.mergeAdjacent === klass &&
      child.getLatest().__parent === parent.getKey()
    ) {
      $mergeRun(child, ctx);
    }
  }
}

/** A run of a holder's content between two lifted blocks. */
interface Segment {
  readonly content: LexicalNode[];
  hadChildren: boolean;
  /** The holder that received the segment, set by $rebuild. */
  holder: ElementNode | null;
}

type RebuildPiece = Segment | {readonly lifted: LexicalNode};

/**
 * Split `holder` into its segments: the original keeps the first segment that
 * had children, copies take the others, and the lifted blocks go between
 * them, all in the holder's place in its parent. An ordered list's copy
 * continues its numbering (see `ListNode`'s split hook). Returns the holders.
 */
function $rebuild(
  holder: ElementNode,
  pieces: readonly RebuildPiece[],
  ctx: Normalization,
): ElementNode[] {
  ctx.changed = true;
  for (const child of holder.getChildren()) {
    $detach(child);
  }
  const placed: LexicalNode[] = [];
  const holders: ElementNode[] = [];
  const preceding: LexicalNode[] = [];
  let holderPlaced = false;
  for (const piece of pieces) {
    if ('lifted' in piece) {
      placed.push(piece.lifted);
      continue;
    }
    if (!piece.hadChildren) {
      continue;
    }
    let target: ElementNode;
    if (!holderPlaced) {
      holderPlaced = true;
      target = holder;
    } else {
      target = $copyNode(holder);
      const hook = (
        target as unknown as {
          INTERNAL_$afterStructureSplit?: (
            original: ElementNode,
            before: readonly LexicalNode[],
          ) => void;
        }
      ).INTERNAL_$afterStructureSplit;
      if (typeof hook === 'function') {
        hook.call(target, holder, preceding);
      }
    }
    $append(target, piece.content);
    piece.holder = target;
    preceding.push(...piece.content);
    placed.push(target);
    holders.push(target);
  }
  const parent = holder.getParentOrThrow();
  ctx.written.add(parent.getKey());
  const at = placed.indexOf(holder);
  let anchor: LexicalNode = holder;
  for (let i = at - 1; i >= 0; i--) {
    $insertSibling(anchor, 'previous', placed[i], false);
    anchor = placed[i];
  }
  anchor = holder;
  for (let i = at + 1; i < placed.length; i++) {
    $insertSibling(anchor, 'next', placed[i], false);
    anchor = placed[i];
  }
  for (const node of placed) {
    ctx.addPath(node);
    ctx.touched.add(node.getKey());
  }
  if (at === -1) {
    // Every child was lifted out: the emptied holder goes, and a point in it
    // goes before what was lifted out of it.
    if (placed.length > 0) {
      ctx.substitutes.set(holder.getKey(), {
        after: false,
        keys: descend(placed[0], false),
      });
    }
    $detach(holder);
  }
  return holders;
}

/**
 * The holder's hook for a child its declared `children` allow that must
 * still be lifted out, given what else the holder holds: a list item lifts a
 * nested list that is not all it holds (see `ListItemNode`). Since the answer
 * depends on the siblings and not on the child alone, a holder that has the
 * hook checks all its children whenever it is visited.
 */
function liftsFromStructure(
  holder: ElementNode,
):
  | null
  | ((this: ElementNode, child: LexicalNode, explicit: boolean) => boolean) {
  const hook = (
    holder as unknown as {
      INTERNAL_$liftsFromStructure?: (
        child: LexicalNode,
        explicit: boolean,
      ) => boolean;
    }
  ).INTERNAL_$liftsFromStructure;
  return typeof hook === 'function' ? hook : null;
}

/**
 * What a holder of inline content does with each child: keeps it, joins it
 * (a plain paragraph, not in an inline element), or lifts it out (any other
 * block, or an allowed child the holder's hook lifts). Disallowed inline
 * content with nowhere to go (a misdeclared class) is kept, never dropped.
 */
function inlineRuleKinds(
  holder: ElementNode,
  rule: NodeChildrenConfig,
  children: readonly LexicalNode[],
  explicit: boolean,
): ('keep' | 'join' | 'lift')[] {
  const inlineHolder = holder.isInline();
  const lifts = liftsFromStructure(holder);
  return children.map(c =>
    allows(rule, c)
      ? lifts !== null && lifts.call(holder, c, explicit)
        ? 'lift'
        : 'keep'
      : !inlineHolder && isJoinableParagraph(rule, c)
        ? 'join'
        : isInlineChild(c)
          ? 'keep'
          : 'lift',
  );
}

/**
 * What a holder that lists the classes it allows (no `'inline'`) does with
 * each child: keeps it, wraps it in the first listed class, flattens it into
 * one (a plain paragraph), or lifts it out.
 */
function classRuleKinds(
  rule: readonly ('inline' | Klass<LexicalNode>)[],
  children: readonly LexicalNode[],
): ('keep' | 'wrap' | 'flatten' | 'lift')[] {
  const wrapper = rule[0] as Klass<ElementNode> | undefined;
  const wrapperChildren =
    wrapper === undefined ? undefined : declaredChildren(wrapper);
  return children.map(c =>
    allows(rule, c)
      ? 'keep'
      : wrapper !== undefined &&
          (wrapperChildren === undefined || allows(wrapperChildren, c))
        ? 'wrap'
        : wrapper !== undefined &&
            wrapperChildren !== undefined &&
            isJoinableParagraph(wrapperChildren, c)
          ? 'flatten'
          : isInlineChild(c)
            ? 'keep'
            : 'lift',
  );
}

/**
 * Before `block` is lifted out of the inline element `holder` (a link, a
 * mark), wrap each run of inline content in it, and in every block it holds
 * at any depth (the items of a list, the paragraphs of a table cell or of a
 * shadow root), in a copy of `holder`, so that what the element says about
 * its content (a URL, comment ids) stays on all of it, as LinkNode's own
 * transform keeps it. A block whose rule does not allow the copy (a list
 * holding stray inline content) then applies its rule to it, as the next pass
 * would.
 */
function $wrapLiftedContent(
  block: ElementNode,
  holder: ElementNode,
  ctx: Normalization,
): void {
  const copies: ElementNode[] = [];
  let run: LexicalNode[] = [];
  const flush = () => {
    if (run.length > 0) {
      const copy = $copyNode(holder);
      $insertSibling(run[0], 'previous', copy, false);
      $append(copy, run);
      copies.push(copy);
      run = [];
    }
  };
  for (const child of block.getChildren()) {
    // An OverflowNode is not wrapped but wrapped inside, which is where
    // LinkNode's own transform, which lifts it out of a link, leaves a copy.
    if (isInlineChild(child) && !isOverflowNode(child)) {
      run.push(child);
      continue;
    }
    flush();
    if ($isElementNode(child)) {
      $wrapLiftedContent(child, holder, ctx);
    }
  }
  flush();
  if (copies.length === 0) {
    return;
  }
  ctx.changed = true;
  ctx.written.add(block.getKey());
  const rule = effectiveChildren(block);
  if (rule !== undefined && copies.some(copy => !allows(rule, copy))) {
    $applyRules(block, rule, true, ctx);
  }
}

/**
 * A holder of inline content (`'inline'`, or a list that names `'inline'`):
 * plain paragraphs become lines of it, joined to the inline content next to
 * them with line breaks (an empty one keeps its line), and other blocks are
 * lifted out, the holder split around them.
 */
function $applyInlineRule(
  holder: ElementNode,
  rule: NodeChildrenConfig,
  ctx: Normalization,
): ElementNode[] {
  const inlineHolder = holder.isInline();
  const children = holder.getChildren();
  const kinds = inlineRuleKinds(holder, rule, children, ctx.explicit);
  if (kinds.every(k => k === 'keep')) {
    return [holder];
  }
  const pieces: RebuildPiece[] = [];
  const emptyLines: {paragraph: ElementNode; segment: Segment; at: number}[] =
    [];
  let segment: Segment = {content: [], hadChildren: false, holder: null};
  let last: 'none' | 'inline' | 'line' | 'block' = 'none';
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const kind = kinds[i];
    if (kind === 'lift') {
      if (inlineHolder && $isElementNode(child)) {
        // Out of an inline element (a link, a mark), the block's inline
        // content is wrapped in copies of it first, as LinkNode's own
        // transform does.
        $wrapLiftedContent(child, holder, ctx);
      }
      pieces.push(segment, {lifted: child});
      segment = {content: [], hadChildren: false, holder: null};
      last = 'none';
      continue;
    }
    segment.hadChildren = true;
    if (kind === 'join') {
      if (last === 'inline' || last === 'line') {
        segment.content.push($createLineBreakNode());
      }
      const content = (child as ElementNode).getChildren();
      if (content.length === 0) {
        emptyLines.push({
          at: segment.content.length,
          paragraph: child as ElementNode,
          segment,
        });
      }
      segment.content.push(...content);
      last = 'line';
      continue;
    }
    const unit = isInlineChild(child) ? 'inline' : 'block';
    if (unit === 'inline' && last === 'line') {
      segment.content.push($createLineBreakNode());
    }
    segment.content.push(child);
    last = unit;
  }
  pieces.push(segment);
  const holders = $rebuild(holder, pieces, ctx);
  for (const {paragraph, segment: s, at} of emptyLines) {
    // An empty paragraph's line: after what precedes it in its segment, or
    // before what follows, or the (otherwise empty) holder of its segment.
    const before = at > 0 ? s.content[at - 1] : undefined;
    const after = s.content[at];
    ctx.substitutes.set(
      paragraph.getKey(),
      before !== undefined
        ? {after: true, keys: descend(before, true)}
        : after !== undefined
          ? {after: false, keys: descend(after, false)}
          : {inside: (s.holder || holder).getKey()},
    );
  }
  return holders;
}

/**
 * A holder that lists the classes it allows and not `'inline'` (a list): a
 * child the first listed class can hold is wrapped in one (a run of inline
 * content in one), a plain paragraph becomes one holding its content, and any
 * other block is lifted out and the holder split around it.
 */
function $applyClassRule(
  holder: ElementNode,
  rule: readonly ('inline' | Klass<LexicalNode>)[],
  ctx: Normalization,
): ElementNode[] {
  const wrapper = rule[0] as Klass<ElementNode> | undefined;
  const children = holder.getChildren();
  const kinds = classRuleKinds(rule, children);
  if (kinds.every(k => k === 'keep')) {
    return [holder];
  }
  const pieces: RebuildPiece[] = [];
  let segment: Segment = {content: [], hadChildren: false, holder: null};
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const kind = kinds[i];
    if (kind === 'lift') {
      pieces.push(segment, {lifted: child});
      segment = {content: [], hadChildren: false, holder: null};
      continue;
    }
    segment.hadChildren = true;
    if (kind === 'keep') {
      segment.content.push(child);
    } else if (kind === 'flatten') {
      const w = $create(wrapper!);
      $append(w, (child as ElementNode).getChildren());
      ctx.substitutes.set(child.getKey(), {inside: w.getKey()});
      segment.content.push(w);
    } else {
      const run = [child];
      while (
        isInlineChild(child) &&
        i + 1 < children.length &&
        kinds[i + 1] === 'wrap' &&
        isInlineChild(children[i + 1])
      ) {
        run.push(children[++i]);
      }
      const w = $create(wrapper!);
      $append(w, run);
      segment.content.push(w);
    }
  }
  pieces.push(segment);
  return $rebuild(holder, pieces, ctx);
}

/**
 * A holder of blocks: each run of inline children is wrapped in the element
 * its first node creates as a parent (a paragraph), as core's shadow root
 * transform does.
 */
function $wrapInlineRun(child: LexicalNode, ctx: Normalization): void {
  const blocked = (n: LexicalNode | null): n is LexicalNode =>
    n !== null && !allows('block', n);
  if (!blocked(child)) {
    return;
  }
  let first = child;
  for (
    let p = first.getPreviousSibling();
    blocked(p);
    p = first.getPreviousSibling()
  ) {
    first = p;
  }
  const run: LexicalNode[] = [first];
  for (let n = first.getNextSibling(); blocked(n); n = n.getNextSibling()) {
    run.push(n);
  }
  const w = first.createParentElementNode();
  $insertSibling(first, 'previous', w, false);
  $append(w, run);
  ctx.changed = true;
  ctx.written.add(w.getKey());
  ctx.addPath(w);
  ctx.touched.add(w.getKey());
}

/**
 * What a holder's rule depends on besides its class, recorded for each
 * version of a node the normalization visits (a node is cloned at most once
 * per update, so a version is the node as the last pass that visited it
 * left it).
 */
const ruleInputs = /* @__PURE__ */ new WeakMap<LexicalNode, number>();

/**
 * Whether the rule inputs of a class's nodes can differ between nodes: it
 * overrides `isShadowRoot()` or `isInline()` (other than with the `isInline()`
 * synthesized from its declaration), so they may read the node's state.
 */
function hasInstanceRuleInputs(klass: Klass<LexicalNode>): boolean {
  let result = instanceRuleInputsCache.get(klass);
  if (result === undefined) {
    const proto = klass.prototype as ElementNode;
    result =
      proto.isShadowRoot !== ElementNode.prototype.isShadowRoot ||
      (proto.isInline !== ElementNode.prototype.isInline &&
        !isSynthesizedIsInline(proto.isInline));
    instanceRuleInputsCache.set(klass, result);
  }
  return result;
}

const instanceRuleInputsCache = /* @__PURE__ */ new WeakMap<
  Klass<LexicalNode>,
  boolean
>();

/**
 * Whether the children of `holder` must all be checked against its rule:
 * the normalization is `full`, or the holder was never visited in its current
 * or committed version, or what its rule depends on (whether it is a root or
 * shadow root, whether it is inline) changed since, or the holder has a hook
 * that lifts allowed children (see {@link liftsFromStructure}). Otherwise only
 * the children to visit can break the rule: every other child was allowed by
 * the same rule after the previous pass, and whether a child is allowed
 * depends on the child alone, which writes it when it changes.
 */
function $checksAllChildren(holder: ElementNode, ctx: Normalization): boolean {
  if (liftsFromStructure(holder) !== null) {
    // Whether a child is allowed depends on its siblings too.
    return true;
  }
  if (
    $isRootNode(holder) ||
    !hasInstanceRuleInputs(holder.constructor as Klass<LexicalNode>)
  ) {
    // The same for every node of the class: its rule never changes.
    return ctx.full;
  }
  const latest = holder.getLatest();
  const inputs =
    ($isRootOrShadowRoot(holder) ? 1 : 0) + (isInlineChild(holder) ? 2 : 0);
  let before = ruleInputs.get(latest);
  if (before === undefined) {
    const committed = $getEditor()
      .getEditorState()
      ._nodeMap.get(holder.getKey());
    before = committed === undefined ? undefined : ruleInputs.get(committed);
  }
  ruleInputs.set(latest, inputs);
  return ctx.full || before !== inputs;
}

/**
 * Apply `holder`'s rule. Returns the holders it was split into, or null when
 * it kept its children as they were.
 */
function $applyRules(
  holder: ElementNode,
  rule: NodeChildrenConfig,
  checksAll: boolean,
  ctx: Normalization,
): ElementNode[] | null {
  if (rule === 'block' && checksAll && !$holdsInline(holder)) {
    // The common case (the root in every update): one walk, no array.
    return null;
  }
  const holderKey = holder.getKey();
  const children = checksAll
    ? holder.getChildren()
    : ctx.$children(holder).filter(c => c.getLatest().__parent === holderKey);
  if (rule === 'block') {
    for (const c of children) {
      if (c.getLatest().__parent === holderKey) {
        $wrapInlineRun(c, ctx);
      }
    }
    return null;
  }
  if (rule === 'inline' || rule.includes('inline')) {
    return inlineRuleKinds(holder, rule, children, ctx.explicit).every(
      k => k === 'keep',
    )
      ? null
      : $applyInlineRule(holder, rule, ctx);
  }
  return classRuleKinds(rule, children).every(k => k === 'keep')
    ? null
    : $applyClassRule(holder, rule, ctx);
}

/**
 * Normalize `node`'s subtree bottom-up: first the merges among its children
 * as they are, then each child to visit (the rest were normalized when they
 * were last written), then, if it is empty and Lexical removes it when empty,
 * its removal, else its own declared `children` (which may split it in its
 * parent), then the merges among the children that result. A child is always
 * normalized before its parent reads it, so the parent's decision never
 * depends on whether the child was repaired yet. Returns whether `node` was
 * removed.
 */
function $normalizeElement(node: ElementNode, ctx: Normalization): boolean {
  const rule = effectiveChildren(node);
  // Decided once per visit: it records what the rule depends on.
  const checksAll =
    rule !== undefined &&
    ($checksAllChildren(node, ctx) ||
      (rule === 'block' && ctx.wrapsAll.has(node.getKey())));
  if (!ctx.full && !ctx.pathByParent.has(node.getKey())) {
    // Written, but none of its children was: only what depends on the node
    // itself can have changed (whether it is empty, what its rule is).
    if (
      node.isEmpty() &&
      !$isRootOrShadowRoot(node) &&
      isRemovedWhenEmpty(node)
    ) {
      $removeEmpty(node, ctx);
      return true;
    }
    if (!checksAll) {
      return false;
    }
  }
  $mergeChildren(node, ctx);
  let removedChild = false;
  for (const c of ctx.$children(node)) {
    if (
      $isElementNode(c) &&
      c.getLatest().__parent === node.getKey() &&
      $normalizeElement(c, ctx)
    ) {
      removedChild = true;
    }
  }
  if (
    node.isEmpty() &&
    !$isRootOrShadowRoot(node) &&
    (isRemovedWhenEmpty(node) || (removedChild && !node.canBeEmpty()))
  ) {
    $removeEmpty(node, ctx);
    return true;
  }
  const holders =
    rule === undefined ? null : $applyRules(node, rule, checksAll, ctx);
  if (holders === null) {
    $mergeChildren(node, ctx);
  } else {
    // A rebuilt holder's children were all moved: every pair is new.
    for (const holder of holders) {
      $mergeChildren(holder, ctx, true);
    }
  }
  return false;
}

/**
 * Whether Lexical removes `node` once it is empty, whichever transform gets
 * to it first: an inline element that cannot be empty (a link, a mark), which
 * `NormalizeInlineElementsExtension` removes, or the character limit's
 * `OverflowNode`, which removes itself. The normalization removes it too,
 * after its children are normalized and before its parent is decided, so
 * whether such a node is still there never changes how its parent is
 * repaired (a holder whose only content it was is emptied either way).
 */
function isRemovedWhenEmpty(node: ElementNode): boolean {
  return isOverflowNode(node) || (isInlineChild(node) && !node.canBeEmpty());
}

/**
 * Remove an empty `node` (see {@link isRemovedWhenEmpty}). As when Lexical
 * removes it, a parent that cannot be empty and is left empty goes too (its
 * own normalization, which runs next, sees that a child was removed).
 */
function $removeEmpty(node: ElementNode, ctx: Normalization): void {
  const prev = node.getPreviousSibling();
  const next = node.getNextSibling();
  const parent = node.getParentOrThrow();
  ctx.substitutes.set(
    node.getKey(),
    prev !== null
      ? {after: true, keys: descend(prev, true)}
      : next !== null
        ? {after: false, keys: descend(next, false)}
        : {inside: parent.getKey()},
  );
  $detach(node);
  // The siblings it separated are now adjacent: they may merge.
  for (const sibling of [prev, next]) {
    if (sibling !== null) {
      ctx.addPath(sibling);
      ctx.touched.add(sibling.getKey());
    }
  }
  ctx.changed = true;
  ctx.written.add(parent.getKey());
}

/** A class whose rule does not depend on the node and that does not merge. */
function isStructurallyStatic(klass: Klass<LexicalNode>): boolean {
  let result = structurallyStaticCache.get(klass);
  if (result === undefined) {
    result =
      !hasInstanceRuleInputs(klass) &&
      cachedNodeStructure(klass).declaredBy.mergeAdjacent !== klass;
    structurallyStaticCache.set(klass, result);
  }
  return result;
}

const structurallyStaticCache = /* @__PURE__ */ new WeakMap<
  Klass<LexicalNode>,
  boolean
>();

/**
 * Whether a written element is, as far as the normalization is concerned,
 * what it was in the committed state, which was normalized: the same place
 * (parent and siblings), the same children, a class whose rule does not
 * depend on the node and that does not merge (whose compared values may have
 * changed). A list item renumbered by its list is such a node.
 */
function isStructurallyUnchanged(
  node: LexicalNode,
  committed: LexicalNode | undefined,
): boolean {
  if (committed === undefined || !$isElementNode(node)) {
    return false;
  }
  const klass = node.constructor as Klass<LexicalNode>;
  if (committed.constructor !== klass || !isStructurallyStatic(klass)) {
    return false;
  }
  const n = node;
  const c = committed as ElementNode;
  return (
    c.__parent === n.__parent &&
    c.__prev === n.__prev &&
    c.__next === n.__next &&
    c.__first === n.__first &&
    c.__last === n.__last &&
    c.__size === n.__size
  );
}

/**
 * Repair the structure around every node written since the last pass, from
 * the root down. A node that was not written holds what the previous pass
 * left, which is already normalized, so the result is the normalization of
 * the whole document: it depends on the document only, never on which nodes
 * are dirty or on the order their transforms run. When the committed state
 * was normalized (`committedNormalized`), a written element that is
 * structurally what it was there is not visited either.
 */
function $normalizeDirty(
  dirty: NodeKey[],
  full: boolean,
  committedNormalized: boolean,
): void {
  const root = $getRoot();
  if (dirty.length === 0 && !full && !$holdsInline(root)) {
    return;
  }
  const ctx = new Normalization();
  ctx.full = full;
  const rootKey = root.getKey();
  // Core's shadow root transform, which the extension turns off, wraps the
  // inline children of the root in every update (Lexical runs the root's
  // transforms whenever anything changed) and those of a shadow root that
  // was written: so does this, whether or not they were written.
  ctx.wrapsAll.add(rootKey);
  ctx.path.add(rootKey);
  const committed = committedNormalized
    ? $getEditor().getEditorState()._nodeMap
    : null;
  const chain: LexicalNode[] = [];
  // A full pass visits every node anyway.
  for (const key of full ? [] : dirty) {
    // The node and its ancestors up to one already added, if it is attached.
    chain.length = 0;
    let attached = false;
    const node = $getNodeByKey(key);
    if ($isElementNode(node) && node.isShadowRoot()) {
      ctx.wrapsAll.add(key);
    }
    if (
      committed !== null &&
      node !== null &&
      isStructurallyUnchanged(node, committed.get(key))
    ) {
      continue;
    }
    for (let n: LexicalNode | null = node; n !== null; n = n.getParent()) {
      if (ctx.path.has(n.getKey())) {
        // The root is always in the path: an attached node reaches it.
        attached = true;
        break;
      }
      chain.push(n);
    }
    if (attached) {
      for (const n of chain) {
        ctx.addPath(n);
      }
    }
  }
  dirty.length = 0;
  if (ctx.path.size > 1 || full || $holdsInline(root)) {
    $normalize(ctx, () => {
      $normalizeElement(root, ctx);
    });
  }
}

/** Whether `node` is an element whose `isInline()` returns false. */
function isBlockElement(node: LexicalNode): boolean {
  if (!$isElementNode(node)) {
    return false;
  }
  try {
    return !node.isInline();
  } catch (_e) {
    return false;
  }
}

/** Whether `node` holds content that a holder of blocks wraps. */
function $holdsInline(node: ElementNode): boolean {
  for (let c = node.getFirstChild(); c !== null; c = c.getNextSibling()) {
    // A block element (a paragraph) is allowed: the cheap test first.
    if (!isBlockElement(c) && !allows('block', c)) {
      return true;
    }
  }
  return false;
}

/**
 * Run `repair`, then make every ancestor of a change dirty, so that its own
 * transforms run again on the result (a list renumbers its items when one of
 * them now only wraps a nested list) whichever of them already ran in this
 * pass, and put the selection back among the content it was in.
 */
function $normalize(
  ctx: Normalization,
  repair: (normalization: Normalization) => void,
): void {
  const selection = $getSelection();
  const saved = $isRangeSelection(selection)
    ? ([selection.anchor, selection.focus] as const).map(point => ({
        anchor: $saveAnchor(point),
        point,
      }))
    : [];
  repair(ctx);
  for (const key of ctx.written) {
    const node = $getNodeByKey(key);
    if (node !== null && node.isAttached()) {
      for (
        let n: LexicalNode | null = node;
        n !== null && !$isRootNode(n);
        n = n.getParent()
      ) {
        n.markDirty();
      }
    }
  }
  if (ctx.changed) {
    for (const {point, anchor} of saved) {
      const at = anchor && ctx.$resolve(anchor);
      if (at) {
        point.set(at[0], at[1], at[2]);
      }
    }
  }
}

/**
 * @internal Not public API.
 *
 * Normalize the subtree rooted at `node` now, as `NodeStructureExtension`
 * does, bottom-up (which may split `node` in its parent), then merge `node`
 * (or what it was split into) with its equal siblings.
 *
 * The extension normalizes only updates that run transforms: code that
 * applies an update with `skipTransforms` calls this on what it changed, in
 * the same update.
 */
export function INTERNAL_$normalizeNodeStructure(node: LexicalNode): void {
  if (!$isElementNode(node) || !node.isAttached()) {
    return;
  }
  const ctx = new Normalization();
  ctx.full = true;
  ctx.explicit = true;
  const parent = node.getParent();
  $normalize(ctx, () => {
    if (parent === null || $isRootOrShadowRoot(node)) {
      // A root (or shadow root) is never split: normalize it in place.
      $normalizeElement(node, ctx);
      return;
    }
    const parentKey = parent.getKey();
    ctx.touched.add(node.getKey());
    $normalizeElement(node, ctx);
    for (const key of Array.from(ctx.touched)) {
      const piece = $getNodeByKey(key);
      if (piece !== null && piece.getLatest().__parent === parentKey) {
        $mergeRun(piece, ctx);
      }
    }
  });
}

interface StructureRegistration {
  refs: number;
  readonly dispose: () => void;
}

let structureRegistrations:
  | WeakMap<LexicalEditor, StructureRegistration>
  | undefined;

/**
 * @internal For `@lexical/extension`'s `NodeStructureExtension` and
 * `registerNodeStructure`; not public API.
 *
 * Enforce the structure node classes declare on `editor` (see
 * {@link StaticNodeConfigValue.children} and
 * {@link StaticNodeConfigValue.mergeAdjacent}), and mark every node dirty so
 * the current document is normalized too. Registrations are counted: the
 * normalization stops when the last one is disposed.
 *
 * Every class gets a transform that records the nodes written in the update,
 * and the root a transform, which Lexical runs last in each transform pass,
 * that normalizes from the root down along those nodes' ancestors, visiting
 * only them and what the repairs move (the first pass after registering
 * visits the whole document).
 *
 * An update applied with `skipTransforms` runs no transform, so it is not
 * normalized, and a later update repairs only what it changes itself, apart
 * from the root's inline children, which every update wraps, as core's own
 * shadow root transform does. Code that applies updates that way calls
 * {@link INTERNAL_$normalizeNodeStructure} on what it changed.
 *
 * @returns A function that disposes this registration
 */
export function INTERNAL_registerNodeStructure(
  editor: LexicalEditor,
): () => void {
  const registry =
    structureRegistrations || (structureRegistrations = new WeakMap());
  let registration = registry.get(editor);
  if (registration === undefined) {
    // The nodes collected since the last pass, and since the last commit.
    const dirty: NodeKey[] = [];
    const collected = new Set<NodeKey>();
    const collect: Transform<LexicalNode> = node => {
      const key = node.__key;
      dirty.push(key);
      collected.add(key);
    };
    // Committed states that may not be normalized: the one before this
    // registration, and any that an update applied without transforms
    // (`skipTransforms`) changed.
    const unnormalized = new WeakSet<EditorState>([editor.getEditorState()]);
    // The first pass after registering normalizes the whole document.
    let full = true;
    const $normalizeTransform: Transform<LexicalNode> = () => {
      const all = full;
      full = false;
      $normalizeDirty(
        dirty,
        all,
        !unnormalized.has($getEditor().getEditorState()),
      );
    };
    const disposeListener = editor.registerUpdateListener(
      ({editorState, dirtyElements, dirtyLeaves}) => {
        const nodeMap = editorState._nodeMap;
        const skipped = (key: NodeKey) =>
          !collected.has(key) && nodeMap.has(key);
        let complete = true;
        for (const [key, intentional] of dirtyElements) {
          if (intentional && key !== 'root' && skipped(key)) {
            complete = false;
            break;
          }
        }
        if (complete) {
          for (const key of dirtyLeaves) {
            if (skipped(key)) {
              complete = false;
              break;
            }
          }
        }
        collected.clear();
        if (!complete) {
          unnormalized.add(editorState);
        }
      },
    );
    const added: [Set<Transform<LexicalNode>>, Transform<LexicalNode>][] = [];
    const types: string[] = [];
    for (const [type, {klass, transforms}] of editor._nodes) {
      const fn = type === 'root' ? $normalizeTransform : collect;
      transforms.add(fn);
      added.push([transforms, fn]);
      if (
        klass.prototype instanceof ElementNode ||
        klass.prototype instanceof DecoratorNode
      ) {
        types.push(type);
      }
    }
    registration = {
      dispose: () => {
        disposeListener();
        for (const [transforms, fn] of added) {
          transforms.delete(fn);
        }
      },
      refs: 0,
    };
    registry.set(editor, registration);
    markNodesWithTypesAsDirty(editor, types);
  }
  registration.refs++;
  let disposed = false;
  const current = registration;
  return () => {
    if (!disposed) {
      disposed = true;
      if (--current.refs === 0) {
        current.dispose();
        registry.delete(editor);
      }
    }
  };
}

/**
 * @internal For Lexical's own code; not public API.
 *
 * Whether `editor` enforces declared node structure (`NodeStructureExtension`
 * or `registerNodeStructure` is registered on it). The transforms that also
 * restructure (the link, list and list item transforms, and core's shadow
 * root transform) use it to leave to the normalization what it does itself,
 * and the list and mdast importers to build directly what it keeps, where
 * the shape they build otherwise would leave something behind once it runs.
 * Reads a registry only, so code that imports it does not pull in the
 * normalization.
 */
export function INTERNAL_isNodeStructureEnforced(
  editor: LexicalEditor,
): boolean {
  return (
    structureRegistrations !== undefined && structureRegistrations.has(editor)
  );
}

/** Whether there is an active editor and it enforces declared structure. */
function $isStructureEnforcedOnActiveEditor(): boolean {
  const editor = internalGetActiveEditor();
  return editor !== null && INTERNAL_isNodeStructureEnforced(editor);
}

/**
 * Lets `$isBlockContainer` narrow without excluding: an element that is not a
 * block container is still an element.
 */
declare const BlockContainerBrand: unique symbol;

/**
 * @experimental node-structure
 *
 * Whether structural commands treat `node` as a container of blocks: the
 * root, a shadow root, or, in an editor that enforces declared node
 * structure (`NodeStructureExtension` enabled, `registerNodeStructure`, or a
 * `@lexical/y` binding, which always enforces it), a block element whose
 * class declares `children: 'block'` (a callout, a box).
 *
 * The commands that convert, wrap, split or insert blocks (`$insertList`,
 * Enter in an empty list item, `$wrapNodes`, `insertNodes`,
 * `$insertNodeToNearestRoot`, `$insertNodeToNearestRootAtCaret` unless
 * given `rootMode: 'root'`, the markdown shortcuts) stop at a container:
 * they act on the blocks inside it and do not replace or split the container
 * itself; in an empty declared container, `$setBlocksType` puts the new
 * block in it. Unlike
 * a shadow root, a declared container is not a selection boundary:
 * select-all, the arrow keys, and Backspace or Delete at its edges treat it
 * like any other element. With no active editor (a bare
 * `editorState.read()`), only the root and shadow roots are containers.
 */
export function $isBlockContainer(
  node: LexicalNode | null | undefined,
): node is ElementNode & {readonly [BlockContainerBrand]: never} {
  if (!$isElementNode(node)) {
    return false;
  }
  return (
    $isRootOrShadowRoot(node) ||
    (cachedNodeStructure(node.constructor as Klass<LexicalNode>).children ===
      'block' &&
      !node.isInline() &&
      $isStructureEnforcedOnActiveEditor())
  );
}

/**
 * @internal
 *
 * Development check of a class's structural declarations, run when an
 * editor is created: `mergeAdjacent.by` must name known, non-derived values;
 * a declared `inline` must agree with an overridden `isInline()`; a class
 * that lists child classes and merges must list classes that hold inline
 * content (possibly with a nested instance of the class itself).
 *
 * Only keys the class declares in its own `$config()` are checked. A
 * declaration it merely inherits never throws: where the class contradicts
 * it, {@link getDeclaredNodeStructure} reads that key as undeclared.
 */
export function validateNodeStructure(klass: Klass<LexicalNode>): void {
  const declared = cachedNodeStructure(klass);
  const name = klass.name || 'node class';
  if (
    declared.mergeAdjacent !== undefined &&
    declared.declaredBy.mergeAdjacent === klass
  ) {
    const invalid = invalidMergeBy(
      klass,
      declared.mergeAdjacent,
      declared.derivedNames,
    );
    if (invalid !== null) {
      invariant(
        invalid.reason !== 'unknown',
        '%s: mergeAdjacent.by names %s, which is not a schema field of the class',
        name,
        invalid.entry,
      );
      invariant(
        invalid.reason !== 'derived',
        '%s: mergeAdjacent.by names %s, which is derived',
        name,
        invalid.entry,
      );
      invariant(
        false,
        '%s: mergeAdjacent.by names the derived NodeState %s',
        name,
        invalid.entry,
      );
    }
    const item = mergingChildNotInline(klass, declared.children);
    invariant(
      item === null,
      '%s: a merging class that lists child classes must list classes that hold inline content (%s does not)',
      name,
      item === null ? '' : item.name,
    );
  }
  if (declared.inline !== undefined && declared.declaredBy.inline === klass) {
    const value = probeOwnIsInline(
      klass,
      Object.getPrototypeOf(klass) as Klass<LexicalNode> | null,
    );
    invariant(
      value === undefined || value === null || value === declared.inline,
      '%s: $config inline is %s but isInline() returns %s',
      name,
      String(declared.inline),
      String(value),
    );
  }
}
