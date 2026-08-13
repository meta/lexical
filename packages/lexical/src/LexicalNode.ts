/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {PROTOTYPE_CONFIG_METHOD} from './LexicalConstants';
import type {
  EditorConfig,
  Klass,
  KlassConstructor,
  LexicalEditor,
} from './LexicalEditor';

import invariant from '@lexical/internal/invariant';

import {
  $createParagraphNode,
  $getCommonAncestor,
  $getCommonAncestorResultBranchOrder,
  $isDecoratorNode,
  $isElementNode,
  $isRootNode,
  $isTextNode,
  type DecoratorNode,
  type ElementNode,
  type NODE_STATE_KEY,
} from '.';
import {DOMSlot} from './LexicalDOMSlot';
import {
  $updateStateFromJSON,
  type NodeState,
  type NodeStateJSON,
  type Prettify,
  type RequiredNodeStateConfig,
} from './LexicalNodeState';
import {CACHED_TEXT_SIZE_KEY} from './LexicalReconciler';
import {
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  $moveSelectionPointToEnd,
  $updateElementSelectionOnCreateDeleteNode,
  type BaseSelection,
  moveSelectionPointToSibling,
  type RangeSelection,
} from './LexicalSelection';
import {
  $errorOnSlotCycleChild,
  $getSlotHost,
  $getSlotHostKey,
  $getSlotsTextContent,
} from './LexicalSlot';
import {
  errorOnReadOnly,
  getActiveEditor,
  getActiveEditorState,
} from './LexicalUpdates';
import {
  $cloneWithProperties,
  $getCompositionKey,
  $getNodeByKey,
  $hasAncestor,
  $isRootOrShadowRoot,
  $maybeMoveChildrenSelectionToParent,
  $removeFromParent,
  $setCompositionKey,
  $setNodeKey,
  $setSelection,
  errorOnInsertTextNodeOnRoot,
  getRegisteredNode,
  getStaticNodeConfig,
  getSuperclassOf,
  internalMarkNodeAsDirty,
} from './LexicalUtils';

const __DEV__ = process.env.NODE_ENV !== 'production';

export type NodeMap = Map<NodeKey, LexicalNode>;

/**
 * The base type for all serialized nodes
 */
export type SerializedLexicalNode = {
  /** The type string used by the Node class */
  type: string;
  /** A numeric version for this schema, defaulting to 1, but not generally recommended for use */
  version: number;
  /**
   * Any state persisted with the NodeState API that is not
   * configured for flat storage
   */
  [NODE_STATE_KEY]?: Record<string, unknown>;
  /**
   * Named slot subtrees keyed by slot name. Present on host nodes (an
   * ElementNode or DecoratorNode that registered slots via `$setSlot`).
   * The `$` prefix keeps the framework-owned key out of the namespace a
   * third-party subclass may already use for its own serialized `slots`
   * property (mirroring the reserved NodeState `'$'` key).
   * @experimental named-slots
   */
  $slots?: Record<string, SerializedLexicalNode>;
};

/**
 * EXPERIMENTAL
 * The configuration of a node returned by LexicalNode.$config()
 *
 * @example
 * ```ts
 * class CustomText extends TextNode {
 *   $config() {
 *     return this.config('custom-text', {extends: TextNode}};
 *   }
 * }
 * ```
 */
export interface StaticNodeConfigValue<
  T extends LexicalNode,
  Type extends string | symbol,
> {
  /**
   * The exact type of T.getType(), e.g. 'text' - the method itself must
   * have a more generic 'string' type to be compatible wtih subclassing.
   *
   * For a concrete node this is its string `type`. An abstract base class is
   * keyed in {@link BaseStaticNodeConfig} by a symbol (it has no concrete node
   * `type`), so `Type` is widened to `string | symbol`; the `type` field is
   * never populated for a symbol-keyed config.
   */
  readonly type?: Type;
  /**
   * An alternative to the internal static transform() method
   * that provides better type inference. If implemented this
   * transform will be registered for this class and any subclass.
   */
  readonly $transform?: (node: T) => void;
  /**
   * An alternative to the static importJSON() method
   * that provides better type inference.
   */
  readonly $importJSON?: (serializedNode: SerializedLexicalNode) => T;
  /**
   * An alternative to the static importDOM() method
   */
  readonly importDOM?: DOMConversionMap;
  /**
   * EXPERIMENTAL
   *
   * An array of RequiredNodeStateConfig to initialize your node with
   * its state requirements. This may be used to configure serialization of
   * that state.
   *
   * This function will be called (at most) once per editor initialization,
   * directly on your node's prototype. It must not depend on any state
   * initialized in the constructor.
   *
   * @example
   * ```ts
   * const flatState = createState("flat", {parse: parseNumber});
   * const nestedState = createState("nested", {parse: parseNumber});
   * class MyNode extends TextNode {
   *   $config() {
   *     return this.config(
   *       'my-node',
   *       {
   *         extends: TextNode,
   *         stateConfigs: [
   *           { stateConfig: flatState, flat: true},
   *           nestedState,
   *         ]
   *       },
   *     );
   *   }
   * }
   * ```
   */
  readonly stateConfigs?: readonly RequiredNodeStateConfig[];
  /**
   * @experimental named-slots
   *
   * Canonical order for this host's named slots. Declared names render,
   * fold, serialize, and traverse in this order; occupied names that are
   * not declared follow in code-unit order. Order is derived from this
   * declaration at every {@link $setSlot} (never stored), so documents
   * re-canonicalize on load and concurrent collaborative slot additions
   * converge to the same order on every client. The declaration is not a
   * schema: undeclared names are still accepted and retained, so adding,
   * reordering, or dropping entries over time is non-destructive.
   *
   * Declaring slots also opts the host into eager slots-map creation in
   * \@lexical/yjs, which makes each name's first set merge per-entry under
   * concurrency instead of racing on attribute creation.
   */
  readonly slots?: readonly string[];
  /**
   * If specified, this must be the exact superclass of the node. It is not
   * checked at compile time and it is provided automatically at runtime.
   *
   * You would want to specify this when you are extending a node that
   * has non-trivial configuration in its $config such
   * as required state. If you do not specify this, the inferred
   * types for your node class might be missing some of that.
   */
  readonly extends?: Klass<LexicalNode>;
}

/**
 * This is the type of LexicalNode.$config() that can be
 * overridden by subclasses.
 *
 * Concrete nodes are keyed by their string `type`. An abstract base class
 * (such as ElementNode or DecoratorNode) has no concrete node `type`, so when
 * it needs to declare configuration that is shared with its concrete
 * subclasses (for example required {@link RequiredNodeStateConfig} state or a
 * `$transform`) it is keyed instead by a well-known symbol, by convention
 * `Symbol.for(<NodeClassName>)` (e.g. `Symbol.for('ElementNode')`). The
 * descriptive, globally-registered symbol keeps the config easy to find in a
 * debugger and can never collide with a real node `type`.
 */
export type BaseStaticNodeConfig = {
  readonly [K in string | symbol]?:
    | undefined
    | StaticNodeConfigValue<LexicalNode, K>;
};

/**
 * Used to extract the node and type from a StaticNodeConfigRecord
 */
export type StaticNodeConfig<
  T extends LexicalNode,
  Type extends string,
> = BaseStaticNodeConfig & {
  readonly [K in Type]?: StaticNodeConfigValue<T, Type>;
};

/**
 * Any StaticNodeConfigValue (for generics and collections)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStaticNodeConfigValue = StaticNodeConfigValue<any, any>;

/**
 * @internal
 *
 * Type-only key under which a {@link StaticNodeConfigRecord} carries the node's
 * own (most-derived) `type` as a nullary accessor `() => Type`.
 *
 * TypeScript's type system is structural, so a node subclass that adds no
 * type-distinguishable members over its base (e.g. {@link TabNode} over
 * {@link TextNode}, which only overrides methods with identical signatures) is
 * structurally identical to that base despite being a distinct class — the
 * negative branch of an `instanceof`-style guard like `$isTabNode()` would
 * otherwise collapse to `never` because TypeScript concludes the base is also
 * assignable to the subclass.
 *
 * Encoding the type as a *function* (rather than a bare `Type`) lets the
 * accessor accumulate down the `extends` chain by intersection: a subclass'
 * record is `ParentRecord & {[STATIC_NODE_TYPE]: () => OwnType}`, so the key
 * holds `(() => ParentType) & (() => OwnType)`. TypeScript resolves an
 * intersection of call signatures as an overload set, which has two effects:
 *
 * - {@link GetStaticNodeType} reads `ReturnType<...>`, which selects the *last*
 *   overload — the most-derived own `type` — rather than a union of the chain.
 * - A node stays assignable to each of its ancestors (the intersection
 *   satisfies every `() => AncestorType`) while an ancestor is not assignable
 *   to it (it lacks the `() => OwnType` signature), so guards narrow correctly
 *   at every level of the hierarchy — not just one.
 *
 * This keeps the node classes themselves nominally distinguishable along their
 * real hierarchy; it is not a cross-cutting trait marker. The accessor is never
 * read at runtime — `config()` does not set this key — so it is `declare`-only
 * and carries no runtime cost. It is `@internal` (surfaced via the
 * {@link StaticNodeTypeAccessor} interface so that inferred `$config()` return
 * types remain nameable in generated declaration files) and a node never
 * references it. Distinction is automatic for any node that declares its
 * `extends`; a subclass adds nothing by hand.
 */
