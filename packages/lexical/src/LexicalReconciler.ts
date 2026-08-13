/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {DOMSlot, ElementDOMSlot} from './LexicalDOMSlot';
import type {
  EditorConfig,
  EditorDOMRenderConfig,
  LexicalEditor,
  MutatedNodes,
  MutationListeners,
  RegisteredNodes,
} from './LexicalEditor';
import type {EditorState} from './LexicalEditorState';
import type {
  LexicalNode,
  LexicalPrivateDOM,
  NodeKey,
  NodeMap,
} from './LexicalNode';
import type {ElementNode} from './nodes/LexicalElementNode';

import invariant from '@lexical/internal/invariant';

import {
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isRootNode,
  $isTextNode,
  DEFAULT_EDITOR_DOM_CONFIG,
} from '.';
import {
  DOUBLE_LINE_BREAK,
  FULL_RECONCILE,
  IS_ALIGN_CENTER,
  IS_ALIGN_END,
  IS_ALIGN_JUSTIFY,
  IS_ALIGN_LEFT,
  IS_ALIGN_RIGHT,
  IS_ALIGN_START,
} from './LexicalConstants';
import {cloneMap} from './LexicalGenMap';
import {$isSlotChild, $isSlotHost, EMPTY_SLOTS} from './LexicalSlot';
import {
  $createChildrenArray,
  $getDocument,
  $getDOMSlot,
  $isRootOrShadowRoot,
  $markSlotEditable,
  cloneDecorators,
  getElementByKeyOrThrow,
  setDOMUnmanaged,
  setMutatedNode,
  setNodeKeyOnDOMNode,
} from './LexicalUtils';

const __DEV__ = process.env.NODE_ENV !== 'production';

type IntentionallyMarkedAsDirtyElement = boolean;

/**
 * @internal
 *
 * A reconcile-managed cache of `getTextContentSize()` for leaf nodes.
 *
 * Stored as a Symbol-keyed property on the node instance itself so that
 * read/write are direct slot access. The slot is pre-allocated to
 * `undefined` as a non-enumerable property in the LexicalNode constructor
 * so all instances share the same V8 hidden-class shape and the setter is
 * a stable inline cache hit instead of a per-instance shape transition.
 *
 * ElementNodes are NOT stored here: an element can be dirty without being
 * cloned (a descendant edit marks ancestors dirty via
 * `internalMarkParentElementsAsDirty` but does not `getWritable()` them), so
 * the same — DEV-frozen — instance would need its size rewritten when its
 * text changes, which the skip-if-set guard cannot do. Element sizes come
 * from `dom.__lexicalTextContent` instead (see `$prevSuffixTextSize`).
 *
 * Leaf writes are skipped when the slot is already not `undefined`. The
 * setter is only re-entered for the same instance via cross-parent moves
 * (where the leaf is reused in a new parent without going through
 * `getWritable` — text is unchanged, so the prior cycle's value is still
 * correct). A leaf whose text actually changed went through
 * `getWritable()` and produced a fresh clone via `static clone(node)` ->
 * ctor -> fresh `undefined` slot, so the setter writes through normally.
 *
 * The reconciler sets this on every reconciled leaf at the end of
 * `$reconcileNode` (and on every newly-created leaf in `$createNode`), so
 * the previous editor state's leaves always carry a valid cached size from
 * the cycle that just committed.
 *
 * Suffix-incremental fast path reads this off the previous-state instance
 * to get the pre-reconcile size of dirty children in O(1), avoiding both
 * the `getLatest()` -> next-state trap and a recursive prev-tree walk.
 */
export const CACHED_TEXT_SIZE_KEY = Symbol.for('@lexical/CachedTextSize');

// Total previous-render text length of the `count` suffix children starting at
// `startKey` (in next-map order, which equals prev order across the size-0 and
// size-±1 fast paths). This is the slice length removed from the parent's
// cached text before the freshly reconciled suffix is appended.
//
// The whole walk runs inside `activePrevEditorState.read(...)` so that every
// node method resolves against the PREVIOUS node map: a moved element recomputes
// its size via `getTextContentSize()` (its shared keyed-DOM cache may already
// hold the NEW size, cf. https://github.com/facebook/lexical/pull/8564), and the
// inter-sibling `isInline()` returns the node's previous-render value (a moved
// or re-typed node could answer differently in the next state, and a node
// removed this cycle would throw). The per-child size logic is inlined here
// rather than shared so it cannot be called outside this read. Non-moved
// elements and leaves still read their O(1) caches, so a large untouched suffix
// child is not re-walked.
function $prevSuffixTextSize(startKey: NodeKey, count: number): number {
  return activePrevEditorState.read(
    () => {
      let size = 0;
      let cur: NodeKey | null = startKey;
      for (let i = 0; i < count && cur !== null; i++) {
        const prevNode = activePrevNodeMap.get(cur);
        // Callers validate every suffix key is present in the prev map, so a
        // miss means a broken upstream invariant. Fail loudly (the reconciler
        // catch recovers via a full reconcile) rather than slice a partial sum.
        invariant(
          prevNode !== undefined,
          'prevSuffixTextSize: missing prev node for key %s',
          cur,
        );
        if ($isElementNode(prevNode)) {
          const nextNode = activeNextNodeMap.get(cur);
          if (
            nextNode !== undefined &&
            $isElementNode(nextNode) &&
            nextNode.__parent !== prevNode.__parent
          ) {
            // Moved to a different parent this cycle: the shared keyed-DOM text
            // cache may already hold its NEW size, so recompute from the prev
            // tree. (`__parent === null` means detached/removed, not moved — its
            // DOM cache is still its prev text.)
            size += prevNode.getTextContentSize();
          } else {
            const keyedDom = activePrevKeyToDOMMap.get(cur);
            const cached = keyedDom && keyedDom.__lexicalTextContent;
            invariant(
              typeof cached === 'string',
              'prevSuffixTextSize: missing __lexicalTextContent for ElementNode of type %s',
              prevNode.getType(),
            );
            size += cached.length;
          }
          if (i < count - 1 && !prevNode.isInline()) {
            size += DOUBLE_LINE_BREAK.length;
          }
        } else {
          // $reconcileNode / $createNode set the size on every leaf they touch,
          // so a missing entry means the invariant was broken upstream.
          const cached = prevNode[CACHED_TEXT_SIZE_KEY];
          invariant(
            cached !== undefined,
            'prevSuffixTextSize: missing cached size for leaf %s key %s',
            prevNode.getType(),
            cur,
          );
          size += cached;
        }
        cur = prevNode.__next;
      }
      return size;
    },
    {editor: activeEditor},
  );
}

function $setCachedTextSize(node: LexicalNode): void {
  if ($isElementNode(node)) {
    return;
  }
  // Skip if a value is already cached on this instance. The setter is only
  // re-entered for the same instance via cross-parent moves (where the leaf
  // is reused in a new parent without going through `getWritable` — text is
  // unchanged so the prior cycle's value is still correct), and that's
  // exactly the case where the instance is also frozen in DEV.
  if (node[CACHED_TEXT_SIZE_KEY] !== undefined) {
    return;
  }
  node[CACHED_TEXT_SIZE_KEY] = $isTextNode(node)
    ? node.__text.length
    : node.getTextContentSize();
}

/**
 * Minimum children count for the suffix-incremental fast path to engage.
 * The fast path adds bookkeeping (cache lookups, suffix walks, splice) that
 * a few-children parent's general walk would beat — gate by a threshold so
 * the overhead only kicks in where the prefix preservation pays for it.
 * Tuned via `editorCycle.bench`.
 */
const MIN_FAST_PATH_CHILDREN = 4;

/**
 * @internal
 *
 * Bench-only escape hatch. When `skipChildrenFastPath` is true the children
 * fast paths in `$reconcileChildren` are skipped and the general path
 * (`$reconcileNodeChildren`) runs instead — used by `editorCycle.bench.ts`
 * to produce a head-to-head A/B against the legacy walk in a single
 * `vitest bench` run. Has no effect when false (default).
 */
export const __benchOnly = {
  skipChildrenFastPath: false,
};

let subTreeTextContent = '';
let subTreeTextFormat: number | null = null;
let subTreeTextStyle: string | null = null;
let subTreeFirstTextKey: NodeKey | null = null;

// Save/restore guard for the leftmost-wins `subTreeFirstTextKey`
// invariant. Any walk that recursively reconciles or creates element
// children must wrap each iteration with `$beginCaptureGuard()` ...
// `$endCaptureGuard(saved)` so the recursive scope's
// `$reconcileChildrenWithDirection` reset doesn't clobber an
// earlier sibling's captured first-text descriptor.
//
// Per-iteration object alloc relies on V8 escape analysis to keep
// `CaptureGuard` off the heap — the shape is monomorphic and the
// lifetime is deterministic, so stack alloc is the expected outcome.
type CaptureGuard = {
  firstTextKey: NodeKey | null;
  format: number | null;
  style: string | null;
};

function $beginCaptureGuard(): CaptureGuard {
  return {
    firstTextKey: subTreeFirstTextKey,
    format: subTreeTextFormat,
    style: subTreeTextStyle,
  };
}

function $endCaptureGuard(saved: CaptureGuard): void {
  if (saved.firstTextKey !== null) {
    subTreeTextFormat = saved.format;
    subTreeTextStyle = saved.style;
    subTreeFirstTextKey = saved.firstTextKey;
  }
}

