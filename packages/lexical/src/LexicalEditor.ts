/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {DOMSlot, ElementDOMSlot} from './LexicalDOMSlot';
import type {KeyDownShortcut} from './LexicalEvents';
import type {CompiledKeyboardShortcuts} from './LexicalKeyboardShortcuts';
import type {ElementNode} from './nodes/LexicalElementNode';

import invariant from '@lexical/internal/invariant';
import {LEXICAL_VERSION} from '@lexical/internal/version';

import {
  $getRoot,
  $getSelection,
  $isElementNode,
  type BaseSelection,
  mergeRegister,
  type RangeSelection,
  TextNode,
} from '.';
import {FULL_RECONCILE, NO_DIRTY_NODES} from './LexicalConstants';
import {DequeSet} from './LexicalDequeSet';
import {
  cloneEditorState,
  createEmptyEditorState,
  type EditorState,
  type SerializedEditorState,
} from './LexicalEditorState';
import {
  addRootElementEvents,
  registerDefaultCommandHandlers,
  removeRootElementEvents,
} from './LexicalEvents';
import {GenMap} from './LexicalGenMap';
import {flushRootMutations, initMutationObserver} from './LexicalMutations';
import {
  type DOMConversion,
  type DOMConversionMap,
  type DOMExportOutput,
  type DOMExportOutputMap,
  LexicalNode,
  type LexicalPrivateDOM,
  type NodeKey,
} from './LexicalNode';
import {createSharedNodeState, type SharedNodeState} from './LexicalNodeState';
import {
  $commitPendingUpdates,
  $fullReconcile,
  internalGetActiveEditor,
  parseEditorState,
  triggerListeners,
  updateEditor,
  updateEditorSync,
} from './LexicalUpdates';
import {
  FOCUS_TAG,
  HISTORY_MERGE_TAG,
  type UpdateTag,
} from './LexicalUpdateTags';
import {
  $addUpdateTag,
  $onUpdate,
  $setSelection,
  clearNodeKeyOnDOMNode,
  createUID,
  dispatchCommand,
  getCachedClassNameArray,
  getCachedTypeToNodeMap,
  getDefaultView,
  getDOMSelection,
  getParentElement,
  getRegisteredNode,
  getStaticNodeConfig,
  hasOwnStaticMethod,
  iterStaticNodeConfigChain,
  markNodesWithTypesAsDirty,
  setNodeKeyOnDOMNode,
} from './LexicalUtils';
import {ArtificialNode__DO_NOT_USE} from './nodes/ArtificialNode';
import {LineBreakNode} from './nodes/LexicalLineBreakNode';
import {ParagraphNode} from './nodes/LexicalParagraphNode';
import {RootNode} from './nodes/LexicalRootNode';
import {TabNode} from './nodes/LexicalTabNode';

const __DEV__ = process.env.NODE_ENV !== 'production';

export type Spread<T1, T2> = Omit<T2, keyof T1> & T1;

// https://github.com/microsoft/TypeScript/issues/3841
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type KlassConstructor<Cls extends GenericConstructor<any>> =
  GenericConstructor<InstanceType<Cls>> & {[k in keyof Cls]: Cls[k]};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GenericConstructor<T> = new (...args: any[]) => T;

export type Klass<T extends LexicalNode> =
  InstanceType<T['constructor']> extends T
    ? T['constructor']
    : GenericConstructor<T> & T['constructor'];

export type EditorThemeClassName = string;

export interface TextNodeThemeClasses {
  base?: EditorThemeClassName;
  bold?: EditorThemeClassName;
  code?: EditorThemeClassName;
  highlight?: EditorThemeClassName;
  italic?: EditorThemeClassName;
  lowercase?: EditorThemeClassName;
  uppercase?: EditorThemeClassName;
  capitalize?: EditorThemeClassName;
  strikethrough?: EditorThemeClassName;
  subscript?: EditorThemeClassName;
  superscript?: EditorThemeClassName;
  underline?: EditorThemeClassName;
  underlineStrikethrough?: EditorThemeClassName;
  [key: string]: EditorThemeClassName | undefined;
}

export type EditorUpdateOptions = {
  /**
   * A function to run once the update is complete. See also {@link $onUpdate}.
   */
  onUpdate?: () => void;
  /**
   * Setting this to true will suppress all node
   * transforms for this update cycle.
   * Useful for synchronizing updates in some cases.
   */
  skipTransforms?: true;
  /**
   * A tag to identify this update, in an update listener, for instance.
   * See also {@link $addUpdateTag}.
   */
  tag?: UpdateTag | UpdateTag[];
  /**
   * If true, prevents this update from being batched, forcing it to
   * run synchronously.
   */
  discrete?: true;
  /** @internal */
  event?: undefined | UIEvent | Event | null;
};

export type EditorSetOptions = {
  tag?: string;
};

/**
 * Controls which editor state {@link LexicalEditor.read} observes and whether
 * pending updates are flushed before the read.
 *
 * - `'force-commit'` (the default) flushes any pending updates immediately
 *   before the read, so it always observes a fully committed and reconciled
 *   state.
 * - `'pending'` reads the pending state if it exists, otherwise the committed
 *   state, without flushing. This is safe to call when an update may already
 *   be in progress at the cost of possibly observing an uncommitted state
 *   before node transforms, DOM reconciliation, etc. have run.
 * - `'latest'` reads the latest committed state without flushing pending
 *   updates, equivalent to `editor.getEditorState().read(callbackFn, {editor})`.
 */
export type EditorReadMode = 'force-commit' | 'pending' | 'latest';

export interface EditorFocusOptions {
  /**
   * Where to move selection when the editor is
   * focused. Can be rootStart, rootEnd, or undefined. Defaults to rootEnd.
   */
  defaultSelection?: 'rootStart' | 'rootEnd';
}

export interface EditorThemeClasses {
  blockCursor?: EditorThemeClassName;
  characterLimit?: EditorThemeClassName;
  code?: EditorThemeClassName;
  codeHighlight?: Record<string, EditorThemeClassName>;
  hashtag?: EditorThemeClassName;
  specialText?: EditorThemeClassName;
  heading?: {
    h1?: EditorThemeClassName;
    h2?: EditorThemeClassName;
    h3?: EditorThemeClassName;
    h4?: EditorThemeClassName;
    h5?: EditorThemeClassName;
    h6?: EditorThemeClassName;
  };
  hr?: EditorThemeClassName;
  hrSelected?: EditorThemeClassName;
  image?: EditorThemeClassName;
  link?: EditorThemeClassName;
  list?: {
    ul?: EditorThemeClassName;
    ulDepth?: EditorThemeClassName[];
    ol?: EditorThemeClassName;
    olDepth?: EditorThemeClassName[];
    checklist?: EditorThemeClassName;
    listitem?: EditorThemeClassName;
    listitemChecked?: EditorThemeClassName;
    listitemUnchecked?: EditorThemeClassName;
    nested?: {
      list?: EditorThemeClassName;
      listitem?: EditorThemeClassName;
    };
  };
  ltr?: EditorThemeClassName;
  mark?: EditorThemeClassName;
  markOverlap?: EditorThemeClassName;
  paragraph?: EditorThemeClassName;
  quote?: EditorThemeClassName;
  root?: EditorThemeClassName;
  rtl?: EditorThemeClassName;
  tab?: EditorThemeClassName;
  table?: EditorThemeClassName;
  tableAddColumns?: EditorThemeClassName;
  tableAddRows?: EditorThemeClassName;
  tableCellActionButton?: EditorThemeClassName;
  tableCellActionButtonContainer?: EditorThemeClassName;
  tableCellSelected?: EditorThemeClassName;
  tableCell?: EditorThemeClassName;
  tableCellHeader?: EditorThemeClassName;
  tableCellResizer?: EditorThemeClassName;
  tableRow?: EditorThemeClassName;
  tableScrollableWrapper?: EditorThemeClassName;
  tableSelected?: EditorThemeClassName;
  tableSelection?: EditorThemeClassName;
  tableStickyScrollbar?: EditorThemeClassName;
  text?: TextNodeThemeClasses;
  collaboration?: {
    cursor?: EditorThemeClassName;
    cursorName?: EditorThemeClassName;
    selection?: EditorThemeClassName;
    selectionBg?: EditorThemeClassName;
  };
  embedBlock?: {
    base?: EditorThemeClassName;
    focus?: EditorThemeClassName;
  };
  indent?: EditorThemeClassName;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface EditorConfig {
  dom?: EditorDOMRenderConfig;
  disableEvents?: boolean;
  namespace: string;
  theme: EditorThemeClasses;
}

/** @internal */
export interface CollapsedSelectionFormat {
  format: number;
  style: string;
  offset: number;
  key: NodeKey;
  timeStamp: number;
}

/** @internal */
export interface InputState {
  compositionPhase: 'idle' | 'composing' | 'ending-firefox' | 'ending-safari';
  compositionEndData: string;
  hadOrphanedCompositionEvents: boolean;