export declare const STATIC_NODE_TYPE: unique symbol;

/**
 * @internal
 *
 * Carries a node's own `type` under the {@link STATIC_NODE_TYPE} accessor. This
 * is an `interface` (rather than an inline object type) on purpose: it is never
 * inlined in generated declaration files, so a subclass' `$config()` return type
 * references it by name (`StaticNodeTypeAccessor<'tab'>`) and the symbol key
 * stays encapsulated here rather than leaking — unnamed — into every node's
 * `.d.ts`.
 */
export interface StaticNodeTypeAccessor<Type extends string> {
  readonly [STATIC_NODE_TYPE]: () => Type;
}

/**
 * @internal
 *
 * Type-only key under which a {@link StaticNodeConfigRecord} carries the node's
 * own configuration (the value passed to {@link LexicalNode.config}) as a
 * nullary accessor `() => Config`.
 *
 * This mirrors {@link STATIC_NODE_TYPE}: encoding the config as a *function*
 * lets it accumulate down the `extends` chain by call-signature intersection so
 * that `ReturnType<...>` resolves the most-derived own config. It exists so that
 * an abstract base class keyed by a symbol — which has no string `type` to index
 * the record by — can still expose its own config to the state-config
 * collectors, and so that such a base's symbol-keyed `$config()` return remains
 * a valid override of an accessor-bearing superclass `$config()` (it inherits
 * the superclass record, hence that record's {@link STATIC_NODE_TYPE} accessor).
 * Never read at runtime — `config()` does not set this key — so it is
 * `declare`-only and carries no runtime cost.
 */
export declare const STATIC_NODE_CONFIG: unique symbol;

/**
 * @internal
 *
 * Carries a node's own config under the {@link STATIC_NODE_CONFIG} accessor.
 * Like {@link StaticNodeTypeAccessor} this is a named `interface` so the symbol
 * key stays encapsulated and inferred `$config()` return types remain nameable
 * in generated declaration files.
 */
export interface StaticNodeConfigAccessor<
  Config extends AnyStaticNodeConfigValue,
> {
  readonly [STATIC_NODE_CONFIG]: () => Config;
}

/**
 * @internal
 *
 * This is the more specific type than BaseStaticNodeConfig that a subclass
 * should return from $config().
 *
 * A node that declares its `extends` accumulates the configuration of its
 * superclass and records its own `type` under {@link STATIC_NODE_TYPE} and its
 * own config under {@link STATIC_NODE_CONFIG}, so that it is nominally distinct
 * from — yet still assignable to — that superclass, and so the state-config
 * collectors can read its own config without indexing by `type`.
 */
export type StaticNodeConfigRecord<
  Type extends string,
  Config extends AnyStaticNodeConfigValue,
> = Config extends {
  extends: abstract new (...args: never) => infer Inst extends LexicalNode;
}
  ? ReturnType<Inst[typeof PROTOTYPE_CONFIG_METHOD]> & {
      readonly [K in Type]?: Config;
    } & StaticNodeTypeAccessor<Type> &
      StaticNodeConfigAccessor<Config>
  : BaseStaticNodeConfig & {readonly [K in Type]?: Config};

/**
 * @internal
 *
 * The record returned by {@link LexicalNode.config} for an abstract base class
 * keyed by a symbol. Unlike {@link StaticNodeConfigRecord} it records no string
 * `type` and adds no {@link STATIC_NODE_TYPE} accessor (an abstract base has no
 * concrete node type), but it does inherit its superclass record and expose its
 * own config under {@link STATIC_NODE_CONFIG}. Inheriting the superclass record
 * is what keeps the override valid when the superclass is a concrete node whose
 * `$config()` return already carries a {@link STATIC_NODE_TYPE} accessor.
 */
export type AbstractStaticNodeConfigRecord<
  Config extends AnyStaticNodeConfigValue,
> = Config extends {
  extends: abstract new (...args: never) => infer Inst extends LexicalNode;
}
  ? ReturnType<Inst[typeof PROTOTYPE_CONFIG_METHOD]> &
      StaticNodeConfigAccessor<Config>
  : BaseStaticNodeConfig & StaticNodeConfigAccessor<Config>;

/**
 * Extract the type from a node based on its $config
 *
 * @example
 * ```ts
 * type TextNodeType = GetStaticNodeType<TextNode>;
 *      // ? 'text'
 * ```
 */
export type GetStaticNodeType<T extends LexicalNode> =
  ReturnType<T[typeof PROTOTYPE_CONFIG_METHOD]> extends {
    readonly [STATIC_NODE_TYPE]: infer Accessor extends () => string;
  }
    ? ReturnType<Accessor>
    : ReturnType<T[typeof PROTOTYPE_CONFIG_METHOD]> extends StaticNodeConfig<
          T,
          infer Type
        >
      ? Type
      : string;

/**
 * @internal
 *
 * A node's own config (the value it passed to {@link LexicalNode.config}), read
 * from the {@link STATIC_NODE_CONFIG} accessor, or `never` for a node whose
 * `$config()` does not set that accessor (a legacy node, or one whose record
 * uses the {@link BaseStaticNodeConfig} fallback). Unlike indexing the record by
 * a resolved string `type`, this also resolves the own config of an abstract
 * base class keyed by a symbol.
 */
export type GetStaticNodeOwnConfig<T extends LexicalNode> =
  ReturnType<T[typeof PROTOTYPE_CONFIG_METHOD]> extends {
    readonly [STATIC_NODE_CONFIG]: infer Accessor extends
      () => AnyStaticNodeConfigValue;
  }
    ? ReturnType<Accessor>
    : never;

/**
 * The most precise type we can infer for the JSON that will
 * be produced by T.exportJSON().
 *
 * Do not use this for the return type of T.exportJSON()! It must be
 * a more generic type to be compatible with subclassing.
 */
export type LexicalExportJSON<T extends LexicalNode> = Prettify<
  Omit<ReturnType<T['exportJSON']>, 'type'> & {
    type: GetStaticNodeType<T>;
  } & NodeStateJSON<T>
>;

/**
 * Omit the children, type, and version properties from the given SerializedLexicalNode definition.
 */
export type LexicalUpdateJSON<T extends SerializedLexicalNode> = Omit<
  T,
  'children' | 'type' | 'version'
>;

/** @internal */
export interface LexicalPrivateDOM {
  __lexicalTextContent?: string | undefined | null;
  /**
   * @experimental named-slots. Byte length of the slot text folded slots-first
   * into the front of `__lexicalTextContent` for a host element. The suffix
   * fast path splices the linked-list child suffix, which lives after this
   * prefix, so it strips this many leading chars to recover the child-only
   * text before splicing and lets the slot fold re-prepend the slot text.
   * Absent / `0` for non-host elements, so non-slot trees splice unchanged.
   */
  __lexicalSlotTextLength?: number | undefined;
  /**
   * NodeKey of the deep first text descendant (DFS order) of this
   * element, or `null` if the subtree carries no text descendants.
   * Maintained alongside `__lexicalTextContent` and used by the
   * suffix-incremental fast path in `$reconcileChildren` to decide in
   * O(1) (via the cycle's dirty-children set) whether the prefix still
   * carries the canonical first text descendant.
   */
  __lexicalFirstTextKey?: NodeKey | null | undefined;
  __lexicalLineBreak?: HTMLBRElement | HTMLImageElement | undefined | null;
  /**
   * Kind of last child recorded for this element during the previous
   * reconcile, used by `$reconcileElementTerminatingLineBreak` to decide
   * whether the trailing-`<br>` shape needs to change without calling
   * `isInline()` on the prev-state node reference (which would resolve
   * to a detached node once the last child has been removed in this
   * commit). Set alongside `setManagedLineBreak` / cleared alongside
   * `removeManagedLineBreak`.
   */
  __lexicalLastChildKind?:
    | 'line-break'
    | 'decorator'
    | 'empty'
    | null
    | undefined;
  __lexicalDir?: 'ltr' | 'rtl' | null | undefined;
  __lexicalUnmanaged?: boolean | undefined;
  /**
   * When true, the DOM subtree owns its own window selection — analogous to
   * a DecoratorNode subtree. Resolution logic that would otherwise force the
   * Lexical selection back onto a managed position treats the caret as
   * intentional and leaves it alone. Set via the `captureSelection` option
   * on {@link setDOMUnmanaged}.
   */
  __lexicalCapturedSelection?: boolean | undefined;
}