// Bubble a non-dirty element child's cached first-text descriptor up to
// the caller's scope so a non-dirty prefix carrying the canonical first
// text still wins over a later dirty sibling. Only fires when the
// caller hasn't already captured one.
//
// `__lexicalFirstTextKey` is a reconciler-maintained cache that
// `$createNode` / `$reconcileNode` set on every element's outer keyed
// DOM. `null` means "this element has no text descendant" (legitimate —
// empty element, decorator); `undefined` means the cache is missing,
// which is an invariant violation worth surfacing loudly rather than
// silently falling through and losing the leftmost-wins capture.
function $bubbleChildFirstText(
  childKeyedDom: HTMLElement & LexicalPrivateDOM,
): void {
  if (subTreeFirstTextKey !== null) {
    return;
  }
  const childFirstKey = childKeyedDom.__lexicalFirstTextKey;
  invariant(
    childFirstKey !== undefined,
    '$bubbleChildFirstText: missing __lexicalFirstTextKey on element keyed DOM',
  );
  if (childFirstKey === null) {
    return;
  }
  const textNode = activeNextNodeMap.get(childFirstKey);
  if ($isTextNode(textNode)) {
    subTreeTextFormat = textNode.getFormat();
    subTreeTextStyle = textNode.getStyle();
    subTreeFirstTextKey = childFirstKey;
  }
}
let activeEditorConfig: EditorConfig;
let activeEditor: LexicalEditor;
let activeEditorNodes: RegisteredNodes;
let treatAllNodesAsDirty = false;
let activeEditorStateReadOnly = false;
let activeMutationListeners: MutationListeners;
let activeDirtyElements: Map<NodeKey, IntentionallyMarkedAsDirtyElement>;
let activeDirtyLeaves: Set<NodeKey>;
let activePrevNodeMap: NodeMap;
let activePrevEditorState: EditorState;
let activeNextNodeMap: NodeMap;
let activePrevKeyToDOMMap: Map<NodeKey, HTMLElement & LexicalPrivateDOM>;
let activeDirtyChildrenByParent: Map<NodeKey, Set<NodeKey>>;
let mutatedNodes: MutatedNodes;
let activeEditorDOMRenderConfig: EditorDOMRenderConfig;

function $destroyNode(key: NodeKey, parentDOM: null | HTMLElement): void {
  const node = activePrevNodeMap.get(key);
  // A node "moved" across parents in the same transaction still exists in
  // the next node map. We only detach its DOM from the old parent here;
  // the new parent's $createNode call will reuse it. Skip child destruction
  // and mutation marking — $reconcileNode will mark it 'updated' instead.
  const isMoved = activeNextNodeMap.has(key);

  if (parentDOM !== null) {
    const dom = getPrevElementByKeyOrThrow(key);
    if (dom.parentNode === parentDOM) {
      parentDOM.removeChild(dom);
    }
  }

  if (isMoved) {
    return;
  }

  // This logic is really important, otherwise we will leak DOM nodes
  // when their corresponding LexicalNodes are removed from the editor state.
  activeEditor._keyToDOMMap.delete(key);

  if ($isElementNode(node)) {
    const children = $createChildrenArray(node, activePrevNodeMap);
    $destroyChildren(children, 0, children.length - 1, null);
  }

  // Slots are a separate channel from the linked-list children, so the
  // recursion above never reaches them. Destroy each slot subtree too —
  // otherwise its _keyToDOMMap entries leak and no 'destroyed' mutation fires
  // for slot nodes. Resolve the container before destroying the subtree (the
  // key is gone from the DOM map after). A decorator host's container is
  // detached (relocated into the decorate() chrome) so remove it explicitly;
  // an element host's container sits inside the host DOM already being removed,
  // where remove() is a harmless no-op on a detached parent.
  if (node !== undefined) {
    for (const slotKey of $readSlots(node).values()) {
      const container = $slotContainerForKey(slotKey);
      $destroyNode(slotKey, null);
      if (container !== null) {
        container.remove();
      }
    }
    setMutatedNode(
      mutatedNodes,
      activeEditorNodes,
      activeMutationListeners,
      node,
      'destroyed',
    );
  }
}

function $destroyChildren(
  children: NodeKey[],
  _startIndex: number,
  endIndex: number,
  dom: null | HTMLElement,
): void {
  for (let startIndex = _startIndex; startIndex <= endIndex; ++startIndex) {
    const child = children[startIndex];

    if (child !== undefined) {
      $destroyNode(child, dom);
    }
  }
}

function setTextAlign(domStyle: CSSStyleDeclaration, value: string): void {
  domStyle.setProperty('text-align', value);
}

const DEFAULT_INDENT_VALUE = '40px';

function setElementIndent(dom: HTMLElement, indent: number): void {
  const indentClassName = activeEditorConfig.theme.indent;

  if (typeof indentClassName === 'string') {
    const elementHasClassName = dom.classList.contains(indentClassName);

    if (indent > 0 && !elementHasClassName) {
      dom.classList.add(indentClassName);
    } else if (indent < 1 && elementHasClassName) {
      dom.classList.remove(indentClassName);
    }
  }

  dom.style.setProperty(
    'padding-inline-start',
    indent === 0
      ? ''
      : `calc(${indent} * var(--lexical-indent-base-value, ${DEFAULT_INDENT_VALUE}))`,
  );
}

function setElementFormat(dom: HTMLElement, format: number): void {
  const domStyle = dom.style;

  if (format === 0) {
    setTextAlign(domStyle, '');
  } else if (format === IS_ALIGN_LEFT) {
    setTextAlign(domStyle, 'left');
  } else if (format === IS_ALIGN_CENTER) {
    setTextAlign(domStyle, 'center');
  } else if (format === IS_ALIGN_RIGHT) {
    setTextAlign(domStyle, 'right');
  } else if (format === IS_ALIGN_JUSTIFY) {
    setTextAlign(domStyle, 'justify');
  } else if (format === IS_ALIGN_START) {
    setTextAlign(domStyle, 'start');
  } else if (format === IS_ALIGN_END) {
    setTextAlign(domStyle, 'end');
  }
}

export function $getReconciledDirection(
  node: ElementNode,
): 'ltr' | 'rtl' | 'auto' | null {
  const direction = node.__dir;
  if (direction !== null) {
    return direction;
  }
  if ($isRootNode(node)) {
    return null;
  }
  const parent = node.getParent();
  if (parent === null) {
    // A slotted node has no parent (its up-pointer is __slotHost); it is
    // the root of an isolated slot subtree, so it behaves like a
    // top-level block and bidi-auto-detects, matching the root-child
    // case below. In non-slot trees every non-root element has a parent,
    // so this branch is unreachable and behavior is unchanged.
    return 'auto';
  }
  if (!$isRootOrShadowRoot(parent) || parent.__dir !== null) {
    return null;
  }
  return 'auto';
}

function $setElementDirection(dom: HTMLElement, node: ElementNode): void {
  const direction = $getReconciledDirection(node);
  if (direction !== null) {
    dom.dir = direction;
  } else {
    dom.removeAttribute('dir');
  }
}

// @experimental named-slots. Slots are a separate channel from the
// linked-list children: each slot subtree renders into its own
// non-keyed container, and its text is concatenated with no separator to
// match `ElementNode.getTextContent`. Containers are synchronous hidden
// placeholders: they mount slots-first in the host DOM with
// `display: 'none'` so every slot subtree is always rendered and part of
// the document, but nothing is visible until the host explicitly attaches
// the container somewhere with `mountSlotContainer` (directly or through
// lexical-react's `useLexicalSlotRef`), which reveals it — mirroring how
// `getDOMSlot` gives an element control over where its linked-list children
// render. Only the wrapper is
// scaffolding; the slot subtree inside carries its own NodeKey and
// reconciles normally.
// Leaves `subTreeTextContent` unchanged (restored on exit); the caller folds
// the returned text in slots-first.
// @experimental named-slots. Build a hidden slot placeholder element (DOM only,
// no Lexical state), shared by the mount and reconcile paths so the two never
// drift. The container is left unattached — the caller inserts it (appended on a
// fresh mount, slots-first on reconcile) — and starts `display: none`, revealed
// only by an explicit mount / $getSlotTargetElement. Editability is applied
// separately by $applySlotEditable.
function $createSlotDOM(name: string): HTMLElement {
  const container = $getDocument().createElement('div');
  container.setAttribute('data-lexical-slot', name);
  container.style.display = 'none';
  return container;
}

// Apply a slot container's editability. Re-run on every (re)mount — including
// the reconcile-reuse path — so a reused container can never keep a stale value.
// Inside a non-editable host (a decorator, or an element shell that wraps
// editable islands in chrome) the container is an island that would not track
// the editor on its own, so it carries an explicit `contentEditable` following
// the editor via `$markSlotEditable`; re-applying on every reconcile is what
// carries an editable toggle (a `$fullReconcile`) into the DOM. Otherwise the
// host is editable and the container inherits, so any stale `contentEditable`
// from a previous host state is cleared.
function $applySlotEditable(
  hostDom: HTMLElement,
  decoratorHost: boolean,
  container: HTMLElement,
): void {
  if (decoratorHost || hostDom.contentEditable === 'false') {
    $markSlotEditable(container, activeEditor);
  } else {
    container.removeAttribute('contenteditable');
  }
}

function $mountSlotChildren(
  node: LexicalNode,
  hostDom: HTMLElement,
  slots: ReadonlyMap<string, NodeKey>,
): string {
  const previousSubTreeTextContent = subTreeTextContent;
  const outerSaved = $beginCaptureGuard();
  subTreeTextContent = '';
  let totalText = '';
  const decoratorHost = $isDecoratorNode(node);
  for (const [name, slotKey] of slots) {
    const container = $createSlotDOM(name);
    $applySlotEditable(hostDom, decoratorHost, container);
    hostDom.appendChild(container);
    subTreeTextContent = '';
    const saved = $beginCaptureGuard();
    $createNode(slotKey, $getDOMSlot(node, container, activeEditor));
    $endCaptureGuard(saved);
    $applySlotTarget(node, name, hostDom, container);
    totalText += subTreeTextContent;
  }
  $endCaptureGuard(outerSaved);
  subTreeTextContent = previousSubTreeTextContent;
  return totalText;
}

function $readSlots(node: LexicalNode): ReadonlyMap<string, NodeKey> {
  return $isSlotHost(node) && node.__slots !== null
    ? node.__slots
    : EMPTY_SLOTS;
}

// @experimental named-slots. Synchronous in-lexical slot attachment: a host
// with a `$getSlotTargetElement` render-config override has the reconciler
// attach and reveal the container in the same commit that (re)mounts it —
// no listener or framework hop. A null target (the default) leaves placement
// to explicit imperative mounting (mountSlotContainer / useLexicalSlotRef).
function $applySlotTarget(
  node: LexicalNode,
  name: string,
  hostDom: HTMLElement,
  container: HTMLElement,
): void {
  const target = activeEditorDOMRenderConfig.$getSlotTargetElement(
    node,
    name,
    hostDom,
    activeEditor,
  );
  if (target !== null) {
    if (container.parentElement !== target) {
      target.appendChild(container);
    }
    container.style.display = '';
  }
}

// @experimental named-slots. A slot value's DOM is mounted directly inside its
// own `[data-lexical-slot]` container, so the container is that DOM's parent.
// Resolving by the slotted key (rather than scanning the host's direct children
// by name) survives the container being relocated out of the host — e.g. a
// decorator host that moves its slot containers into its decorate() chrome — and
// can't match a slot subtree's own nested slot container.
function $slotContainerForKey(slotKey: NodeKey): HTMLElement | null {
  const slotDom = activePrevKeyToDOMMap.get(slotKey);
  return slotDom !== undefined ? slotDom.parentElement : null;
}