  lastKeyDownTimeStamp: number;
  lastKeyCode: string | null;
  lastBeforeInputInsertTextTimeStamp: number;
  unprocessedBeforeInputData: string | null;
  collapsedSelectionFormat: CollapsedSelectionFormat;
  postDeleteSelectionToRestore: RangeSelection | null;

  isSelectionChangeFromDOMUpdate: boolean;
  /**
   * The DOM boundary points the reconciler applied when it set
   * isSelectionChangeFromDOMUpdate, so the selectionchange handler can tell
   * "the event for our own update" apart from a user selection that arrives
   * while the flag is stale. WebKit fires no selectionchange at all when the
   * applied selection matches what the DOM already had, so the flag alone can
   * outlive its event and swallow the next real one.
   */
  selectionChangeFromDOMUpdatePoints: null | {
    anchorNode: Node;
    anchorOffset: number;
    focusNode: Node;
    focusOffset: number;
  };
  isSelectionChangeFromMouseDown: boolean;
  isInsertLineBreak: boolean;

  isInsertTextAfterHandledSelectionCommand: boolean;
  handledSelectionCommandTimeoutId: ReturnType<typeof setTimeout> | null;
}

/** @internal */
export function createInputState(): InputState {
  return {
    collapsedSelectionFormat: {
      format: 0,
      key: 'root',
      offset: 0,
      style: '',
      timeStamp: 0,
    },
    compositionEndData: '',
    compositionPhase: 'idle',
    hadOrphanedCompositionEvents: false,
    handledSelectionCommandTimeoutId: null,
    isInsertLineBreak: false,
    isInsertTextAfterHandledSelectionCommand: false,
    isSelectionChangeFromDOMUpdate: false,
    isSelectionChangeFromMouseDown: false,
    lastBeforeInputInsertTextTimeStamp: 0,
    lastKeyCode: null,
    lastKeyDownTimeStamp: 0,
    postDeleteSelectionToRestore: null,
    selectionChangeFromDOMUpdatePoints: null,
    unprocessedBeforeInputData: null,
  };
}

/**
 * Configuration entry passed in {@link CreateEditorArgs.nodes} to substitute
 * a core node class with a custom subclass. The replacement class itself
 * must also appear in `nodes`.
 *
 * See [Node Replacement](https://lexical.dev/docs/concepts/node-replacement).
 */
export type LexicalNodeReplacement = {
  /**
   * The core node class whose instances should be replaced.
   */
  replace: Klass<LexicalNode>;
  /**
   * Called by the `$create*` factories for `replace` with the
   * freshly-constructed original. Returns the substitute node, which must be
   * an instance of `withKlass` when set.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  with: <T extends {new (...args: any): any}>(
    node: InstanceType<T>,
  ) => LexicalNode;
  /**
   * The replacement class returned by `with`. Must extend `replace`. When
   * set, {@link LexicalEditor.registerNodeTransform} and
   * {@link LexicalEditor.registerMutationListener} subscriptions registered
   * against `replace` also fire for the replacement. Will be required in a
   * future version.
   */
  withKlass?: Klass<LexicalNode>;
};

export type HTMLConfig = {
  export?: DOMExportOutputMap;
  import?: DOMConversionMap;
};

/**
 * A LexicalNode class or LexicalNodeReplacement configuration
 */
export type LexicalNodeConfig = Klass<LexicalNode> | LexicalNodeReplacement;

/**
 * @experimental
 *
 * The slot type produced by `$getDOMSlot` for a given node, narrowed via
 * the node's static class: `ElementNode` resolves to {@link ElementDOMSlot}
 * (with children-management methods), other nodes to the base
 * {@link DOMSlot}. Callers passing a known node type get the narrowed slot
 * without manual `instanceof` checks.
 */
export type DOMSlotForNode<N extends LexicalNode> = N extends ElementNode
  ? ElementDOMSlot<HTMLElement>
  : DOMSlot<HTMLElement>;

/** @internal @experimental */
export interface EditorDOMRenderConfig {
  /** @internal @experimental */
  $createDOM: <T extends LexicalNode>(
    node: T,
    editor: LexicalEditor,
  ) => HTMLElement;
  /**
   * @internal @experimental
   *
   * The default impl dispatches to `node.getDOMSlot(dom)`. The return type is
   * narrowed via {@link DOMSlotForNode}: callers passing an `ElementNode` get
   * an {@link ElementDOMSlot} with children-management methods, callers
   * passing a non-Element node get the base {@link DOMSlot}.
   */
  $getDOMSlot: <N extends LexicalNode>(
    node: N,
    dom: HTMLElement,
    editor: LexicalEditor,
  ) => DOMSlotForNode<N>;
  /** @internal @experimental */
  $exportDOM: <T extends LexicalNode>(
    node: T,
    editor: LexicalEditor,
  ) => DOMExportOutput;
  /** @internal @experimental */
  $extractWithChild: <T extends LexicalNode>(
    node: T,
    childNode: LexicalNode,
    selection: null | BaseSelection,
    destination: 'clone' | 'html',
    editor: LexicalEditor,
  ) => boolean;
  /** @internal @experimental */
  $decorateDOM: <T extends LexicalNode>(
    node: T,
    prevNode: null | T,
    dom: HTMLElement,
    editor: LexicalEditor,
  ) => void;
  /**
   * @internal @experimental named-slots
   *
   * Where a named slot's container should attach, for hosts rendered
   * entirely in-lexical (no chrome framework). The reconciler consults
   * this whenever it creates or reconciles the slot's container,
   * synchronously within the same commit: a non-null return attaches the
   * container to that element (a no-op when it is already there, so
   * returning `hostDom` reveals the slot in its default slots-first
   * position) and reveals it. Returning null (the default) leaves the
   * container as a hidden placeholder for explicit imperative mounting
   * (`mountSlotContainer` / lexical-react's `useLexicalSlotRef`). The
   * named-slot analog of `$getDOMSlot`'s control over where linked-list
   * children render; the returned element should live within the host's
   * own DOM so it is torn down with the host. Override per node type via
   * `DOMRenderMatch.$getSlotTargetElement` (lexical-html).
   */
  $getSlotTargetElement: <T extends LexicalNode>(
    node: T,
    slotName: string,
    hostDom: HTMLElement,
    editor: LexicalEditor,
  ) => HTMLElement | null;
  /** @internal @experimental */
  $updateDOM: <T extends LexicalNode>(
    nextNode: T,
    prevNode: T,
    dom: HTMLElement,
    editor: LexicalEditor,
  ) => boolean;
  /** @internal @experimental */
  $shouldInclude: <T extends LexicalNode>(
    node: T,
    selection: null | BaseSelection,
    editor: LexicalEditor,
  ) => boolean;
  /** @internal @experimental */
  $shouldExclude: <T extends LexicalNode>(
    node: T,
    selection: null | BaseSelection,
    editor: LexicalEditor,
  ) => boolean;
}

export interface CreateEditorArgs {
  disableEvents?: boolean;
  editorState?: EditorState;
  namespace?: string;
  nodes?: readonly LexicalNodeConfig[];
  onError?: ErrorHandler;
  /**
   * Optional handler for recoverable, warn-level conditions (e.g. the
   * update-recursion guard tripping). Mirrors {@link onError} but is reserved
   * for conditions the editor has already recovered from, so embedders can
   * route them to telemetry at warn severity without raising an error alarm.
   * Defaults to a handler that throws in development (so the condition is
   * impossible to miss) and only `console.warn`s in production.
   */
  onWarn?: ErrorHandler;
  parentEditor?: LexicalEditor;
  editable?: boolean;
  theme?: EditorThemeClasses;
  html?: HTMLConfig;
  dom?: Partial<EditorDOMRenderConfig>;
}

export type RegisteredNodes = Map<string, RegisteredNode>;

export type RegisteredNode = {
  klass: Klass<LexicalNode>;
  transforms: Set<Transform<LexicalNode>>;
  replace: null | ((node: LexicalNode) => LexicalNode);
  replaceWithKlass: null | Klass<LexicalNode>;
  exportDOM?: (
    editor: LexicalEditor,
    targetNode: LexicalNode,
  ) => DOMExportOutput;
  sharedNodeState: SharedNodeState;
};

export type Transform<T extends LexicalNode> = (node: T) => void;

export type ErrorHandler = (error: Error) => void;

/**
 * Default {@link CreateEditorArgs.onWarn} handler. Used for recoverable,
 * warn-level conditions (e.g. the update-recursion guard tripping) that the
 * editor has already recovered from. Throws in development so the condition is
 * impossible to miss, and only `console.warn`s in production so it is not
 * reported as a fatal error. Embedders can override this via `onWarn` to route
 * the condition to their own telemetry at warn severity.
 */
function defaultOnWarn(error: Error): void {
  if (__DEV__) {
    throw error;
  }
  console.warn(error);
}

export type MutationListeners = Map<MutationListener, Set<Klass<LexicalNode>>>;

export type MutatedNodes = Map<Klass<LexicalNode>, Map<NodeKey, NodeMutation>>;

export type NodeMutation = 'created' | 'updated' | 'destroyed';

export interface MutationListenerOptions {
  /**
   * Skip the initial call of the listener with pre-existing DOM nodes.
   *
   * The default was previously true for backwards compatibility with <= 0.16.1
   * but this default has been changed to false as of 0.21.0.
   */
  skipInitialization?: boolean;
}

const DEFAULT_SKIP_INITIALIZATION = false;

/**
 * The payload passed to an UpdateListener
 */
export interface UpdateListenerPayload {
  /**
   * A Map of NodeKeys of ElementNodes to a boolean that is true
   * if the node was intentionally mutated ('unintentional' mutations
   * are triggered when an indirect descendant is marked dirty)
   */
  dirtyElements: Map<NodeKey, IntentionallyMarkedAsDirtyElement>;
  /**
   * A Set of NodeKeys of all nodes that were marked dirty that
   * do not inherit from ElementNode.
   */
  dirtyLeaves: Set<NodeKey>;
  /**
   * The new EditorState after all updates have been processed,
   * equivalent to `editor.getEditorState()`
   */
  editorState: EditorState;
  /**
   * The Map of LexicalNode constructors to a `Map<NodeKey, NodeMutation>`,
   * this is useful when you have a mutation listener type use cases that
   * should apply to all or most nodes. Will be null if no DOM was mutated,
   * such as when only the selection changed. Note that this will be empty
   * unless at least one MutationListener is explicitly registered
   * (any MutationListener is sufficient to compute the mutatedNodes Map
   * for all nodes).
   *
   * Added in v0.28.0
   */
  mutatedNodes: null | MutatedNodes;
  /**
   * For advanced use cases only.
   *
   * Tracks the keys of TextNode descendants that have been merged
   * with their siblings by normalization. Note that these keys may
   * not exist in either editorState or prevEditorState and generally
   * this is only used for conflict resolution edge cases in collab.
   */
  normalizedNodes: Set<NodeKey>;
  /**
   * The previous EditorState that is being discarded
   */
  prevEditorState: EditorState;
  /**
   * The set of tags added with update options or {@link $addUpdateTag},
   * node that this includes all tags that were processed in this
   * reconciliation which may have been added by separate updates.
   */
  tags: Set<string>;
}

/**
 * A listener that gets called after the editor is updated
 */
export type UpdateListener = (payload: UpdateListenerPayload) => void;

export type DecoratorListener<T = never> = (
  decorator: Record<NodeKey, T>,
) => void;

/**
 * A listener that is called when {@link LexicalEditor.setRootElement} changes the
 * element that the editor is attached to. If this callback returns a function,
 * that function will be called before the next value update or unregister.
 */
export type RootListener = (
  rootElement: null | HTMLElement,
  prevRootElement: null | HTMLElement,
) => void | (() => void);

export type TextContentListener = (text: string) => void;

export type MutationListener = (
  nodes: Map<NodeKey, NodeMutation>,
  payload: {
    updateTags: Set<string>;
    dirtyLeaves: Set<string>;
    prevEditorState: EditorState;
  },
) => void;

export type CommandListener<P> = (payload: P, editor: LexicalEditor) => boolean;

/**
 * A listener that is called when {@link LexicalEditor.setEditable} changes the
 * editable state of the editor. If this callback returns a function,
 * that function will be called before the next value update or unregister.
 */
export type EditableListener = (editable: boolean) => void | (() => void);

export type CommandListenerPriority = 0 | 1 | 2 | 3 | 4;
export type CommandListenerPriorityBefore =
  | typeof COMMAND_PRIORITY_BEFORE_CRITICAL
  | typeof COMMAND_PRIORITY_BEFORE_EDITOR
  | typeof COMMAND_PRIORITY_BEFORE_HIGH
  | typeof COMMAND_PRIORITY_BEFORE_LOW
  | typeof COMMAND_PRIORITY_BEFORE_NORMAL;

/**
 * {@link LexicalEditor.registerCommand} listener added to the end of the editor priority queue (after critical, high, normal, low)
 */
export const COMMAND_PRIORITY_EDITOR = 0;
/**
 * {@link LexicalEditor.registerCommand} listener added to the end of the low priority queue (after critical, high, normal; before editor)
 */
export const COMMAND_PRIORITY_LOW = 1;
/**
 * {@link LexicalEditor.registerCommand} listener added to the end of the normal priority queue (after critical, high; before low, editor)
 */
export const COMMAND_PRIORITY_NORMAL = 2;
/**
 * {@link LexicalEditor.registerCommand} listener added to the end of the high priority queue (after critical; before normal, low, editor)
 */
export const COMMAND_PRIORITY_HIGH = 3;
/**
 * {@link LexicalEditor.registerCommand} listener added to the end of the critical priority queue (before high, normal, low, editor)
 */
export const COMMAND_PRIORITY_CRITICAL = 4;
/**
 * {@link LexicalEditor.registerCommand} listener added to the beginning of the editor priority queue (after critical, high, normal, low)
 */
export const COMMAND_PRIORITY_BEFORE_EDITOR = -8;
/**
 * {@link LexicalEditor.registerCommand} listener added to the beginning of the low priority queue (after critical, high, normal; before editor)
 */
export const COMMAND_PRIORITY_BEFORE_LOW = -7;
/**
 * {@link LexicalEditor.registerCommand} listener added to the beginning of the normal priority queue (after critical, high; before low, editor)
 */
export const COMMAND_PRIORITY_BEFORE_NORMAL = -6;
/**
 * {@link LexicalEditor.registerCommand} listener added to the beginning of the high priority queue (after critical; before normal, low, editor)
 */
export const COMMAND_PRIORITY_BEFORE_HIGH = -5;
/**
 * {@link LexicalEditor.registerCommand} listener added to the beginning of the critical priority queue (before high, normal, low, editor)
 */
export const COMMAND_PRIORITY_BEFORE_CRITICAL = -4;

type Tuple5<T> = readonly [T, T, T, T, T];

function normalizePriority(
  priority: CommandListenerPriority | CommandListenerPriorityBefore,
): CommandListenerPriority {
  return (priority & 7) as CommandListenerPriority;
}

declare const LexicalCommandBrand: unique symbol;

export interface LexicalCommand<TPayload> {
  type?: string;
  // TPayload must be invariant
  readonly [LexicalCommandBrand]?: (payload: TPayload) => TPayload;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyLexicalCommand = LexicalCommand<any>;

/**
 * Type helper for extracting the payload type from a command.
 *
 * @example
 * ```ts
 * const MY_COMMAND = createCommand<SomeType>();
 *
 * // ...
 *
 * editor.registerCommand(MY_COMMAND, payload => {
 *   // Type of `payload` is inferred here. But lets say we want to extract a function to delegate to
 *   $handleMyCommand(editor, payload);
 *   return true;
 * });
 *
 * function $handleMyCommand(editor: LexicalEditor, payload: CommandPayloadType<typeof MY_COMMAND>) {
 *   // `payload` is of type `SomeType`, extracted from the command.
 * }
 * ```
 */
export type CommandPayloadType<TCommand extends AnyLexicalCommand> =
  TCommand extends LexicalCommand<infer TPayload> ? TPayload : never;

export type CommandPayloadArgs<TPayload> = [
  TPayload extends undefined ? true : never,
] extends [never]
  ? [payload: TPayload]
  : [payload?: TPayload];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCommandListener = CommandListener<any>;

type Commands = Map<AnyLexicalCommand, Tuple5<DequeSet<AnyCommandListener>>>;

export type ListenerMap<T> = Map<T, undefined | (() => void)>;

export interface Listeners {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  decorator: ListenerMap<DecoratorListener<any>>;
  mutation: MutationListeners;
  editable: ListenerMap<EditableListener>;
  root: ListenerMap<RootListener>;
  textcontent: ListenerMap<TextContentListener>;
  update: ListenerMap<UpdateListener>;
}

export type MapListeners = {
  [K in keyof Listeners as Listeners[K] extends Map<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (...args: any[]) => void | undefined | (() => void),
    undefined | (() => void)
  >
    ? K
    : never]: Listeners[K] extends Map<
    (...args: infer Args) => void | undefined | (() => void),
    undefined | (() => void)
  >
    ? Args
    : never;
};

export type TransformerType = 'text' | 'decorator' | 'element' | 'root';

type IntentionallyMarkedAsDirtyElement = boolean;

type DOMConversionCache = Map<string, ((node: Node) => DOMConversion | null)[]>;

export type SerializedEditor = {
  editorState: SerializedEditorState;
};

/** @internal */
export type ResetEditorOptions = {
  /**
   * When `true`, `_updates` and `_updateTags` are kept intact across the
   * reset. Used by callers that preserve `pendingEditorState` and intend
   * the queued updates to commit against it (notably `setRootElement`).
   * Without this, queued callbacks tagged for the upcoming commit would
   * be silently dropped despite the state being kept.
   */
  preserveUpdateQueue?: boolean;
};

/**
 * @internal
 *
 * Resets the editor's transient state — DOM mappings, dirty tracking,
 * composition, and (by default) the queued updates and tags — while
 * applying the given pendingEditorState. Used during root element
 * transitions and reconciler error recovery.
 */
export function resetEditor(
  editor: LexicalEditor,
  prevRootElement: null | HTMLElement,
  nextRootElement: null | HTMLElement,
  pendingEditorState: EditorState,
  options?: ResetEditorOptions,
): void {
  const keyNodeMap = editor._keyToDOMMap;
  keyNodeMap.clear();
  editor._editorState = createEmptyEditorState();
  editor._pendingEditorState = pendingEditorState;
  editor._compositionKey = null;
  editor._dirtyType = NO_DIRTY_NODES;
  editor._cloneNotNeeded.clear();
  editor._dirtyLeaves = new Set();
  editor._dirtyElements.clear();
  editor._normalizedNodes = new Set();
  if (!options || !options.preserveUpdateQueue) {
    editor._updateTags = new Set();
    editor._updates = [];
    editor._cascadeCount = 0;
  }
  editor._blockCursorElement = null;
  if (editor._inputState.handledSelectionCommandTimeoutId !== null) {
    clearTimeout(editor._inputState.handledSelectionCommandTimeoutId);
  }
  editor._inputState = createInputState();

  const observer = editor._observer;

  if (observer !== null) {
    observer.disconnect();
    editor._observer = null;
  }

  // Remove all the DOM nodes from the root element
  if (prevRootElement !== null) {
    prevRootElement.textContent = '';
    clearNodeKeyOnDOMNode(prevRootElement, editor);
  }

  if (nextRootElement !== null) {
    nextRootElement.textContent = '';
    keyNodeMap.set('root', nextRootElement);
    // Stash __lexicalKey_${editor._key} = 'root' on the root element so it
    // participates in the unified key lookup (selection resolution in
    // $internalResolveSelectionPoint, mutation handling in
    // $getNearestManagedNodePairFromDOMNode, $getNodeFromDOM, and
    // $getNearestNodeFromDOMNode) instead of requiring a dedicated
    // editor.getRootElement() carveout at each call site.
    setNodeKeyOnDOMNode(nextRootElement, editor, 'root');
  }
}

function initializeConversionCache(
  nodes: RegisteredNodes,
  additionalConversions?: DOMConversionMap,
): DOMConversionCache {
  const conversionCache = new Map();
  const handledConversions = new Set();
  const addConversionsToCache = (map: DOMConversionMap) => {
    Object.keys(map).forEach(key => {
      let currentCache = conversionCache.get(key);

      if (currentCache === undefined) {
        currentCache = [];
        conversionCache.set(key, currentCache);
      }

      currentCache.push(map[key]);
    });
  };
  nodes.forEach(node => {
    const importDOM = node.klass.importDOM;

    if (importDOM == null || handledConversions.has(importDOM)) {
      return;
    }

    handledConversions.add(importDOM);
    const map = importDOM.call(node.klass);

    if (map !== null) {
      addConversionsToCache(map);
    }
  });
  if (additionalConversions) {
    addConversionsToCache(additionalConversions);
  }
  return conversionCache;
}

/** @internal */
export function getTransformSetFromKlass(
  klass: KlassConstructor<typeof LexicalNode>,
): Set<Transform<LexicalNode>> {
  const transforms = new Set<Transform<LexicalNode>>();
  const staticTransforms = new Set<(typeof klass)['transform']>();
  for (const {klass: currentKlass, ownNodeConfig} of iterStaticNodeConfigChain(
    klass,
  )) {
    const staticTransform = currentKlass.transform;
    if (!staticTransforms.has(staticTransform)) {
      staticTransforms.add(staticTransform);
      const transform = currentKlass.transform();
      if (transform) {
        transforms.add(transform);
      }
    }
    if (ownNodeConfig) {
      const $transform = ownNodeConfig.$transform;
      if ($transform) {
        transforms.add($transform);
      }
    }
  }
  return transforms;
}

/** @internal @experimental */
export const DEFAULT_EDITOR_DOM_CONFIG: EditorDOMRenderConfig = {
  $createDOM: (node, editor) => node.createDOM(editor._config, editor),
  $decorateDOM: (_node, _prevNode, _dom, _editor) => {},
  $exportDOM: (node, editor) => {
    const registeredNode = getRegisteredNode(editor, node.getType());
    // Use HTMLConfig overrides, if available.
    return registeredNode && registeredNode.exportDOM !== undefined
      ? registeredNode.exportDOM(editor, node)
      : node.exportDOM(editor);
  },
  $extractWithChild: (node, childNode, selection, destination, _editor) =>
    $isElementNode(node) &&
    node.extractWithChild(childNode, selection, destination),
  $getDOMSlot: <N extends LexicalNode>(
    node: N,
    dom: HTMLElement,
    _editor: LexicalEditor,
  ): DOMSlotForNode<N> => node.getDOMSlot(dom) as DOMSlotForNode<N>,
  $getSlotTargetElement: (_node, _slotName, _hostDom, _editor) => null,
  $shouldExclude: (node, _selection, _editor) =>
    $isElementNode(node) && node.excludeFromCopy('html'),
  $shouldInclude: (node, selection, _editor) =>
    selection ? node.isSelected(selection) : true,
  $updateDOM: (nextNode, prevNode, dom, editor) =>
    nextNode.updateDOM(prevNode, dom, editor._config),
};

/**
 * Creates a new LexicalEditor attached to a single contentEditable (provided in the config). This is
 * the lowest-level initialization API for a LexicalEditor. If you're using React or another framework,
 * consider using the appropriate abstractions, such as LexicalComposer
 * @param editorConfig - the editor configuration.
 * @returns a LexicalEditor instance
 */
export function createEditor(editorConfig?: CreateEditorArgs): LexicalEditor {
  const config = editorConfig || {};
  const activeEditor = internalGetActiveEditor();
  const theme = config.theme || {};
  const parentEditor =
    editorConfig === undefined ? activeEditor : config.parentEditor || null;
  const disableEvents = config.disableEvents || false;
  const editorState = createEmptyEditorState();
  const namespace =
    config.namespace ||
    (parentEditor !== null ? parentEditor._config.namespace : createUID());
  const initialEditorState = config.editorState;
  const nodes = [
    RootNode,
    TextNode,
    LineBreakNode,
    TabNode,
    ParagraphNode,
    ArtificialNode__DO_NOT_USE,
    ...(config.nodes || []),
  ];
  const {onError, onWarn, html} = config;
  const isEditable = config.editable !== undefined ? config.editable : true;
  let registeredNodes: RegisteredNodes;

  if (editorConfig === undefined && activeEditor !== null) {
    registeredNodes = activeEditor._nodes;
  } else {
    registeredNodes = new Map();
    for (let i = 0; i < nodes.length; i++) {
      let klass = nodes[i];
      let replace: RegisteredNode['replace'] = null;
      let replaceWithKlass: RegisteredNode['replaceWithKlass'] = null;

      if (klass && typeof klass === 'object') {
        const options = klass;
        klass = options.replace;
        replace = options.with;
        replaceWithKlass = options.withKlass || null;
      }
      if (
        typeof klass !== 'function' ||
        !klass.prototype ||
        !(klass === LexicalNode || klass.prototype instanceof LexicalNode)
      ) {
        let version = '<unknown>';
        try {
          version = JSON.parse(LEXICAL_VERSION);
        } catch {
          //
        }
        invariant(
          false,
          'createEditor: nodes[%s] %s is not a constructor that subclasses LexicalNode from the lexical package used by this editor (%s)',
          String(i - nodes.length + (config.nodes ? config.nodes.length : 0)),
          typeof klass === 'function'
            ? `${klass.name}${typeof klass.getType === 'function' ? ` (type ${String(klass.getType())})` : ''}`
            : String(klass),
          String(version),
        );
      }
      // For the side-effect of filling in the static methods
      void getStaticNodeConfig(klass);

      // Ensure custom nodes implement required methods and replaceWithKlass is instance of base klass.
      if (__DEV__) {
        // ArtificialNode__DO_NOT_USE can get renamed, so we use the type
        const name = klass.name;
        const nodeType =
          hasOwnStaticMethod(klass, 'getType') && klass.getType();

        if (replaceWithKlass) {
          invariant(
            replaceWithKlass.prototype instanceof klass,
            "%s doesn't extend the %s",
            replaceWithKlass.name,
            name,
          );
        } else if (replace) {
          console.warn(
            `Override for ${name} specifies 'replace' without 'withKlass'. 'withKlass' will be required in a future version.`,
          );
        }
        if (
          name !== 'RootNode' &&
          nodeType !== 'root' &&
          nodeType !== 'artificial' &&
          // This is mostly for the unit test suite which
          // uses LexicalNode in an otherwise incorrect way
          // by mocking its static getType
          klass !== LexicalNode
        ) {
          (['getType', 'clone'] as const).forEach(method => {
            if (!hasOwnStaticMethod(klass, method)) {
              console.warn(`${name} must implement static "${method}" method`);
            }
          });
          if (!hasOwnStaticMethod(klass, 'importJSON')) {
            console.warn(
              `${name} should implement "importJSON" method to ensure JSON and default HTML serialization works as expected`,
            );
          }
        }
      }
      const type = klass.getType();
      const transforms = getTransformSetFromKlass(klass);
      registeredNodes.set(type, {
        exportDOM: html && html.export ? html.export.get(klass) : undefined,
        klass,
        replace,
        replaceWithKlass,
        sharedNodeState: createSharedNodeState(nodes[i]),
        transforms,
      });
    }
  }
  const editor = new LexicalEditor(
    editorState,
    parentEditor,
    registeredNodes,
    {
      disableEvents,
      dom: {
        ...DEFAULT_EDITOR_DOM_CONFIG,
        ...(editorConfig && editorConfig.dom),
      },
      namespace,
      theme,
    },
    onError ? onError : console.error,
    onWarn ? onWarn : defaultOnWarn,
    initializeConversionCache(registeredNodes, html ? html.import : undefined),
    isEditable,
    editorConfig,
  );

  if (initialEditorState !== undefined) {
    editor._pendingEditorState = initialEditorState;
    editor._dirtyType = FULL_RECONCILE;
  }

  registerDefaultCommandHandlers(editor);

  return editor;
}

function triggerListener<
  T extends (...args_: Args) => void | undefined | (() => void),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Args extends any[],
>(listenerMap: ListenerMap<T>, listener: T, args: Args) {
  const unregister = listenerMap.get(listener);
  if (unregister) {
    unregister();
  }
  listenerMap.set(listener, listener(...args) || undefined);
}

function unregisterListener<T>(listenerMap: ListenerMap<T>, listener: T): void {
  const unregister = listenerMap.get(listener);
  listenerMap.delete(listener);
  if (unregister) {
    unregister();
  }
}

function registerListener<T>(
  listenerMap: ListenerMap<T>,
  listener: T,
  unregister?: undefined | (() => void),
): () => void {
  listenerMap.set(listener, unregister);
  return unregisterListener.bind(null, listenerMap, listener);
}

export class LexicalEditor {
  /** @internal */
  declare ['constructor']: KlassConstructor<typeof LexicalEditor>;

