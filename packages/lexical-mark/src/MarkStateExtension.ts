/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  effect,
  getPeerDependencyFromEditor,
  namedSignals,
  type ReadonlySignal,
  type Signal,
  signal,
} from '@lexical/extension';
import {
  $setRenderContextValue,
  createRenderState,
  defineImportRule,
  DOMImportExtension,
  domOverride,
  DOMRenderExtension,
  type RenderStateConfig,
  sel,
} from '@lexical/html';
import invariant from '@lexical/internal/invariant';
import {
  $createTextNode,
  $fullReconcile,
  $getEditor,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getSlot,
  $getSlotNames,
  $getState,
  $hasUpdateTag,
  $isDecoratorNode,
  $isElementNode,
  $isLexicalNode,
  $isRangeSelection,
  $isTextNode,
  $setState,
  addClassNamesToElement,
  arraySetValue,
  type BaseSelection,
  COLLABORATION_TAG,
  COMMAND_PRIORITY_CRITICAL,
  COMPOSITION_START_COMMAND,
  COMPOSITION_START_TAG,
  configExtension,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  createState,
  type DecoratorNode,
  defineExtension,
  type EditorState,
  type ElementNode,
  type ExtensionConfigBase,
  HISTORIC_TAG,
  isHTMLElement,
  type Klass,
  type LexicalEditor,
  type LexicalExtension,
  type LexicalNode,
  LineBreakNode,
  mergeRegister,
  type NodeKey,
  PASTE_COMMAND,
  type PointType,
  removeClassNamesFromElement,
  RootNode,
  safeCast,
  type SerializationSchema,
  SKIP_DOM_SELECTION_TAG,
  type StateConfig,
  TextNode,
} from 'lexical';

import {$isMarkNode} from './MarkNode';

/**
 * The NodeState key that {@link MarkStateExtension} stores mark ids under: a
 * leaf covered by `c1` and `c2` has `{"markIds": ["c1", "c2"]}` (sorted) in
 * the `$` record of its JSON.
 *
 * The state is an `arraySetValue` (see `lexical`), so its schema marks it as
 * a set whose members are independent: code that stores or merges NodeState
 * can treat each id separately.
 *
 * @experimental
 */
export const MARK_STATE_KEY = 'markIds';

/**
 * A node class, matched with `instanceof`, or a guard function, as used in
 * the `markableNodes` config of {@link MarkStateExtension}.
 *
 * @experimental
 */
export type MarkableNodeMatch =
  | Klass<LexicalNode>
  | ((node: LexicalNode) => boolean);

/**
 * The attribute that {@link MarkStateExtension} renders on the element of each
 * marked leaf in the editor, holding its space separated ids. HTML export
 * writes it when `exportIDsToHTML` is set, and HTML import reads it back.
 *
 * @experimental
 */
export const MARK_STATE_IDS_ATTRIBUTE = 'data-lexical-mark-ids';

/**
 * Configuration for {@link MarkStateExtension}.
 *
 * @experimental
 */
export interface MarkStateConfig {
  /**
   * When `true`, mark ids are not rendered in the editor DOM, the
   * `markIDNodeKeys` output is emptied and no longer maintained, and text
   * inserted next to a marked run no longer has its ids adjusted (it keeps
   * whatever ids the TextNode it lands in has). The ids stay in the document,
   * the `$` functions keep working, and HTML export (with `exportIDsToHTML`)
   * and import still write and read the ids.
   */
  disabled: boolean;
  /**
   * When `true`, HTML export (`$generateHtmlFromNodes`, and so copying to the
   * clipboard as `text/html`) writes the `data-lexical-mark-ids` attribute on
   * marked leaves, so that the ids survive an HTML round trip. Default
   * `false`, like MarkNode, which exports no ids: they are often internal
   * thread ids that should not leak into other applications.
   */
  exportIDsToHTML: boolean;
  /**
   * The nodes that carry mark ids: a node is markable when it is an instance
   * of one of these classes or one of these guards returns `true` for it.
   * Marking a range marks the markable nodes in it, and the ElementNodes and
   * slot hosts in it are looked through (their children and their slots).
   * Use it for leaves: TextNode, LineBreakNode and DecoratorNode subclasses.
   *
   * The default is `[TextNode, LineBreakNode, $isInlineDecoratorNode]`:
   * TextNode and its subclasses, LineBreakNode, and every inline DecoratorNode
   * (which includes `DecoratorTextNode` from `@lexical/extension`). To extend
   * it, spread the default:
   * `[...DEFAULT_MARKABLE_NODES, MyBlockDecoratorNode]`.
   * Every editor that edits the same document should use the same set.
   */
  markableNodes: readonly MarkableNodeMatch[];
  /**
   * Which mark ids are rendered in the editor DOM. A leaf gets the `mark`
   * theme class and the `data-lexical-mark-ids` attribute for the ids this
   * returns `true` for (and `markOverlap` when there is more than one), and
   * no decoration when it returns `false` for all of them. The default shows
   * every id.
   *
   * Use it to hide resolved comment threads while their ids stay in the
   * document. It only changes rendering: the ids stay in the document, and
   * the `$` functions, the `markIDNodeKeys` output and HTML export still see
   * every id. It is called during reconciliation, so it should be a cheap,
   * pure read of the app's own state.
   *
   * To change it at runtime, for example when a thread is resolved or
   * reopened, update the app's state and assign a new function to the
   * `isMarkIDShown` output signal: the marked leaves are re-rendered (after
   * the pending update commits, when assigned during one). Changing the
   * state that the current function reads without assigning a new function
   * does not re-render them.
   */
  isMarkIDShown?: (id: string) => boolean;
}

/**
 * Output of {@link MarkStateExtension}.
 *
 * @experimental
 */
export interface MarkStateOutput {
  disabled: Signal<boolean>;
  exportIDsToHTML: Signal<boolean>;
  /**
   * The `isMarkIDShown` config, which defaults to showing every id. Assign a
   * new function to re-render the marked leaves with it, for example when a
   * thread is resolved or reopened.
   */
  isMarkIDShown: Signal<(id: string) => boolean>;
  /**
   * Every mark id in the document, mapped to the keys of the leaves that carry
   * it (in no particular order). A new Map is published after each update that
   * changes it. Empty while the extension is disabled.
   */
  markIDNodeKeys: ReadonlySignal<ReadonlyMap<string, readonly NodeKey[]>>;
}

/**
 * What {@link registerMarkIDsListener} reports after a commit that changed
 * which ids of a mark flavor are in the document.
 *
 * @experimental
 */
export interface MarkIDsChange {
  /** The ids that no leaf carried before and at least one carries now */
  added: ReadonlySet<string>;
  /** Every id of the flavor in the document now */
  ids: ReadonlySet<string>;
  /** The ids that some leaf carried before and none carries now */
  removed: ReadonlySet<string>;
  /**
   * The tags of the update that made the change, for example
   * `COLLABORATION_TAG` for a collaborator's edit or `HISTORIC_TAG` for an
   * undo or redo. Empty for the first call of a listener.
   */
  tags: ReadonlySet<string>;
}

/**
 * A listener registered with {@link registerMarkIDsListener}.
 *
 * @experimental
 */
export type MarkIDsListener = (change: MarkIDsChange) => void;

/**
 * The init result of a mark flavor extension: state that outlives a
 * `disabled` toggle.
 *
 * @experimental
 */
export interface MarkStateInit {
  markIDNodeKeys: Signal<ReadonlyMap<string, readonly NodeKey[]>>;
  /** @internal The listeners, each with the ids last reported to it */
  listeners: Set<{listener: MarkIDsListener; reported: ReadonlySet<string>}>;
}

const MARK_STATE_EXTENSION_NAME = '@lexical/mark/MarkState';

/** Any mark flavor extension, as the internals look it up by name. */
type AnyMarkFlavorExtensionType = LexicalExtension<
  MarkStateConfig,
  string,
  MarkStateOutput,
  MarkStateInit
>;

/**
 * The parts of a mark flavor that the internals need, created once per
 * {@link defineMarkExtension} call. Every function that reads or writes ids
 * takes one, so that two flavors never see each other's ids.
 */
interface MarkFlavor {
  /** The flavor extension's name */
  readonly name: string;
  readonly stateKey: string;
  readonly attribute: string;
  /** The set-valued NodeState that stores the ids */
  readonly state: StateConfig<string, readonly string[]>;
  /** The theme classes of a marked leaf, and of a leaf with several ids */
  readonly classNames: (editor: LexicalEditor) => {
    mark: undefined | string;
    overlap: undefined | string;
  };
  readonly renderDisabled: RenderStateConfig<boolean>;
  /** The compiled `markableNodes` config, per editor */
  readonly isMarkableByEditor: WeakMap<
    LexicalEditor,
    (node: LexicalNode) => boolean
  >;
  /** The pending edits of the inserted-text rule, per editor */
  readonly editsByEditor: WeakMap<LexicalEditor, PendingEdits>;
}

/**
 * Whether `id` can be used as a mark id: a non-empty string without
 * whitespace, since the ids of a leaf are written space separated in the
 * `data-lexical-mark-ids` attribute.
 */
function isValidMarkID(id: unknown): id is string {
  return typeof id === 'string' && id !== '' && !/\s/.test(id);
}

/**
 * The item schema of the ids: a string that {@link isValidMarkID} accepts.
 * `arraySetValue` drops the members its item does not accept, so an invalid
 * id is dropped wherever the ids are parsed: JSON, HTML import, a value
 * written with `$setState`, or a state applied by `updateFromUnknown`.
 *
 * @__NO_SIDE_EFFECTS__
 */
function markIDValue(): SerializationSchema<string> {
  return Object.assign(
    (value: unknown): string => (isValidMarkID(value) ? value : ''),
    {
      accepts: isValidMarkID,
      defaultValue: '',
      meta: {kind: 'string'} as const,
    },
  );
}

/**
 * The NodeState of the ids of a flavor: a frozen array, sorted and without
 * duplicates, which is also its JSON.
 *
 * @__NO_SIDE_EFFECTS__
 */
function createMarkIDsState(
  stateKey: string,
): StateConfig<string, readonly string[]> {
  return createState(stateKey, {parse: arraySetValue(markIDValue())});
}

/**
 * Inline DecoratorNodes, one of the default `markableNodes` of
 * {@link MarkStateExtension}. This includes `DecoratorTextNode`.
 *
 * @experimental
 */
export function $isInlineDecoratorNode(
  node: null | undefined | LexicalNode,
): node is DecoratorNode<unknown> {
  return $isDecoratorNode(node) && node.isInline();
}

/**
 * The default `markableNodes` of {@link MarkStateExtension}: TextNode,
 * LineBreakNode and inline DecoratorNodes (including `DecoratorTextNode`).
 *
 * @experimental
 */
export const DEFAULT_MARKABLE_NODES: readonly MarkableNodeMatch[] = [
  TextNode,
  LineBreakNode,
  $isInlineDecoratorNode,
];

function isNodeClass(match: MarkableNodeMatch): match is Klass<LexicalNode> {
  // A guard written as an arrow function has no prototype
  return $isLexicalNode(match.prototype);
}

function compileMarkableNodes(
  matches: readonly MarkableNodeMatch[],
): (node: LexicalNode) => boolean {
  const klasses: Klass<LexicalNode>[] = [];
  const guards: ((node: LexicalNode) => boolean)[] = [];
  for (const match of matches) {
    if (isNodeClass(match)) {
      klasses.push(match);
    } else {
      guards.push(match as (node: LexicalNode) => boolean);
    }
  }
  return node =>
    klasses.some(klass => node instanceof klass) ||
    guards.some(guard => guard(node));
}

let defaultIsMarkable: undefined | ((node: LexicalNode) => boolean);

/**
 * Whether `node` carries ids of `flavor` in the active editor, according to
 * the `markableNodes` config of that flavor's extension (or the default,
 * when the extension is not installed). Inline ElementNodes such as links
 * are not marked themselves, their leaves are.
 */
function $isMarkableNode(
  flavor: MarkFlavor,
  node: null | undefined | LexicalNode,
): boolean {
  if (!node) {
    return false;
  }
  const isMarkable = flavor.isMarkableByEditor.get($getEditor());
  if (isMarkable) {
    return isMarkable(node);
  }
  if (defaultIsMarkable === undefined) {
    defaultIsMarkable = compileMarkableNodes(DEFAULT_MARKABLE_NODES);
  }
  return defaultIsMarkable(node);
}

/**
 * The flavor-first form: like the form below (which keeps its place as the
 * last overload, the one `Parameters` and `ReturnType` read), for the ids of
 * `flavor` instead of {@link MarkStateExtension}'s.
 *
 * @param flavor A mark flavor made with {@link defineMarkExtension}
 * @param node The node
 */
export function $getNodeMarkIDs(
  flavor: AnyMarkFlavorExtension,
  node: LexicalNode,
): string[];
/**
 * Get the mark ids stored on a node, sorted: the ids of
 * {@link MarkStateExtension}, or of the flavor passed first. Nodes that
 * cannot carry ids return an empty array.
 *
 * @param node The node
 * @returns A new array of the ids, sorted, which the caller may change
 *
 * @experimental
 */
export function $getNodeMarkIDs(node: LexicalNode): string[];
export function $getNodeMarkIDs(
  ...args: [LexicalNode] | [AnyMarkFlavorExtension, LexicalNode]
): string[] {
  const [flavor, node] = splitFlavorArgs<[LexicalNode]>(args);
  return $readNodeMarkIDs(flavor, node).slice();
}

/**
 * The stored value itself, frozen: for reads that do not hand it out.
 */
function $readNodeMarkIDs(
  flavor: MarkFlavor,
  node: LexicalNode,
): readonly string[] {
  return $getState(node, flavor.state);
}

/** The ids of `node` when it is markable, otherwise none. */
function $getMarkableIDs(
  flavor: MarkFlavor,
  node: null | undefined | LexicalNode,
): readonly string[] {
  return node && $isMarkableNode(flavor, node)
    ? $readNodeMarkIDs(flavor, node)
    : NO_IDS;
}