// @experimental named-slots. Reconcile mirror of `$mountSlotChildren`.
// Slot containers already sit slots-first in the host DOM from the create
// path, so reconciling each in place keeps DOM order. Same name + key →
// reconcile in place; same name + new key → destroy old subtree, mount the
// new one into the existing container; removed name → destroy + drop its
// container; new name → mount a fresh container before the first non-slot
// child so a slot added after the host's initial render stays slots-first.
// Containers are resolved via `$slotContainerForKey` (the slotted node's DOM
// parent). Like the mount helper this leaves `subTreeTextContent` unchanged and
// returns the concatenated slot text for the caller to fold in slots-first.
function $reconcileSlotChildren(
  prevNode: LexicalNode,
  nextNode: LexicalNode,
  hostDom: HTMLElement,
): string {
  const prevSlots = $readSlots(prevNode);
  const nextSlots = $readSlots(nextNode);
  for (const [name, prevSlotKey] of prevSlots) {
    if (!nextSlots.has(name)) {
      const staleContainer = $slotContainerForKey(prevSlotKey);
      $destroyNode(prevSlotKey, null);
      if (staleContainer !== null) {
        staleContainer.remove();
      }
    }
  }
  const previousSubTreeTextContent = subTreeTextContent;
  const outerSaved = $beginCaptureGuard();
  let totalText = '';
  let prevContainer: Element | null = null;
  const decoratorHost = $isDecoratorNode(nextNode);
  for (const [name, nextSlotKey] of nextSlots) {
    const prevSlotKey = prevSlots.get(name);
    let container =
      prevSlotKey !== undefined ? $slotContainerForKey(prevSlotKey) : null;
    subTreeTextContent = '';
    const saved = $beginCaptureGuard();
    if (container === null) {
      container = $createSlotDOM(name);
      // Keep the hidden placeholder slots-first: it must land ahead of the
      // linked-list children (and the terminating <br>) so the leading
      // DOMSlot boundary can skip it; it must not be appended after them.
      // Insert before the first non-slot child; earlier slot containers are
      // skipped, so several slots added in one update preserve their Map
      // order at the front.
      let firstNonSlot: Element | null = null;
      for (const child of hostDom.children) {
        if (!child.hasAttribute('data-lexical-slot')) {
          firstNonSlot = child;
          break;
        }
      }
      hostDom.insertBefore(container, firstNonSlot);
      $createNode(nextSlotKey, $getDOMSlot(nextNode, container, activeEditor));
    } else if (prevSlotKey === nextSlotKey) {
      $reconcileNode(nextSlotKey, container);
    } else {
      // Reusing the container, so the old subtree's DOM must be detached
      // from it (pass the container as parentDOM) before mounting the new
      // one; otherwise both render side by side.
      if (prevSlotKey !== undefined) {
        $destroyNode(prevSlotKey, container);
      }
      $createNode(nextSlotKey, $getDOMSlot(nextNode, container, activeEditor));
    }
    $endCaptureGuard(saved);
    $applySlotEditable(hostDom, decoratorHost, container);
    $applySlotTarget(nextNode, name, hostDom, container);
    totalText += subTreeTextContent;
    // Keep placeholder DOM order in sync with the slot Map order. A reused
    // container stays where it was first mounted, so a remove + re-add of an
    // existing name (which moves it to the Map's tail) would otherwise leave
    // its container stranded at its old DOM position, diverging from the model
    // order that getSlotNames / the text fold / the exporters all read. Anchor
    // each container right after the previous slot's (the first at the very
    // front), staying slots-first ahead of the linked-list children. Only
    // placeholders still parked in the host DOM are anchored: a container the
    // host explicitly attached elsewhere (mountSlotContainer / useLexicalSlotRef)
    // is owned by that mount and re-parenting it here would yank it back.
    if (container.parentElement === hostDom) {
      const anchor: ChildNode | null =
        prevContainer === null ? hostDom.firstChild : prevContainer.nextSibling;
      if (anchor !== container) {
        hostDom.insertBefore(container, anchor);
      }
      prevContainer = container;
    }
  }
  $endCaptureGuard(outerSaved);
  subTreeTextContent = previousSubTreeTextContent;
  return totalText;
}

function $createNode(key: NodeKey, slot: DOMSlot | null): HTMLElement {
  const node = activeNextNodeMap.get(key);

  if (node === undefined) {
    invariant(false, 'createNode: node does not exist in nodeMap');
  }

  // Cross-parent move: the same key existed in the previous tree under a
  // different parent. Reuse the existing DOM so React decorator portals,
  // contentEditable focus, etc. survive the reparenting. Without this the
  // DecoratorNode's wrapper is recreated and React unmounts/remounts the
  // child component (visible as a 1-frame flicker in Safari).
  // Requires a slot so $reconcileNode has a valid parentDOM in case the
  // moved node also reports updateDOM=true and needs an in-place replace.
  // Two move shapes route here:
  //   - model move: cross-parent (linked-list children) or cross-slot-host
  //     (a slot value moved between hosts in one update; both nodes have
  //     __parent === null, so cross-host is detected via __slotHost).
  //   - DOM move (slot children only): a host's wrapper was recreated
  //     (updateDOM=true) and its slot children's existing DOM is no longer
  //     under the new slot container. Limited to slot children because a
  //     regular child whose wrapper parent was recreated should re-render
  //     through its type-derived createDOM (list item attributes, etc.),
  //     not reuse a stale wrapper.
  if (slot !== null) {
    const prevNode = activePrevNodeMap.get(key);
    if (prevNode !== undefined) {
      const existingDOM = activePrevKeyToDOMMap.get(key);
      if (existingDOM !== undefined) {
        const prevSlotHost = $isSlotChild(prevNode)
          ? prevNode.__slotHost
          : null;
        const nextSlotHost = $isSlotChild(node) ? node.__slotHost : null;
        const modelMoved =
          prevNode.__parent !== node.__parent || prevSlotHost !== nextSlotHost;
        const slotChildDomDetached =
          nextSlotHost !== null && existingDOM.parentElement !== slot.element;
        if (modelMoved || slotChildDomDetached) {
          slot.insertChild(existingDOM);
          return $reconcileNode(key, slot.element);
        }
      }
    }
  }

  const dom: HTMLElement & LexicalPrivateDOM =
    activeEditorDOMRenderConfig.$createDOM(node, activeEditor);

  storeDOMWithKey(key, dom, activeEditor);

  // This helps preserve the text, and stops spell check tools from
  // merging or break the spans (which happens if they are missing
  // this attribute).
  if ($isTextNode(node)) {
    dom.setAttribute('data-lexical-text', 'true');
  } else if ($isDecoratorNode(node)) {
    dom.setAttribute('data-lexical-decorator', 'true');
    // DecoratorNode DOM is selection-captured: window selection inside
    // a decorator subtree (e.g. an embedded input) is owned by the
    // decorator, not by Lexical's caret management. Marking it via
    // setDOMUnmanaged unifies the decorator case with extension-owned
    // unmanaged subtrees so callers only need isDOMCapturingSelection /
    // isDOMUnmanaged.
    setDOMUnmanaged(dom, {captureSelection: true});
  }

  if ($isElementNode(node)) {
    const indent = node.__indent;
    const childrenSize = node.__size;
    $setElementDirection(dom, node);
    if (indent !== 0) {
      setElementIndent(dom, indent);
    }
    // @experimental named-slots. Slots render slots-first, ahead of the
    // linked-list children, each into its own container nested in the
    // host DOM. Their text folds into the host's cache ahead of the
    // child text to match `ElementNode.getTextContent`. The slots'
    // first-text key is deliberately kept out of __lexicalFirstTextKey,
    // which feeds children-only navigation / selection.
    const slots = $readSlots(node);
    const slotTextContent =
      slots.size > 0 ? $mountSlotChildren(node, dom, slots) : '';
    if (childrenSize === 0) {
      // Empty element: $createChildren's cache write is skipped, so set
      // the cache explicitly on the keyed DOM. Symmetric with the
      // (keyed-DOM) writes in $createChildren / $reconcileChildren.
      dom.__lexicalTextContent = slotTextContent;
      dom.__lexicalFirstTextKey = null;
      subTreeTextContent += slotTextContent;
      if (slots.size > 0) {
        dom.__lexicalSlotTextLength = slotTextContent.length;
      }
    } else {
      const outerBefore = subTreeTextContent;
      const endIndex = childrenSize - 1;
      const children = $createChildrenArray(node, activeNextNodeMap);
      $createChildren(
        children,
        node,
        0,
        endIndex,
        $getDOMSlot(node, dom, activeEditor),
      );
      // $createChildren set dom.__lexicalTextContent to the child-only
      // text and subTreeTextContent to outerBefore + childText. Rebuild
      // both slots-first (slot text precedes child text) so the host's
      // contribution to the parent accumulator stays in document order.
      // __lexicalFirstTextKey is left as the children's — slots stay out
      // of navigation / selection.
      if (slotTextContent !== '') {
        const childText = dom.__lexicalTextContent || '';
        dom.__lexicalTextContent = slotTextContent + childText;
        subTreeTextContent = outerBefore + slotTextContent + childText;
      }
      if (slots.size > 0) {
        dom.__lexicalSlotTextLength = slotTextContent.length;
      }
    }

    const format = node.__format;

    if (format !== 0) {
      setElementFormat(dom, format);
    }
    if (!node.isInline()) {
      $reconcileElementTerminatingLineBreak(null, node, dom);
      $reconcileDecoratorBoundaryAnchors(node, dom);
    }
  } else {
    const text = node.getTextContent();

    if ($isDecoratorNode(node)) {
      const decorator = node.decorate(activeEditor, activeEditorConfig);

      if (decorator !== null) {
        reconcileDecorator(key, decorator);
      }
      // Decorators are always non editable
      dom.contentEditable = 'false';
      // @experimental named-slots. A decorator can host editable slots; each
      // mounts into its own detached contentEditable container that the
      // lexical-react component relocates into the decorate() chrome. The slot
      // text is already folded into `text` by getTextContent
      // ($getSlotsTextContent), so this mount is render-only —
      // $mountSlotChildren preserves subTreeTextContent.
      const slots = $readSlots(node);
      if (slots.size > 0) {
        $mountSlotChildren(node, dom, slots);
      }
    }
    subTreeTextContent += text;
  }

  if (slot !== null) {
    slot.insertChild(dom);
  }

  activeEditorDOMRenderConfig.$decorateDOM(node, null, dom, activeEditor);

  // Same cached-text-size invariant as $reconcileNode — every node leaving
  // a reconciler entry point in the next state carries a current label.
  $setCachedTextSize(node);
  if (__DEV__) {
    // Freeze the node in DEV to prevent accidental mutations
    Object.freeze(node);
  }

  setMutatedNode(
    mutatedNodes,
    activeEditorNodes,
    activeMutationListeners,
    node,
    'created',
  );
  return dom;
}