  /** The version with build identifiers for this editor (since 0.17.1) */
  static version: string | undefined;

  /** @internal */
  _headless: boolean;
  /** @internal */
  _parentEditor: null | LexicalEditor;
  /** @internal */
  _rootElement: null | HTMLElement;
  /** @internal */
  _editorState: EditorState;
  /** @internal */
  _pendingEditorState: null | EditorState;
  /** @internal */
  _compositionKey: null | NodeKey;
  /** @internal */
  _deferred: (() => void)[];
  /** @internal */
  _keyToDOMMap: Map<NodeKey, HTMLElement & LexicalPrivateDOM>;
  /** @internal */
  _updates: [() => void, EditorUpdateOptions | undefined][];
  /** @internal */
  _updating: boolean;
  /** @internal */
  _cascadeCount: number;
  /** @internal */
  _listeners: Listeners;
  /** @internal */
  _commands: Commands;
  /** @internal */
  _nodes: RegisteredNodes;
  /** @internal */
  _decorators: Record<NodeKey, unknown>;
  /** @internal */
  _pendingDecorators: null | Record<NodeKey, unknown>;
  /** @internal */
  _config: EditorConfig;
  /** @internal */
  _dirtyType: 0 | 1 | 2;
  /** @internal */
  _cloneNotNeeded: Set<NodeKey>;
  /** @internal */
  _dirtyLeaves: Set<NodeKey>;
  /** @internal */
  _dirtyElements: Map<NodeKey, IntentionallyMarkedAsDirtyElement>;
  /** @internal */
  _normalizedNodes: Set<NodeKey>;
  /** @internal */
  _updateTags: Set<UpdateTag>;
  /** @internal */
  _observer: null | MutationObserver;
  /** @internal */
  _key: string;
  /** @internal */
  _onError: ErrorHandler;
  /** @internal */
  _onWarn: ErrorHandler;
  /** @internal */
  _htmlConversions: DOMConversionCache;
  /** @internal */
  _window: null | Window;
  /** @internal */
  _editable: boolean;
  /** @internal */
  _blockCursorElement: null | HTMLDivElement;
  /**
   * @internal @experimental
   *
   * Latches to `true` the first time {@link $setSlot} runs in this
   * editor. Gates the commit-time slot-containment clamp so editors that never
   * use slots skip the per-update frame walk entirely. The latch persists for
   * the lifetime of the editor instance — `resetEditor` and `setEditorState`
   * do not clear it, so an editor that once used slots keeps paying the clamp
   * cost even after switching to a slot-free state.
   */
  _slotsUsed: boolean;
  /** @internal */
  _keyDownShortcuts: null | CompiledKeyboardShortcuts<KeyDownShortcut>;
  /** @internal */
  _inputState: InputState;
  /** @internal */
  _createEditorArgs?: undefined | CreateEditorArgs;