export function $removeNode(
  nodeToRemove: LexicalNode,
  restoreSelection: boolean,
  preserveEmptyParent?: boolean,
): void {
  errorOnReadOnly();
  const key = nodeToRemove.__key;
  const parent = nodeToRemove.getParent();
  if (parent === null) {
    invariant(
      $getSlotHostKey(nodeToRemove) === null,
      '$removeNode: node %s is slotted into host %s; use removeSlot on the host instead of remove().',
      key,
      String($getSlotHostKey(nodeToRemove)),
    );
    return;
  }
  const selection = $maybeMoveChildrenSelectionToParent(nodeToRemove);
  let selectionMoved = false;
  if ($isRangeSelection(selection) && restoreSelection) {
    const anchor = selection.anchor;
    const focus = selection.focus;
    if (anchor.key === key) {
      moveSelectionPointToSibling(
        anchor,
        nodeToRemove,
        parent,
        nodeToRemove.getPreviousSibling(),
        nodeToRemove.getNextSibling(),
      );
      selectionMoved = true;
    }
    if (focus.key === key) {
      moveSelectionPointToSibling(
        focus,
        nodeToRemove,
        parent,
        nodeToRemove.getPreviousSibling(),
        nodeToRemove.getNextSibling(),
      );
      selectionMoved = true;
    }
  } else if (
    $isNodeSelection(selection) &&
    restoreSelection &&
    nodeToRemove.isSelected()
  ) {
    nodeToRemove.selectPrevious();
  }

  if ($isRangeSelection(selection) && restoreSelection && !selectionMoved) {
    // Doing this is O(n) so lets avoid it unless we need to do it
    const index = nodeToRemove.getIndexWithinParent();
    $removeFromParent(nodeToRemove);
    $updateElementSelectionOnCreateDeleteNode(selection, parent, index, -1);
  } else {
    $removeFromParent(nodeToRemove);
  }

  if (
    !preserveEmptyParent &&
    !$isRootOrShadowRoot(parent) &&
    !parent.canBeEmpty() &&
    parent.isEmpty()
  ) {
    $removeNode(parent, restoreSelection);
  }
  if (
    restoreSelection &&
    selection &&
    $isRootNode(parent) &&
    parent.isEmpty()
  ) {
    parent.selectEnd();
  }
}

export type DOMConversionProp<T extends HTMLElement> = (
  node: T,
) => DOMConversion<T> | null;

export type DOMConversionPropByTagName<K extends string> = DOMConversionProp<
  K extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[K] : HTMLElement
>;

export type DOMConversionTagNameMap<K extends string> = {
  [NodeName in K]?: DOMConversionPropByTagName<NodeName>;
};

/**
 * An identity function that will infer the type of DOM nodes
 * based on tag names to make it easier to construct a
 * DOMConversionMap.
 */
export function buildImportMap<K extends string>(importMap: {
  [NodeName in K]: DOMConversionPropByTagName<NodeName>;
}): DOMConversionMap {
  return importMap as unknown as DOMConversionMap;
}

export type DOMConversion<T extends HTMLElement = HTMLElement> = {
  conversion: DOMConversionFn<T>;
  priority?: 0 | 1 | 2 | 3 | 4;
};

export type DOMConversionFn<T extends HTMLElement = HTMLElement> = (
  element: T,
) => DOMConversionOutput | null;

export type DOMChildConversion = (
  lexicalNode: LexicalNode,
  parentLexicalNode: LexicalNode | null | undefined,
) => LexicalNode | null | undefined;

export type DOMConversionMap<T extends HTMLElement = HTMLElement> = Record<
  NodeName,
  DOMConversionProp<T>
>;
type NodeName = string;

export type DOMConversionOutput = {
  after?: (childLexicalNodes: LexicalNode[]) => LexicalNode[];
  forChild?: DOMChildConversion;
  node: null | LexicalNode | LexicalNode[];
};

export type DOMExportOutputMap = Map<
  Klass<LexicalNode>,
  (editor: LexicalEditor, target: LexicalNode) => DOMExportOutput
>;

export interface DOMExportOutput {
  /**
   * Called after the node and all of its children are constructed, can be used
   * to perform any in-place updates to the node or return something else
   * entirely.
   *
   * @param generatedElement `element` after children are appended
   * @returns The final representation of this node in the exported DOM
   */
  after?: (
    generatedElement: HTMLElement | DocumentFragment | Text | null | undefined,
  ) => HTMLElement | DocumentFragment | Text | null | undefined;
  /**
   * A DOM node for this lexical node, or null to skip it
   */
  element: HTMLElement | DocumentFragment | Text | null;
  /**
   * An optional override to change how and where DOM nodes for this
   * ElementNode's children are appended, particularly useful if
   * this node's children are not direct ancestors.
   *
   * @param element The DOM of a child node to append
   */
  append?: (element: HTMLElement | DocumentFragment | Text) => void;
  /**
   * If defined, will be used instead of `node.getChildren()` to determine
   * which children to render for this LexicalNode.
   *
   * @returns The children to export
   */
  $getChildNodes?: () => Iterable<LexicalNode>;
}

export type NodeKey = string;

const EPHEMERAL = Symbol.for('ephemeral');

/**
 * @internal
 * @param node any LexicalNode
 * @returns true if the node was created with {@link $cloneWithPropertiesEphemeral}
 */
export function $isEphemeral(
  node: LexicalNode & {readonly [EPHEMERAL]?: boolean},
): boolean {
  return node[EPHEMERAL] || false;
}
/**
 * @internal
 * Mark this node as ephemeral, its instance always returns this
 * for getLatest and getWritable. It must not be added to an EditorState.
 */
export function $markEphemeral<T extends LexicalNode>(
  node: T & {[EPHEMERAL]?: boolean},
): T {
  node[EPHEMERAL] = true;
  return node;
}

/** @internal */
const NON_ENUMERABLE_PROP_DESC: PropertyDescriptor = {
  configurable: true,
  enumerable: false,
  value: undefined,
  writable: true,
};

/**
 * A node that can host named slots, implemented by {@link ElementNode} and
 * {@link DecoratorNode}. The map is allocated lazily (null until the first
 * {@link $setSlot}) since most nodes have none. Declaring this off the base
 * {@link LexicalNode} is what lets {@link $setSlot} / {@link $removeSlot}
 * reject a non-host at compile time.
 *
 * @experimental
 */
export interface SlotHostNode {
  /** @internal */
  __slots: null | Map<string, NodeKey>;
}

/**
 * A node that can occupy a named slot, implemented by {@link ElementNode} and
 * {@link DecoratorNode}. Its up-pointer is `__slotHost` rather than `__parent`
 * (the two are mutually exclusive), so the slot boundary behaves like a shadow
 * root.
 *
 * @experimental
 */
export interface SlotChildNode {
  /** @internal */
  __slotHost: null | NodeKey;
}

export class LexicalNode {
  /** @internal Allow us to look up the type including static props */
  declare ['constructor']: KlassConstructor<typeof LexicalNode>;
  /** @internal */
  // `__type` is assigned once, in the constructor, and is never valid to
  // mutate afterward.
  readonly __type: string;
  /** @internal */
  //@ts-ignore We set the key in the constructor.
  __key: string;
  /** @internal */
  __parent: null | NodeKey;
  /** @internal */
  __prev: null | NodeKey;
  /** @internal */
  __next: null | NodeKey;
  /** @internal */
  __state?: NodeState<this>;
  /** @internal */
  [CACHED_TEXT_SIZE_KEY]?: number;

  // Flow doesn't support abstract classes unfortunately, so we can't _force_
  // subclasses of Node to implement statics. All subclasses of Node should have
  // a static getType and clone method though. We define getType and clone here so we can call it
  // on any  Node, and we throw this error by default since the subclass should provide
  // their own implementation.
  /**
   * Returns the string type of this node. Every node must
   * implement this and it MUST BE UNIQUE amongst nodes registered
   * on the editor.
   *
   */
  static getType(): string {
    const {ownNodeType} = getStaticNodeConfig(this);
    invariant(
      ownNodeType !== undefined,
      'LexicalNode: Node %s does not implement .getType().',
      this.name,
    );
    return ownNodeType;
  }