function $createChildren(
  children: NodeKey[],
  element: ElementNode,
  _startIndex: number,
  endIndex: number,
  slot: ElementDOMSlot,
): void {
  // Save outer scope and reset module state so this walk's
  // `dom.__lexicalFirstTextKey` write only reflects descendants captured
  // here, not a leaked first-text key from an earlier sibling's outer
  // walk. Mirrors what `$reconcileChildrenWithDirection` does at entry.
  const previousSubTreeTextContent = subTreeTextContent;
  const outerSaved = $beginCaptureGuard();
  subTreeTextContent = '';
  subTreeTextFormat = null;
  subTreeTextStyle = null;
  subTreeFirstTextKey = null;
  let startIndex = _startIndex;

  for (; startIndex <= endIndex; ++startIndex) {
    const saved = $beginCaptureGuard();
    $createNode(children[startIndex], slot);
    const node = activeNextNodeMap.get(children[startIndex]);
    if (node !== null && $isTextNode(node)) {
      if (subTreeTextFormat === null) {
        subTreeTextFormat = node.getFormat();
        subTreeTextStyle = node.getStyle();
        subTreeFirstTextKey = node.__key;
      }
    } else if (
      // inline $textContentRequiresDoubleLinebreakAtEnd
      $isElementNode(node) &&
      startIndex < endIndex &&
      !node.isInline()
    ) {
      subTreeTextContent += DOUBLE_LINE_BREAK;
    }
    $endCaptureGuard(saved);
  }
  // Cache lives on the keyed DOM (outer wrapper) for wrapping elements;
  // identical to `slot.element` otherwise. Look up rather than thread a
  // parameter — the element's DOM is already in the map via
  // `storeDOMWithKey` by the time we get here.
  const cacheDom = activeEditor._keyToDOMMap.get(element.__key);
  invariant(
    cacheDom !== undefined,
    '$createChildren: Element with key %s missing from keyToDOMMap',
    element.__key,
  );
  cacheDom.__lexicalTextContent = subTreeTextContent;
  cacheDom.__lexicalFirstTextKey = subTreeFirstTextKey;
  subTreeTextContent = previousSubTreeTextContent + subTreeTextContent;
  // Outer-scope leftmost-wins: if the caller already had a first text
  // captured, restore it. Otherwise leave this walk's first-text in the
  // module state so the caller's outer walk picks it up.
  $endCaptureGuard(outerSaved);
}

type LastChildState = 'line-break' | 'decorator' | 'empty';
function $isLastChildLineBreakOrDecorator(
  element: null | ElementNode,
  nodeMap: NodeMap,
): null | LastChildState {
  if (element) {
    const lastKey = element.__last;
    if (lastKey) {
      const node = nodeMap.get(lastKey);
      if (node) {
        return $isLineBreakNode(node)
          ? 'line-break'
          : $isDecoratorNode(node) && node.isInline()
            ? 'decorator'
            : null;
      }
    }
    // A host with slots but no linked-list children is not empty (the slots
    // carry its content). The 'empty' line break exists to give a truly empty
    // block a caret target; on a slots-only host that <br> would instead be a
    // stray caret target in the host's own child area, after the slot
    // containers — text typed there leaks out of the slot. Skip it.
    return $readSlots(element).size > 0 ? null : 'empty';
  }
  return null;
}

function $isBlockDecoratorChild(
  key: null | NodeKey,
  nodeMap: NodeMap,
): boolean {
  if (!key) {
    return false;
  }
  const node = nodeMap.get(key);
  return $isDecoratorNode(node) && !node.isInline();
}

/**
 * Browsers drop the selection highlight for the whole document when a range
 * endpoint lands on an element boundary that is immediately adjacent to a
 * block-level `contenteditable=false` child — e.g. select-all in a document
 * whose first or last block is a DecoratorNode (#8922). Keep a zero-size
 * out-of-flow anchor parked outside each such boundary child so the browser has
 * an editable inline box to resolve the boundary position against. Interior
 * decorators are unaffected, so only the first / last child is considered.
 */
function $reconcileDecoratorBoundaryAnchors(
  nextElement: ElementNode,
  dom: HTMLElement & LexicalPrivateDOM,
): void {
  const slot = $getDOMSlot(nextElement, dom, activeEditor);
  slot.setDecoratorBoundaryAnchor(
    'leading',
    $isBlockDecoratorChild(nextElement.__first, activeNextNodeMap),
  );
  slot.setDecoratorBoundaryAnchor(
    'trailing',
    $isBlockDecoratorChild(nextElement.__last, activeNextNodeMap),
  );
}

// If we end an element with a LineBreakNode, then we need to add an additional <br>
function $reconcileElementTerminatingLineBreak(
  prevElement: null | ElementNode,
  nextElement: ElementNode,
  dom: HTMLElement & LexicalPrivateDOM,
): void {
  // Read previous render's last-child kind from the slot element's cache
  // so the prev-state DecoratorNode reference's isInline() (which routes
  // through getLatest() and would throw once the key is detached from the
  // active node map) is never called.
  const slot = $getDOMSlot(nextElement, dom, activeEditor);
  const slotElement: HTMLElement & LexicalPrivateDOM = slot.element;
  const prevLineBreak = slotElement.__lexicalLastChildKind ?? null;
  const nextLineBreak = $isLastChildLineBreakOrDecorator(
    nextElement,
    activeNextNodeMap,
  );
  if (prevLineBreak !== nextLineBreak) {
    slot.setManagedLineBreak(nextLineBreak);
  }
}

function reconcileTextFormat(element: ElementNode): void {
  if (
    subTreeTextFormat != null &&
    subTreeTextFormat !== element.__textFormat &&
    !activeEditorStateReadOnly
  ) {
    element.setTextFormat(subTreeTextFormat);
  }
}

function reconcileTextStyle(element: ElementNode): void {
  if (
    subTreeTextStyle != null &&
    subTreeTextStyle !== element.__textStyle &&
    !activeEditorStateReadOnly
  ) {
    element.setTextStyle(subTreeTextStyle);
  }
}

function $reconcileChildrenWithDirection(
  prevElement: ElementNode,
  nextElement: ElementNode,
  dom: HTMLElement,
): void {
  subTreeTextFormat = null;
  subTreeTextStyle = null;
  subTreeFirstTextKey = null;
  $reconcileChildren(
    prevElement,
    nextElement,
    $getDOMSlot(nextElement, dom, activeEditor),
  );
  if (!$isRootOrShadowRoot(nextElement)) {
    // RootNode / ShadowRootNode never expose `__textFormat` / `__textStyle`
    // to user code: `LexicalElementNode.exportJSON` excludes them (#7968)
    // and selection inheritance only reads element format/style for
    // empty-element anchors gated on `!isRootTextContentEmpty`. Skipping
    // reconcile here keeps the invariant aligned and sidesteps the
    // suffix-fast-path's stale-format edge case at the root level.
    reconcileTextFormat(nextElement);
    reconcileTextStyle(nextElement);
  }
}

function $buildDirtyChildrenByParent(): Map<NodeKey, Set<NodeKey>> {
  const map = new Map<NodeKey, Set<NodeKey>>();
  const addKeysToMap = (keys: Iterable<NodeKey>): void => {
    for (const key of keys) {
      const node = activeNextNodeMap.get(key);
      if (node === undefined) {
        continue;
      }
      const parentKey = node.__parent;
      if (parentKey === null) {
        continue;
      }
      let set = map.get(parentKey);
      if (set === undefined) {
        set = new Set();
        map.set(parentKey, set);
      }
      set.add(key);
    }
  };
  addKeysToMap(activeDirtyElements.keys());
  addKeysToMap(activeDirtyLeaves);
  return map;
}

// Returns the key of the first child in the K-element suffix if all dirty
// children form a contiguous suffix of `parent` (and 0 < K < total children).
// Returns null otherwise — caller falls back to the full-walk fast path.
function $suffixStartIfContiguous(
  parent: ElementNode,
  dirty: Set<NodeKey>,
): NodeKey | null {
  const k = dirty.size;
  if (k === 0 || k >= parent.__size) {
    return null;
  }
  let cur: NodeKey | null = parent.__last;
  let suffixStart: NodeKey | null = null;
  let i = 0;
  while (cur !== null && i < k) {
    if (!dirty.has(cur)) {
      return null;
    }
    suffixStart = cur;
    const node = activeNextNodeMap.get(cur);
    if (node === undefined) {
      return null;
    }
    cur = node.__prev;
    i++;
  }
  if (i !== k) {
    return null;
  }
  // The element immediately before the suffix must be non-dirty
  // (cur === null is excluded by the k < parent.__size check above).
  if (cur !== null && dirty.has(cur)) {
    return null;
  }
  return suffixStart;
}