const NO_IDS: readonly string[] = [];

function $addNodeMarkIDs(
  flavor: MarkFlavor,
  node: LexicalNode,
  ids: readonly string[],
): void {
  // $setState sorts and dedupes the result
  $setState(node, flavor.state, prev =>
    ids.every(id => prev.includes(id)) ? prev : [...prev, ...ids],
  );
}

function $removeNodeMarkIDs(
  flavor: MarkFlavor,
  node: LexicalNode,
  ids: readonly string[],
): void {
  $setState(node, flavor.state, prev =>
    ids.some(id => prev.includes(id))
      ? prev.filter(id => !ids.includes(id))
      : prev,
  );
}

function assertValidMarkID(id: string): void {
  invariant(
    isValidMarkID(id),
    'MarkStateExtension: invalid mark id %s, ids must be non-empty strings without whitespace',
    JSON.stringify(id),
  );
}

/** Call `fn` with the value of each slot of `node`. */
function $forEachSlot(
  node: LexicalNode,
  fn: (slot: LexicalNode) => void,
): void {
  for (const name of $getSlotNames(node)) {
    const slot = $getSlot(node, name);
    if (slot !== null) {
      fn(slot);
    }
  }
}

function $markableNodesInSelection(
  flavor: MarkFlavor,
  selection: BaseSelection,
): LexicalNode[] {
  if ($isRangeSelection(selection) && selection.isCollapsed()) {
    return [];
  }
  // extract() splits the TextNodes at the boundaries of a RangeSelection, so
  // only the selected part of them is returned. It does not include the
  // content of slots, which is collected from each selected slot host.
  const nodes: LexicalNode[] = [];
  const seen = new Set<LexicalNode>();
  for (const node of selection.extract()) {
    if ($isMarkableNode(flavor, node) && !seen.has(node)) {
      seen.add(node);
      nodes.push(node);
    }
    $forEachSlot(node, slot =>
      $collectMarkableNodes(flavor, slot, nodes, seen),
    );
  }
  return nodes;
}

/**
 * The flavor-first form: like the form below (which keeps its place as the
 * last overload, the one `Parameters` and `ReturnType` read), for the ids of
 * `flavor` instead of {@link MarkStateExtension}'s.
 *
 * @param flavor A mark flavor made with {@link defineMarkExtension}
 * @param id The mark id
 * @param selection The selection to mark
 */
export function $addMarkID(
  flavor: AnyMarkFlavorExtension,
  id: string,
  selection: BaseSelection,
): LexicalNode[];
/**
 * Add the mark `id` to every markable node in `selection` (TextNode,
 * LineBreakNode and inline DecoratorNode by default, see `markableNodes`),
 * including the content of the slots of the nodes in it, splitting the
 * TextNodes at its boundaries. Ids already on those nodes are kept, so marks
 * can overlap freely. A collapsed selection marks nothing.
 *
 * The id is added to {@link MarkStateExtension}'s ids, or to the ids of the
 * flavor passed first: `$addMarkID(CommentMarks, 'c1', selection)`.
 *
 * @param id The mark id, for example a comment thread id. It must be a
 *   non-empty string without whitespace, otherwise this throws.
 * @param selection The selection to mark
 * @returns The nodes that now carry the id
 *
 * @experimental
 */
export function $addMarkID(id: string, selection: BaseSelection): LexicalNode[];
export function $addMarkID(
  ...args:
    | [string, BaseSelection]
    | [AnyMarkFlavorExtension, string, BaseSelection]
): LexicalNode[] {
  const [flavor, id, selection] =
    splitFlavorArgs<[string, BaseSelection]>(args);
  assertValidMarkID(id);
  const nodes = $markableNodesInSelection(flavor, selection);
  for (const node of nodes) {
    $addNodeMarkIDs(flavor, node, [id]);
  }
  return nodes;
}

/**
 * Collect the markable nodes in the subtree of `node`, looking through the
 * children of ElementNodes and the slots of slot hosts (ElementNodes and
 * DecoratorNodes).
 */
function $collectMarkableNodes(
  flavor: MarkFlavor,
  node: LexicalNode,
  out: LexicalNode[],
  seen: Set<LexicalNode>,
): void {
  if ($isMarkableNode(flavor, node) && !seen.has(node)) {
    seen.add(node);
    out.push(node);
  }
  if ($isElementNode(node)) {
    for (
      let child = node.getFirstChild();
      child !== null;
      child = child.getNextSibling()
    ) {
      $collectMarkableNodes(flavor, child, out, seen);
    }
  }
  $forEachSlot(node, slot => $collectMarkableNodes(flavor, slot, out, seen));
}

function $markableNodesIn(
  flavor: MarkFlavor,
  node: LexicalNode,
): LexicalNode[] {
  const out: LexicalNode[] = [];
  $collectMarkableNodes(flavor, node, out, new Set());
  return out;
}

/**
 * The leaves that may carry `id` without a full document walk: the leaves the
 * `markIDNodeKeys` output had for it at the last commit, plus the leaves
 * changed by the pending update (which include every leaf that got the id,
 * or was split off one, since). `null` when the extension is not installed
 * or is disabled.
 */
function $getMarkIDCandidates(
  flavor: MarkFlavor,
  id: string,
): null | LexicalNode[] {
  const editor = $getEditor();
  const dep = getPeerDependencyFromEditor<AnyMarkFlavorExtensionType>(
    editor,
    flavor.name,
  );
  if (!dep || dep.output.disabled.peek()) {
    return null;
  }
  const keys = new Set(dep.output.markIDNodeKeys.peek().get(id));
  // @internal access: the leaves this update made dirty, which the update
  // listener receives as `dirtyLeaves` once it commits
  for (const key of editor._dirtyLeaves) {
    keys.add(key);
  }
  const nodes: LexicalNode[] = [];
  for (const key of keys) {
    const node = $getNodeByKey(key);
    if (node !== null && $isMarkableNode(flavor, node) && node.isAttached()) {
      nodes.push(node);
    }
  }
  return nodes;
}

/**
 * The flavor-first form: like the form below (which keeps its place as the
 * last overload, the one `Parameters` and `ReturnType` read), for the ids of
 * `flavor` instead of {@link MarkStateExtension}'s.
 *
 * @param flavor A mark flavor made with {@link defineMarkExtension}
 * @param id The mark id
 * @param selection Limit the removal to this selection
 */
export function $removeMarkID(
  flavor: AnyMarkFlavorExtension,
  id: string,
  selection?: null | BaseSelection,
): void;
/**
 * Remove the mark `id`. With a `selection` it is removed from the nodes in
 * that selection only (splitting the TextNodes at its boundaries), otherwise
 * from the whole document (found through the `markIDNodeKeys` output, or by
 * walking the document when the extension is not active). Text that no
 * longer differs from its neighbors is merged back by normalization.
 *
 * The id is removed from {@link MarkStateExtension}'s ids, or from the ids
 * of the flavor passed first: `$removeMarkID(CommentMarks, 'c1')`.
 *
 * @param id The mark id
 * @param selection Limit the removal to this selection
 *
 * @experimental
 */
export function $removeMarkID(
  id: string,
  selection?: null | BaseSelection,
): void;
export function $removeMarkID(
  ...args:
    | [string, (null | BaseSelection)?]
    | [AnyMarkFlavorExtension, string, (null | BaseSelection)?]
): void {
  const [flavor, id, selection] =
    splitFlavorArgs<[string, (null | BaseSelection)?]>(args);
  const nodes = selection
    ? $markableNodesInSelection(flavor, selection)
    : $getMarkIDCandidates(flavor, id) || $markableNodesIn(flavor, $getRoot());
  for (const node of nodes) {
    $removeNodeMarkIDs(flavor, node, [id]);
  }
  // The inserted-text rule of this update must not give the id back
  const edit = flavor.editsByEditor.get($getEditor());
  if (edit) {
    edit.removed.add(id);
    forgetSoon(edit);
  }
}

function $getPointMarkIDs(
  flavor: MarkFlavor,
  point: PointType,
): readonly string[] {
  const node = point.getNode();
  if (point.type === 'text') {
    const ids = $readNodeMarkIDs(flavor, node);
    if (
      ids.length === 0 &&
      $isTextNode(node) &&
      point.offset === node.getTextContentSize()
    ) {
      // Like $getMarkIDs: a caret right before a marked run is in it
      return $getMarkableIDs(flavor, $getAdjacentLeaf(node, 'next'));
    }
    return ids;
  }
  if ($isElementNode(node)) {
    const before = $getMarkableIDs(
      flavor,
      node.getChildAtIndex(point.offset - 1),
    );
    return before.length > 0
      ? before
      : $getMarkableIDs(flavor, node.getChildAtIndex(point.offset));
  }
  return NO_IDS;
}

/**
 * The flavor-first form: like the form below (which keeps its place as the
 * last overload, the one `Parameters` and `ReturnType` read), for the ids of
 * `flavor` instead of {@link MarkStateExtension}'s.
 *
 * @param flavor A mark flavor made with {@link defineMarkExtension}
 * @param selection The selection, defaults to the current selection
 * @param mode `'any'` or `'all'`, for a selection that is not collapsed
 */
export function $getMarkIDsAtSelection(
  flavor: AnyMarkFlavorExtension,
  selection?: null | BaseSelection,
  mode?: 'any' | 'all',
): string[];
/**
 * Get the mark ids at a selection, sorted. For a collapsed RangeSelection
 * these are the ids of the leaf holding the caret (or of the next leaf, when
 * the caret is at the end of an unmarked TextNode), like `$getMarkIDs` does
 * for MarkNode. Otherwise, `mode` `'any'` (the default) returns the ids on
 * any selected leaf, and `'all'` the ids shared by every selected leaf. The
 * TextNodes that a RangeSelection only touches at an edge are ignored.
 *
 * These are {@link MarkStateExtension}'s ids, or the ids of the flavor passed
 * first: `$getMarkIDsAtSelection(CommentMarks)`.
 *
 * @param selection The selection, defaults to the current selection
 * @param mode `'any'` or `'all'`, for a selection that is not collapsed
 * @returns The ids, sorted
 *
 * @experimental
 */
export function $getMarkIDsAtSelection(
  selection?: null | BaseSelection,
  mode?: 'any' | 'all',
): string[];
export function $getMarkIDsAtSelection(
  ...args:
    | [(null | BaseSelection)?, ('any' | 'all')?]
    | [AnyMarkFlavorExtension, (null | BaseSelection)?, ('any' | 'all')?]
): string[] {
  const [flavor, selectionArg, mode = 'any'] =
    splitFlavorArgs<[(null | BaseSelection)?, ('any' | 'all')?]>(args);
  // An explicit undefined defaults too, as with a default parameter
  const selection = selectionArg === undefined ? $getSelection() : selectionArg;
  if (!selection) {
    return [];
  }
  if ($isRangeSelection(selection) && selection.isCollapsed()) {
    return $getPointMarkIDs(flavor, selection.anchor).slice();
  }
  let leaves = selection
    .getNodes()
    .filter(node => $isMarkableNode(flavor, node));
  if ($isRangeSelection(selection)) {
    const [start, end] = selection.isBackward()
      ? [selection.focus, selection.anchor]
      : [selection.anchor, selection.focus];
    leaves = leaves.filter(node => {
      if (!$isTextNode(node)) {
        return true;
      }
      const key = node.getKey();
      const from =
        start.type === 'text' && start.key === key ? start.offset : 0;
      const to =
        end.type === 'text' && end.key === key
          ? end.offset
          : node.getTextContentSize();
      return to > from;
    });
  }
  if (leaves.length === 0) {
    return [];
  }
  const idSets = leaves.map(node => $readNodeMarkIDs(flavor, node));
  // Both build a new array, so the stored values are never sorted in place
  return mode === 'any'
    ? Array.from(new Set(idSets.flat())).sort()
    : idSets[0].filter(id => idSets.every(ids => ids.includes(id)));
}

/**
 * The flavor-first form: like the form below (which keeps its place as the
 * last overload, the one `Parameters` and `ReturnType` read), for the ids of
 * `flavor` instead of {@link MarkStateExtension}'s.
 *
 * @param flavor A mark flavor made with {@link defineMarkExtension}
 * @param node The subtree to convert, defaults to the root
 */
export function $migrateMarkNodesToMarkState(
  flavor: AnyMarkFlavorExtension,
  node?: LexicalNode,
): number;
/**
 * Convert a document that uses MarkNode into one that uses
 * {@link MarkStateExtension}: the ids of every MarkNode (including the ids of
 * MarkNodes it is nested in) are added to the leaves inside it, and the
 * MarkNode is unwrapped.
 *
 * Run this once per document, before anything else edits it (for example in
 * a headless editor): the unwrap is a structural change, and an edit made at
 * the same time by another writer races with it as with any MarkNode edit.
 * Like {@link $addMarkID}, it throws on an id that is empty or contains
 * whitespace.
 *
 * The ids go to {@link MarkStateExtension}, or to the flavor passed first:
 * `$migrateMarkNodesToMarkState(CommentMarks)`.
 *
 * @param node The subtree to convert, defaults to the root
 * @returns The number of MarkNodes that were unwrapped
 *
 * @experimental
 */
export function $migrateMarkNodesToMarkState(node?: LexicalNode): number;
export function $migrateMarkNodesToMarkState(
  ...args: [LexicalNode?] | [AnyMarkFlavorExtension, LexicalNode?]
): number {
  const [flavor, nodeArg] = splitFlavorArgs<[LexicalNode?]>(args);
  const node = nodeArg === undefined ? $getRoot() : nodeArg;
  let count = 0;
  const $visit = (current: LexicalNode, inherited: readonly string[]) => {
    if ($isMarkNode(current)) {
      const ownIDs = current.getIDs();
      ownIDs.forEach(assertValidMarkID);
      const ids = Array.from(new Set([...inherited, ...ownIDs]));
      for (const child of current.getChildren()) {
        $visit(child, ids);
      }
      // Re-read: unwrapping a nested MarkNode replaced it with its children
      for (const child of current.getChildren()) {
        current.insertBefore(child);
      }
      current.remove();
      count++;
    } else {
      if ($isMarkableNode(flavor, current) && inherited.length > 0) {
        $addNodeMarkIDs(flavor, current, inherited);
      }
      if ($isElementNode(current)) {
        for (const child of current.getChildren()) {
          $visit(child, inherited);
        }
      }
      $forEachSlot(current, slot => $visit(slot, inherited));
    }
  };
  $visit(node, []);
  return count;
}