  /**
   * Clones this node, creating a new node with a different key
   * and adding it to the EditorState (but not attaching it anywhere!). All nodes must
   * implement this method.
   *
   */
  static clone(_data: unknown): LexicalNode {
    invariant(
      false,
      'LexicalNode: Node %s does not implement .clone().',
      this.name,
    );
  }

  /**
   * Override this to implement the new static node configuration protocol,
   * this method is called directly on the prototype and must not depend
   * on anything initialized in the constructor. Generally it should be
   * a trivial implementation.
   *
   * @example
   * ```ts
   * class MyNode extends TextNode {
   *   $config() {
   *     return this.config('my-node', {extends: TextNode});
   *   }
   * }
   * ```
   */
  $config(): BaseStaticNodeConfig {
    return {};
  }

  /**
   * This is a convenience method for $config that
   * aids in type inference. See {@link LexicalNode.$config}
   * for example usage.
   *
   * An abstract base class that has no concrete node `type` may pass a
   * well-known symbol (by convention `Symbol.for(<NodeClassName>)`) instead of
   * a string `type` to declare configuration shared with its subclasses.
   */
  config<const Config extends StaticNodeConfigValue<this, string>>(
    type: symbol,
    config: Config,
  ): AbstractStaticNodeConfigRecord<Config>;
  config<
    Type extends string,
    const Config extends StaticNodeConfigValue<this, Type>,
  >(type: Type, config: Config): StaticNodeConfigRecord<Type, Config>;
  config(
    type: string | symbol,
    config: AnyStaticNodeConfigValue,
  ): BaseStaticNodeConfig {
    const parentKlass = config.extends || getSuperclassOf(this.constructor);
    Object.assign(config, {extends: parentKlass});
    // A concrete node records its string `type`; an abstract base class is
    // keyed by a well-known symbol (e.g. Symbol.for('ElementNode')) and has no
    // concrete node `type`.
    if (typeof type === 'string') {
      Object.assign(config, {type});
    }
    return {[type]: config} as BaseStaticNodeConfig;
  }

  /**
   * Perform any state updates on the clone of prevNode that are not already
   * handled by the constructor call in the static clone method. If you have
   * state to update in your clone that is not handled directly by the
   * constructor, it is advisable to override this method but it is required
   * to include a call to `super.afterCloneFrom(prevNode)` in your
   * implementation. This is only intended to be called by
   * {@link $cloneWithProperties} function or via a super call.
   *
   * @example
   * ```ts
   * class ClassesTextNode extends TextNode {
   *   // Not shown: static getType, static importJSON, exportJSON, createDOM, updateDOM
   *   __classes = new Set<string>();
   *   static clone(node: ClassesTextNode): ClassesTextNode {
   *     // The inherited TextNode constructor is used here, so
   *     // classes is not set by this method.
   *     return new ClassesTextNode(node.__text, node.__key);
   *   }
   *   afterCloneFrom(node: this): void {
   *     // This calls TextNode.afterCloneFrom and LexicalNode.afterCloneFrom
   *     // for necessary state updates
   *     super.afterCloneFrom(node);
   *     this.__addClasses(node.__classes);
   *   }
   *   // This method is a private implementation detail, it is not
   *   // suitable for the public API because it does not call getWritable
   *   __addClasses(classNames: Iterable<string>): this {
   *     for (const className of classNames) {
   *       this.__classes.add(className);
   *     }
   *     return this;
   *   }
   *   addClass(...classNames: string[]): this {
   *     return this.getWritable().__addClasses(classNames);
   *   }
   *   removeClass(...classNames: string[]): this {
   *     const node = this.getWritable();
   *     for (const className of classNames) {
   *       this.__classes.delete(className);
   *     }
   *     return this;
   *   }
   *   getClasses(): Set<string> {
   *     return this.getLatest().__classes;
   *   }
   * }
   * ```
   *
   */
  afterCloneFrom(prevNode: this): void {
    if (this.__key === prevNode.__key) {
      this.__parent = prevNode.__parent;
      this.__next = prevNode.__next;
      this.__prev = prevNode.__prev;
      this.__state = prevNode.__state;
    } else if (prevNode.__state) {
      this.__state = prevNode.__state.getWritable(this);
    }
  }