// Suffix-incremental fast path for ±1 children-size mutations.
// Two structural patterns are supported (others bail to the general path):
//   - sizeDelta=+1, K=2: append at end, or end-split where one node
//     becomes two. Last 2 children of `nextElement` are dirty; one prev
//     child corresponds.
//   - sizeDelta=-1, K=1: boundary-collapse (e.g. backspace at the start
//     of a block merging into the previous). Last 1 child of `nextElement`
//     is dirty; two prev children correspond.
// (The same-size sizeDelta=0 case is inlined in `$reconcileChildren` and
// uses the same splice math with a simpler suffix walk.)
//
// Returns true if the cache was spliced and DOM mutated; false on bail
// (K mismatch, boundary mismatch, or out-of-order suffix overlap), in
// which case the caller falls through to `$reconcileNodeChildren`.
function $tryReconcileSuffixWithSizeDelta(
  prevElement: ElementNode,
  nextElement: ElementNode,
  slot: ElementDOMSlot,
  cacheDom: HTMLElement & LexicalPrivateDOM,
  cachedParentText: string,
  suffixStartKey: NodeKey,
  k: number,
  sizeDelta: number,
): boolean {
  // `slot.element` is the inner DOM where children live and where DOM
  // operations (replaceChild / removeChild / insertBefore) must target;
  // `cacheDom` is the outer keyed DOM that holds the parent's text-content
  // cache. For non-wrapping ElementNodes they're the same element; for
  // wrapping nodes (e.g. TableNode with a scrollable wrapper) they differ
  // and routing each role to the right element matters for correctness.
  // Caller invariant: this helper only handles ±1 children-size mutations.
  // Bailing on anything else preserves defense-in-depth in case the
  // upstream gate ever loosens.
  if (sizeDelta !== 1 && sizeDelta !== -1) {
    return false;
  }
  // Only the two patterns above are supported; e.g. K=3 dirty after a
  // split-into-three, or K=1 with sizeDelta=+1 (pure append with no
  // sibling cloned for `__next` link), all bail.
  const expectedK = sizeDelta === 1 ? 2 : 1;
  if (k !== expectedK) {
    return false;
  }
  // K' = K − sizeDelta: delta=+1, K=2 → K'=1; delta=-1, K=1 → K'=2.
  const kPrime = k - sizeDelta;
  let prevSuffixStartKey: NodeKey | null = prevElement.__last;
  for (let i = 0; i < kPrime - 1; i++) {
    if (prevSuffixStartKey === null) {
      return false;
    }
    const node = activePrevNodeMap.get(prevSuffixStartKey);
    if (node === undefined) {
      return false;
    }
    prevSuffixStartKey = node.__prev;
  }
  if (prevSuffixStartKey === null) {
    return false;
  }
  const nextStartNode = activeNextNodeMap.get(suffixStartKey);
  const prevStartNode = activePrevNodeMap.get(prevSuffixStartKey);
  if (nextStartNode === undefined || prevStartNode === undefined) {
    return false;
  }
  // Boundary identity: the node immediately before the suffix in next must
  // match the corresponding node in prev. Both null (suffix starts at first
  // child) is a match too.
  if (nextStartNode.__prev !== prevStartNode.__prev) {
    return false;
  }
  const nextSuffixKeys: NodeKey[] = [];
  let cur: NodeKey | null = suffixStartKey;
  for (let i = 0; i < k; i++) {
    if (cur === null) {
      return false;
    }
    nextSuffixKeys.push(cur);
    const node = activeNextNodeMap.get(cur);
    cur = node ? node.__next : null;
  }
  const prevSuffixKeys: NodeKey[] = [];
  cur = prevSuffixStartKey;
  for (let i = 0; i < kPrime; i++) {
    if (cur === null) {
      return false;
    }
    prevSuffixKeys.push(cur);
    const node = activePrevNodeMap.get(cur);
    cur = node ? node.__next : null;
  }
  // Two-pointer walk to validate ordering and plan ops in next-order.
  // Bail if a key is in both suffixes but at different positions (reorder).
  const prevSet = new Set(prevSuffixKeys);
  const nextSet = new Set(nextSuffixKeys);
  type SuffixOp =
    | {kind: 'reconcile'; key: NodeKey}
    | {kind: 'create'; key: NodeKey; nextIndex: number}
    | {kind: 'destroy'; key: NodeKey};
  const ops: SuffixOp[] = [];
  let pi = 0;
  let ni = 0;
  while (pi < kPrime && ni < k) {
    if (nextSuffixKeys[ni] === prevSuffixKeys[pi]) {
      ops.push({key: nextSuffixKeys[ni], kind: 'reconcile'});
      pi++;
      ni++;
    } else if (!nextSet.has(prevSuffixKeys[pi])) {
      ops.push({key: prevSuffixKeys[pi], kind: 'destroy'});
      pi++;
    } else if (!prevSet.has(nextSuffixKeys[ni])) {
      ops.push({key: nextSuffixKeys[ni], kind: 'create', nextIndex: ni});
      ni++;
    } else {
      return false;
    }
  }
  while (pi < kPrime) {
    ops.push({key: prevSuffixKeys[pi++], kind: 'destroy'});
  }
  while (ni < k) {
    ops.push({key: nextSuffixKeys[ni], kind: 'create', nextIndex: ni});
    ni++;
  }
  // `prevSuffixKeys` was built above by walking the prev map from
  // `prevSuffixStartKey`, so every key is present there and the helper
  // reproduces the same `kPrime`-length traversal.
  const oldSuffixLength = $prevSuffixTextSize(prevSuffixStartKey, kPrime);
  for (const op of ops) {
    const saved = $beginCaptureGuard();
    if (op.kind === 'reconcile') {
      $reconcileNode(op.key, slot.element);
    } else if (op.kind === 'destroy') {
      $destroyNode(op.key, slot.element);
    } else {
      let beforeDOM: Node | null = null;
      for (let j = op.nextIndex + 1; j < k; j++) {
        const siblingDOM = activeEditor._keyToDOMMap.get(nextSuffixKeys[j]);
        if (siblingDOM !== undefined) {
          beforeDOM = siblingDOM;
          break;
        }
      }
      // No lexical sibling found: insertion goes at the end of the lexical
      // range, which is still bounded by `slot.before` for slots carrying a
      // trailing non-lexical decoration (e.g. a drag handle pinned as the
      // last DOM child of the parent). Falling back to `slot.before` keeps
      // those decorations behind the new child.
      $createNode(op.key, slot.withBefore(beforeDOM ?? slot.before));
    }
    if (op.kind !== 'destroy') {
      const opNode = activeNextNodeMap.get(op.key);
      if (opNode && $isTextNode(opNode) && subTreeTextFormat === null) {
        subTreeTextFormat = opNode.getFormat();
        subTreeTextStyle = opNode.getStyle();
        subTreeFirstTextKey = opNode.__key;
      }
    }
    $endCaptureGuard(saved);
  }
  let newSuffix = '';
  for (let i = 0; i < k; i++) {
    const node = activeNextNodeMap.get(nextSuffixKeys[i]);
    if (node === undefined) {
      return false;
    }
    let text: string;
    if ($isElementNode(node)) {
      const childKeyedDom = activeEditor._keyToDOMMap.get(nextSuffixKeys[i]);
      const cached = childKeyedDom && childKeyedDom.__lexicalTextContent;
      invariant(
        typeof cached === 'string',
        'tryReconcileSuffixWithSizeDelta: missing __lexicalTextContent on child of type %s after suffix reconcile',
        node.getType(),
      );
      text = cached;
    } else {
      text = node.getTextContent();
    }
    newSuffix += text;
    if (i < k - 1 && $isElementNode(node) && !node.isInline()) {
      newSuffix += DOUBLE_LINE_BREAK;
    }
  }
  // @experimental named-slots. `cachedParentText` holds the host's combined
  // cache (slot text folded slots-first ahead of the child text). The suffix
  // we just rebuilt is child-only, so strip the slot prefix to recover the
  // child-only cache before splicing, and write child-only here — the slot
  // fold in `$reconcileNode` re-prepends the slot text. `slotLen` is `0` for
  // non-slot hosts, so the slice is a no-op and they splice unchanged.
  const slotLen = cacheDom.__lexicalSlotTextLength || 0;
  const prevChildText =
    slotLen > 0 ? cachedParentText.slice(slotLen) : cachedParentText;
  cacheDom.__lexicalTextContent =
    prevChildText.slice(0, prevChildText.length - oldSuffixLength) + newSuffix;
  return true;
}

/**
 * Decide whether the post-suffix-walk values of `subTreeTextFormat` /
 * `subTreeTextStyle` should be kept (the prefix has no text descendant
 * and the suffix carries the canonical first text) or replaced with the
 * prev-cycle's canonical values (the prefix is still authoritative).
 *
 * The cached `__lexicalFirstTextKey` on `dom` is the deep TextNode key
 * recorded when this element's children were last walked. We climb its
 * ancestor chain in next-state until we reach a direct child of
 * `nextElement`, then probe `dirtyChildren`: if that direct child is
 * dirty (or the cached key is missing from the next map), the cached
 * key has been moved into the suffix's subtree or destroyed, so the
 * suffix-derived values are authoritative. Otherwise the prefix is
 * canonical and we recover format/style from the live text node, which
 * lets `reconcileTextFormat` / `reconcileTextStyle` no-op via their
 * existing equality check against the parent's `__textFormat` /
 * `__textStyle`.
 *
 * Walk depth is bounded by tree depth from the text node to the
 * reconciled element (typically 1 — text directly under a paragraph).
 * Always refreshes the cache for the next cycle.
 */
function $resolveSuffixPathFormat(
  nextElement: ElementNode,
  dom: HTMLElement & LexicalPrivateDOM,
  dirtyChildren: Set<NodeKey>,
): void {
  const cachedFirstTextKey = dom.__lexicalFirstTextKey;
  if (cachedFirstTextKey != null) {
    const parentKey = nextElement.__key;
    let ancestor: NodeKey | null = cachedFirstTextKey;
    while (ancestor !== null) {
      const node = activeNextNodeMap.get(ancestor);
      if (node === undefined) {
        ancestor = null;
        break;
      }
      if (node.__parent === parentKey) {
        break;
      }
      ancestor = node.__parent;
    }
    if (ancestor !== null && !dirtyChildren.has(ancestor)) {
      const textNode = activeNextNodeMap.get(cachedFirstTextKey);
      if ($isTextNode(textNode)) {
        // Prefix carries the canonical first text descendant. Recover
        // format/style from the live next-state node — `reconcileTextFormat`
        // will compare against `nextElement.__textFormat` and no-op when
        // the prev cycle's value is still correct.
        subTreeTextFormat = textNode.getFormat();
        subTreeTextStyle = textNode.getStyle();
        // Cache key is unchanged this cycle.
        return;
      }
    }
  }
  // Either no prev text descendant, ancestor not found, or ancestor is
  // dirty. Keep the suffix-derived `subTreeTextFormat` / `subTreeTextStyle`
  // so reconcileTextFormat updates the parent (or no-ops on root /
  // shadow root via the gate). Refresh the cache to reflect this cycle's
  // first text descendant, recorded by the recursive suffix-child walks
  // into `subTreeFirstTextKey`.
  dom.__lexicalFirstTextKey = subTreeFirstTextKey;
}