  /** @internal */
  constructor(
    editorState: EditorState,
    parentEditor: null | LexicalEditor,
    nodes: RegisteredNodes,
    config: EditorConfig,
    onError: ErrorHandler,
    onWarn: ErrorHandler,
    htmlConversions: DOMConversionCache,
    editable: boolean,
    createEditorArgs?: CreateEditorArgs,
  ) {
    this._createEditorArgs = createEditorArgs;
    this._parentEditor = parentEditor;
    // The root element associated with this editor
    this._rootElement = null;
    // The current editor state
    this._editorState = editorState;
    // Handling of drafts and updates
    this._pendingEditorState = null;
    // Used to help co-ordinate selection and events
    this._compositionKey = null;
    this._deferred = [];
    // Used during reconciliation
    this._keyToDOMMap = new GenMap();
    this._updates = [];
    this._updating = false;
    this._cascadeCount = 0;
    // Listeners
    this._listeners = {
      decorator: new Map(),
      editable: new Map(),
      mutation: new Map(),
      root: new Map(),
      textcontent: new Map(),
      update: new Map(),
    };
    // Commands
    this._commands = new Map();
    // Editor configuration for theme/context.
    this._config = config;
    // Mapping of types to their nodes
    this._nodes = nodes;
    // React node decorators for portals
    this._decorators = {};
    this._pendingDecorators = null;
    // Used to optimize reconciliation
    this._dirtyType = NO_DIRTY_NODES;
    this._cloneNotNeeded = new Set();
    this._dirtyLeaves = new Set();
    this._dirtyElements = new Map();
    this._normalizedNodes = new Set();
    this._updateTags = new Set();
    // Handling of DOM mutations
    this._observer = null;
    // Used for identifying owning editors
    this._key = createUID();

    this._onError = onError;
    this._onWarn = onWarn;
    this._htmlConversions = htmlConversions;
    this._editable = editable;
    this._headless = parentEditor !== null && parentEditor._headless;
    this._window = null;
    this._blockCursorElement = null;
    this._slotsUsed = false;
    this._keyDownShortcuts = null;
    this._inputState = createInputState();
  }