/** The default `isMarkIDShown`: every id is rendered. */
function isEveryMarkIDShown(_id: string): boolean {
  return true;
}

/** The ids in `ids` that `isMarkIDShown` renders. */
function filterShownMarkIDs(
  ids: readonly string[],
  isMarkIDShown: (id: string) => boolean,
): readonly string[] {
  return isMarkIDShown === isEveryMarkIDShown
    ? ids
    : ids.filter(id => isMarkIDShown(id));
}

function $decorateMarkIDs(
  flavor: MarkFlavor,
  node: LexicalNode,
  dom: HTMLElement,
  editor: LexicalEditor,
): void {
  let ids = $readNodeMarkIDs(flavor, node);
  if (ids.length > 0) {
    const dep = getPeerDependencyFromEditor<AnyMarkFlavorExtensionType>(
      editor,
      flavor.name,
    );
    if (dep) {
      ids = filterShownMarkIDs(ids, dep.output.isMarkIDShown.peek());
    }
  }
  const {mark, overlap} = flavor.classNames(editor);
  if (ids.length > 0) {
    dom.setAttribute(flavor.attribute, ids.join(' '));
  } else {
    dom.removeAttribute(flavor.attribute);
  }
  const add = [
    ...classTokens(ids.length > 0 ? mark : undefined),
    ...classTokens(ids.length > 1 ? overlap : undefined),
  ];
  const remove = [
    ...classTokens(ids.length > 0 ? undefined : mark),
    ...classTokens(ids.length > 1 ? undefined : overlap),
  ].filter(token => !add.includes(token) && dom.classList.contains(token));
  addClassNamesToElement(dom, ...add);
  if (remove.length > 0) {
    // A class that another flavor shows on this leaf stays
    const kept = $classTokensOfOtherFlavors(flavor, node, editor);
    removeClassNamesFromElement(
      dom,
      ...remove.filter(token => !kept.has(token)),
    );
  }
}

function classTokens(classNames: undefined | string): string[] {
  return classNames ? classNames.split(/\s+/).filter(Boolean) : [];
}

/**
 * The classes that the other enabled flavors of the editor render on
 * `node`, so that two flavors that share a class (or a flavor that uses a
 * theme class of MarkStateExtension) do not remove it from each other.
 */
function $classTokensOfOtherFlavors(
  flavor: MarkFlavor,
  node: LexicalNode,
  editor: LexicalEditor,
): Set<string> {
  const kept = new Set<string>();
  const base = getPeerDependencyFromEditor<typeof MarkBaseExtension>(
    editor,
    MARK_BASE_EXTENSION_NAME,
  );
  if (!base) {
    return kept;
  }
  for (const extension of base.output.flavors.values()) {
    const other = extension.__markFlavor;
    const dep =
      other !== flavor
        ? getPeerDependencyFromEditor<AnyMarkFlavorExtensionType>(
            editor,
            other.name,
          )
        : undefined;
    if (dep && !dep.output.disabled.peek() && $isMarkableNode(other, node)) {
      const shown = filterShownMarkIDs(
        $readNodeMarkIDs(other, node),
        dep.output.isMarkIDShown.peek(),
      );
      const {mark, overlap} = other.classNames(editor);
      for (const token of [
        ...classTokens(shown.length > 0 ? mark : undefined),
        ...classTokens(shown.length > 1 ? overlap : undefined),
      ]) {
        kept.add(token);
      }
    }
  }
  return kept;
}

/**
 * The HTML import rule of a flavor: the ids in its attribute are added to
 * the markable leaves the element imports to.
 *
 * @__NO_SIDE_EFFECTS__
 */
function createMarkIDsImportRule(flavor: MarkFlavor) {
  return defineImportRule({
    $import: (_ctx, el, $next) => {
      const nodes = $next();
      const ids = (el.getAttribute(flavor.attribute) || '')
        .split(/\s+/)
        .filter(isValidMarkID);
      if (ids.length > 0) {
        const leaves: LexicalNode[] = [];
        const seen = new Set<LexicalNode>();
        for (const node of nodes) {
          $collectMarkableNodes(flavor, node, leaves, seen);
        }
        for (const leaf of leaves) {
          $addNodeMarkIDs(flavor, leaf, ids);
        }
      }
      return nodes;
    },
    match: sel.any().attr(flavor.attribute, true),
    name: `${flavor.name}/ids`,
  });
}

/**
 * `setEditorState` replaces the whole document: its dirty sets do not list
 * the nodes it replaced (LexicalConstants `FULL_RECONCILE`).
 */
const FULL_RECONCILE = 2;

/**
 * What the inserted text rule needs to know about the current edits besides
 * the two editor states: the selection that an insertion or paste command
 * replaces (recorded before its handler replaces it), and the ids removed
 * with {@link $removeMarkID}, which the rule must not give back. Both are
 * forgotten when the editor commits and at the next microtask: a command
 * dispatched outside an update runs each priority level in an update of its
 * own, and an update that changes nothing is dropped without a commit.
 */
interface PendingEdits {
  replaced: null | readonly [PointLike, PointLike];
  removed: Set<string>;
}

function forgetEdits(edit: PendingEdits): void {
  edit.replaced = null;
  edit.removed.clear();
}

/**
 * Forget the edits at the next microtask. The updates they apply to have run
 * their transforms by then: a command and the transforms of its update run
 * synchronously.
 */
function forgetSoon(edit: PendingEdits): void {
  Promise.resolve().then(() => forgetEdits(edit));
}

/**
 * Maintains the `markIDNodeKeys` output, and keeps text inserted next to a
 * marked run consistent with the documented rule (see
 * {@link $applyInsertedTextMarkIDs}). Mutation listeners are not used because
 * they do not run without a root element.
 *
 * The output is updated after each commit from the dirty leaves, so the cost
 * of an update is proportional to what it changed: removed leaves are found
 * under the removed dirty nodes of the previous state. A commit whose dirty
 * sets do not describe the change is compared with the previous state node
 * by node: a `setEditorState` (an undo or redo, or any other replacement of
 * the editor state), recognized from the root transform of that update or
 * from its tag. Only the nodes that are not the same object in both states
 * are read.
 *
 * After publishing a change, it reports the ids that appeared or disappeared
 * to the listeners of {@link registerMarkIDsListener}.
 */