function $reconcileChildren(
  prevElement: ElementNode,
  nextElement: ElementNode,
  slot: ElementDOMSlot,
): void {
  const previousSubTreeTextContent = subTreeTextContent;
  const prevChildrenSize = prevElement.__size;
  const nextChildrenSize = nextElement.__size;
  subTreeTextContent = '';
  // `dom` is `slot.element` (the inner DOM where children live and where
  // DOM operations target). `cacheDom` is the keyed DOM (outer wrapper
  // for nodes that wrap, identical to `dom` otherwise) and holds the
  // `__lexicalTextContent` / `__lexicalFirstTextKey` caches for this
  // element. Keeping them split lets wrapping nodes (TableNode etc.)
  // route cache R/W to the outer DOM while DOM ops stay on the slot.
  const dom: HTMLElement & LexicalPrivateDOM = slot.element;
  const cacheDom = activeEditor._keyToDOMMap.get(nextElement.__key);
  invariant(
    cacheDom !== undefined,
    '$reconcileChildren: Element with key %s missing from keyToDOMMap',
    nextElement.__key,
  );

  const sizeDelta = nextChildrenSize - prevChildrenSize;
  if (
    !__benchOnly.skipChildrenFastPath &&
    // A FULL_RECONCILE (e.g. `setEditorState`, which backs history
    // undo/redo) swaps the whole node map wholesale without routing
    // structural changes through `getWritable()`, so `_cloneNotNeeded`
    // is empty even when prev and next children differ by key. That
    // breaks the `sizeDelta === 0` walk below, which starts at
    // `prevElement.__first` but advances via the next map's `__next`
    // pointers — assuming both lists hold the same keys in the same
    // order. With a same-size key swap (undo replacing a CodeNode with
    // the paragraphs it came from) the walk reaches a next-only key and
    // `$reconcileNode` throws on the missing prev node (#8563). Dirty
    // tracking is meaningless in this mode anyway, so fall through to the
    // general key-diffing path.
    !treatAllNodesAsDirty &&
    Math.abs(sizeDelta) <= 1 &&
    prevChildrenSize >= MIN_FAST_PATH_CHILDREN &&
    prevElement.__first === nextElement.__first &&
    // For sizeDelta=0 the parent must not have been cloned this cycle —
    // any structural mutation routed through Lexical's mutation API
    // (insertBefore/insertAfter/replace/remove/append etc.) keeps the
    // parent in `_cloneNotNeeded` via `getWritable()`, so this single
    // check already covers a stale `__last` for those cases. Direct
    // pointer mutation that bypasses `getWritable()` is outside the
    // contract and not guarded against here. For sizeDelta=±1 the
    // parent is always cloned (its `__size` mutation goes through
    // `getWritable`), so the same check would dead-code that branch.
    (sizeDelta !== 0 || !activeEditor._cloneNotNeeded.has(prevElement.__key))
  ) {
    // Suffix-incremental fast path: when the dirty children form a
    // contiguous suffix and the parent already has a valid cached text,
    // splice the new suffix into the cache instead of walking every child.
    // The non-dirty prefix (and its DLB into the suffix) stays untouched,
    // so format/style propagation — which captures the first text descendant
    // — is unaffected.
    const cachedParentText = cacheDom.__lexicalTextContent;
    const dirtyChildren = activeDirtyChildrenByParent.get(prevElement.__key);
    if (
      !treatAllNodesAsDirty &&
      typeof cachedParentText === 'string' &&
      dirtyChildren !== undefined
    ) {
      const suffixStartKey = $suffixStartIfContiguous(
        nextElement,
        dirtyChildren,
      );
      if (suffixStartKey !== null) {
        const k = dirtyChildren.size;
        if (sizeDelta === 0) {
          // Same keys in the same order across prev and next (gated by
          // `prevElement.__first === nextElement.__first`, no clone), so the
          // prev-map walk visits exactly this suffix.
          const oldSuffixLength = $prevSuffixTextSize(suffixStartKey, k);
          let cur: NodeKey | null = suffixStartKey;
          let i = 0;
          while (cur !== null && i < k) {
            const node = activeNextNodeMap.get(cur);
            if (node === undefined) {
              break;
            }
            const saved = $beginCaptureGuard();
            $reconcileNode(cur, dom);
            if ($isTextNode(node) && subTreeTextFormat === null) {
              subTreeTextFormat = node.getFormat();
              subTreeTextStyle = node.getStyle();
              subTreeFirstTextKey = node.__key;
            }
            $endCaptureGuard(saved);
            cur = node.__next;
            i++;
          }

          let newSuffix = '';
          cur = suffixStartKey;
          i = 0;
          while (cur !== null && i < k) {
            const node = activeNextNodeMap.get(cur);
            if (node === undefined) {
              break;
            }
            let text: string;
            if ($isElementNode(node)) {
              // Read from the current keyed DOM map, not the prev snapshot.
              // The just-completed reconcile loop above can fire
              // `$reconcileNode`'s `parentDOM.replaceChild` branch when a
              // dirty child's `$updateDOM` returns true (e.g. `ListNode`
              // toggling `__tag` / `__listType`); the snapshot would still
              // point at the detached old DOM whose `__lexicalTextContent`
              // is from the previous cycle. Mirrors the size-delta helper
              // at L856.
              const childKeyedDom = activeEditor._keyToDOMMap.get(cur);
              const cached =
                childKeyedDom && childKeyedDom.__lexicalTextContent;
              invariant(
                typeof cached === 'string',
                'reconcileChildren same-size suffix: missing __lexicalTextContent on child of type %s after reconcile',
                node.getType(),
              );
              text = cached;
            } else {
              text = node.getTextContent();
            }
            newSuffix += text;
            if (i < k - 1 && $isElementNode(node) && !node.isInline()) {
              newSuffix += DOUBLE_LINE_BREAK;
            }
            cur = node.__next;
            i++;
          }

          // @experimental named-slots. Strip the slot prefix to recover the
          // child-only cache, splice the child suffix, and write child-only —
          // the slot fold in `$reconcileNode` re-prepends the slot text.
          // `slotLen` is `0` for non-slot hosts (slice is a no-op), so their
          // cache stays bit-identical and the fold leaves it untouched.
          const slotLen = cacheDom.__lexicalSlotTextLength || 0;
          const prevChildText =
            slotLen > 0 ? cachedParentText.slice(slotLen) : cachedParentText;
          const newChildText =
            prevChildText.slice(0, prevChildText.length - oldSuffixLength) +
            newSuffix;
          cacheDom.__lexicalTextContent = newChildText;
          subTreeTextContent = previousSubTreeTextContent + newChildText;
          // Recover the canonical first-text format/style for this parent.
          // If the prefix carries it, `reconcileTextFormat` no-ops via
          // equality. If the prefix has no text descendant, the
          // suffix-derived values stay and propagate correctly.
          $resolveSuffixPathFormat(nextElement, cacheDom, dirtyChildren);
          return;
        }
        if (
          $tryReconcileSuffixWithSizeDelta(
            prevElement,
            nextElement,
            slot,
            cacheDom,
            cachedParentText,
            suffixStartKey,
            k,
            sizeDelta,
          )
        ) {
          // Helper returns true only after writing cacheDom.__lexicalTextContent
          // (helper body's final line). Match the PR-wide strict-on-miss
          // policy rather than masking a future regression with `?? ''`.
          const newCachedText = cacheDom.__lexicalTextContent;
          invariant(
            typeof newCachedText === 'string',
            'reconcileChildren: $tryReconcileSuffixWithSizeDelta returned true without writing __lexicalTextContent',
          );
          subTreeTextContent = previousSubTreeTextContent + newCachedText;
          $resolveSuffixPathFormat(nextElement, cacheDom, dirtyChildren);
          return;
        }
        // Bail: helper rejected the size-delta candidate (K mismatch,
        // boundary mismatch, or out-of-order suffix overlap). Fall through
        // to the outer general path.
      }
    }

    if (sizeDelta === 0) {
      let nodeKey: NodeKey | null = prevElement.__first;
      let i = 0;
      while (nodeKey !== null) {
        const node = activeNextNodeMap.get(nodeKey);
        if (node === undefined) {
          break;
        }
        const isDirty =
          treatAllNodesAsDirty ||
          activeDirtyLeaves.has(nodeKey) ||
          activeDirtyElements.has(nodeKey);
        const saved = $beginCaptureGuard();
        if (isDirty) {
          $reconcileNode(nodeKey, dom);
        } else {
          // Subtree is structurally and content-clean — accumulate the
          // cached text from the existing DOM rather than walking back
          // through `$reconcileNode`.
          let text: string;
          let childKeyedDom: undefined | (HTMLElement & LexicalPrivateDOM);
          if ($isElementNode(node)) {
            childKeyedDom = activePrevKeyToDOMMap.get(nodeKey);
            const cached = childKeyedDom && childKeyedDom.__lexicalTextContent;
            invariant(
              typeof cached === 'string',
              'reconcileChildren structurally-clean walk: missing __lexicalTextContent on non-dirty child of type %s',
              node.getType(),
            );
            text = cached;
          } else {
            text = node.getTextContent();
          }
          subTreeTextContent += text;
          if (childKeyedDom !== undefined) {
            $bubbleChildFirstText(childKeyedDom);
          }
        }
        if ($isTextNode(node)) {
          if (subTreeTextFormat === null) {
            subTreeTextFormat = node.getFormat();
            subTreeTextStyle = node.getStyle();
            subTreeFirstTextKey = node.__key;
          }
        } else if (
          $isElementNode(node) &&
          i < nextChildrenSize - 1 &&
          !node.isInline()
        ) {
          subTreeTextContent += DOUBLE_LINE_BREAK;
        }
        $endCaptureGuard(saved);
        nodeKey = node.__next;
        i++;
      }
      cacheDom.__lexicalTextContent = subTreeTextContent;
      cacheDom.__lexicalFirstTextKey = subTreeFirstTextKey;
      subTreeTextContent = previousSubTreeTextContent + subTreeTextContent;
      return;
    }
    // sizeDelta !== 0 with no successful suffix-incremental path: fall
    // through to the outer general walk (`$reconcileNodeChildren`), which
    // handles arbitrary size changes.
  }

  if (prevChildrenSize === 1 && nextChildrenSize === 1) {
    const prevFirstChildKey: NodeKey = prevElement.__first!;
    const nextFirstChildKey: NodeKey = nextElement.__first!;
    if (prevFirstChildKey === nextFirstChildKey) {
      $reconcileNode(prevFirstChildKey, dom);
    } else {
      const lastDOM = getPrevElementByKeyOrThrow(prevFirstChildKey);
      const replacementDOM = $createNode(nextFirstChildKey, null);
      try {
        if (lastDOM.parentNode === dom) {
          dom.replaceChild(replacementDOM, lastDOM);
        } else {
          // lastDOM was reused as a descendant of replacementDOM (cross-parent
          // move, e.g. wrapping an image in a link). It's already detached
          // from `dom`, so just insert the replacement.
          slot.insertChild(replacementDOM);
        }
      } catch (error) {
        if (typeof error === 'object' && error != null) {
          const msg = `${error.toString()} Parent: ${
            dom.tagName
          }, new child: {tag: ${
            replacementDOM.tagName
          } key: ${nextFirstChildKey}}, old child: {tag: ${
            lastDOM.tagName
          }, key: ${prevFirstChildKey}}.`;
          throw new Error(msg);
        } else {
          throw error;
        }
      }
      $destroyNode(prevFirstChildKey, null);
    }
    const nextChildNode = activeNextNodeMap.get(nextFirstChildKey);
    if ($isTextNode(nextChildNode)) {
      if (subTreeTextFormat === null) {
        subTreeTextFormat = nextChildNode.getFormat();
        subTreeTextStyle = nextChildNode.getStyle();
        subTreeFirstTextKey = nextChildNode.__key;
      }
    }
  } else {
    const prevChildren = $createChildrenArray(prevElement, activePrevNodeMap);
    const nextChildren = $createChildrenArray(nextElement, activeNextNodeMap);
    invariant(
      prevChildren.length === prevChildrenSize,
      '$reconcileChildren: prevChildren.length !== prevChildrenSize',
    );
    invariant(
      nextChildren.length === nextChildrenSize,
      '$reconcileChildren: nextChildren.length !== nextChildrenSize',
    );

    if (prevChildrenSize === 0) {
      if (nextChildrenSize !== 0) {
        $createChildren(
          nextChildren,
          nextElement,
          0,
          nextChildrenSize - 1,
          slot,
        );
      }
    } else if (nextChildrenSize === 0) {
      if (prevChildrenSize !== 0) {
        const canUseFastPath =
          slot.after == null &&
          slot.before == null &&
          // Slot containers are prepended into this same DOM (slots-first), so
          // clearing it with `textContent = ''` would wipe them along with the
          // children. Fall back to the keyed slow path, which removes only the
          // child DOM nodes and leaves the slot containers intact.
          $readSlots(nextElement).size === 0 &&
          (slot.element as HTMLElement & LexicalPrivateDOM)
            .__lexicalLineBreak == null;
        $destroyChildren(
          prevChildren,
          0,
          prevChildrenSize - 1,
          canUseFastPath ? null : dom,
        );

        if (canUseFastPath) {
          // Fast path for removing DOM nodes
          dom.textContent = '';
        }
      }
    } else {
      $reconcileNodeChildren(
        nextElement,
        prevChildren,
        nextChildren,
        prevChildrenSize,
        nextChildrenSize,
        slot,
      );
    }
  }

  cacheDom.__lexicalTextContent = subTreeTextContent;
  cacheDom.__lexicalFirstTextKey = subTreeFirstTextKey;
  subTreeTextContent = previousSubTreeTextContent + subTreeTextContent;
}