  /**
   *
   * @returns true if the editor is currently in "composition" mode due to receiving input
   * through an IME, or 3P extension, for example. Returns false otherwise.
   */
  isComposing(): boolean {
    return this._compositionKey != null;
  }
  /**
   * Registers a listener for Editor update event. Will trigger the provided callback
   * each time the editor goes through an update (via {@link LexicalEditor.update}) until the
   * teardown function is called.
   *
   * @returns a teardown function that can be used to cleanup the listener.
   */
  registerUpdateListener(listener: UpdateListener): () => void {
    return registerListener(this._listeners.update, listener);
  }
  /**
   * Registers a listener for when the editor changes between editable and non-editable states.
   * Will trigger the provided callback each time the editor transitions between these states until the
   * teardown function is called.
   *
   * If the listener returns a function, that function will be called before the next transition or
   * teardown.
   *
   * @returns a teardown function that can be used to cleanup the listener.
   */
  registerEditableListener(listener: EditableListener): () => void {
    return registerListener(this._listeners.editable, listener);
  }
  /**
   * Registers a listener for when the editor's decorator object changes. The decorator object contains
   * all DecoratorNode keys -> their decorated value. This is primarily used with external UI frameworks.
   *
   * Will trigger the provided callback each time the editor transitions between these states until the
   * teardown function is called.
   *
   * @returns a teardown function that can be used to cleanup the listener.
   */
  registerDecoratorListener<T>(listener: DecoratorListener<T>): () => void {
    return registerListener(this._listeners.decorator, listener);
  }
  /**
   * Registers a listener for when Lexical commits an update to the DOM and the text content of
   * the editor changes from the previous state of the editor. If the text content is the
   * same between updates, no notifications to the listeners will happen.
   *
   * Will trigger the provided callback each time the editor transitions between these states until the
   * teardown function is called.
   *
   * @returns a teardown function that can be used to cleanup the listener.
   */
  registerTextContentListener(listener: TextContentListener): () => void {
    return registerListener(this._listeners.textcontent, listener);
  }
  /**
   * Registers a listener for when the editor's root DOM element (the content editable
   * Lexical attaches to) changes. This is primarily used to attach event listeners to the root
   *  element. The root listener function is executed directly upon registration and then on
   * any subsequent update.
   *
   * Will trigger the provided callback each time the editor transitions between these states until the
   * teardown function is called.
   *
   * If the listener returns a function, that function will be called before the next transition or
   * teardown.
   *
   * @returns a teardown function that can be used to cleanup the listener.
   */
  registerRootListener(listener: RootListener): () => void {
    const listenerMap = this._listeners.root;
    return mergeRegister(
      registerListener(
        listenerMap,
        listener,
        listener(this._rootElement, null) || undefined,
      ),
      () => triggerListener(listenerMap, listener, [null, this._rootElement]),
    );
  }
  /**
   * Registers a listener that will trigger anytime the provided command
   * is dispatched with {@link LexicalEditor.dispatch}, subject to priority.
   * Listeners that run at a higher priority can "intercept" commands and
   * prevent them from propagating to other handlers by returning true.
   *
   * Listeners are always invoked in an {@link LexicalEditor.update} and can
   * call dollar functions.
   *
   * Listeners registered at the same priority level will run
   * deterministically in the order of registration.
   *
   * @param command - the command that will trigger the callback.
   * @param listener - the function that will execute when the command is dispatched.
   * @param priority - the relative priority of the listener. 0 | 1 | 2 | 3 | 4
   *   (or {@link COMMAND_PRIORITY_EDITOR} |
   *     {@link COMMAND_PRIORITY_LOW} |
   *     {@link COMMAND_PRIORITY_NORMAL} |
   *     {@link COMMAND_PRIORITY_HIGH} |
   *     {@link COMMAND_PRIORITY_CRITICAL})
   * @returns a teardown function that can be used to cleanup the listener.
   */
  registerCommand<P>(
    command: LexicalCommand<P>,
    listener: CommandListener<P>,
    priority: CommandListenerPriority | CommandListenerPriorityBefore,
  ): () => void {
    if (priority === undefined) {
      invariant(false, 'Listener for type "command" requires a "priority".');
    }

    const commandsMap = this._commands;

    if (!commandsMap.has(command)) {
      commandsMap.set(command, [
        new DequeSet(),
        new DequeSet(),
        new DequeSet(),
        new DequeSet(),
        new DequeSet(),
      ]);
    }

    const listenersInPriorityOrder = commandsMap.get(command);

    if (listenersInPriorityOrder === undefined) {
      invariant(
        false,
        'registerCommand: Command %s not found in command map',
        String(command),
      );
    }

    const normalizedPriority = normalizePriority(priority);

    const listeners = listenersInPriorityOrder[normalizedPriority];
    if (normalizedPriority !== priority) {
      listeners.addFront(listener);
    } else {
      listeners.addBack(listener);
    }
    return () => {
      listeners.delete(listener);

      if (
        listenersInPriorityOrder.every(listenersSet => listenersSet.size === 0)
      ) {
        commandsMap.delete(command);
      }
    };
  }