  /**
   * Reset state in this copy of originalNode, if necessary
   *
   * @param originalNode
   */
  resetOnCopyNodeFrom(originalNode: this): void {
    if (this.__state) {
      this.__state = this.__state.getWritable(this).resetOnCopyNode();
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static importDOM?: () => DOMConversionMap<any> | null;

  constructor(key?: NodeKey) {
    this.__type = this.constructor.getType();
    this.__parent = null;
    this.__prev = null;
    this.__next = null;
    Object.defineProperty(this, '__state', NON_ENUMERABLE_PROP_DESC);
    // Pre-initialize the reconciler's cached-text-size slot so subsequent
    // assignments on the V8 hot path slot into a stable hidden class
    // instead of triggering per-instance shape transitions.
    Object.defineProperty(this, CACHED_TEXT_SIZE_KEY, NON_ENUMERABLE_PROP_DESC);
    $setNodeKey(this, key);

    if (__DEV__) {
      if (this.__type !== 'root') {
        errorOnTypeKlassMismatch(this.__type, this.constructor);
      }
    }
  }
  // Getters and Traversers

  /**
   * Returns the string type of this node.
   */
  getType(): string {
    return this.__type;
  }

  isInline(): boolean {
    invariant(
      false,
      'LexicalNode: Node %s does not implement .isInline().',
      this.constructor.name,
    );
  }

  /**
   * Returns true if there is a path between this node and the RootNode, false otherwise.
   * This is a way of determining if the node is "attached" EditorState. Unattached nodes
   * won't be reconciled and will ultimately be cleaned up by the Lexical GC.
   */
  isAttached(): boolean {
    let nodeKey: string | null = this.__key;
    while (nodeKey !== null) {
      if (nodeKey === 'root') {
        return true;
      }

      // Annotation breaks a circular inference through the loop (TS7022),
      // remove when the deprecated generic signatures from #8661 are removed
      const node: LexicalNode | null = $getNodeByKey(nodeKey);

      if (node === null) {
        break;
      }
      // A slotted node has no __parent; follow its slot host up toward root.
      nodeKey = node.__parent !== null ? node.__parent : $getSlotHostKey(node);
    }
    return false;
  }

  /**
   * Returns true if this node is contained within the provided Selection., false otherwise.
   * Relies on the algorithms implemented in {@link BaseSelection.getNodes} to determine
   * what's included.
   *
   * @param selection - The selection that we want to determine if the node is in.
   */
  isSelected(selection?: null | BaseSelection): boolean {
    const targetSelection = selection || $getSelection();
    if (targetSelection == null) {
      return false;
    }

    const isSelected = targetSelection
      .getNodes()
      .some(n => n.__key === this.__key);

    if ($isTextNode(this)) {
      return isSelected;
    }
    // For inline images inside of element nodes.
    // Without this change the image will be selected if the cursor is before or after it.
    const isElementRangeSelection =
      $isRangeSelection(targetSelection) &&
      targetSelection.anchor.type === 'element' &&
      targetSelection.focus.type === 'element';

    if (isElementRangeSelection) {
      if (targetSelection.isCollapsed()) {
        return false;
      }

      const parentNode = this.getParent();
      if ($isDecoratorNode(this) && this.isInline() && parentNode) {
        const firstPoint = targetSelection.isBackward()
          ? targetSelection.focus
          : targetSelection.anchor;
        if (
          parentNode.is(firstPoint.getNode()) &&
          firstPoint.offset === parentNode.getChildrenSize() &&
          this.is(parentNode.getLastChild())
        ) {
          return false;
        }
      }
    }
    return isSelected;
  }

  /**
   * Returns this nodes key.
   */
  getKey(): NodeKey {
    // Key is stable between copies
    return this.__key;
  }

  /**
   * Returns the zero-based index of this node within the parent.
   */
  getIndexWithinParent(): number {
    const parent = this.getParent();
    if (parent === null) {
      return -1;
    }
    let node = parent.getFirstChild();
    let index = 0;
    while (node !== null) {
      if (this.is(node)) {
        return index;
      }
      index++;
      node = node.getNextSibling();
    }
    return -1;
  }

  /**
   * Returns the parent of this node, or null if none is found.
   */
  getParent(): ElementNode | null;
  /**
   * @deprecated The type parameter is an unchecked and unsafe cast,
   * equivalent to `node.getParent() as T | null`, and will be removed
   * in a future release. Call this method without a type argument and
   * narrow the result with a type guard instead.
   */
  getParent<T extends ElementNode>(): T | null;
  getParent(): ElementNode | null {
    const parent = this.getLatest().__parent;
    if (parent === null) {
      return null;
    }
    // Cast: a parent key always refers to an ElementNode
    return $getNodeByKey(parent) as ElementNode | null;
  }

  /**
   * Returns the parent of this node, or throws if none is found.
   */
  getParentOrThrow(): ElementNode;
  /**
   * @deprecated The type parameter is an unchecked and unsafe cast,
   * equivalent to `node.getParentOrThrow() as T`, and will be removed
   * in a future release. Call this method without a type argument and
   * narrow the result with a type guard instead.
   */
  getParentOrThrow<T extends ElementNode>(): T;
  getParentOrThrow(): ElementNode {
    const parent = this.getParent();
    if (parent === null) {
      invariant(false, 'Expected node %s to have a parent.', this.__key);
    }
    return parent;
  }

  /**
   * Returns the highest (in the EditorState tree)
   * non-root ancestor of this node, or null if none is found. See {@link lexical!$isRootOrShadowRoot}
   * for more information on which Elements comprise "roots".
   */
  getTopLevelElement(): ElementNode | DecoratorNode<unknown> | null {
    let node: ElementNode | this | null = this;
    while (node !== null) {
      // Annotation breaks a circular inference through the loop (TS7022),
      // remove when the deprecated generic signatures from #8661 are removed
      const parent: ElementNode | null = node.getParent();
      // A slot value's host acts as a shadow root, so the slot boundary is
      // the top of the isolated scope and this node is its top-level element.
      if ($isRootOrShadowRoot(parent) || $getSlotHostKey(node) !== null) {
        invariant(
          $isElementNode(node) || (node === this && $isDecoratorNode(node)),
          'Children of root nodes must be elements or decorators',
        );
        return node;
      }
      node = parent;
    }
    return null;
  }

  /**
   * Returns the highest (in the EditorState tree)
   * non-root ancestor of this node, or throws if none is found. See {@link lexical!$isRootOrShadowRoot}
   * for more information on which Elements comprise "roots".
   */
  getTopLevelElementOrThrow(): ElementNode | DecoratorNode<unknown> {
    const parent = this.getTopLevelElement();
    if (parent === null) {
      invariant(
        false,
        'Expected node %s to have a top parent element.',
        this.__key,
      );
    }
    return parent;
  }

  /**
   * Returns a list of the every ancestor of this node,
   * all the way up to the RootNode.
   *
   */
  getParents(): ElementNode[] {
    const parents: ElementNode[] = [];
    let node = this.getParent();
    while (node !== null) {
      parents.push(node);
      node = node.getParent();
    }
    return parents;
  }

  /**
   * Returns a list of the keys of every ancestor of this node,
   * all the way up to the RootNode.
   *
   */
  getParentKeys(): NodeKey[] {
    const parents = [];
    let node = this.getParent();
    while (node !== null) {
      parents.push(node.__key);
      node = node.getParent();
    }
    return parents;
  }

  /**
   * Returns the node before this one in the same parent, or null
   * if there is no such node.
   */
  getPreviousSibling(): LexicalNode | null;
  /**
   * @deprecated The type parameter is an unchecked and unsafe cast,
   * equivalent to `node.getPreviousSibling() as T | null`, and will be
   * removed in a future release. Call this method without a type argument
   * and narrow the result with a type guard instead.
   */
  getPreviousSibling<T extends LexicalNode>(): T | null;
  getPreviousSibling(): LexicalNode | null {
    const self = this.getLatest();
    const prevKey = self.__prev;
    return prevKey === null ? null : $getNodeByKey(prevKey);
  }

  /**
   * Returns all nodes before this one in the same parent,
   * in document order.
   */
  getPreviousSiblings(): LexicalNode[];
  /**
   * @deprecated The type parameter is an unchecked and unsafe cast,
   * equivalent to `node.getPreviousSiblings() as T[]`, and will be
   * removed in a future release. Call this method without a type argument
   * and narrow the results with a type guard instead.
   */
  getPreviousSiblings<T extends LexicalNode>(): T[];
  getPreviousSiblings(): LexicalNode[] {
    const siblings: LexicalNode[] = [];
    const parent = this.getParent();
    if (parent === null) {
      return siblings;
    }
    let node = parent.getFirstChild();
    while (node !== null) {
      if (node.is(this)) {
        break;
      }
      siblings.push(node);
      node = node.getNextSibling();
    }
    return siblings;
  }

  /**
   * Returns the node after this one in the same parent, or null
   * if there is no such node.
   */
  getNextSibling(): LexicalNode | null;
  /**
   * @deprecated The type parameter is an unchecked and unsafe cast,
   * equivalent to `node.getNextSibling() as T | null`, and will be
   * removed in a future release. Call this method without a type argument
   * and narrow the result with a type guard instead.
   */
  getNextSibling<T extends LexicalNode>(): T | null;
  getNextSibling(): LexicalNode | null {
    const self = this.getLatest();
    const nextKey = self.__next;
    return nextKey === null ? null : $getNodeByKey(nextKey);
  }

  /**
   * Returns all nodes after this one in the same parent,
   * in document order.
   */
  getNextSiblings(): LexicalNode[];
  /**
   * @deprecated The type parameter is an unchecked and unsafe cast,
   * equivalent to `node.getNextSiblings() as T[]`, and will be
   * removed in a future release. Call this method without a type argument
   * and narrow the results with a type guard instead.
   */
  getNextSiblings<T extends LexicalNode>(): T[];
  getNextSiblings(): LexicalNode[] {
    const siblings: LexicalNode[] = [];
    let node = this.getNextSibling();
    while (node !== null) {
      siblings.push(node);
      node = node.getNextSibling();
    }
    return siblings;
  }

  /**
   * @deprecated use {@link $getCommonAncestor}
   *
   * Returns the closest common ancestor of this node and the provided one or null
   * if one cannot be found.
   *
   * @param node - the other node to find the common ancestor of.
   */
  getCommonAncestor<T extends ElementNode = ElementNode>(
    node: LexicalNode,
  ): T | null {
    const a = $isElementNode(this) ? this : this.getParent();
    const b = $isElementNode(node) ? node : node.getParent();
    const result = a && b ? $getCommonAncestor(a, b) : null;
    return result
      ? (result.commonAncestor as T) /* TODO this type cast is a lie, but fixing it would break backwards compatibility */
      : null;
  }

  /**
   * Returns true if the provided node is the exact same one as this node, from Lexical's perspective.
   * Always use this instead of referential equality.
   *
   * @param object - the node to perform the equality comparison on.
   */
  is(object: LexicalNode | null | undefined): boolean {
    if (object == null) {
      return false;
    }
    return this.__key === object.__key;
  }

  /**
   * Returns true if this node logically precedes the target node in the
   * editor state, false otherwise (including if there is no common ancestor).
   *
   * Note that this notion of isBefore is based on post-order; a descendant
   * node is always before its ancestors. See also
   * {@link $getCommonAncestor} and {@link $comparePointCaretNext} for
   * more flexible ways to determine the relative positions of nodes.
   *
   * @param targetNode - the node we're testing to see if it's after this one.
   */
  isBefore(targetNode: LexicalNode): boolean {
    const compare = $getCommonAncestor(this, targetNode);
    if (compare === null) {
      return false;
    }
    if (compare.type === 'descendant') {
      return true;
    }
    if (compare.type === 'branch') {
      return $getCommonAncestorResultBranchOrder(compare) === -1;
    }
    invariant(
      compare.type === 'same' || compare.type === 'ancestor',
      'LexicalNode.isBefore: exhaustiveness check',
    );
    return false;
  }

  /**
   * Returns true if this node is an ancestor of and distinct from the target node, false otherwise.
   *
   * @param targetNode - the would-be child node.
   */
  isParentOf(targetNode: LexicalNode): boolean {
    return $hasAncestor(targetNode, this);
  }

  // TO-DO: this function can be simplified a lot
  /**
   * Returns a list of nodes that are between this node and
   * the target node in the EditorState.
   *
   * @param targetNode - the node that marks the other end of the range of nodes to be returned.
   */
  getNodesBetween(targetNode: LexicalNode): LexicalNode[] {
    const isBefore = this.isBefore(targetNode);
    const nodes = [];
    const visited = new Set();
    let node: LexicalNode | this | null = this;
    while (true) {
      if (node === null) {
        break;
      }
      const key = node.__key;
      if (!visited.has(key)) {
        visited.add(key);
        nodes.push(node);
      }
      if (node === targetNode) {
        break;
      }
      const child: LexicalNode | null = $isElementNode(node)
        ? isBefore
          ? node.getFirstChild()
          : node.getLastChild()
        : null;
      if (child !== null) {
        node = child;
        continue;
      }
      const nextSibling: LexicalNode | null = isBefore
        ? node.getNextSibling()
        : node.getPreviousSibling();
      if (nextSibling !== null) {
        node = nextSibling;
        continue;
      }
      const parent: LexicalNode | null = node.getParentOrThrow();
      if (!visited.has(parent.__key)) {
        nodes.push(parent);
      }
      if (parent === targetNode) {
        break;
      }
      let parentSibling = null;
      let ancestor: LexicalNode | null = parent;
      do {
        if (ancestor === null) {
          invariant(false, 'getNodesBetween: ancestor is null');
        }
        parentSibling = isBefore
          ? ancestor.getNextSibling()
          : ancestor.getPreviousSibling();
        ancestor = ancestor.getParent();
        if (ancestor !== null) {
          if (parentSibling === null && !visited.has(ancestor.__key)) {
            nodes.push(ancestor);
          }
        } else {
          break;
        }
      } while (parentSibling === null);
      node = parentSibling;
    }
    if (!isBefore) {
      nodes.reverse();
    }
    return nodes;
  }

  /**
   * Returns true if this node has been marked dirty during this update cycle.
   *
   */
  isDirty(): boolean {
    const editor = getActiveEditor();
    const dirtyLeaves = editor._dirtyLeaves;
    return dirtyLeaves !== null && dirtyLeaves.has(this.__key);
  }

  /**
   * Returns the latest version of the node from the active EditorState.
   * This is used to avoid getting values from stale node references.
   *
   */
  getLatest(): this {
    if ($isEphemeral(this)) {
      return this;
    }
    // Cast: the nodeMap entry for this key is always the same node class
    const latest = $getNodeByKey(this.__key) as this | null;
    if (latest === null) {
      invariant(
        false,
        'Lexical node does not exist in active editor state. Avoid using the same node references between nested closures from editorState.read/editor.update.',
      );
    }
    return latest;
  }

  /**
   * Returns a mutable version of the node using {@link $cloneWithProperties}
   * if necessary. Will throw an error if called outside of a Lexical Editor
   * {@link LexicalEditor.update} callback.
   *
   */
  getWritable(): this {
    if ($isEphemeral(this)) {
      return this;
    }
    errorOnReadOnly();
    const editorState = getActiveEditorState();
    const editor = getActiveEditor();
    const nodeMap = editorState._nodeMap;
    const key = this.__key;
    // Ensure we get the latest node from pending state
    const latestNode = this.getLatest();
    const cloneNotNeeded = editor._cloneNotNeeded;
    const selection = $getSelection();
    if (selection !== null) {
      selection.setCachedNodes(null);
    }
    if (cloneNotNeeded.has(key)) {
      // Transforms clear the dirty node set on each iteration to keep track on newly dirty nodes
      internalMarkNodeAsDirty(latestNode);
      return latestNode;
    }
    const mutableNode = $cloneWithProperties(latestNode);
    cloneNotNeeded.add(key);
    internalMarkNodeAsDirty(mutableNode);
    // Update reference in node map
    nodeMap.set(key, mutableNode);

    return mutableNode;
  }

  /**
   * Returns the text content of the node. Override this for
   * custom nodes that should have a representation in plain text
   * format (for copy + paste, for example)
   *
   */
  getTextContent(): string {
    return $getSlotsTextContent(this);
  }

  /**
   * Returns the length of the string produced by calling getTextContent on this node.
   *
   */
  getTextContentSize(): number {
    // Decorator slot hosts use this base impl: slot text is folded into
    // getTextContent, so .length is the size — counted by length, not by each
    // slot's own getTextContentSize (the ElementNode override sums those).
    return this.getTextContent().length;
  }

  // View

  /**
   * Called during the reconciliation process to determine which nodes
   * to insert into the DOM for this Lexical Node.
   *
   * This method must return exactly one HTMLElement. Nested elements are not supported.
   *
   * Do not attempt to update the Lexical EditorState during this phase of the update lifecycle.
   *
   * @param _config - allows access to things like the EditorTheme (to apply classes) during reconciliation.
   * @param _editor - allows access to the editor for context during reconciliation.
   *
   * */
  createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
    invariant(false, 'createDOM: base method not extended');
  }

  /**
   * Called when a node changes and should update the DOM
   * in whatever way is necessary to make it align with any changes that might
   * have happened during the update.
   *
   * Returning "true" here will cause lexical to unmount and recreate the DOM node
   * (by calling createDOM). You would need to do this if the element tag changes,
   * for instance.
   *
   * */
  updateDOM(
    _prevNode: unknown,
    _dom: HTMLElement,
    _config: EditorConfig,
  ): boolean {
    invariant(false, 'updateDOM: base method not extended');
  }

  /**
   * Returns a {@link DOMSlot} pointing at the content-bearing element of this
   * node's DOM. The default returns a slot wrapping the keyed DOM as-is.
   *
   * Override this when {@link createDOM} returns a wrapper around the
   * content-bearing element (e.g. `<span><br/></span>` for a styled line
   * break), so selection / reconciliation logic can target the inner element.
   *
   * {@link ElementNode} overrides this to return an {@link ElementDOMSlot}
   * with children-management semantics (used by the reconciler to place
   * managed children).
   *
   * @experimental
   */
  getDOMSlot(element: HTMLElement): DOMSlot<HTMLElement> {
    return new DOMSlot(element);
  }

  /**
   * Controls how the this node is serialized to HTML. This is important for
   * copy and paste between Lexical and non-Lexical editors, or Lexical editors with different namespaces,
   * in which case the primary transfer format is HTML. It's also important if you're serializing
   * to HTML for any other reason via {@link @lexical/html!$generateHtmlFromNodes}. You could
   * also use this method to build your own HTML renderer.
   *
   * */
  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const element = this.createDOM(editor._config, editor);
    return {element};
  }