function $reconcileNode(
  key: NodeKey,
  parentDOM: HTMLElement | null,
): HTMLElement {
  const prevNode = activePrevNodeMap.get(key);
  let nextNode = activeNextNodeMap.get(key);

  if (prevNode === undefined || nextNode === undefined) {
    invariant(
      false,
      'reconcileNode: prevNode or nextNode does not exist in nodeMap',
    );
  }

  const isDirty =
    treatAllNodesAsDirty ||
    activeDirtyLeaves.has(key) ||
    activeDirtyElements.has(key);
  const dom: HTMLElement & LexicalPrivateDOM = getElementByKeyOrThrow(
    activeEditor,
    key,
  );

  // If the node key points to the same instance in both states
  // and isn't dirty, we just update the text content cache
  // and return the existing DOM Node.
  if (prevNode === nextNode && !isDirty) {
    let text: string;
    if ($isElementNode(prevNode)) {
      const previousSubTreeTextContent = dom.__lexicalTextContent;
      // Strict invariant — every element reconciled in a previous cycle has
      // both `__lexicalTextContent` and `__lexicalFirstTextKey` set on its
      // keyed DOM by `$createNode` / `$reconcileChildren`. A missing cache
      // here would silently desync the parent text accumulation and pair
      // with `$bubbleChildFirstText`'s own strict invariant a line below,
      // so fail loudly here instead.
      invariant(
        typeof previousSubTreeTextContent === 'string',
        'reconcileNode: missing __lexicalTextContent on non-dirty element of type %s',
        prevNode.getType(),
      );
      text = previousSubTreeTextContent;
      // Bubble this clean element's cached first-text descendant up to the
      // caller's scope so a non-dirty prefix carrying the canonical first
      // text still wins over a later dirty sibling whose recursion would
      // otherwise clobber the module state.
      $bubbleChildFirstText(dom);
    } else {
      text = prevNode.getTextContent();
    }
    subTreeTextContent += text;

    return dom;
  }
  // If the node key doesn't point to the same instance in both maps,
  // it was cloned. If it's also dirty, we mark it as mutated.
  if (prevNode !== nextNode && isDirty) {
    setMutatedNode(
      mutatedNodes,
      activeEditorNodes,
      activeMutationListeners,
      nextNode,
      'updated',
    );
  }

  // Update node. If it returns true, we need to unmount and re-create the node
  if (
    activeEditorDOMRenderConfig.$updateDOM(
      nextNode,
      prevNode,
      dom,
      activeEditor,
    )
  ) {
    const replacementDOM = $createNode(key, null);

    if (parentDOM === null) {
      invariant(false, 'reconcileNode: parentDOM is null');
    }

    parentDOM.replaceChild(replacementDOM, dom);
    $destroyNode(key, null);
    return replacementDOM;
  }

  if ($isElementNode(prevNode)) {
    invariant(
      $isElementNode(nextNode),
      'Node with key %s changed from ElementNode to !ElementNode',
      key,
    );
    const nextIndent = nextNode.__indent;

    if (treatAllNodesAsDirty || nextIndent !== prevNode.__indent) {
      setElementIndent(dom, nextIndent);
    }

    const nextFormat = nextNode.__format;

    if (treatAllNodesAsDirty || nextFormat !== prevNode.__format) {
      setElementFormat(dom, nextFormat);
    }
    // @experimental named-slots reconcile. Slot edits dirty the host
    // through __slotHost propagation, so a clean host means its slots are
    // unchanged and the cache already holds their text — only diff when
    // dirty and the node has (or had) slots. Returns the slot text to fold
    // slots-first ahead of the child text in each dirty branch below.
    const slotTextContent =
      isDirty &&
      ($readSlots(nextNode).size > 0 || $readSlots(prevNode).size > 0)
        ? $reconcileSlotChildren(prevNode, nextNode, dom)
        : '';
    if (isDirty) {
      const outerBefore = subTreeTextContent;
      $reconcileChildrenWithDirection(prevNode, nextNode, dom);
      if (!nextNode.isInline()) {
        if (!$isRootNode(nextNode)) {
          $reconcileElementTerminatingLineBreak(prevNode, nextNode, dom);
        }
        // Unlike the terminating line break this applies to the root too — a
        // leading / trailing block decorator at the top level is exactly the
        // shape that breaks select-all.
        $reconcileDecoratorBoundaryAnchors(nextNode, dom);
      }
      // Fold slot text slots-first, ahead of the child text the children
      // reconcile just wrote, matching `ElementNode.getTextContent` and the
      // create path's else branch.
      if (slotTextContent !== '') {
        const childText = dom.__lexicalTextContent || '';
        dom.__lexicalTextContent = slotTextContent + childText;
        subTreeTextContent = outerBefore + slotTextContent + childText;
        dom.__lexicalSlotTextLength = slotTextContent.length;
      } else if (
        $readSlots(nextNode).size > 0 ||
        $readSlots(prevNode).size > 0
      ) {
        // Slot existed but produced no text this cycle (removed or emptied):
        // clear the stale prefix length so the next suffix fast path strips
        // nothing from the now child-only cache.
        dom.__lexicalSlotTextLength = 0;
      }
    } else {
      // Currently unreachable under normal flow — `getWritable()` always
      // calls `internalMarkNodeAsDirty` (LexicalNode.ts: getWritable),
      // so a non-identity (`prevNode !== nextNode`) reconcile implies
      // `isDirty` is true. Kept as defense-in-depth in case the dirty
      // propagation contract changes.
      const previousSubTreeTextContent = dom.__lexicalTextContent;
      // Same strict invariant as the prevNode === nextNode branch above —
      // the cache is set on every reconciled element and surviving until
      // here without one means an upstream invariant was broken.
      invariant(
        typeof previousSubTreeTextContent === 'string',
        'reconcileNode: missing __lexicalTextContent on cloned non-dirty element of type %s',
        prevNode.getType(),
      );
      subTreeTextContent += previousSubTreeTextContent;
      // Mirror the prevNode === nextNode branch: bubble this clean element's
      // cached first-text descendant up to the caller's scope.
      $bubbleChildFirstText(dom);
    }

    if (
      treatAllNodesAsDirty ||
      nextNode.__dir !== prevNode.__dir ||
      nextNode.__parent !== prevNode.__parent
    ) {
      $setElementDirection(dom, nextNode);
      if (
        // Root node direction changing from set to unset (or vice versa)
        // changes how children's direction is calculated.
        $isRootNode(nextNode) &&
        // Can skip if all children already reconciled.
        !treatAllNodesAsDirty
      ) {
        for (const child of nextNode.getChildren()) {
          if ($isElementNode(child)) {
            const childDom = getElementByKeyOrThrow(
              activeEditor,
              child.getKey(),
            );
            $setElementDirection(childDom, child);
          }
        }
      }
    }
  } else {
    const text = nextNode.getTextContent();

    if ($isDecoratorNode(nextNode)) {
      const decorator = nextNode.decorate(activeEditor, activeEditorConfig);

      if (decorator !== null) {
        reconcileDecorator(key, decorator);
      }
      // @experimental named-slots. Mirror the element-host slot reconcile for
      // decorator hosts (including its isDirty gate: a clean host means its
      // slots are unchanged). Slot text is already folded into `text` by
      // getTextContent, so this is render-only ($reconcileSlotChildren
      // preserves subTreeTextContent).
      if (
        isDirty &&
        ($readSlots(nextNode).size > 0 || $readSlots(prevNode).size > 0)
      ) {
        $reconcileSlotChildren(prevNode, nextNode, dom);
      }
    }

    subTreeTextContent += text;
  }

  if (!activeEditorStateReadOnly && $isRootNode(nextNode)) {
    // Re-fetch the latest root: a child reconcile (e.g. `reconcileTextFormat`
    // calling `setTextFormat` on the parent) can clone the root mid-cycle,
    // leaving the local `nextNode` pointing at a stale instance whose
    // `__cachedText` would no-op the comparison below while the actual root
    // in the map carries `null` (RootNode constructor's default).
    const latestRoot = nextNode.getLatest();
    if (latestRoot.__cachedText !== subTreeTextContent) {
      // Cache the latest text content.
      const nextRootNode = latestRoot.getWritable();
      nextRootNode.__cachedText = subTreeTextContent;
      // This invariant from #8099 is left commented out for performance reasons
      // if (__DEV__) {
      //   const computedTextContent =
      //     ElementNode.prototype.getTextContent.call(nextRootNode);
      //   devInvariant(
      //     computedTextContent === subTreeTextContent,
      //     'LexicalReconciler: Computed nextRootNode.getTextContent() does not match nextRootNode.__cachedText %s !== %s (dom.__lexicalTextContent %s)',
      //     JSON.stringify(computedTextContent),
      //     JSON.stringify(subTreeTextContent),
      //     JSON.stringify(dom.__lexicalTextContent),
      //   );
      // }
      nextNode = nextRootNode;
    }
  }

  activeEditorDOMRenderConfig.$decorateDOM(
    nextNode,
    prevNode,
    dom,
    activeEditor,
  );
  // Maintain the cached-text-size invariant: every reconciled node carries
  // a current label so the next cycle's reads of the previous-state
  // instance are O(1) and never need to fall through to a recursive walk
  // that would resolve via `getLatest()` -> next state.
  $setCachedTextSize(nextNode);
  if (__DEV__) {
    // Freeze the node in DEV to prevent accidental mutations
    Object.freeze(nextNode);
  }

  return dom;
}