  /**
   * Registers a listener that will run when a Lexical node of the provided class is
   * mutated. The listener will receive a list of nodes along with the type of mutation
   * that was performed on each: created, destroyed, or updated.
   *
   * One common use case for this is to attach DOM event listeners to the underlying DOM nodes as Lexical nodes are created.
   * {@link LexicalEditor.getElementByKey} can be used for this.
   *
   * If any existing nodes are in the DOM, and skipInitialization is not true, the listener
   * will be called immediately with an updateTag of 'registerMutationListener' where all
   * nodes have the 'created' NodeMutation. This can be controlled with the skipInitialization option
   * (whose default was previously true for backwards compatibility with &lt;=0.16.1 but has been changed to false as of 0.21.0).
   *
   * @param klass - The class of the node that you want to listen to mutations on.
   * @param listener - The logic you want to run when the node is mutated.
   * @param options - see {@link MutationListenerOptions}
   * @returns a teardown function that can be used to cleanup the listener.
   */
  registerMutationListener(
    klass: Klass<LexicalNode>,
    listener: MutationListener,
    options?: MutationListenerOptions,
  ): () => void {
    const klassToMutate = this.resolveRegisteredNodeAfterReplacements(
      this.getRegisteredNode(klass),
    ).klass;
    const mutations = this._listeners.mutation;
    let klassSet = mutations.get(listener);
    if (klassSet === undefined) {
      klassSet = new Set();
      mutations.set(listener, klassSet);
    }
    klassSet.add(klassToMutate);
    const skipInitialization = options && options.skipInitialization;
    if (
      !(skipInitialization === undefined
        ? DEFAULT_SKIP_INITIALIZATION
        : skipInitialization)
    ) {
      this.initializeMutationListener(listener, klassToMutate);
    }

    return () => {
      klassSet.delete(klassToMutate);
      if (klassSet.size === 0) {
        mutations.delete(listener);
      }
    };
  }