  /**
   * Controls how the this node is serialized to JSON. This is important for
   * copy and paste between Lexical editors sharing the same namespace. It's also important
   * if you're serializing to JSON for persistent storage somewhere.
   * See [Serialization & Deserialization](https://lexical.dev/docs/concepts/serialization#lexical---html).
   *
   * */
  exportJSON(): SerializedLexicalNode {
    const state = this.__state ? this.__state.toJSON() : undefined;
    return {
      type: this.__type,
      version: 1,
      ...state,
    };
  }

  /**
   * Controls how the this node is deserialized from JSON. This is usually boilerplate,
   * but provides an abstraction between the node implementation and serialized interface that can
   * be important if you ever make breaking changes to a node schema (by adding or removing properties).
   * See [Serialization & Deserialization](https://lexical.dev/docs/concepts/serialization#lexical---html).
   *
   * */
  static importJSON(
    _serializedNode: SerializedLexicalNode & Record<string, unknown>,
  ): LexicalNode {
    invariant(
      false,
      'LexicalNode: Node %s does not implement .importJSON().',
      this.name,
    );
  }

  /**
   * Update this LexicalNode instance from serialized JSON. It's recommended
   * to implement as much logic as possible in this method instead of the
   * static importJSON method, so that the functionality can be inherited in subclasses.
   *
   * The LexicalUpdateJSON utility type should be used to ignore any type, version,
   * or children properties in the JSON so that the extended JSON from subclasses
   * are acceptable parameters for the super call.
   *
   * If overridden, this method must call super.
   *
   * @example
   * ```ts
   * class MyTextNode extends TextNode {
   *   // ...
   *   static importJSON(serializedNode: SerializedMyTextNode): MyTextNode {
   *     return $createMyTextNode()
   *       .updateFromJSON(serializedNode);
   *   }
   *   updateFromJSON(
   *     serializedNode: LexicalUpdateJSON<SerializedMyTextNode>,
   *   ): this {
   *     return super.updateFromJSON(serializedNode)
   *       .setMyProperty(serializedNode.myProperty);
   *   }
   * }
   * ```
   **/
  updateFromJSON(
    serializedNode: LexicalUpdateJSON<SerializedLexicalNode>,
  ): this {
    return $updateStateFromJSON(this, serializedNode);
  }

  /**
   * @experimental
   *
   * Registers the returned function as a transform on the node during
   * Editor initialization. Most such use cases should be addressed via
   * the {@link LexicalEditor.registerNodeTransform} API.
   *
   * Experimental - use at your own risk.
   */
  static transform(): ((node: LexicalNode) => void) | null {
    return null;
  }