function reconcileDecorator(key: NodeKey, decorator: unknown): void {
  let pendingDecorators = activeEditor._pendingDecorators;
  const currentDecorators = activeEditor._decorators;

  if (pendingDecorators === null) {
    if (currentDecorators[key] === decorator) {
      return;
    }

    pendingDecorators = cloneDecorators(activeEditor);
  }

  pendingDecorators[key] = decorator;
}

function getNextSibling(element: HTMLElement): Node | null {
  let nextSibling = element.nextSibling;
  if (
    nextSibling !== null &&
    nextSibling === activeEditor._blockCursorElement
  ) {
    nextSibling = nextSibling.nextSibling;
  }
  return nextSibling;
}

function childrenSet(children: NodeKey[], start: number): Set<NodeKey> {
  const s = new Set<NodeKey>();
  for (let i = start; i < children.length; i++) {
    s.add(children[i]);
  }
  return s;
}

function $reconcileNodeChildren(
  nextElement: ElementNode,
  prevChildren: NodeKey[],
  nextChildren: NodeKey[],
  prevChildrenLength: number,
  nextChildrenLength: number,
  slot: ElementDOMSlot,
): void {
  const prevEndIndex = prevChildrenLength - 1;
  const nextEndIndex = nextChildrenLength - 1;
  let prevChildrenSet: Set<NodeKey> | undefined;
  let nextChildrenSet: Set<NodeKey> | undefined;
  let siblingDOM: null | Node = slot.getFirstChild();
  let prevIndex = 0;
  let nextIndex = 0;

  while (prevIndex <= prevEndIndex && nextIndex <= nextEndIndex) {
    const prevKey = prevChildren[prevIndex];
    const nextKey = nextChildren[nextIndex];
    const saved = $beginCaptureGuard();

    if (prevKey === nextKey) {
      siblingDOM = getNextSibling($reconcileNode(nextKey, slot.element));
      prevIndex++;
      nextIndex++;
    } else {
      if (nextChildrenSet === undefined) {
        nextChildrenSet = childrenSet(nextChildren, nextIndex);
      }
      if (prevChildrenSet === undefined) {
        prevChildrenSet = childrenSet(prevChildren, prevIndex);
      } else if (!prevChildrenSet.has(prevKey)) {
        // continue if prevKey has already been moved
        prevIndex++;
        $endCaptureGuard(saved);
        continue;
      }
      if (!nextChildrenSet.has(prevKey)) {
        // Remove prev and continue
        siblingDOM = getNextSibling(getPrevElementByKeyOrThrow(prevKey));
        $destroyNode(prevKey, slot.element);
        prevIndex++;
        prevChildrenSet.delete(prevKey);
        $endCaptureGuard(saved);
        continue;
      }
      if (!prevChildrenSet.has(nextKey)) {
        // Create next. When siblingDOM is null we're appending at the end
        // of the lexical range; fall back to `slot.before` so slots with a
        // trailing non-lexical decoration (e.g. block drag handle) keep
        // that decoration after the new child.
        $createNode(nextKey, slot.withBefore(siblingDOM ?? slot.before));
        nextIndex++;
      } else {
        // Move next
        const childDOM = getElementByKeyOrThrow(activeEditor, nextKey);
        if (childDOM !== siblingDOM) {
          slot.withBefore(siblingDOM ?? slot.before).insertChild(childDOM);
        }
        siblingDOM = getNextSibling($reconcileNode(nextKey, slot.element));

        prevIndex++;
        nextIndex++;
      }
    }

    const node = activeNextNodeMap.get(nextKey);
    if (node !== null && $isTextNode(node)) {
      if (subTreeTextFormat === null) {
        subTreeTextFormat = node.getFormat();
        subTreeTextStyle = node.getStyle();
        subTreeFirstTextKey = node.__key;
      }
    } else if (
      // inline $textContentRequiresDoubleLinebreakAtEnd
      $isElementNode(node) &&
      nextIndex <= nextEndIndex &&
      !node.isInline()
    ) {
      subTreeTextContent += DOUBLE_LINE_BREAK;
    }
    $endCaptureGuard(saved);
  }

  const appendNewChildren = prevIndex > prevEndIndex;
  const removeOldChildren = nextIndex > nextEndIndex;

  if (appendNewChildren && !removeOldChildren) {
    const previousNode = nextChildren[nextEndIndex + 1];
    const insertDOM =
      previousNode === undefined
        ? null
        : activeEditor.getElementByKey(previousNode);
    $createChildren(
      nextChildren,
      nextElement,
      nextIndex,
      nextEndIndex,
      // Preserve the slot's trailing decoration anchor when appending at
      // the end (insertDOM === null).
      slot.withBefore(insertDOM ?? slot.before),
    );
  } else if (removeOldChildren && !appendNewChildren) {
    $destroyChildren(prevChildren, prevIndex, prevEndIndex, slot.element);
  }
}

export function $reconcileRoot(
  prevEditorState: EditorState,
  nextEditorState: EditorState,
  editor: LexicalEditor,
  dirtyType: 0 | 1 | 2,
  dirtyElements: Map<NodeKey, IntentionallyMarkedAsDirtyElement>,
  dirtyLeaves: Set<NodeKey>,
): MutatedNodes {
  // We cache text content to make retrieval more efficient.
  // The cache must be rebuilt during reconciliation to account for any changes.
  // Reset all four sub-tree accumulators at cycle start so the
  // first-text/format/style invariant doesn't carry state across cycles.
  subTreeTextContent = '';
  subTreeTextFormat = null;
  subTreeTextStyle = null;
  subTreeFirstTextKey = null;
  // Rather than pass around a load of arguments through the stack recursively
  // we instead set them as bindings within the scope of the module.
  treatAllNodesAsDirty = dirtyType === FULL_RECONCILE;
  activeEditor = editor;
  activeEditorConfig = editor._config;
  activeEditorDOMRenderConfig = editor._config.dom || DEFAULT_EDITOR_DOM_CONFIG;
  activeEditorNodes = editor._nodes;
  activeMutationListeners = activeEditor._listeners.mutation;
  activeDirtyElements = dirtyElements;
  activeDirtyLeaves = dirtyLeaves;
  activePrevNodeMap = prevEditorState._nodeMap;
  activePrevEditorState = prevEditorState;
  activeNextNodeMap = nextEditorState._nodeMap;
  activeEditorStateReadOnly = nextEditorState._readOnly;
  activePrevKeyToDOMMap = cloneMap(editor._keyToDOMMap);
  activeDirtyChildrenByParent = $buildDirtyChildrenByParent();
  // We keep track of mutated nodes so we can trigger mutation
  // listeners later in the update cycle.
  const currentMutatedNodes = new Map();
  mutatedNodes = currentMutatedNodes;
  $reconcileNode('root', null);
  // We don't want a bunch of void checks throughout the scope
  // so instead we make it seem that these values are always set.
  // We also want to make sure we clear them down, otherwise we
  // can leak memory.
  // @ts-ignore
  activeEditor = undefined;
  // @ts-ignore
  activeEditorNodes = undefined;
  // @ts-ignore
  activeDirtyElements = undefined;
  // @ts-ignore
  activeDirtyLeaves = undefined;
  // @ts-ignore
  activePrevNodeMap = undefined;
  // @ts-ignore
  activePrevEditorState = undefined;
  // @ts-ignore
  activeNextNodeMap = undefined;
  // @ts-ignore
  activeEditorConfig = undefined;
  // @ts-ignore
  activePrevKeyToDOMMap = undefined;
  // @ts-ignore
  activeDirtyChildrenByParent = undefined;
  // @ts-ignore
  mutatedNodes = undefined;
  activeEditorDOMRenderConfig = DEFAULT_EDITOR_DOM_CONFIG;

  return currentMutatedNodes;
}

export function storeDOMWithKey(
  key: NodeKey,
  dom: HTMLElement,
  editor: LexicalEditor,
): void {
  const keyToDOMMap = editor._keyToDOMMap;
  setNodeKeyOnDOMNode(dom, editor, key);
  keyToDOMMap.set(key, dom);
}

function getPrevElementByKeyOrThrow(key: NodeKey): HTMLElement {
  const element = activePrevKeyToDOMMap.get(key);

  if (element === undefined) {
    invariant(
      false,
      'Reconciliation: could not find DOM element for node key %s',
      key,
    );
  }

  return element;
}