  /** @internal */
  getRegisteredNode(klass: Klass<LexicalNode>): RegisteredNode {
    const registeredNode = this._nodes.get(klass.getType());

    if (registeredNode === undefined) {
      invariant(
        false,
        'Node %s has not been registered. Ensure node has been passed to createEditor.',
        klass.name,
      );
    }

    return registeredNode;
  }

  /** @internal */
  resolveRegisteredNodeAfterReplacements(
    registeredNode: RegisteredNode,
  ): RegisteredNode {
    while (registeredNode.replaceWithKlass) {
      registeredNode = this.getRegisteredNode(registeredNode.replaceWithKlass);
    }
    return registeredNode;
  }

  /** @internal */
  private initializeMutationListener(
    listener: MutationListener,
    klass: Klass<LexicalNode>,
  ): void {
    const prevEditorState = this._editorState;
    const nodeMap = getCachedTypeToNodeMap(prevEditorState).get(
      klass.getType(),
    );
    if (!nodeMap) {
      return;
    }
    const nodeMutationMap = new Map<string, NodeMutation>();
    for (const k of nodeMap.keys()) {
      nodeMutationMap.set(k, 'created');
    }
    if (nodeMutationMap.size > 0) {
      listener(nodeMutationMap, {
        dirtyLeaves: new Set(),
        prevEditorState,
        updateTags: new Set(['registerMutationListener']),
      });
    }
  }

  /** @internal */
  private registerNodeTransformToKlass<T extends LexicalNode>(
    klass: Klass<T>,
    listener: Transform<T>,
  ): RegisteredNode {
    const registeredNode = this.getRegisteredNode(klass);
    registeredNode.transforms.add(listener as Transform<LexicalNode>);

    return registeredNode;
  }

  /**
   * Registers a listener that will run when a Lexical node of the provided class is
   * marked dirty during an update. The listener will continue to run as long as the node
   * is marked dirty. There are no guarantees around the order of transform execution!
   *
   * Watch out for infinite loops. See [Node Transforms](https://lexical.dev/docs/concepts/transforms)
   * @param klass - The class of the node that you want to run transforms on.
   * @param listener - The logic you want to run when the node is updated.
   * @returns a teardown function that can be used to cleanup the listener.
   */
  registerNodeTransform<T extends LexicalNode>(
    klass: Klass<T>,
    listener: Transform<T>,
  ): () => void {
    const registeredNode = this.registerNodeTransformToKlass(klass, listener);
    const registeredNodes = [registeredNode];

    const replaceWithKlass = registeredNode.replaceWithKlass;
    if (replaceWithKlass != null) {
      const registeredReplaceWithNode = this.registerNodeTransformToKlass(
        replaceWithKlass,
        listener as Transform<LexicalNode>,
      );
      registeredNodes.push(registeredReplaceWithNode);
    }

    markNodesWithTypesAsDirty(
      this,
      registeredNodes.map(node => node.klass.getType()),
    );
    return () => {
      registeredNodes.forEach(node =>
        node.transforms.delete(listener as Transform<LexicalNode>),
      );
    };
  }

  /**
   * Used to assert that a certain node is registered, usually by plugins to ensure nodes that they
   * depend on have been registered.
   * @returns True if the editor has registered the provided node type, false otherwise.
   */
  hasNode<T extends Klass<LexicalNode>>(node: T): boolean {
    return this._nodes.has(node.getType());
  }

  /**
   * Used to assert that certain nodes are registered, usually by plugins to ensure nodes that they
   * depend on have been registered.
   * @returns True if the editor has registered all of the provided node types, false otherwise.
   */
  hasNodes<T extends Klass<LexicalNode>>(nodes: T[]): boolean {
    return nodes.every(this.hasNode.bind(this));
  }

  /**
   * Dispatches a command of the specified type with the specified payload.
   * This triggers all command listeners (set by {@link LexicalEditor.registerCommand})
   * for this type, passing them the provided payload. The command listeners
   * will be triggered in an implicit {@link LexicalEditor.update}, unless
   * this was invoked from inside an update in which case that update context
   * will be re-used (as if this was a dollar function itself).
   * @param type - the type of command listeners to trigger.
   * @param payload - the data to pass as an argument to the command listeners.
   */
  dispatchCommand<TCommand extends AnyLexicalCommand>(
    type: TCommand,
    ...args: CommandPayloadArgs<CommandPayloadType<TCommand>>
  ): boolean {
    return dispatchCommand(this, type, ...args);
  }

  /**
   * Gets a map of all decorators in the editor.
   * @returns A mapping of call decorator keys to their decorated content
   */
  getDecorators<T>(): Record<NodeKey, T> {
    return this._decorators as Record<NodeKey, T>;
  }

  /**
   *
   * @returns the current root element of the editor. If you want to register
   * an event listener, do it via {@link LexicalEditor.registerRootListener}, since
   * this reference may not be stable.
   */
  getRootElement(): null | HTMLElement {
    return this._rootElement;
  }

  /**
   * Gets the key of the editor
   * @returns The editor key
   */
  getKey(): string {
    return this._key;
  }

  /**
   * Imperatively set the root contenteditable element that Lexical listens
   * for events on.
   */
  setRootElement(nextRootElement: null | HTMLElement): void {
    const prevRootElement = this._rootElement;

    if (nextRootElement !== prevRootElement) {
      const classNames = getCachedClassNameArray(this._config.theme, 'root');
      const pendingEditorState = this._pendingEditorState || this._editorState;
      this._rootElement = nextRootElement;
      resetEditor(this, prevRootElement, nextRootElement, pendingEditorState, {
        preserveUpdateQueue: true,
      });

      if (prevRootElement !== null) {
        // TODO: remove this flag once we no longer use UEv2 internally
        if (!this._config.disableEvents) {
          removeRootElementEvents(prevRootElement);
        }
        if (classNames != null) {
          prevRootElement.classList.remove(...classNames);
        }
      }

      if (nextRootElement !== null) {
        const windowObj = getDefaultView(nextRootElement);
        const style = nextRootElement.style;
        style.userSelect = 'text';
        style.whiteSpace = 'pre-wrap';
        style.wordBreak = 'break-word';
        nextRootElement.setAttribute('data-lexical-editor', 'true');
        this._window = windowObj;
        this._dirtyType = FULL_RECONCILE;
        initMutationObserver(this);

        this._updateTags.add(HISTORY_MERGE_TAG);

        $commitPendingUpdates(this);

        // TODO: remove this flag once we no longer use UEv2 internally
        if (!this._config.disableEvents) {
          addRootElementEvents(nextRootElement, this);
        }
        if (classNames != null) {
          nextRootElement.classList.add(...classNames);
        }
        if (__DEV__) {
          const nextRootElementParent = getParentElement(nextRootElement);
          if (
            nextRootElementParent != null &&
            ['flex', 'inline-flex'].includes(
              getComputedStyle(nextRootElementParent).display,
            )
          ) {
            console.warn(
              `When using "display: flex" or "display: inline-flex" on an element containing content editable, Chrome may have unwanted focusing behavior when clicking outside of it. Consider wrapping the content editable within a non-flex element.`,
            );
          }
        }
      } else {
        // When the content editable is unmounted we will still trigger a
        // reconciliation so that any pending updates are flushed,
        // to match the previous state change when
        // `_editorState = pendingEditorState` was used, but by
        // using a commit we preserve the readOnly invariant
        // for editor.getEditorState().
        this._window = null;
        this._updateTags.add(HISTORY_MERGE_TAG);
        $commitPendingUpdates(this);
      }

      triggerListeners('root', this, false, nextRootElement, prevRootElement);
    }
  }

  /**
   * Gets the underlying HTMLElement associated with the LexicalNode for the given key.
   * @returns the HTMLElement rendered by the LexicalNode associated with the key.
   * @param key - the key of the LexicalNode.
   */
  getElementByKey(key: NodeKey): HTMLElement | null {
    return this._keyToDOMMap.get(key) || null;
  }

  /**
   * Gets the active editor state.
   * @returns The editor state
   */
  getEditorState(): EditorState {
    return this._editorState;
  }