  // Setters and mutators

  /**
   * Removes this LexicalNode from the EditorState. If the node isn't re-inserted
   * somewhere, the Lexical garbage collector will eventually clean it up.
   *
   * @param preserveEmptyParent - If falsy, the node's parent will be removed if
   * it's empty after the removal operation. This is the default behavior, subject to
   * other node heuristics such as {@link ElementNode#canBeEmpty}
   * */
  remove(preserveEmptyParent?: boolean): void {
    $removeNode(this, true, preserveEmptyParent);
  }

  /**
   * Replaces this LexicalNode with the provided node, optionally transferring the children
   * of the replaced node to the replacing node.
   *
   * Named slots are bound to their host node and are never transferred: this
   * node keeps its slot map, so if it is reattached elsewhere (as
   * `$wrapNodeInElement` does) its slots come with it, and if it stays
   * detached the slot subtrees are garbage-collected along with it. To move a
   * slot value onto another host, use `$setSlot` explicitly.
   *
   * @param replaceWith - The node to replace this one with.
   * @param includeChildren - Whether or not to transfer the children of this node to the replacing node.
   * */
  replace<N extends LexicalNode>(replaceWith: N, includeChildren?: boolean): N {
    errorOnReadOnly();
    let selection = $getSelection();
    if (selection !== null) {
      selection = selection.clone();
    }
    errorOnInsertTextNodeOnRoot(this, replaceWith);
    const self = this.getLatest();
    const toReplaceKey = this.__key;
    // A named-slot value has no parent (its up-link is __slotHost), so the
    // getParentOrThrow below would throw an unhelpful generic error. Fail with
    // an actionable one instead, mirroring the $removeFromParent guard for
    // remove(): the slot assignment is managed by the node or extension that
    // owns the slot, so generic tree surgery must go through $setSlot.
    const slotHost = $getSlotHost(self);
    if (slotHost !== null) {
      invariant(
        false,
        'replace: node %s (type %s) is slotted into host %s (type %s); a slot value cannot be replaced through the tree API. Use $setSlot on its host to assign a replacement.',
        toReplaceKey,
        self.getType(),
        slotHost.getKey(),
        slotHost.getType(),
      );
    }
    const key = replaceWith.__key;
    const writableReplaceWith = replaceWith.getWritable();
    const writableParent = this.getParentOrThrow().getWritable();
    // Before any mutation: becoming a child of this node's parent must not
    // close a cycle through a slot up-link (reverse of $setSlot's guard).
    $errorOnSlotCycleChild(writableParent, writableReplaceWith);
    const size = writableParent.__size;
    // Capture replaceWith's old parent / index before removeFromParent so the
    // cloned selection's element offsets in that old parent can be adjusted
    // afterwards. See #6031.
    const replaceWithOldParent = writableReplaceWith.getParent();
    const replaceWithOldIndex =
      replaceWithOldParent !== null
        ? writableReplaceWith.getIndexWithinParent()
        : -1;
    $removeFromParent(writableReplaceWith);
    if (replaceWithOldParent !== null && $isRangeSelection(selection)) {
      $updateElementSelectionOnCreateDeleteNode(
        selection,
        replaceWithOldParent,
        replaceWithOldIndex,
        -1,
      );
    }
    const prevSibling = self.getPreviousSibling();
    const nextSibling = self.getNextSibling();
    const prevKey = self.__prev;
    const nextKey = self.__next;
    const parentKey = self.__parent;
    $removeNode(self, false, true);

    if (prevSibling === null) {
      writableParent.__first = key;
    } else {
      const writablePrevSibling = prevSibling.getWritable();
      writablePrevSibling.__next = key;
    }
    writableReplaceWith.__prev = prevKey;
    if (nextSibling === null) {
      writableParent.__last = key;
    } else {
      const writableNextSibling = nextSibling.getWritable();
      writableNextSibling.__prev = key;
    }
    writableReplaceWith.__next = nextKey;
    writableReplaceWith.__parent = parentKey;
    // `size` was read before replaceWith was detached. When replaceWith was
    // already a child of this same parent, two children collapse into one, so
    // the restored size must account for the node that is not coming back.
    writableParent.__size =
      replaceWithOldParent !== null && replaceWithOldParent.is(writableParent)
        ? size - 1
        : size;
    // Snapshot replaceWith's children count before children transfer so
    // element-anchored selections on `this` can map to the equivalent offset
    // in writableReplaceWith.
    let prevSizeBeforeChildrenTransfer = 0;
    if (includeChildren) {
      invariant(
        $isElementNode(this) && $isElementNode(writableReplaceWith),
        'includeChildren should only be true for ElementNodes',
      );
      prevSizeBeforeChildrenTransfer = writableReplaceWith.getChildrenSize();
      writableReplaceWith.splice(
        prevSizeBeforeChildrenTransfer,
        0,
        this.getChildren(),
      );
    }
    if ($isRangeSelection(selection)) {
      $setSelection(selection);
      const anchor = selection.anchor;
      const focus = selection.focus;
      // For an element-anchored point on `this` with includeChildren, the
      // transferred children land at offsets [prevSize ... prevSize + N) in
      // writableReplaceWith, so the equivalent point is at
      // `prevSize + originalOffset`. Without this remap the caller (e.g.
      // `$setBlocksType`) has to re-anchor afterwards from a stale clone.
      // For non-element points or !includeChildren the children are gone, so
      // fall back to the previous "move to end" behavior.
      if (anchor.key === toReplaceKey) {
        if (includeChildren && anchor.type === 'element') {
          anchor.set(
            writableReplaceWith.__key,
            prevSizeBeforeChildrenTransfer + anchor.offset,
            'element',
          );
        } else {
          $moveSelectionPointToEnd(anchor, writableReplaceWith);
        }
      }
      if (focus.key === toReplaceKey) {
        if (includeChildren && focus.type === 'element') {
          focus.set(
            writableReplaceWith.__key,
            prevSizeBeforeChildrenTransfer + focus.offset,
            'element',
          );
        } else {
          $moveSelectionPointToEnd(focus, writableReplaceWith);
        }
      }
    }
    if ($getCompositionKey() === toReplaceKey) {
      $setCompositionKey(key);
    }
    return writableReplaceWith;
  }

  /**
   * Inserts a node after this LexicalNode (as the next sibling).
   *
   * @param nodeToInsert - The node to insert after this one.
   * @param restoreSelection - Whether or not to attempt to resolve the
   * selection to the appropriate place after the operation is complete.
   * */
  insertAfter(nodeToInsert: LexicalNode, restoreSelection = true): LexicalNode {
    errorOnReadOnly();
    errorOnInsertTextNodeOnRoot(this, nodeToInsert);
    const writableSelf = this.getWritable();
    const writableNodeToInsert = nodeToInsert.getWritable();
    // Before any mutation: becoming a sibling of this node must not close a
    // cycle through a slot up-link (reverse of $setSlot's guard).
    $errorOnSlotCycleChild(this.getParentOrThrow(), writableNodeToInsert);
    const oldParent = writableNodeToInsert.getParent();
    const selection = $getSelection();
    let elementAnchorSelectionOnNode = false;
    let elementFocusSelectionOnNode = false;
    if (oldParent !== null) {
      // TODO: this is O(n), can we improve?
      const oldIndex = nodeToInsert.getIndexWithinParent();
      if ($isRangeSelection(selection)) {
        const oldParentKey = oldParent.__key;
        const anchor = selection.anchor;
        const focus = selection.focus;
        elementAnchorSelectionOnNode =
          anchor.type === 'element' &&
          anchor.key === oldParentKey &&
          anchor.offset === oldIndex + 1;
        elementFocusSelectionOnNode =
          focus.type === 'element' &&
          focus.key === oldParentKey &&
          focus.offset === oldIndex + 1;
      }
      $removeFromParent(writableNodeToInsert);
      // Adjust element-anchored offsets in oldParent to track its reduced
      // child count. The boolean flags captured above
      // (elementAnchorSelectionOnNode / elementFocusSelectionOnNode) recorded
      // whether anchor/focus sat at oldIndex+1 before this removal; the
      // post-insertion block below uses them to re-anchor onto the moved
      // node in its new parent. See #6031.
      if (restoreSelection && $isRangeSelection(selection)) {
        $updateElementSelectionOnCreateDeleteNode(
          selection,
          oldParent,
          oldIndex,
          -1,
        );
      }
    } else {
      $removeFromParent(writableNodeToInsert);
    }
    const nextSibling = this.getNextSibling();
    const writableParent = this.getParentOrThrow().getWritable();
    const insertKey = writableNodeToInsert.__key;
    const nextKey = writableSelf.__next;
    if (nextSibling === null) {
      writableParent.__last = insertKey;
    } else {
      const writableNextSibling = nextSibling.getWritable();
      writableNextSibling.__prev = insertKey;
    }
    writableParent.__size++;
    writableSelf.__next = insertKey;
    writableNodeToInsert.__next = nextKey;
    writableNodeToInsert.__prev = writableSelf.__key;
    writableNodeToInsert.__parent = writableSelf.__parent;
    if (restoreSelection && $isRangeSelection(selection)) {
      const index = this.getIndexWithinParent();
      $updateElementSelectionOnCreateDeleteNode(
        selection,
        writableParent,
        index + 1,
      );
      const writableParentKey = writableParent.__key;
      if (elementAnchorSelectionOnNode) {
        selection.anchor.set(writableParentKey, index + 2, 'element');
      }
      if (elementFocusSelectionOnNode) {
        selection.focus.set(writableParentKey, index + 2, 'element');
      }
    }
    return nodeToInsert;
  }