function registerMarkState(
  flavor: MarkFlavor,
  editor: LexicalEditor,
  init: MarkStateInit,
  splits: SplitOrigins,
): () => void {
  const output = init.markIDNodeKeys;
  const idsByKey = new Map<NodeKey, readonly string[]>();
  const keysById = new Map<string, Set<NodeKey>>();
  let changed = false;
  let replacedState = false;
  let compositionBase: null | EditorState = null;
  // Set when an update tagged COLLABORATION_TAG (another editor's update)
  // changed the block of the composition while it was in progress: comparing
  // with `compositionBase` would then take that update's text for composed
  // text
  let compositionTainted = false;
  // The selection the composition started with, once its first update is
  // seen to have replaced it (see $getCompositionReplacedRange)
  let compositionReplaced: null | readonly [PointLike, PointLike] = null;
  const edit: PendingEdits = {
    removed: new Set(),
    replaced: null,
  };
  flavor.editsByEditor.set(editor, edit);
  const setKey = (key: NodeKey, ids: readonly string[]) => {
    const prev = idsByKey.get(key) || NO_IDS;
    if (flavor.state.isEqual(prev, ids)) {
      return;
    }
    changed = true;
    for (const id of prev) {
      const keys = keysById.get(id);
      if (keys && !ids.includes(id)) {
        keys.delete(key);
        if (keys.size === 0) {
          keysById.delete(id);
        }
      }
    }
    for (const id of ids) {
      let keys = keysById.get(id);
      if (!keys) {
        keys = new Set();
        keysById.set(id, keys);
      }
      keys.add(key);
    }
    if (ids.length > 0) {
      idsByKey.set(key, ids);
    } else {
      idsByKey.delete(key);
    }
  };
  const $visit = (key: NodeKey) => {
    const node = $getNodeByKey(key);
    setKey(key, $getMarkableIDs(flavor, node));
  };
  const $rescan = () => {
    const seen = new Set<NodeKey>();
    for (const leaf of $markableNodesIn(flavor, $getRoot())) {
      seen.add(leaf.getKey());
      setKey(leaf.getKey(), $readNodeMarkIDs(flavor, leaf));
    }
    for (const key of Array.from(idsByKey.keys())) {
      if (!seen.has(key)) {
        setKey(key, NO_IDS);
      }
    }
  };
  /**
   * Bring the output from `prevState` to `nextState` when the dirty sets do
   * not describe the change. A node that did not change is the same object
   * in both states (an undo restores a state that shares its unchanged
   * nodes with the current one), so only the others are read.
   */
  const rescanChanged = (prevState: EditorState, nextState: EditorState) => {
    // @internal access: the node maps, compared by identity
    const prevNodes = prevState._nodeMap;
    const nextNodes = nextState._nodeMap;
    nextState.read(
      () => {
        for (const [key, node] of nextNodes) {
          if (prevNodes.get(key) !== node) {
            setKey(
              key,
              $isMarkableNode(flavor, node) && node.isAttached()
                ? $readNodeMarkIDs(flavor, node)
                : NO_IDS,
            );
          }
        }
      },
      {editor},
    );
    for (const key of Array.from(idsByKey.keys())) {
      if (!nextNodes.has(key)) {
        setKey(key, NO_IDS);
      }
    }
  };
  const publish = (tags: ReadonlySet<string>) => {
    if (changed) {
      changed = false;
      const next = new Map<string, readonly NodeKey[]>();
      for (const [id, keys] of keysById) {
        next.set(id, Array.from(keys));
      }
      output.value = next;
      reportMarkIDs(init, tags);
    }
  };
  // Set when this registration is disposed (the flavor was disabled, or the
  // editor disposed): an update listener or transform that the editor had
  // already collected for the current commit must then do nothing
  let disposed = false;
  const $recordReplaced = () => {
    edit.replaced = $getReplacedRange($getSelection());
    forgetSoon(edit);
    return false;
  };
  editor.getEditorState().read($rescan, {editor});
  publish(new Set());
  // Also when nothing changed: the ids may have gone while it was disabled
  reportMarkIDs(init, new Set());
  return mergeRegister(
    editor.registerUpdateListener(
      ({editorState, prevEditorState, dirtyElements, dirtyLeaves, tags}) => {
        if (disposed) {
          return;
        }
        forgetEdits(edit);
        splits.clear();
        if (compositionBase !== null) {
          if (!editor.isComposing()) {
            compositionBase = null;
            compositionTainted = false;
            compositionReplaced = null;
          } else if (tags.has(COMPOSITION_START_TAG)) {
            compositionReplaced = $getCompositionReplacedRange(
              editor,
              compositionBase,
              editorState,
            );
          } else if (!compositionTainted && tags.has(COLLABORATION_TAG)) {
            compositionTainted = editorState.read(
              () => {
                // @internal access: the node being composed
                const key = editor._compositionKey;
                const node = key !== null ? $getNodeByKey(key) : null;
                const composing = node !== null ? $getBlock(node) : null;
                return (
                  composing === null || dirtyElements.has(composing.getKey())
                );
              },
              {editor},
            );
          }
        }
        if (
          replacedState ||
          tags.has(HISTORIC_TAG) ||
          (dirtyLeaves.size === 0 &&
            dirtyElements.size === 1 &&
            dirtyElements.has('root'))
        ) {
          replacedState = false;
          rescanChanged(prevEditorState, editorState);
          publish(tags);
          return;
        }
        if (dirtyLeaves.size === 0 && dirtyElements.size === 0) {
          return;
        }
        // The dirty nodes that this update removed: the markable nodes under
        // them in the previous state are gone too, unless they were moved
        // (which made them dirty leaves of their own)
        const removed: NodeKey[] = [];
        editorState.read(
          () => {
            for (const key of dirtyLeaves) {
              $visit(key);
              if ($getNodeByKey(key) === null) {
                removed.push(key);
              }
            }
            for (const key of dirtyElements.keys()) {
              const node = $getNodeByKey(key);
              if (node === null) {
                removed.push(key);
              } else if ($isMarkableNode(flavor, node)) {
                setKey(key, $readNodeMarkIDs(flavor, node));
              }
            }
          },
          {editor},
        );
        if (removed.length > 0) {
          const gone: NodeKey[] = [];
          prevEditorState.read(
            () => {
              for (const key of removed) {
                const node = $getNodeByKey(key);
                if (node !== null) {
                  for (const leaf of $markableNodesIn(flavor, node)) {
                    gone.push(leaf.getKey());
                  }
                }
              }
            },
            {editor},
          );
          editorState.read(
            () => {
              for (const key of gone) {
                if ($getNodeByKey(key) === null) {
                  setKey(key, NO_IDS);
                }
              }
            },
            {editor},
          );
        }
        publish(tags);
      },
    ),
    editor.registerNodeTransform(RootNode, () => {
      if (disposed) {
        return;
      }
      // @internal access: nothing else tells a transform that this update is
      // a setEditorState, whose dirty sets the update listener cannot use and
      // which is not an edit
      if (editor._dirtyType === FULL_RECONCILE) {
        replacedState = true;
        return;
      }
      if (
        editor.isComposing() ||
        $hasUpdateTag(COLLABORATION_TAG) ||
        $hasUpdateTag(HISTORIC_TAG)
      ) {
        return;
      }
      if (compositionBase !== null) {
        // The end of a composition: the composed text is compared with the
        // document from before it, and replaces the selection it had. The
        // composed text is written into the TextNode the caret was in, which
        // may be one that existed, so a selection that the composition's
        // first update was seen to replace is known to be replaced
        if (!compositionTainted) {
          $applyInsertedTextMarkIDs(
            flavor,
            editor,
            compositionBase,
            compositionReplaced !== null
              ? compositionReplaced
              : compositionBase.read(() => $getReplacedRange($getSelection()), {
                  editor,
                }),
            edit.removed,
            splits,
            compositionReplaced !== null,
          );
        }
        return;
      }
      $applyInsertedTextMarkIDs(
        flavor,
        editor,
        editor.getEditorState(),
        edit.replaced,
        edit.removed,
        splits,
      );
    }),
    editor.registerCommand(
      COMPOSITION_START_COMMAND,
      () => {
        // Transforms skip the node being composed, so the composed text is
        // compared with the document from before the composition once it ends
        compositionBase = editor.getEditorState();
        compositionTainted = false;
        compositionReplaced = null;
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    ),
    // The selection that an insertion replaces, before the handler of the
    // command replaces it (a beforeinput event sets it from its target range
    // in the same update)
    editor.registerCommand(
      CONTROLLED_TEXT_INSERTION_COMMAND,
      $recordReplaced,
      COMMAND_PRIORITY_CRITICAL,
    ),
    editor.registerCommand(
      PASTE_COMMAND,
      $recordReplaced,
      COMMAND_PRIORITY_CRITICAL,
    ),
    () => {
      disposed = true;
      compositionBase = null;
      compositionReplaced = null;
      forgetEdits(edit);
      if (flavor.editsByEditor.get(editor) === edit) {
        flavor.editsByEditor.delete(editor);
      }
      // Not reported to the listeners: the ids are still in the document.
      // When the flavor is enabled again, the listeners get the net change.
      output.value = new Map();
    },
  );
}

/** The nearest ancestor of `node` (or `node` itself) that is a block. */
function $getBlock(node: LexicalNode): null | ElementNode {
  let current: null | LexicalNode = node;
  while (current !== null) {
    if ($isElementNode(current) && !current.isInline()) {
      return current;
    }
    current = current.getParent();
  }
  return null;
}

/**
 * The leaf next to `node` in `direction` within its block, looking through
 * the boundaries of inline elements such as links: the last leaf of a
 * preceding link, or the leaf after the link that `node` ends. An empty
 * inline element is returned as is (it carries no ids).
 */
function $getAdjacentLeaf(
  node: LexicalNode,
  direction: 'previous' | 'next',
): null | LexicalNode {
  let current: LexicalNode = node;
  for (;;) {
    const sibling =
      direction === 'previous'
        ? current.getPreviousSibling()
        : current.getNextSibling();
    if (sibling === null) {
      const parent = current.getParent();
      if ($isElementNode(parent) && parent.isInline()) {
        current = parent;
        continue;
      }
      return null;
    }
    let leaf: LexicalNode = sibling;
    while ($isElementNode(leaf) && leaf.isInline()) {
      const child: null | LexicalNode =
        direction === 'previous' ? leaf.getLastChild() : leaf.getFirstChild();
      if (child === null) {
        break;
      }
      leaf = child;
    }
    return leaf;
  }
}

/**
 * A character of a markable TextNode (a code point, so that a surrogate pair
 * is never split), or a run of characters of one TextNode that both states
 * share at the start or the end of the compared text (see
 * {@link flattenSide})
 */
const CHAR = 0;
/** A markable leaf that is not a TextNode (a LineBreakNode, a decorator) */
const LEAF = 1;
/** The boundary between two blocks */
const BREAK = 2;
/** Anything else: a nested block, a leaf that cannot carry ids */
const OPAQUE = 3;
type Kind = typeof CHAR | typeof LEAF | typeof BREAK | typeof OPAQUE;

/** A point to locate in the flattened units: the caret, or an end of a selection */
interface PointLike {
  key: NodeKey;
  offset: number;
  type: 'text' | 'element';
}

/**
 * The part of a block that is flattened: its children from `from` to `to`,
 * both included, or from its first child or to its last one when `null`.
 */
interface BlockWindow {
  block: ElementNode;
  from: null | LexicalNode;
  to: null | LexicalNode;
}

/**
 * A markable TextNode with its text, or one other unit. Positions in a run
 * of segments count each UTF-16 code unit of a text, and each other unit, as
 * one.
 */
interface Segment {
  /** How the unit compares, for a unit that is not a text */
  code: string;
  ids: readonly string[];
  kind: Kind;
  node: LexicalNode;
  /** The text of a TextNode, otherwise empty */
  text: string;
}

interface Segments {
  length: number;
  /** The position of each point that was asked for, -1 when it is not there */
  points: number[];
  segs: Segment[];
  /** The texts, with U+FFFF for each other unit */
  text: string;
  /** The code of each other unit, by position */
  codes: Map<number, string>;
}

/**
 * Units that the text inserted into them is found with. Two units are the
 * same when their codes are: a character when it is the same character, a
 * run of characters when it is the same run of the shared start or end, any
 * other unit when it is the same node.
 */
interface Flattened {
  codes: string[];
  kinds: Kind[];
  ids: (readonly string[])[];
  nodes: LexicalNode[];
  /** The offset of the unit in its node */
  offsets: number[];
  /** The index of each point that was asked for, -1 when it is not there */
  points: number[];
}

function toPointLike(point: PointType): PointLike {
  return {key: point.key, offset: point.offset, type: point.type};
}

/** The start and end of a selection that is not collapsed, otherwise `null` */
function $getReplacedRange(
  selection: null | BaseSelection,
): null | readonly [PointLike, PointLike] {
  if (!$isRangeSelection(selection) || selection.isCollapsed()) {
    return null;
  }
  const [start, end] = selection.isBackward()
    ? [selection.focus, selection.anchor]
    : [selection.anchor, selection.focus];
  return [toPointLike(start), toPointLike(end)];
}

/**
 * The text a composition puts in place of the selection it replaces until
 * the input method writes: nothing, or the core's placeholder (a zero width
 * or a non-breaking space, depending on the browser).
 */
const COMPOSITION_PLACEHOLDERS = ['', '\u200b', '\u00a0'];

/** How {@link $childrenText} writes a child that is not text: one unit. */
const NON_TEXT_UNIT = '\ufffc';

/**
 * The text of `block`'s children as {@link $offsetInBlock} counts it: an
 * inline element's text is its children's, and a child that is not text (a
 * decorator, a line break) is one unit, whatever its `getTextContent` (often
 * empty for a decorator, which would let a selection of it span nothing).
 * `getTextContent` would also put the text of the block's named slots in
 * front, and an inline element can add text of its own to its
 * `getTextContent`, neither of which a point in the children counts.
 */
function $childrenText(block: ElementNode): string {
  let text = '';
  for (const child of block.getChildren()) {
    if ($isElementNode(child)) {
      text += child.isInline() ? $childrenText(child) : child.getTextContent();
    } else {
      text += $isTextNode(child) ? child.getTextContent() : NON_TEXT_UNIT;
    }
  }
  return text;
}

/** The size of a leaf in {@link $childrenText}. */
function $unitSize(node: LexicalNode): number {
  return $isTextNode(node) ? node.getTextContentSize() : 1;
}

/**
 * The offset of `point` in the text of `block`'s children (see
 * {@link $childrenText}), or -1 when `block` holds a nested block before it
 * or does not hold the point.
 */
function $offsetInBlock(block: ElementNode, point: PointLike): number {
  let offset = 0;
  const $walk = (element: ElementNode): boolean => {
    if (point.type === 'element' && point.key === element.getKey()) {
      const children = element.getChildren();
      for (let i = 0; i < point.offset && i < children.length; i++) {
        if (!$add(children[i])) {
          return false;
        }
      }
      return true;
    }
    for (
      let child = element.getFirstChild();
      child !== null;
      child = child.getNextSibling()
    ) {
      if ($isTextNode(child) && child.getKey() === point.key) {
        offset += point.offset;
        return true;
      }
      if ($isElementNode(child)) {
        if (!child.isInline()) {
          offset = -1;
          return true;
        }
        if ($walk(child)) {
          return true;
        }
      } else {
        offset += $unitSize(child);
      }
    }
    return false;
  };
  const $add = (node: LexicalNode): boolean => {
    if ($isElementNode(node)) {
      if (!node.isInline()) {
        return false;
      }
      for (const child of node.getChildren()) {
        if (!$add(child)) {
          return false;
        }
      }
      return true;
    }
    offset += $unitSize(node);
    return true;
  };
  return $walk(block) ? offset : -1;
}

/**
 * The selection a composition started with (in `base`, the state from
 * before the composition), when the update that started it (`started`)
 * replaced it: its block's text is the text from before it without the
 * selection, with nothing or the core's placeholder in its place, and the
 * caret after that or the placeholder selected. Otherwise `null`, as for a
 * selection that was not
 * replaced (an application handler moved the caret, or handled the
 * composition's insertion another way) or that spans blocks.
 */
function $getCompositionReplacedRange(
  editor: LexicalEditor,
  base: EditorState,
  started: EditorState,
): null | readonly [PointLike, PointLike] {
  const before = base.read(
    () => {
      const range = $getReplacedRange($getSelection());
      if (range === null) {
        return null;
      }
      const startNode = $getNodeByKey(range[0].key);
      const endNode = $getNodeByKey(range[1].key);
      const block = startNode !== null ? $getBlock(startNode) : null;
      if (block === null || endNode === null || !block.is($getBlock(endNode))) {
        return null;
      }
      const start = $offsetInBlock(block, range[0]);
      const end = $offsetInBlock(block, range[1]);
      return start < 0 || end < start
        ? null
        : {
            block: block.getKey(),
            end,
            range,
            start,
            text: $childrenText(block),
          };
    },
    {editor},
  );
  if (before === null) {
    return null;
  }
  return started.read(
    () => {
      const selection = $getSelection();
      const block = $getNodeByKey(before.block);
      if (
        !$isRangeSelection(selection) ||
        !$isElementNode(block) ||
        !block.isAttached()
      ) {
        return null;
      }
      const anchor = $offsetInBlock(block, toPointLike(selection.anchor));
      const focus = $offsetInBlock(block, toPointLike(selection.focus));
      const text = $childrenText(block);
      const head = before.text.slice(0, before.start);
      const tail = before.text.slice(before.end);
      const selected = before.text.slice(before.start, before.end);
      for (const placeholder of COMPOSITION_PLACEHOLDERS) {
        // A selection that is the placeholder itself, kept by a start that
        // wrote nothing, would look replaced: leave it to the comparison
        if (placeholder !== '' && placeholder === selected) {
          continue;
        }
        const end = before.start + placeholder.length;
        if (
          text === head + placeholder + tail &&
          Math.max(anchor, focus) === end &&
          (Math.min(anchor, focus) === end ||
            Math.min(anchor, focus) === before.start)
        ) {
          return before.range;
        }
      }
      return null;
    },
    {editor},
  );
}

function $collectSegments(
  flavor: MarkFlavor,
  windows: readonly BlockWindow[],
  points: readonly PointLike[],
  $isUnchangedBlock: (node: ElementNode) => boolean,
): Segments {
  const out: Segments = {
    codes: new Map(),
    length: 0,
    points: points.map(() => -1),
    segs: [],
    text: '',
  };
  const texts: string[] = [];
  // The first segment of the current window, and whether the units that
  // follow need a boundary from a nested block before them
  let windowStart = 0;
  let afterNested = false;
  const add = (
    node: LexicalNode,
    kind: Kind,
    code: string,
    text: string,
    ids: readonly string[],
  ) => {
    if (afterNested) {
      afterNested = false;
      if (kind !== BREAK) {
        separate(node);
      }
    }
    out.segs.push({code, ids, kind, node, text});
    if (kind !== CHAR) {
      out.codes.set(out.length, code);
      text = '\uffff';
    }
    texts.push(text);
    out.length += text.length;
  };
  // A boundary between blocks, where units of the window precede it
  const separate = (node: LexicalNode) => {
    const last = out.segs.length > windowStart ? out.segs.at(-1) : undefined;
    if (last !== undefined && last.kind !== BREAK) {
      add(node, BREAK, '\u0000', '', NO_IDS);
    }
  };
  const locateElementPoints = (key: NodeKey, index: number) => {
    points.forEach((point, i) => {
      if (
        point.type === 'element' &&
        point.key === key &&
        point.offset === index
      ) {
        out.points[i] = out.length;
      }
    });
  };
  const $visitChildren = (
    element: ElementNode,
    from: null | LexicalNode,
    to: null | LexicalNode,
  ) => {
    const key = element.getKey();
    // The index of the child is only needed for an element point in it
    let index = points.some(
      point => point.type === 'element' && point.key === key,
    )
      ? from !== null
        ? from.getIndexWithinParent()
        : 0
      : -1;
    for (
      let child = from !== null ? from : element.getFirstChild();
      child !== null;
      child = child.getNextSibling()
    ) {
      if (index >= 0) {
        locateElementPoints(key, index++);
      }
      $visitNode(child);
      if (to !== null && child.is(to)) {
        break;
      }
    }
    if (index >= 0) {
      locateElementPoints(key, index);
    }
  };
  const $visitNode = (node: LexicalNode) => {
    const key = node.getKey();
    if ($isTextNode(node) && $isMarkableNode(flavor, node)) {
      const text = node.getTextContent();
      points.forEach((point, i) => {
        if (
          point.type === 'text' &&
          point.key === key &&
          point.offset <= text.length
        ) {
          out.points[i] = out.length + point.offset;
        }
      });
      add(node, CHAR, '', text, $readNodeMarkIDs(flavor, node));
    } else if ($isMarkableNode(flavor, node)) {
      add(node, LEAF, '\u0002' + key, '', $readNodeMarkIDs(flavor, node));
    } else if ($isElementNode(node) && node.isInline()) {
      $visitChildren(node, null, null);
    } else if ($isElementNode(node) && !$isUnchangedBlock(node)) {
      // A nested block that the update changed (the items of a list, a list
      // in a list item): its text is compared like the text of the blocks
      // around it, so that text that an edit moves out of it or into it, or
      // re-creates there, is found. Boundaries separate it from the units
      // around it, as they separate the windows, and not from the start or
      // end of the window. An unchanged one is a unit of its own.
      separate(node);
      $visitChildren(node, null, null);
      afterNested = true;
    } else {
      add(node, OPAQUE, '\u0001' + key, '', NO_IDS);
    }
  };
  windows.forEach(({block, from, to}, i) => {
    afterNested = false;
    if (i > 0) {
      add(block, BREAK, '\u0000', '', NO_IDS);
    }
    windowStart = out.segs.length;
    $visitChildren(block, from, to);
  });
  out.text = texts.join('');
  return out;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * How many positions at the start of `a` and `b` (or at their end, when
 * `fromEnd`) are the same, at most `limit`, without ending inside a
 * surrogate pair.
 */
function sameEnd(
  a: Segments,
  b: Segments,
  limit: number,
  fromEnd: boolean,
): number {
  const at = (side: Segments, k: number) => (fromEnd ? side.length - 1 - k : k);
  let k = 0;
  for (; k < limit; k++) {
    const code = a.text.charCodeAt(at(a, k));
    if (
      code !== b.text.charCodeAt(at(b, k)) ||
      (code === 0xffff && a.codes.get(at(a, k)) !== b.codes.get(at(b, k)))
    ) {
      break;
    }
  }
  const last = k > 0 ? a.text.charCodeAt(at(a, k - 1)) : 0;
  return (fromEnd ? isLowSurrogate(last) : isHighSurrogate(last)) ? k - 1 : k;
}

/** The positions where the segments of `side` end */
function segmentEnds(side: Segments): number[] {
  let position = 0;
  return side.segs.map(
    seg => (position += seg.kind === CHAR ? seg.text.length : 1),
  );
}

/**
 * Flatten `side` into units: a unit per character, except in the first
 * `prefix` and the last `suffix` positions, which both sides share. There a
 * run of characters is one unit, cut where a segment of either side ends, so
 * that the two sides have the same units there and each unit is in one
 * node. A keystroke in a long TextNode then costs a comparison of its text
 * rather than units for each of its characters.
 */
function flattenSide(
  side: Segments,
  other: Segments,
  prefix: number,
  suffix: number,
): Flattened {
  const out: Flattened = {
    codes: [],
    ids: [],
    kinds: [],
    nodes: [],
    offsets: [],
    points: side.points.map(() => -1),
  };
  const suffixStart = side.length - suffix;
  // Where a shared run is cut, in the positions of `side`
  const cutSet = new Set<number>();
  segmentEnds(side).forEach(end => cutSet.add(end));
  for (const end of segmentEnds(other)) {
    if (end < prefix) {
      cutSet.add(end);
    } else if (end > other.length - suffix) {
      cutSet.add(end - other.length + side.length);
    }
  }
  cutSet.add(prefix);
  cutSet.add(suffixStart);
  const cuts = Array.from(cutSet).sort((x, y) => x - y);
  let cut = 0;
  const starts: number[] = [];
  const push = (
    code: string,
    kind: Kind,
    node: LexicalNode,
    offset: number,
    ids: readonly string[],
    start: number,
  ) => {
    out.codes.push(code);
    out.kinds.push(kind);
    out.nodes.push(node);
    out.offsets.push(offset);
    out.ids.push(ids);
    starts.push(start);
  };
  let position = 0;
  for (const {code, ids, kind, node, text} of side.segs) {
    if (kind !== CHAR) {
      push(code, kind, node, 0, ids, position++);
      continue;
    }
    for (let offset = 0; offset < text.length; ) {
      const at = position + offset;
      if (at < prefix || at >= suffixStart) {
        while (cuts[cut] <= at) {
          cut++;
        }
        const end = Math.min(cuts[cut], position + text.length);
        push(
          at < prefix ? '\u0003' + at : '\u0004' + (side.length - at),
          CHAR,
          node,
          offset,
          ids,
          at,
        );
        offset = end - position;
      } else {
        const size =
          isHighSurrogate(text.charCodeAt(offset)) &&
          isLowSurrogate(text.charCodeAt(offset + 1))
            ? 2
            : 1;
        push(text.slice(offset, offset + size), CHAR, node, offset, ids, at);
        offset += size;
      }
    }
    position += text.length;
  }
  side.points.forEach((point, i) => {
    if (point >= 0) {
      let index = 0;
      while (index < starts.length && starts[index] < point) {
        index++;
      }
      out.points[i] = index;
    }
  });
  return out;
}

/** The ids in both `a` and `b`. */
function intersect(
  a: readonly string[],
  b: readonly string[],
): readonly string[] {
  return a.length === 0 || b.length === 0
    ? NO_IDS
    : a.filter(id => b.includes(id));
}

/** The ids in `a` that are not in `removed`. */
function without(
  a: readonly string[],
  removed: ReadonlySet<string>,
): readonly string[] {
  return removed.size === 0 || !a.some(id => removed.has(id))
    ? a
    : a.filter(id => !removed.has(id));
}

/** The ids in `a` or `b`, sorted. */
function union(a: readonly string[], b: readonly string[]): readonly string[] {
  if (b.length === 0) {
    return a;
  }
  if (a.length === 0) {
    return b;
  }
  return Array.from(new Set([...a, ...b])).sort();
}

/**
 * The largest number of unit pairs {@link matchUnits} compares. A change
 * that is larger and is not a replaced selection is taken as one replacement.
 */
const MATCH_BUDGET = 250_000;

/**
 * The longest common subsequence of `a[a0, a1)` and `b[b0, b1)`, as the
 * index pairs it matches (taking the earliest matches, so that inserted
 * units come as late as they can), or `null` when there are too many units
 * to compare.
 */
function matchUnits(
  a: readonly string[],
  a0: number,
  a1: number,
  b: readonly string[],
  b0: number,
  b1: number,
): null | [number, number][] {
  const n = a1 - a0;
  const m = b1 - b0;
  if (n === 0 || m === 0) {
    return [];
  }
  if (n * m > MATCH_BUDGET) {
    return null;
  }
  const width = m + 1;
  // lengths[i * width + j]: the length of the LCS of a[a0 + i, a1) and
  // b[b0 + j, b1)
  const lengths = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[a0 + i] === b[b0 + j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[a0 + i] === b[b0 + j]) {
      pairs.push([a0 + i, b0 + j]);
      i++;
      j++;
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * Whether ids were ever set on `node`, or on the node it was split or copied
 * from. A TextNode that the core or a transform creates from scratch to hold
 * existing text (a hashtag, a segmented node turned into text) has none.
 */
function $hasMarkIDsState(flavor: MarkFlavor, node: LexicalNode): boolean {
  // @internal access: NodeState does not expose whether a value was set
  const state = node.getLatest().__state;
  return (
    state !== undefined &&
    (state.knownState.has(flavor.state) ||
      (state.unknownState !== undefined &&
        flavor.stateKey in state.unknownState))
  );
}

/**
 * Whether `splitText` cuts `node` into nodes of its own class: a TextNode in
 * normal mode that is a TextNode, or of the class that replaces TextNode in
 * this editor (a node replacement), since the pieces after the first are
 * created with `$createTextNode`. The pieces of another subclass (a hashtag,
 * a code token) would be plain text, which its transforms merge back.
 */
function $splitsIntoOwnClass(node: TextNode): boolean {
  return (
    node.getMode() === 'normal' &&
    (node.isSimpleText() ||
      // An unattached node, garbage collected with the update
      $createTextNode('').constructor === node.constructor)
  );
}

/**
 * Set the ids of the units `[start, end)` of `flat`, which are all the units
 * of one node, to `ids[start, end)`. A TextNode is split where they differ
 * when its pieces are of its own class; another TextNode (a token or
 * segmented node, a hashtag, a code token) gets all of them, so that none of
 * its text loses an id it had.
 */
function $setUnitIDs(
  flavor: MarkFlavor,
  flat: Flattened,
  ids: readonly (readonly string[])[],
  start: number,
  end: number,
  splits: SplitOrigins,
): void {
  const {state} = flavor;
  const node = flat.nodes[start];
  if (!$isTextNode(node)) {
    $setState(node, state, ids[start]);
    return;
  }
  const offsets: number[] = [];
  for (let i = start + 1; i < end; i++) {
    if (!state.isEqual(ids[i], ids[i - 1])) {
      offsets.push(flat.offsets[i]);
    }
  }
  if (offsets.length > 0 && !$splitsIntoOwnClass(node)) {
    let all = NO_IDS;
    for (let i = start; i < end; i++) {
      all = union(all, ids[i]);
    }
    if (!state.isEqual($readNodeMarkIDs(flavor, node), all)) {
      $setState(node, state, all);
    }
    return;
  }
  const parts = offsets.length > 0 ? node.splitText(...offsets) : [node];
  // The other flavors must not take the pieces for inserted content: they
  // carry copies of the other flavors' ids of the node they were cut from
  for (let p = 1; p < parts.length; p++) {
    splits.set(parts[p].getKey(), {flavor, origin: node.getKey()});
  }
  let i = start;
  for (const part of parts) {
    if (!state.isEqual($readNodeMarkIDs(flavor, part), ids[i])) {
      $setState(part, state, ids[i]);
    }
    // The next part starts where the ids change
    do {
      i++;
    } while (i < end && state.isEqual(ids[i], ids[i - 1]));
  }
}

/**
 * The offsets `[start, end)` of `text` that are not in `prevText`, the text
 * that the same TextNode had: what an edit inserted between the text it kept
 * at each end. With `caret` (an offset in `text`, -1 when the caret is
 * elsewhere), the insertion ends at the caret when the text after the caret
 * is the end of `prevText`. Neither end splits a surrogate pair.
 */
function getInsertedRange(
  prevText: string,
  text: string,
  caret: number,
): readonly [number, number] {
  let end = -1;
  let maxStart = Math.min(prevText.length, text.length);
  if (caret >= 0 && prevText.endsWith(text.slice(caret))) {
    end = caret;
    maxStart = Math.min(caret, prevText.length - (text.length - caret));
  }
  let start = 0;
  while (
    start < maxStart &&
    prevText.charCodeAt(start) === text.charCodeAt(start)
  ) {
    start++;
  }
  if (start > 0 && isHighSurrogate(text.charCodeAt(start - 1))) {
    start--;
  }
  if (end < 0) {
    let suffix = 0;
    const maxSuffix = Math.min(prevText.length, text.length) - start;
    while (
      suffix < maxSuffix &&
      prevText.charCodeAt(prevText.length - 1 - suffix) ===
        text.charCodeAt(text.length - 1 - suffix)
    ) {
      suffix++;
    }
    end = text.length - suffix;
    if (end < text.length && isLowSurrogate(text.charCodeAt(end))) {
      end++;
    }
  }
  return [start, end];
}

/**
 * Give the text a local edit inserted the ids the documented rule says it
 * has, whatever TextNode the core put it in, and give text that the edit
 * re-created back its ids:
 *
 * - Inserted text gets the ids shared by the units right before and right
 *   after it, within its block: text inserted inside a marked run joins it,
 *   text inserted at its edge does not.
 * - When it replaces a selection, also the ids all of the replaced text had.
 * - Its own ids: those of the nodes it came in (pasted or otherwise inserted
 *   nodes). Text inserted into a node that existed has none, also when a
 *   transform split it off into a copy of that node (`$isSplitOffEntity`).
 * - Text that was not deleted keeps its ids, also when the core or a
 *   transform moved it into a new TextNode that has none (a hashtag, a
 *   segmented node turned into text, the text around a replaced selection),
 *   and when the update moved a leaf that existed (a block type or list
 *   change moving its text into another block): a leaf that kept its text
 *   keeps its ids, and a TextNode that also changed keeps them on the text
 *   it kept at each end (see {@link getInsertedRange}).
 * - None of this gives back an id in `removed` (removed with
 *   {@link $removeMarkID} in this update).
 *
 * The change is found by comparing the units around the caret with the same
 * units in `prevState`. Only the children of the blocks that the update
 * changed are compared: a child that is the same object in both states is
 * unchanged, and one on each side bounds the comparison. A nested block
 * among them (the items of a list) is compared by its text, like the blocks
 * around it. Text in a leaf that existed and that the comparison cannot
 * line up with its previous place, because the update moved it from a
 * block outside the compared ones, keeps its ids (see `$isKeptUnit`). Within
 * them, the
 * text both states share at the start and at the end is a few units (see
 * {@link flattenSide}), so the cost is a scan of the changed TextNodes and
 * units for the changed text only. The change ends at the caret (what
 * follows the caret is what followed the change), and starts at the end of
 * the common prefix, or at the start of the selection it replaced. That
 * selection is `replaced`: the selection when an insertion or paste command
 * was last dispatched, or the one a composition started with. It is only
 * used when the text in its place is in new TextNodes, as the core inserts
 * it, so a handler that wrapped the selection instead is not taken for one
 * that replaced it, or when `replacedForSure` says that it was replaced
 * (the selection a composition started with, which the update that started
 * the composition was seen to replace, see
 * {@link $getCompositionReplacedRange}: the composed text is then written
 * into the TextNode the caret is in, often one that existed).
 * Without it (text replaced by code that dispatches no
 * command), the longest common subsequence of the two sides of the change
 * tells the units that were kept from those that were inserted or deleted.
 *
 * This needs no knowledge of how the text was inserted (typing, native
 * input, composition, paste, or any code that edits TextNodes and leaves the
 * caret after its insertion), and it runs as a root transform, after every
 * TextNode has been normalized.
 */
function $applyInsertedTextMarkIDs(
  flavor: MarkFlavor,
  editor: LexicalEditor,
  prevState: EditorState,
  replaced: null | readonly [PointLike, PointLike],
  removed: ReadonlySet<string>,
  splits: SplitOrigins,
  replacedForSure = false,
): void {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return;
  }
  const caret = selection.anchor;
  const caretNode = caret.getNode();
  const block = $getBlock(caretNode);
  if (block === null) {
    return;
  }
  // @internal access: a node that this update did not change is the same
  // object in both states
  const prevNodes = prevState._nodeMap;
  const $isUnchangedInline = (element: ElementNode): boolean => {
    let hasUnits = false;
    for (
      let child = element.getFirstChild();
      child !== null;
      child = child.getNextSibling()
    ) {
      if (prevNodes.get(child.getKey()) !== child) {
        return false;
      }
      if ($isElementNode(child) && child.isInline()) {
        if (!$isUnchangedInline(child)) {
          return false;
        }
        hasUnits = true;
      } else if (!$isTextNode(child) || child.getTextContentSize() > 0) {
        hasUnits = true;
      }
    }
    return hasUnits;
  };
  // A child of a block that bounds the comparison: unchanged, with units
  const $isContext = (node: LexicalNode): boolean => {
    if (prevNodes.get(node.getKey()) !== node) {
      return false;
    }
    if ($isTextNode(node)) {
      return node.getTextContentSize() > 0;
    }
    return (
      !($isElementNode(node) && node.isInline()) || $isUnchangedInline(node)
    );
  };
  const $expand = (
    start: null | LexicalNode,
    direction: 'previous' | 'next',
  ): null | LexicalNode => {
    let node = start;
    while (node !== null && !$isContext(node)) {
      node =
        direction === 'previous'
          ? node.getPreviousSibling()
          : node.getNextSibling();
    }
    return node;
  };
  // The children of the caret's block around the caret that may have
  // changed, bounded by an unchanged child on each side (or the block's ends)
  let left: null | LexicalNode;
  let right: null | LexicalNode;
  if (caret.type === 'element' && caret.key === block.getKey()) {
    right = block.getChildAtIndex(caret.offset);
    left = right !== null ? right.getPreviousSibling() : block.getLastChild();
  } else {
    let top: LexicalNode = caretNode;
    for (
      let parent = top.getParent();
      parent !== null && !parent.is(block);
      parent = top.getParent()
    ) {
      top = parent;
    }
    left = top.getPreviousSibling();
    right = top.getNextSibling();
  }
  const from = $expand(left, 'previous');
  const to = $expand(right, 'next');
  // The blocks around the caret that may have changed: from the nearest one
  // at or before it that existed before the update, up to the next one that
  // did and did not lose its first children to the blocks before it (as a
  // list does when its first item is turned into a paragraph: the list
  // holds the previous place of their text)
  const $isNextBoundary = (node: LexicalNode): boolean => {
    const key = node.getKey();
    if (!prevNodes.has(key)) {
      return false;
    }
    const firstChild = $isElementNode(node) ? node.getFirstChild() : null;
    return (
      prevNodes.get(key) === node ||
      firstChild === null ||
      prevNodes.get(firstChild.getKey()) === firstChild
    );
  };
  const parent = block.getParent();
  let first: null | LexicalNode = block;
  let next: null | LexicalNode = null;
  if (parent !== null) {
    while (first !== null && !prevNodes.has(first.getKey())) {
      first = first.getPreviousSibling();
    }
    next = block.getNextSibling();
    while (next !== null && !$isNextBoundary(next)) {
      next = next.getNextSibling();
    }
  } else if (!prevNodes.has(block.getKey())) {
    return;
  }
  const windows: BlockWindow[] = [];
  for (
    let current: null | LexicalNode =
      first !== null ? first : parent!.getFirstChild();
    current !== null && current !== next;
    current = current.getNextSibling()
  ) {
    if (!$isElementNode(current)) {
      return;
    }
    const isCaretBlock = current.is(block);
    let windowFrom: null | LexicalNode = null;
    if (windows.length === 0 && first !== null) {
      windowFrom = isCaretBlock
        ? from
        : $expand(current.getLastChild(), 'previous');
    }
    windows.push({
      block: current,
      from: windowFrom,
      to: isCaretBlock ? to : null,
    });
    if ((isCaretBlock && to !== null) || parent === null) {
      // What follows an unchanged child after the caret is not compared
      break;
    }
  }
  // A nested block that is the same object in both states, with nothing in
  // it changed by this update: compared as one unit, without reading it
  // @internal access: the elements this update changed or changed inside
  const dirtyElements = editor._dirtyElements;
  // @internal access: the node map of the pending state
  const nextNodes = editor._pendingEditorState!._nodeMap;
  const $isUnchangedBlock = (node: ElementNode) => {
    const key = node.getKey();
    const prevNode = prevNodes.get(key);
    return (
      prevNode !== undefined &&
      prevNode === nextNodes.get(key) &&
      !dirtyElements.has(key)
    );
  };
  const afterSegments = $collectSegments(
    flavor,
    windows,
    [caret],
    $isUnchangedBlock,
  );
  const firstKey = first !== null ? first.getKey() : null;
  const nextKey = next !== null ? next.getKey() : null;
  const parentKey = parent !== null ? parent.getKey() : null;
  const blockKey = block.getKey();
  const fromKey = windows[0].from !== null ? windows[0].from.getKey() : null;
  const lastWindow = windows[windows.length - 1];
  const toKey = lastWindow.to !== null ? lastWindow.to.getKey() : null;
  const beforeSegments = prevState.read(
    () => {
      const prevWindows: BlockWindow[] = [];
      let current: null | LexicalNode;
      if (firstKey !== null) {
        current = $getNodeByKey(firstKey);
        const prevParent = current && current.getParent();
        if ((prevParent ? prevParent.getKey() : null) !== parentKey) {
          return null;
        }
      } else {
        const prevParent = parentKey !== null ? $getNodeByKey(parentKey) : null;
        if (!$isElementNode(prevParent)) {
          return null;
        }
        current = prevParent.getFirstChild();
      }
      let reachedTo = false;
      for (; current !== null; current = current.getNextSibling()) {
        if (current.getKey() === nextKey) {
          break;
        }
        if (!$isElementNode(current)) {
          return null;
        }
        const prevWindow: BlockWindow = {block: current, from: null, to: null};
        if (prevWindows.length === 0 && fromKey !== null) {
          // Unchanged, so in the same block as in the pending state
          prevWindow.from = $getNodeByKey(fromKey);
          if (
            prevWindow.from === null ||
            !current.is(prevWindow.from.getParent())
          ) {
            return null;
          }
        }
        prevWindows.push(prevWindow);
        if (toKey !== null && current.getKey() === blockKey) {
          prevWindow.to = $getNodeByKey(toKey);
          if (
            prevWindow.to === null ||
            !current.is(prevWindow.to.getParent())
          ) {
            return null;
          }
          reachedTo = true;
          break;
        }
        if (parentKey === null) {
          break;
        }
      }
      if (toKey !== null ? !reachedTo : nextKey !== null && current === null) {
        return null;
      }
      return $collectSegments(
        flavor,
        prevWindows,
        replaced || [],
        $isUnchangedBlock,
      );
    },
    {editor},
  );
  const caretAt = afterSegments.points[0];
  if (beforeSegments === null || caretAt < 0) {
    return;
  }
  // The text both sides share at the start and the end is compared as a few
  // units. Those stay outside the change: the start before the caret and
  // before what follows the caret in the previous state, the end after both,
  // and both outside the replaced selection.
  let suffixLimit = afterSegments.length - caretAt;
  let prefixLimit = Math.max(
    0,
    Math.min(caretAt, beforeSegments.length - suffixLimit),
  );
  const [replacedStart, replacedEnd] = beforeSegments.points;
  if (replacedStart >= 0 && replacedEnd >= 0) {
    prefixLimit = Math.min(prefixLimit, replacedStart);
    suffixLimit = Math.min(suffixLimit, beforeSegments.length - replacedEnd);
  }
  const prefix = sameEnd(afterSegments, beforeSegments, prefixLimit, false);
  const suffix = sameEnd(
    afterSegments,
    beforeSegments,
    Math.min(
      suffixLimit,
      Math.min(afterSegments.length, beforeSegments.length) - prefix,
    ),
    true,
  );
  const after = flattenSide(afterSegments, beforeSegments, prefix, suffix);
  const before = flattenSide(beforeSegments, afterSegments, prefix, suffix);
  const c = after.points[0];
  const n = after.codes.length;
  const m = before.codes.length;
  // Anchored at the caret: what follows it is what followed the change
  const k = n - c;
  if (k > m) {
    return;
  }
  for (let i = 1; i <= k; i++) {
    if (after.codes[n - i] !== before.codes[m - i]) {
      return;
    }
  }
  const e = m - k;
  let s = 0;
  while (s < c && s < e && after.codes[s] === before.codes[s]) {
    s++;
  }
  // @internal access: the keys of the TextNodes merged by this update
  const normalized = editor._normalizedNodes;
  let absorbedNew = false;
  for (const key of normalized) {
    if (!prevNodes.has(key)) {
      const node = $getNodeByKey(key);
      if (node === null || !node.isAttached()) {
        absorbedNew = true;
        break;
      }
    }
  }
  // A node that did not exist before the update brought its ids with it,
  // and so did a node that absorbed one when normalization merged them
  // (which it only does for nodes with the same ids). A piece that another
  // flavor's rule cut off a node in this update is as new as that node.
  const $isNewText = (node: LexicalNode) => {
    const key = getSplitOrigin(splits, flavor, node.getKey());
    return !prevNodes.has(key) || (absorbedNew && normalized.has(key));
  };
  // The replaced selection, when the text in its place is new text: the
  // core puts the text that replaces a selection in a new TextNode, so a
  // handler that wrapped the selection instead is not mistaken for one
  // (unless it is known to be replaced, see `replacedForSure`)
  let replacedSelection = false;
  if (replaced !== null) {
    const [start, end] = before.points;
    if (start >= 0 && end > start && end === e && start <= s) {
      replacedSelection = true;
      for (let i = start; i < c && replacedSelection && !replacedForSure; i++) {
        replacedSelection = after.kinds[i] > LEAF || $isNewText(after.nodes[i]);
      }
      if (replacedSelection) {
        s = start;
      }
    }
  }
  // The nearest previous sibling of a node that existed before the update,
  // by key, for the nodes that did not
  const origins = new Map<NodeKey, null | LexicalNode>();
  const $getOrigin = (node: LexicalNode): null | LexicalNode => {
    const keys: NodeKey[] = [];
    let origin = node.getPreviousSibling();
    while (origin !== null && !prevNodes.has(origin.getKey())) {
      const known = origins.get(origin.getKey());
      if (known !== undefined) {
        origin = known;
        break;
      }
      keys.push(origin.getKey());
      origin = origin.getPreviousSibling();
    }
    for (const key of keys) {
      origins.set(key, origin);
    }
    return origin;
  };
  // Whether `node` is text that a transform split off a TextNode that
  // existed, of another class than the pieces `splitText` creates (a text
  // entity: a hashtag, a mention), with the text inserted at its end, which
  // no longer belongs to it. `splitText` creates such a piece with
  // `$createTextNode` and a copy of the ids of that node, after it (and
  // after its other pieces). Those ids are not the inserted text's own.
  const splitOff = new Map<NodeKey, boolean>();
  const $isSplitOffEntity = (node: LexicalNode): boolean => {
    const key = node.getKey();
    let result = splitOff.get(key);
    if (result === undefined) {
      const origin =
        $isTextNode(node) && !prevNodes.has(key) ? $getOrigin(node) : null;
      result =
        $isTextNode(origin) &&
        origin.constructor !== node.constructor &&
        // The same value: `splitText` cloned the node's state into the
        // piece in this update. Inserted nodes bring ids of their own, even
        // equal ones (pasted, dropped, inserted or marked by code).
        $readNodeMarkIDs(flavor, origin) === $readNodeMarkIDs(flavor, node) &&
        // An unattached node, garbage collected with the update
        $createTextNode('').constructor === node.constructor;
      splitOff.set(key, result);
    }
    return result;
  };
  const ids = after.ids.slice();
  // A kept character in a TextNode that the update created without ids
  // (or one that absorbed such a node) was re-created: it keeps its ids
  const $keep = (i: number, j: number) => {
    if (
      after.kinds[i] === CHAR &&
      ids[i].length === 0 &&
      before.ids[j].length > 0
    ) {
      const node = after.nodes[i];
      const key = node.getKey();
      if (
        key !== before.nodes[j].getKey() &&
        ((!prevNodes.has(key) && !$hasMarkIDsState(flavor, node)) ||
          (absorbedNew && normalized.has(key)))
      ) {
        ids[i] = without(before.ids[j], removed);
      }
    }
  };
  for (let i = 0; i < s; i++) {
    $keep(i, i);
  }
  for (let i = c; i < n; i++) {
    $keep(i, i - c + e);
  }
  // The inserted runs [i0, i1), each with the run [j0, j1) of `before` it
  // replaced
  const gaps: [number, number, number, number][] = [];
  const pairs = replacedSelection
    ? []
    : matchUnits(after.codes, s, c, before.codes, s, e);
  let i0 = s;
  let j0 = s;
  for (const [i, j] of pairs || []) {
    if (i > i0 || j > j0) {
      gaps.push([i0, i, j0, j]);
    }
    $keep(i, j);
    i0 = i + 1;
    j0 = j + 1;
  }
  if (c > i0 || e > j0) {
    gaps.push([i0, c, j0, e]);
  }
  const unitIDs = (i: number): readonly string[] =>
    i >= 0 && i < n && after.kinds[i] <= LEAF ? ids[i] : NO_IDS;
  // The leaves whose text in `prevState` is part of `before`
  const compared = new Set<NodeKey>();
  for (const node of before.nodes) {
    compared.add(node.getKey());
  }
  // For a TextNode that existed, with other text, outside the compared
  // blocks: the offsets [start, end) of its text that are not in the text it
  // had, anchored at the caret when it holds the caret
  const insertedRanges = new Map<NodeKey, readonly [number, number]>();
  const $getInsertedRange = (node: TextNode, prevText: string) => {
    const key = node.getKey();
    let range = insertedRanges.get(key);
    if (range === undefined) {
      range = getInsertedRange(
        prevText,
        node.getTextContent(),
        caret.type === 'text' && caret.key === key ? caret.offset : -1,
      );
      insertedRanges.set(key, range);
    }
    return range;
  };
  // Whether unit `i`, in a gap, is text that was there before the update
  // rather than inserted by it. A leaf that existed (with the same text, for
  // a TextNode) holds no inserted text wherever the update moved it, and the
  // comparison takes it for inserted text when it moved in from a block that
  // is not compared (out of a list item, into a list it merges with) or lines
  // up with equal text elsewhere. A TextNode that also changed and comes from
  // outside the compared blocks keeps the text at its ends that it had.
  const $isKeptUnit = (i: number): boolean => {
    const node = after.nodes[i];
    const prevNode = prevNodes.get(node.getKey());
    if (prevNode === undefined) {
      return false;
    }
    if (!$isTextNode(node) || !$isTextNode(prevNode)) {
      return true;
    }
    // @internal access: the text of the node in `prevState` (its methods
    // read the pending version)
    const prevText = prevNode.__text;
    if (prevText === node.getTextContent()) {
      return true;
    }
    if (compared.has(node.getKey())) {
      return false;
    }
    const [start, end] = $getInsertedRange(node, prevText);
    return after.offsets[i] < start || after.offsets[i] >= end;
  };
  for (const [g0, g1, r0, r1] of gaps) {
    if (g1 === g0) {
      continue;
    }
    const kept: boolean[] = [];
    for (let i = g0; i < g1; i++) {
      kept.push(after.kinds[i] <= LEAF && $isKeptUnit(i));
    }
    // The ids every replaced unit had (line breaks between blocks aside)
    let replacedIDs: null | readonly string[] = null;
    for (let j = r0; j < r1; j++) {
      if (before.kinds[j] !== BREAK) {
        const unit = before.kinds[j] <= LEAF ? before.ids[j] : NO_IDS;
        replacedIDs =
          replacedIDs === null ? unit : intersect(replacedIDs, unit);
      }
    }
    // Each run of inserted units between kept ones (the whole gap, when it
    // holds none) is an insertion
    for (let start = g0; start < g1; ) {
      if (kept[start - g0]) {
        start++;
        continue;
      }
      let end = start + 1;
      while (end < g1 && !kept[end - g0]) {
        end++;
      }
      let shared = intersect(unitIDs(start - 1), unitIDs(end));
      if (replacedIDs !== null) {
        shared = union(shared, without(replacedIDs, removed));
      }
      for (let i = start; i < end; i++) {
        if (after.kinds[i] <= LEAF) {
          // Text inserted into a node that existed, or split off one, has no
          // ids of its own
          const node = after.nodes[i];
          const own =
            $isNewText(node) &&
            after.ids[i].length > 0 &&
            !$isSplitOffEntity(node)
              ? after.ids[i]
              : NO_IDS;
          ids[i] = union(own, shared);
        }
      }
      start = end;
    }
  }
  for (let i = 0; i < n; ) {
    let end = i + 1;
    while (end < n && after.nodes[end] === after.nodes[i]) {
      end++;
    }
    for (let u = i; u < end; u++) {
      if (
        after.kinds[u] <= LEAF &&
        !flavor.state.isEqual(ids[u], after.ids[u])
      ) {
        $setUnitIDs(flavor, after, ids, i, end, splits);
        break;
      }
    }
    i = end;
  }
}

/**
 * Make the StateConfig of a flavor (`markIds` for MarkStateExtension) known
 * to every node type of the editor, as using it on a node of that type
 * would, so that ids read from JSON or applied with `updateFromUnknown` are
 * parsed right away, and code that reads the StateConfig of a node can
 * recognize it as set-valued before this editor has marked anything.
 */
function registerMarkIDsState(flavor: MarkFlavor, editor: LexicalEditor): void {
  // @internal access with precedent (NormalizeInlineElementsExtension): there
  // is no public API to declare a state for node classes the extension does
  // not own
  for (const {sharedNodeState} of editor._nodes.values()) {
    const {sharedConfigMap} = sharedNodeState;
    if (!sharedConfigMap.has(flavor.stateKey)) {
      sharedConfigMap.set(flavor.stateKey, flavor.state);
    }
  }
}

/**
 * Where the pieces that a flavor's inserted-text rule cut off a TextNode in
 * the current update came from: piece key to the flavor and the key of the
 * node it was cut from. Shared by the flavors of an editor through
 * {@link MarkBaseExtension}, and forgotten at each commit.
 */
type SplitOrigins = Map<NodeKey, {flavor: MarkFlavor; origin: NodeKey}>;

/**
 * The key of the node that `key` stands for in `flavor`'s comparison: a
 * piece that another flavor cut off a node in this update stands for that
 * node, since it holds that node's text and copies of its ids.
 */
function getSplitOrigin(
  splits: SplitOrigins,
  flavor: MarkFlavor,
  key: NodeKey,
): NodeKey {
  for (
    let entry = splits.get(key);
    entry !== undefined && entry.flavor !== flavor;
    entry = splits.get(key)
  ) {
    key = entry.origin;
  }
  return key;
}

const MARK_BASE_EXTENSION_NAME = '@lexical/mark/MarkBase';

/**
 * The init result of {@link MarkBaseExtension}.
 *
 * @experimental
 */
export interface MarkBaseInit {
  /** @internal The flavors of the editor, by stateKey */
  flavors: Map<string, AnyMarkFlavorExtension>;
  /** @internal */
  splits: SplitOrigins;
}

/**
 * Output of {@link MarkBaseExtension}.
 *
 * @experimental
 */
export interface MarkBaseOutput {
  /** The mark flavors of the editor, by their `stateKey` */
  flavors: ReadonlyMap<string, AnyMarkFlavorExtension>;
}

/**
 * The shared base of the mark flavors ({@link MarkStateExtension} and every
 * extension made with {@link defineMarkExtension}), which all depend on it,
 * so an editor rarely lists it itself. It keeps the registry of the
 * editor's flavors (the `flavors` output), rejects two flavors that share a
 * `stateKey` or an attribute when the editor is built, and lets the
 * inserted-text rules of the flavors tell each other's work from inserted
 * content. See also {@link $getMarkIDsByFlavor}.
 *
 * (`MarkExtension` is the extension that registers {@link MarkNode}.)
 *
 * @experimental
 */
export const MarkBaseExtension: LexicalExtension<
  ExtensionConfigBase,
  typeof MARK_BASE_EXTENSION_NAME,
  MarkBaseOutput,
  MarkBaseInit
> = defineExtension<
  ExtensionConfigBase,
  typeof MARK_BASE_EXTENSION_NAME,
  MarkBaseOutput,
  MarkBaseInit
>({
  build: (_editor, _config, state): MarkBaseOutput => ({
    flavors: state.getInitResult().flavors,
  }),
  init: (): MarkBaseInit => ({flavors: new Map(), splits: new Map()}),
  name: MARK_BASE_EXTENSION_NAME,
  register: (editor, _config, state) => {
    const {splits} = state.getInitResult();
    return mergeRegister(
      editor.registerUpdateListener(() => splits.clear()),
      () => splits.clear(),
    );
  },
});

/**
 * A mark flavor: an extension that stores one kind of annotation ids
 * (comments, suggestions, highlights) in its own set-valued NodeState key,
 * renders them with its own attribute and classes, and reports them to its
 * own listeners. Made with {@link defineMarkExtension};
 * {@link MarkStateExtension} is the default flavor. The `$` functions of
 * `@lexical/mark` take one as their first argument.
 *
 * @experimental
 */
export type MarkFlavorExtension<
  Name extends string = string,
  Key extends string = string,
> = LexicalExtension<MarkStateConfig, Name, MarkStateOutput, MarkStateInit> & {
  /** The attribute that marked leaves are rendered with */
  readonly attribute: string;
  /** The NodeState key that the ids are stored under */
  readonly stateKey: Key;
  /** @internal */
  readonly __markFlavor: MarkFlavor;
};

/**
 * Any {@link MarkFlavorExtension}.
 *
 * @experimental
 */
export type AnyMarkFlavorExtension = MarkFlavorExtension<string, string>;

/**
 * The type rules of a `stateKey` for {@link defineMarkExtension}: the key
 * itself when it is valid, otherwise a message that says how to fix it,
 * which is what the type error shows.
 *
 * @experimental
 */
export type MarkStateKeyCheck<Key extends string> = string extends Key
  ? 'stateKey must be a string literal, such as "commentIds"'
  : Key extends ''
    ? 'stateKey must not be empty: use a name such as "commentIds"'
    : Key extends `${string}${' ' | '\t' | '\n' | '\r'}${string}`
      ? 'stateKey must not contain whitespace: use a name such as "commentIds"'
      : Key extends typeof MARK_STATE_KEY
        ? '"markIds" is the key of MarkStateExtension, the default flavor. Choose another stateKey, such as "commentIds"'
        : Key extends '__proto__'
          ? 'stateKey must not be "__proto__", which objects cannot hold as a key: use a name such as "commentIds"'
          : Key;

/**
 * The argument of {@link defineMarkExtension}.
 *
 * @experimental
 */
export interface MarkFlavorDefinition<Name extends string, Key extends string> {
  /** The extension's name, unique in the editor, such as `'@app/CommentMarks'` */
  name: Name;
  /**
   * The NodeState key the ids are stored under, such as `'commentIds'`: a
   * leaf with comment `c1` has `"$": {"commentIds": ["c1"]}` in its JSON.
   * Every flavor in an editor needs its own key, and `'markIds'` belongs to
   * {@link MarkStateExtension}.
   */
  stateKey: MarkStateKeyCheck<Key>;
  /**
   * The attribute that marked leaves are rendered with (and that HTML export
   * writes with `exportIDsToHTML`, and HTML import reads). Defaults to
   * `data-lexical-` followed by the key in kebab case:
   * `data-lexical-comment-ids` for `commentIds`. It is lowercased, as HTML
   * stores attribute names.
   */
  attribute?: string;
  /** The classes of a leaf with at least one shown id (space separated) */
  className?: string;
  /** The classes of a leaf with more than one shown id (space separated) */
  overlapClassName?: string;
  /** Defaults for the flavor's config, which `configExtension` overrides */
  config?: Partial<MarkStateConfig>;
}

/** `commentIds` to `data-lexical-comment-ids` */
function defaultMarkAttribute(stateKey: string): string {
  return (
    'data-lexical-' +
    stateKey.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())
  );
}

function isMarkFlavorExtension(
  value: unknown,
): value is AnyMarkFlavorExtension {
  return typeof value === 'object' && value !== null && '__markFlavor' in value;
}

/**
 * The flavor that a `$` function was called with (its first argument, when
 * that is a flavor extension, otherwise {@link MarkStateExtension}), and the
 * other arguments.
 */
function splitFlavorArgs<Rest extends unknown[]>(
  args: Rest | [AnyMarkFlavorExtension, ...Rest],
): [MarkFlavor, ...Rest] {
  if (isMarkFlavorExtension(args[0])) {
    const [first, ...rest] = args as [AnyMarkFlavorExtension, ...Rest];
    return [first.__markFlavor, ...rest];
  }
  return [MarkStateExtension.__markFlavor, ...(args as Rest)];
}

/**
 * Report to each listener the ids that appeared or disappeared since the
 * last report to it. Each listener has its own baseline, so one registered
 * while the flavor was disabled gets every id when it is enabled again.
 */
function reportMarkIDs(init: MarkStateInit, tags: ReadonlySet<string>): void {
  if (init.listeners.size === 0) {
    return;
  }
  const ids: ReadonlySet<string> = new Set(init.markIDNodeKeys.peek().keys());
  for (const entry of Array.from(init.listeners)) {
    const prev = entry.reported;
    const added = new Set<string>();
    const removed = new Set<string>();
    for (const id of ids) {
      if (!prev.has(id)) {
        added.add(id);
      }
    }
    for (const id of prev) {
      if (!ids.has(id)) {
        removed.add(id);
      }
    }
    // Unregistered by an earlier listener of this report
    if ((added.size > 0 || removed.size > 0) && init.listeners.has(entry)) {
      entry.reported = ids;
      entry.listener({added, ids, removed, tags});
    }
  }
}

/**
 * Build a mark flavor extension. {@link defineMarkExtension} checks its
 * arguments; {@link MarkStateExtension} is built here directly, with the
 * classes of the editor theme.
 *
 * @__NO_SIDE_EFFECTS__
 */
function createMarkFlavorExtension<Name extends string, Key extends string>(
  name: Name,
  stateKey: Key,
  attribute: string,
  classNames: MarkFlavor['classNames'],
  renderStateName: string,
  configDefaults: Partial<MarkStateConfig>,
): MarkFlavorExtension<Name, Key> {
  const flavor: MarkFlavor = {
    attribute,
    classNames,
    editsByEditor: new WeakMap(),
    isMarkableByEditor: new WeakMap(),
    name,
    renderDisabled: createRenderState(renderStateName, () => false),
    state: createMarkIDsState(stateKey),
    stateKey,
  };
  // A guard rather than the predicate itself: narrowing a `LexicalNode`
  // with `node is LexicalNode` leaves `never` where it returns `false`
  const $isMarkableNodeMatch = (node: LexicalNode): node is LexicalNode =>
    $isMarkableNode(flavor, node);
  const extension: MarkFlavorExtension<Name, Key> = Object.assign(
    defineExtension<MarkStateConfig, Name, MarkStateOutput, MarkStateInit>({
      build: (editor, config, state): MarkStateOutput => {
        const {flavors} = state.getDependency(MarkBaseExtension).init;
        for (const other of flavors.values()) {
          invariant(
            other.stateKey !== stateKey,
            'MarkBaseExtension: %s and %s both use stateKey %s. Give each flavor its own stateKey.',
            other.name,
            name,
            JSON.stringify(stateKey),
          );
          invariant(
            other.attribute !== attribute,
            'MarkBaseExtension: %s and %s both render the attribute %s. Give each flavor its own attribute.',
            other.name,
            name,
            attribute,
          );
        }
        flavors.set(stateKey, extension);
        flavor.isMarkableByEditor.set(
          editor,
          compileMarkableNodes(config.markableNodes),
        );
        registerMarkIDsState(flavor, editor);
        const {
          isMarkIDShown,
          markableNodes: _markableNodes,
          ...signalConfig
        } = config;
        return {
          ...namedSignals(signalConfig),
          isMarkIDShown: signal(isMarkIDShown || isEveryMarkIDShown),
          markIDNodeKeys: state.getInitResult().markIDNodeKeys,
        };
      },
      config: safeCast<MarkStateConfig>({
        disabled: false,
        exportIDsToHTML: false,
        isMarkIDShown: isEveryMarkIDShown,
        markableNodes: DEFAULT_MARKABLE_NODES,
        ...configDefaults,
      }),
      dependencies: [
        configExtension(DOMRenderExtension, {
          overrides: [
            // A guard rather than [TextNode, LineBreakNode, DecoratorNode]:
            // the class form requires every class to be registered, and
            // DecoratorNode is abstract.
            domOverride(
              [$isMarkableNodeMatch],
              {
                $decorateDOM: (node, _prevNode, dom, editor) =>
                  $decorateMarkIDs(flavor, node, dom, editor),
              },
              {disabledForEditor: ctx => ctx.get(flavor.renderDisabled)},
            ),
            domOverride([$isMarkableNodeMatch], {
              $exportDOM: (node, $next, editor) => {
                const output = $next();
                const dep =
                  getPeerDependencyFromEditor<AnyMarkFlavorExtensionType>(
                    editor,
                    name,
                  );
                if (!dep || !dep.output.exportIDsToHTML.peek()) {
                  return output;
                }
                const ids = $readNodeMarkIDs(flavor, node);
                if (ids.length > 0 && isHTMLElement(output.element)) {
                  output.element.setAttribute(attribute, ids.join(' '));
                }
                return output;
              },
            }),
          ],
        }),
        configExtension(DOMImportExtension, {
          rules: [createMarkIDsImportRule(flavor)],
        }),
        MarkBaseExtension,
      ],
      init: (): MarkStateInit => ({
        listeners: new Set(),
        markIDNodeKeys: signal(new Map()),
      }),
      name,
      register: (editor, _config, state) => {
        const {disabled, isMarkIDShown} = state.getOutput();
        const init = state.getInitResult();
        const {splits} = state.getDependency(MarkBaseExtension).init;
        return mergeRegister(
          effect(() => {
            const isDisabled = disabled.value;
            $setRenderContextValue(flavor.renderDisabled, isDisabled, editor);
            if (!isDisabled) {
              return registerMarkState(flavor, editor, init, splits);
            }
          }),
          registerMarkIDShownRerender(
            editor,
            isMarkIDShown,
            disabled,
            init.markIDNodeKeys,
          ),
        );
      },
    }),
    {__markFlavor: flavor, attribute, stateKey},
  );
  return extension;
}

/**
 * Define a mark flavor: an extension for one kind of annotation, such as
 * comments, suggestions or highlights, that works like
 * {@link MarkStateExtension} on its own NodeState key. Two flavors on the
 * same text never see each other's ids: each has its own key, its own
 * rendering (`className`, `overlapClassName`, `attribute`), its own config
 * (`isMarkIDShown`, `disabled`, `markableNodes`, `exportIDsToHTML`) and
 * output, and its own {@link registerMarkIDsListener} listeners. Pass the
 * flavor first to the `$` functions: `$addMarkID(CommentMarks, 'c1',
 * selection)`.
 *
 * The ids say which text an annotation covers, nothing more: keep the
 * annotation's data (author, body, resolved) in your own store, keyed by id.
 *
 * ```ts
 * export const CommentMarks = defineMarkExtension({
 *   className: 'comment',
 *   name: '@app/CommentMarks',
 *   overlapClassName: 'comment-overlap',
 *   stateKey: 'commentIds',
 * });
 * ```
 *
 * The `stateKey` must be a non-empty string literal without whitespace,
 * other than `'markIds'` (MarkStateExtension's); a type error says which
 * rule it breaks. Two flavors with the same key or attribute in one editor
 * throw when the editor is built.
 *
 * @experimental
 * @__NO_SIDE_EFFECTS__
 */
export function defineMarkExtension<
  const Name extends string,
  const Key extends string,
>(definition: MarkFlavorDefinition<Name, Key>): MarkFlavorExtension<Name, Key> {
  const {name, className, overlapClassName, config = {}} = definition;
  const stateKey = definition.stateKey as string as Key;
  invariant(
    isValidMarkID(stateKey) &&
      stateKey !== MARK_STATE_KEY &&
      stateKey !== '__proto__',
    'defineMarkExtension: invalid stateKey %s for %s. Use a non-empty name without whitespace, other than "markIds" (the key of MarkStateExtension) and "__proto__", such as "commentIds".',
    JSON.stringify(stateKey),
    name,
  );
  const classes = {mark: className, overlap: overlapClassName};
  return createMarkFlavorExtension(
    name,
    stateKey,
    // Lowercase, as HTML stores attribute names, so that a clash is caught
    (definition.attribute || defaultMarkAttribute(stateKey)).toLowerCase(),
    () => classes,
    `markStateDisabled:${stateKey}`,
    config,
  );
}

/**
 * Call `listener` after each commit that changes which ids of `flavor` are
 * in the document, with the ids that appeared (`added`: no leaf carried them
 * before), the ids that disappeared (`removed`: no leaf carries them now),
 * every id now (`ids`) and the update's `tags`. If the document already has
 * ids, it is also called right away, with all of them in `added`.
 *
 * Use it to keep your own store in step with the text: when all of a
 * comment's text is deleted its id is `removed`, so mark the thread orphaned
 * rather than deleting it; an undo or a paste that brings the text back
 * reports it `added` again. Check `tags` for `COLLABORATION_TAG` to leave a
 * collaborator's edit to the peer that made it, and for `HISTORIC_TAG` to
 * tell undo and redo.
 *
 * Nothing is reported while the flavor is `disabled` (the ids stay in the
 * document); when it is enabled again, the listener gets the net change.
 *
 * @param editor An editor built with `flavor`
 * @param flavor {@link MarkStateExtension} or a flavor made with
 *   {@link defineMarkExtension}
 * @param listener Called with a {@link MarkIDsChange}
 * @returns A function that unregisters the listener
 *
 * @experimental
 */
export function registerMarkIDsListener(
  editor: LexicalEditor,
  flavor: AnyMarkFlavorExtension,
  listener: MarkIDsListener,
): () => void {
  const dep = getPeerDependencyFromEditor<AnyMarkFlavorExtensionType>(
    editor,
    flavor.name,
  );
  invariant(
    dep !== undefined,
    'registerMarkIDsListener: the editor was not built with %s. Add it to the dependencies of the extension the editor is built from.',
    flavor.name,
  );
  const {init, output} = dep;
  // While disabled the ids are not tracked: the first report comes when the
  // flavor is enabled again
  const ids: ReadonlySet<string> = output.disabled.peek()
    ? new Set()
    : new Set(output.markIDNodeKeys.peek().keys());
  // Called before it is registered, so that a listener that throws here is
  // not left registered
  if (ids.size > 0) {
    listener({added: ids, ids, removed: new Set(), tags: new Set()});
  }
  const entry = {listener, reported: ids};
  init.listeners.add(entry);
  return () => {
    init.listeners.delete(entry);
  };
}

/**
 * Get the ids of every mark flavor of the active editor on a node, by
 * `stateKey`, sorted: `{commentIds: ['c1'], suggestionIds: []}`. A flavor
 * whose `markableNodes` do not include the node has an empty array.
 *
 * @param node The node
 * @returns New arrays, which the caller may change
 *
 * @experimental
 */
export function $getMarkIDsByFlavor(
  node: LexicalNode,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const dep = getPeerDependencyFromEditor<typeof MarkBaseExtension>(
    $getEditor(),
    MARK_BASE_EXTENSION_NAME,
  );
  if (dep) {
    for (const [stateKey, extension] of dep.output.flavors) {
      out[stateKey] = $getMarkableIDs(extension.__markFlavor, node).slice();
    }
  }
  return out;
}

/**
 * An experimental alternative to `MarkNode` for comments and other
 * annotations: the mark ids are stored as a set-valued NodeState
 * (`markIds`, a sorted array in JSON) on the leaves they cover (TextNode,
 * LineBreakNode and inline DecoratorNode by default, see `markableNodes`),
 * instead of wrapping them in a MarkNode.
 *
 * - Marks overlap freely: text covered by two comments is one TextNode with
 *   both ids, not a MarkNode split into sibling wrappers.
 * - Adding or removing an id changes NodeState only; it never moves,
 *   re-creates or wraps text. (Adding or removing it on part of a TextNode
 *   splits that TextNode, and TextNodes left with the same ids merge back.)
 * - The ids live on the leaves, so they travel with the text: typing inside
 *   a marked run, copying, cutting or deleting text keeps its ids with it.
 * - Marked leaves are rendered with the `mark` (and, for more than one id,
 *   `markOverlap`) theme classes and a `data-lexical-mark-ids` attribute.
 *   With `exportIDsToHTML`, HTML export writes that attribute too; the
 *   `@lexical/html` import pipeline reads it back. `isMarkIDShown` limits
 *   which ids are rendered (to hide resolved threads, for example), and can
 *   be changed at runtime through the output signal of the same name.
 * - Text inserted at the edge of a marked run does not join it, like
 *   MarkNode; text inserted inside a run does. Text that replaces a
 *   selection also gets the ids all of the replaced text had, and pasted
 *   content keeps its own ids (pasted marked text stays marked). Text that
 *   the edit moves into a new TextNode (a hashtag, a segmented node turned
 *   into text) keeps its ids, except an id removed with
 *   {@link $removeMarkID} in the same update. A TextNode is split where its
 *   text gets different ids when its pieces stay of its own class (TextNode,
 *   or the class that replaces it); other TextNodes (a token or segmented
 *   node, a hashtag) get every id their text had.
 *
 * Use {@link $addMarkID}, {@link $removeMarkID},
 * {@link $getMarkIDsAtSelection} and {@link $getNodeMarkIDs} to work with
 * the ids, the `markIDNodeKeys` output to find the nodes of an id,
 * {@link registerMarkIDsListener} to learn when ids appear or disappear, and
 * {@link $migrateMarkNodesToMarkState} to convert MarkNode documents.
 *
 * It is the default mark flavor: {@link defineMarkExtension} makes more,
 * one per kind of annotation, each on its own NodeState key.
 *
 * @experimental
 */
export const MarkStateExtension: MarkFlavorExtension<
  typeof MARK_STATE_EXTENSION_NAME,
  typeof MARK_STATE_KEY
> = createMarkFlavorExtension(
  MARK_STATE_EXTENSION_NAME,
  MARK_STATE_KEY,
  MARK_STATE_IDS_ATTRIBUTE,
  // @internal access with precedent (CodeNode, HorizontalRuleExtension): the
  // render overrides receive the editor, not its theme
  editor => ({
    mark: editor._config.theme.mark,
    overlap: editor._config.theme.markOverlap,
  }),
  'markStateDisabled',
  {},
);

/**
 * Re-render the marked leaves when a new `isMarkIDShown` is assigned. The
 * old and the new function cannot be compared: an app that resolves a thread
 * typically updates the state both of them read, then assigns a new
 * function. So every marked leaf is re-rendered, unless the document has no
 * marks. The ids are rendered by `$decorateDOM`, which a full reconcile runs
 * for every node without changing any (as `DOMRenderExtension` does when
 * `disabled` changes), so nothing is synced to collaborators or pushed to
 * the history.
 *
 * The full reconcile is an update of its own: when the function is assigned
 * while an update is pending (inside `editor.update`, or before a batched
 * update commits), or in a listener that may queue edits, it waits for them
 * to commit, since a full reconcile in an edit would make it look like a
 * `setEditorState` to {@link registerMarkState}. It does not move the DOM
 * selection, which may be in another editable (a comment reply box) when a
 * thread is resolved.
 */
function registerMarkIDShownRerender(
  editor: LexicalEditor,
  isMarkIDShown: ReadonlySignal<(id: string) => boolean>,
  disabled: ReadonlySignal<boolean>,
  markIDNodeKeys: ReadonlySignal<ReadonlyMap<string, readonly NodeKey[]>>,
): () => void {
  let prev = isMarkIDShown.peek();
  let scheduled = false;
  let disposed = false;
  const rerender = () => {
    scheduled = false;
    if (
      disposed ||
      disabled.peek() ||
      editor.getRootElement() === null ||
      markIDNodeKeys.peek().size === 0
    ) {
      return;
    }
    // @internal access: whether an update is in progress or waiting to
    // commit, which the full reconcile would otherwise join
    if (editor._pendingEditorState !== null) {
      // Joins the pending update, and runs once it commits; the re-render
      // is then queued as an update of its own
      scheduled = true;
      editor.update(() => {}, {onUpdate: rerender});
      return;
    }
    // @internal access: in an update or command listener, or an `onUpdate`
    // callback, an update is queued and joins the updates queued before it
    // (an edit a listener makes): wait until they have run
    if (editor._updating) {
      scheduled = true;
      Promise.resolve().then(rerender);
      return;
    }
    editor.update($fullReconcile, {
      discrete: true,
      tag: SKIP_DOM_SELECTION_TAG,
    });
  };
  const unregister = effect(() => {
    const next = isMarkIDShown.value;
    if (next !== prev) {
      prev = next;
      // A scheduled re-render reads the latest function when it runs
      if (!scheduled) {
        rerender();
      }
    }
  });
  return () => {
    disposed = true;
    unregister();
  };
}