  /**
   * Imperatively set the EditorState. Triggers reconciliation like an update.
   * @param editorState - the state to set the editor
   * @param options - options for the update.
   */
  setEditorState(editorState: EditorState, options?: EditorSetOptions): void {
    if (editorState.isEmpty()) {
      invariant(
        false,
        "setEditorState: the editor state is empty. Ensure the editor state's root node never becomes empty.",
      );
    }

    // Ensure that we have a writable EditorState so that transforms can run
    // during a historic operation
    let writableEditorState = editorState;
    if (writableEditorState._readOnly) {
      writableEditorState = cloneEditorState(editorState);
      writableEditorState._selection = editorState._selection
        ? editorState._selection.clone()
        : null;
    }

    flushRootMutations(this);
    const pendingEditorState = this._pendingEditorState;
    const tag = options !== undefined ? options.tag : null;

    if (pendingEditorState !== null && !pendingEditorState.isEmpty()) {
      if (tag != null) {
        this._updateTags.add(tag);
      }
      // This may commit a no-op update (e.g. when called via dispatchCommand
      // mid-update), which resets this._updateTags to a fresh Set. Always read
      // this._updateTags fresh below rather than caching the reference, so the
      // tag for the editor state we are about to apply is added to the live Set
      // that the subsequent commit will observe.
      $commitPendingUpdates(this);
    }

    this._pendingEditorState = writableEditorState;
    this._dirtyType = FULL_RECONCILE;
    this._dirtyElements.set('root', false);
    this._compositionKey = null;
    this._slotsUsed = this._slotsUsed || editorState._slotsUsed;

    // Only commit pending updates if not already in an editor.update
    // (e.g. dispatchCommand) otherwise this will cause a second commit
    // with an already read-only state and selection
    updateEditorSync(
      this,
      () => {
        if (tag) {
          this._updateTags.add(tag);
        }
        if (editorState._parsed) {
          for (const [key, node] of writableEditorState._nodeMap.entries()) {
            // Mark all nodes as dirty with a freshly parsed EditorState
            // hydrate-time normalize: external inputs (URL doc payloads, imported
            // JSON, paste round-trips) may carry shadow-root slot frames whose
            // children violate the `Children of root nodes must be elements or
            // decorators` invariant set by `getTopLevelElement`. In-editor mutation
            // paths still fail-fast on the invariant — this only catches shapes
            // that were parsed in from outside.
            //
            // Drives the existing dirty-node transform cycle: dirty-mark the slot
            // hosts so `ElementNode`'s `$config` `$transform` (which calls
            // `$normalizeShadowRootChildren`) picks them up.
            if ($isElementNode(node)) {
              this._dirtyElements.set(key, true);
            } else {
              this._dirtyLeaves.add(key);
            }
          }
        }
      },
      {discrete: this._updating ? undefined : true},
    );
  }

  /**
   * Parses a SerializedEditorState (usually produced by {@link EditorState.toJSON}) and returns
   * and EditorState object that can be, for example, passed to {@link LexicalEditor.setEditorState}. Typically,
   * deserialization from JSON stored in a database uses this method.
   * @param maybeStringifiedEditorState
   * @param updateFn
   * @returns
   */
  parseEditorState(
    maybeStringifiedEditorState: string | SerializedEditorState,
    updateFn?: () => void,
  ): EditorState {
    const serializedEditorState =
      typeof maybeStringifiedEditorState === 'string'
        ? JSON.parse(maybeStringifiedEditorState)
        : maybeStringifiedEditorState;
    return parseEditorState(serializedEditorState, this, updateFn);
  }

  /**
   * Executes a read of the editor's state, with the
   * editor context available (useful for exporting and read-only DOM
   * operations). Much like update, but prevents any mutation of the
   * editor's state.
   *
   * When called with a single argument the `mode` defaults to
   * `'force-commit'`, which flushes any pending updates immediately before the
   * read so it always observes a fully committed and reconciled state. See
   * {@link EditorReadMode} for the behavior of the other modes (`'pending'`
   * and `'latest'`).
   * @param callbackFn - A function that has access to read-only editor state.
   */
  read<T>(callbackFn: () => T): T;
  /**
   * Executes a read of the editor's state in the given `mode`, with the editor
   * context available. See {@link EditorReadMode} for the available modes.
   * @param mode - Which editor state to read and whether to flush first.
   * @param callbackFn - A function that has access to read-only editor state.
   */
  read<T>(mode: EditorReadMode, callbackFn: () => T): T;
  read<T>(...args: [() => T] | [EditorReadMode, () => T]): T {
    const [mode, callbackFn]: [EditorReadMode, () => T] =
      args.length === 1 ? ['force-commit', args[0]] : args;
    if (mode === 'force-commit') {
      $commitPendingUpdates(this);
    }
    // 'pending' observes an in-progress or queued update without flushing it;
    // 'force-commit' and 'latest' read the committed (reconciled) state.
    const editorState =
      mode === 'pending'
        ? this._pendingEditorState || this._editorState
        : this.getEditorState();
    return editorState.read(callbackFn, {editor: this});
  }

  /**
   * Executes an update to the editor state. The updateFn callback is the ONLY place
   * where Lexical editor state can be safely mutated.
   * @param updateFn - A function that has access to writable editor state.
   * @param options - A bag of options to control the behavior of the update.
   */
  update(updateFn: () => void, options?: EditorUpdateOptions): void {
    updateEditor(this, updateFn, options);
  }

  /**
   * Focuses the editor by marking the existing selection as dirty, or by
   * creating a new selection at `defaultSelection` if one does not already
   * exist. If you want to force a specific selection, you should call
   * `root.selectStart()` or `root.selectEnd()` in an update.
   *
   * @param callbackFn - A function to run after the editor is focused.
   * @param options - A bag of options
   */
  focus(callbackFn?: () => void, options: EditorFocusOptions = {}): void {
    const rootElement = this._rootElement;

    if (rootElement !== null) {
      // This ensures that iOS does not trigger caps lock upon focus
      rootElement.setAttribute('autocapitalize', 'off');
      updateEditorSync(this, () => {
        const selection = $getSelection();
        const root = $getRoot();

        if (selection !== null) {
          // Marking the selection dirty will force the selection back to it
          if (!selection.dirty) {
            $setSelection(selection.clone());
          }
        } else if (root.getChildrenSize() !== 0) {
          if (options.defaultSelection === 'rootStart') {
            root.selectStart();
          } else {
            root.selectEnd();
          }
        }
        $addUpdateTag(FOCUS_TAG);
        $onUpdate(() => {
          rootElement.removeAttribute('autocapitalize');
          if (callbackFn) {
            callbackFn();
          }
        });
      });
      // In the case where onUpdate doesn't fire (due to the focus update not
      // occurring).
      if (this._pendingEditorState === null) {
        rootElement.removeAttribute('autocapitalize');
      }
    }
  }

  /**
   * Removes focus from the editor.
   */
  blur(): void {
    const rootElement = this._rootElement;

    if (rootElement !== null) {
      rootElement.blur();
    }

    const domSelection = getDOMSelection(this._window);

    if (domSelection !== null) {
      domSelection.removeAllRanges();
    }
  }
  /**
   * Returns true if the editor is editable, false otherwise.
   * @returns True if the editor is editable, false otherwise.
   */
  isEditable(): boolean {
    return this._editable;
  }
  /**
   * Sets the editable property of the editor. When false, the
   * editor will not listen for user events on the underling contenteditable.
   * @param editable - the value to set the editable mode to.
   */
  setEditable(editable: boolean): void {
    if (this._editable !== editable) {
      this._editable = editable;
      triggerListeners('editable', this, true, editable);
      // A named-slot island rendered inside a non-editable host carries an
      // explicit `contentEditable` resolved from this editable state, so it
      // does not follow the root's editability on its own. Re-render to push
      // the toggle into those islands. A normal (non-discrete) update is safe
      // whether `setEditable` is called standalone (it commits on a microtask)
      // or from inside an update (it queues into that update's commit). Gated
      // on `_slotsUsed` so an editor that never slots anything keeps the
      // original no-reconcile behavior.
      if (this._slotsUsed) {
        this.update(() => $fullReconcile());
      }
    }
  }
  /**
   * Returns a JSON-serializable javascript object NOT a JSON string.
   * You still must call JSON.stringify (or something else) to turn the
   * state into a string you can transfer over the wire and store in a database.
   *
   * See {@link LexicalNode.exportJSON}
   *
   * @returns A JSON-serializable javascript object
   */
  toJSON(): SerializedEditor {
    return {
      editorState: this._editorState.toJSON(),
    };
  }
}

LexicalEditor.version = LEXICAL_VERSION;