  /**
   * Inserts a node before this LexicalNode (as the previous sibling).
   *
   * @param nodeToInsert - The node to insert before this one.
   * @param restoreSelection - Whether or not to attempt to resolve the
   * selection to the appropriate place after the operation is complete.
   * */
  insertBefore(
    nodeToInsert: LexicalNode,
    restoreSelection = true,
  ): LexicalNode {
    errorOnReadOnly();
    errorOnInsertTextNodeOnRoot(this, nodeToInsert);
    const writableSelf = this.getWritable();
    const writableNodeToInsert = nodeToInsert.getWritable();
    // Before any mutation: becoming a sibling of this node must not close a
    // cycle through a slot up-link (reverse of $setSlot's guard).
    $errorOnSlotCycleChild(this.getParentOrThrow(), writableNodeToInsert);
    const insertKey = writableNodeToInsert.__key;
    const selection = $getSelection();
    // Capture nodeToInsert's old parent / index before detaching so the
    // selection's element offsets in that old parent can be adjusted
    // afterwards. See #6031.
    const insertOldParent = writableNodeToInsert.getParent();
    const insertOldIndex =
      insertOldParent !== null
        ? writableNodeToInsert.getIndexWithinParent()
        : -1;
    $removeFromParent(writableNodeToInsert);
    if (
      insertOldParent !== null &&
      restoreSelection &&
      $isRangeSelection(selection)
    ) {
      $updateElementSelectionOnCreateDeleteNode(
        selection,
        insertOldParent,
        insertOldIndex,
        -1,
      );
    }
    const prevSibling = this.getPreviousSibling();
    const writableParent = this.getParentOrThrow().getWritable();
    const prevKey = writableSelf.__prev;
    // TODO: this is O(n), can we improve?
    const index = this.getIndexWithinParent();
    if (prevSibling === null) {
      writableParent.__first = insertKey;
    } else {
      const writablePrevSibling = prevSibling.getWritable();
      writablePrevSibling.__next = insertKey;
    }
    writableParent.__size++;
    writableSelf.__prev = insertKey;
    writableNodeToInsert.__prev = prevKey;
    writableNodeToInsert.__next = writableSelf.__key;
    writableNodeToInsert.__parent = writableSelf.__parent;
    if (restoreSelection && $isRangeSelection(selection)) {
      const parent = this.getParentOrThrow();
      $updateElementSelectionOnCreateDeleteNode(selection, parent, index);
    }
    return nodeToInsert;
  }

  /**
   * Whether or not this node has a required parent. Used during copy + paste operations
   * to normalize nodes that would otherwise be orphaned. For example, ListItemNodes without
   * a ListNode parent or TextNodes with a ParagraphNode parent.
   *
   * */
  isParentRequired(): boolean {
    return false;
  }

  /**
   * The creation logic for any required parent. Should be implemented if {@link isParentRequired} returns true.
   *
   * */
  createParentElementNode(): ElementNode {
    return $createParagraphNode();
  }

  selectStart(): RangeSelection {
    return this.selectPrevious();
  }

  selectEnd(): RangeSelection {
    return this.selectNext(0, 0);
  }

  /**
   * Moves selection to the previous sibling of this node, at the specified offsets.
   *
   * @param anchorOffset - The anchor offset for selection.
   * @param focusOffset -  The focus offset for selection
   * */
  selectPrevious(anchorOffset?: number, focusOffset?: number): RangeSelection {
    errorOnReadOnly();
    // Slot value root has __parent === null, so the regular sibling walk
    // would throw via getParentOrThrow. Defer to the host so the cursor
    // moves past the slot-bearing host's previous sibling.
    const slotHost = $getSlotHost(this);
    if (slotHost !== null) {
      return slotHost.selectPrevious(anchorOffset, focusOffset);
    }
    const prevSibling = this.getPreviousSibling();
    const parent = this.getParentOrThrow();
    if (prevSibling === null) {
      return parent.select(0, 0);
    }
    if ($isElementNode(prevSibling)) {
      return prevSibling.select();
    } else if (!$isTextNode(prevSibling)) {
      const index = prevSibling.getIndexWithinParent() + 1;
      return parent.select(index, index);
    }
    return prevSibling.select(anchorOffset, focusOffset);
  }

  /**
   * Moves selection to the next sibling of this node, at the specified offsets.
   *
   * @param anchorOffset - The anchor offset for selection.
   * @param focusOffset -  The focus offset for selection
   * */
  selectNext(anchorOffset?: number, focusOffset?: number): RangeSelection {
    errorOnReadOnly();
    // Slot value root has __parent === null, so the regular sibling walk
    // would throw via getParentOrThrow. Defer to the host so the cursor
    // moves past the slot-bearing host's next sibling.
    const slotHost = $getSlotHost(this);
    if (slotHost !== null) {
      return slotHost.selectNext(anchorOffset, focusOffset);
    }
    const nextSibling = this.getNextSibling();
    const parent = this.getParentOrThrow();
    if (nextSibling === null) {
      return parent.select();
    }
    if ($isElementNode(nextSibling)) {
      return nextSibling.select(0, 0);
    } else if (!$isTextNode(nextSibling)) {
      const index = nextSibling.getIndexWithinParent();
      return parent.select(index, index);
    }
    return nextSibling.select(anchorOffset, focusOffset);
  }

  /**
   * Marks a node dirty, triggering transforms and
   * forcing it to be reconciled during the update cycle.
   *
   * */
  markDirty(): void {
    this.getWritable();
  }

  /**
   * @internal
   *
   * When the reconciler detects that a node was mutated, this method
   * may be called to restore the node to a known good state.
   */
  reconcileObservedMutation(dom: HTMLElement, editor: LexicalEditor): void {
    this.markDirty();
  }
}

function errorOnTypeKlassMismatch(
  type: string,
  klass: Klass<LexicalNode>,
): void {
  const registeredNode = getRegisteredNode(getActiveEditor(), type);
  // Common error - split in its own invariant
  if (registeredNode === undefined) {
    invariant(
      false,
      'Create node: Attempted to create node %s that was not configured to be used on the editor.',
      klass.name,
    );
  }
  const editorKlass = registeredNode.klass;
  if (editorKlass !== klass) {
    invariant(
      false,
      'Create node: Type %s in node %s does not match registered node %s with the same type',
      type,
      klass.name,
      editorKlass.name,
    );
  }
}

/**
 * Insert a series of nodes after this LexicalNode (as next siblings)
 *
 * @param firstToInsert - The first node to insert after this one.
 * @param lastToInsert - The last node to insert after this one. Must be a
 * later sibling of FirstNode. If not provided, it will be its last sibling.
 */
export function insertRangeAfter(
  node: LexicalNode,
  firstToInsert: LexicalNode,
  lastToInsert?: LexicalNode,
) {
  const lastToInsert2 =
    lastToInsert || firstToInsert.getParentOrThrow().getLastChild()!;
  let current = firstToInsert;
  const nodesToInsert = [firstToInsert];
  while (current !== lastToInsert2) {
    if (!current.getNextSibling()) {
      invariant(
        false,
        'insertRangeAfter: lastToInsert must be a later sibling of firstToInsert',
      );
    }
    current = current.getNextSibling()!;
    nodesToInsert.push(current);
  }

  let currentNode: LexicalNode = node;
  for (const nodeToInsert of nodesToInsert) {
    currentNode = currentNode.insertAfter(nodeToInsert);
  }
}

/**
 * Returns true if the given value is a {@link LexicalNode} instance.
 */
export function $isLexicalNode(
  node: null | undefined | LexicalNode,
): node is LexicalNode {
  return node instanceof LexicalNode;
}
