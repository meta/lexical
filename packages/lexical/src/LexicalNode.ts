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
import type {GeneratedJSONFactory} from './LexicalGeneratedJSON';

import invariant from '@lexical/internal/invariant';

import {
  $createParagraphNode,
  $getCommonAncestor,
  $getCommonAncestorResultBranchOrder,
  $getSiblingCaret,
  $isDecoratorNode,
  $isElementNode,
  $isRootNode,
  $isTextNode,
  type DecoratorNode,
  type ElementNode,
  type NODE_STATE_KEY,
} from '.';
import {
  $collectSiblingNodes,
  $detachNodeWithSelection,
  $insertNodeBetween,
  $insertSibling,
  $selectAdjacentNode,
} from './caret/LexicalCaretTree';
import {DOMSlot} from './LexicalDOMSlot';
import {
  $updateStateFromJSON,
  type AnyStateConfig,
  type NodeState,
  type NodeStateJSON,
  type Prettify,
  type RequiredNodeStateConfig,
} from './LexicalNodeState';
import {CACHED_TEXT_SIZE_KEY} from './LexicalReconciler';
import {type NodeSerializationSchema} from './LexicalSchema';
import {
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  $moveSelectionPointToEnd,
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
  $applyJSONSetters,
  $cloneWithProperties,
  $exportNodeJSONOnce,
  $getCompositionKey,
  $getEditorDOMRenderConfig,
  $getNodeByKey,
  $hasAncestor,
  $isKeyInSelectionNodes,
  $isRootOrShadowRoot,
  $maybeMoveChildrenSelectionToParent,
  $setCompositionKey,
  $setNodeKey,
  $setSelection,
  errorOnInsertTextNodeOnRoot,
  getRegisteredNode,
  getStaticNodeConfig,
  getSuperclassOf,
  internalMarkNodeAsDirty,
  internalStopExportMemo,
} from './LexicalUtils';

const __DEV__ = process.env.NODE_ENV !== 'production';

export type NodeMap = Map<NodeKey, LexicalNode>;

/**
 * The base type for all serialized nodes
 */
export type SerializedLexicalNode = {
  /** The type string used by the Node class */
  type: string;
  /**
   * @deprecated A numeric schema version. Nothing reads it — parsing ignores
   * it entirely — and nothing should.
   *
   * `exportJSON()` still writes it as `1` so the output stays readable by
   * older versions, which is the only reason it remains, and it stays required
   * here so that the legacy form promises what it actually writes. The two
   * places it is genuinely absent relax it themselves: a compact export omits
   * it along with everything else parsing restores on its own (see
   * {@link SerializedPartial}), and the parse shapes drop it outright (see
   * {@link LexicalUpdateJSON}).
   */
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
 * @experimental node-structure
 *
 * What an element may hold; see {@link StaticNodeConfigValue.children}.
 */
export type NodeChildrenConfig =
  | 'inline'
  | 'block'
  | readonly ('inline' | Klass<LexicalNode>)[];

/**
 * @experimental node-structure
 *
 * When adjacent siblings merge; see
 * {@link StaticNodeConfigValue.mergeAdjacent}.
 */
export interface MergeAdjacentConfig {
  /** Schema field names of the class, or NodeState configs. */
  readonly by: readonly (string | AnyStateConfig)[];
}

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
   *
   * A method signature rather than a function-typed property, so that the
   * parameter is checked bivariantly: the JSON handed in may be the compact
   * form, so a callback may take `SerializedPartial<SerializedLexicalNode>`,
   * while one written before that form existed takes `SerializedLexicalNode`
   * (`version` required) and has to stay assignable. A property's parameter
   * is compared contravariantly and would refuse it.
   */
  $importJSON?(serializedNode: SerializedPartial<SerializedLexicalNode>): T;
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
   * @experimental node-structure
   *
   * Whether a node of this class is inline (it sits among text, like a link)
   * rather than a block. A class that declares it in its own `$config()` and
   * does not write its own `isInline()` gets one that returns it; a class
   * that writes one must agree with it (checked when an editor is created, in
   * development). Inherited by subclasses that do not declare it, unless a
   * subclass's own `isInline()` may return something else.
   */
  readonly inline?: boolean;
  /**
   * @experimental node-structure
   *
   * What an {@link ElementNode} of this class may hold:
   *
   * - `'inline'`: inline content only (text, line breaks, inline elements and
   *   decorators), like a paragraph. A plain paragraph child becomes lines of
   *   the node: its content is joined to the inline content next to it with
   *   line breaks, as importers build a quote or list item from several
   *   paragraphs. Any other block child is lifted out: the node is split
   *   around it, so the block keeps its type and sits between the two parts.
   *   Out of an inline element (a link), the block's content is first wrapped
   *   in a copy of the element.
   * - `'block'`: blocks only, like a table cell. Each run of inline children
   *   is wrapped in a paragraph. With the extension, the node is also a block
   *   container for structural commands (see `$isBlockContainer`): they
   *   convert, wrap, split and insert blocks inside it and never replace or
   *   split the node itself.
   * - a list of `'inline'` and classes: only those (a class allows its
   *   subclasses). When the list names no `'inline'` (a list holds list
   *   items), a child the first listed class can hold is wrapped in one (a
   *   run of inline content in one), a plain paragraph becomes one holding
   *   its content, and any other block is lifted out. Otherwise blocks are
   *   handled as for `'inline'`.
   *
   * A block lifted out of a node goes on up until it reaches a node that may
   * hold it, or one whose class declares nothing. A root or shadow root
   * always holds blocks, whatever its class declares.
   *
   * The opt-in `NodeStructureExtension` enforces it in the same update as a
   * change, and only moves content (it also removes an inline element left
   * with nothing in it, which Lexical removes anyway); without the extension
   * it changes nothing. Inherited by subclasses that do not declare it.
   */
  readonly children?: NodeChildrenConfig;
  /**
   * @experimental node-structure
   *
   * Adjacent siblings of this class are the same thing when the values `by`
   * names are equal: schema fields of the class or {@link StateConfig}s
   * (NodeState counts only when named; a derived value cannot be named).
   * Tools that read the declarations can treat such siblings as one.
   *
   * `NodeStructureExtension` merges them, the later one's children appended
   * to the earlier one, whose values win, for the class that declares it in
   * its own `$config()` only. A subclass that merely inherits the declaration
   * is never merged by the extension, so a merge method it overrides (such as
   * `LinkNode`'s `shouldMergeAdjacentLink`) stays the authority. A class
   * whose own transform merges must merge the same siblings the same way
   * (`ListNode`'s leaves it to the extension where it is registered). `false`
   * turns off a declaration an ancestor made. Inherited by subclasses that do
   * not declare it.
   */
  readonly mergeAdjacent?: MergeAdjacentConfig | false;
  /**
   * The exact superclass of the node. Always name it.
   *
   * The runtime fills it in from the prototype chain when it is left out, but
   * the type system cannot: `extends` is what the composed serialization types
   * follow from one config to the next. A node that omits it still contributes
   * its own declarations — `LexicalSchemaInput` reads the config in hand — but
   * the walk stops there, so every property the node inherits is missing from
   * the type while the runtime keeps applying it. Where the superclass itself
   * declares a `$config()` — which `TextNode`, `ElementNode` and
   * `LineBreakNode` all do — omitting it is a compile error on the override
   * rather than a silent loss.
   *
   * It must be the *exact* superclass. Nothing checks that: naming a class
   * further up the chain silently skips everything in between, which drops
   * those classes' schema fields, `$transform`, `slots` and `stateConfigs`
   * from every walk.
   */
  readonly extends?: Klass<LexicalNode>;
  /**
   * EXPERIMENTAL
   *
   * A {@link SerializationSchema} describing this node's serialized JSON (the
   * node-specific properties it adds over its parent's, not including
   * `type`/`version`/`children` or node state). When provided it is the single
   * source of truth for parsing those properties — a node's `updateFromJSON`
   * can apply it — and, because the schema is introspectable, tooling such as
   * `@lexical/fast-check` can use it to generate example serializations.
   *
   * It is named `json` rather than `schema` to avoid ambiguity with other kinds
   * of node schema (e.g. a schema of allowed children).
   */
  readonly json?: NodeSerializationSchema<T>;
  /**
   * @internal
   *
   * Specialized `exportJSON`/`updateFromJSON` implementations compiled from
   * this class's serialization schema by `scripts/generate-node-json.mjs`,
   * which the schema-driven walks use in place of walking. Set by the core
   * node classes
   * that are code-generated; there is no reason to write it by hand.
   *
   * Carried here rather than looked up by node type, because a type does not
   * identify a class: a subclass that declares no `$config` of its own inherits
   * its ancestor's, type included, and may still override an accessor the
   * generated code compiled away. Passing the code through the config makes the
   * association the same one the schema itself has — the class whose `$config`
   * named it — so the two cannot come apart.
   *
   * A factory rather than the functions themselves: registration calls it
   * with the class's composed schema, and the generated code reads the lookup
   * tables it needs off that schema, so a generated module carries no copy of
   * a table and a subclass that inherits the code runs it over its own.
   */
  readonly generated?: GeneratedJSONFactory;
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
 * The brand every {@link LexicalNode} carries in its type and nothing else
 * does, for a check that has to say "a node" without relating a class to
 * `LexicalNode` member by member; see `SetterReturn` in LexicalSchema.ts.
 * Declared only — `instanceof LexicalNode` is what a runtime check uses.
 * @internal
 */
export declare const LEXICAL_NODE_BRAND: unique symbol;

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
 * What `T.exportJSON(compact)` returns for the *legacy* form, which is the one
 * that writes every property. The compact form omits properties and so returns
 * the {@link SerializedPartial} of this.
 *
 * Matched against the whole overload set rather than read with `ReturnType`,
 * which resolves an overloaded type to its *last* signature — the compact one,
 * where nothing is promised. Both signatures have to appear in the pattern:
 * matching only the first infers `never`, because an overloaded source is
 * assignable to a single-signature target through its last overload.
 *
 * A node that declares one `exportJSON(compact?: boolean)` signature — a
 * narrowing of both overloads at once, which therefore cannot distinguish
 * them — satisfies both and matches too.
 */
type LexicalFullExportJSON<T extends LexicalNode> = T['exportJSON'] extends {
  (compact?: false): infer R;
  (compact: boolean): unknown;
}
  ? R
  : ReturnType<T['exportJSON']>;

export type LexicalExportJSON<T extends LexicalNode> = Prettify<
  Omit<LexicalFullExportJSON<T>, 'type' | 'version'> & {
    type: GetStaticNodeType<T>;
    /**
     * Written by `exportJSON()` so the output remains readable by older
     * versions. Required, like {@link SerializedLexicalNode.version}: this is
     * the legacy form, which writes it unconditionally. `exportJSON(true)`
     * returns the {@link SerializedPartial} of this, where it is optional
     * along with everything else parsing restores on its own.
     */
    version: number;
  } & NodeStateJSON<T>
>;

/**
 * Omit the children, type, and version properties from the given SerializedLexicalNode definition.
 *
 * This is the shape a hand-written `updateFromJSON` override reads: each
 * property keeps its declared type. The parser behind a serialization schema
 * faces wider input than that — see {@link LexicalParseJSON}.
 */
export type LexicalUpdateJSON<T extends SerializedLexicalNode> = Omit<
  T,
  'children' | 'type' | 'version'
>;

/**
 * The serialized form of a node as accepted by the parsing methods
 * ({@link LexicalNode.importJSON} and {@link LexicalNode.updateFromJSON}).
 *
 * Only `type` identifies the node here: every node-specific property is made
 * optional via `Partial`. Parsing is generally untrusted and must tolerate
 * missing or out-of-domain values, so implementations are expected to
 * substitute sensible defaults — see the {@link Parse} helpers such as
 * {@link stringValue}, {@link numberValue}, and {@link enumValue}. This also
 * enables a "compact" serialization variant in which any property left at its
 * default is omitted.
 *
 * The deprecated `version` is relaxed here rather than on
 * {@link SerializedLexicalNode}: a compact export omits it, but the legacy
 * form always writes it, and making it optional at the base would take that
 * promise away from the full output type as well.
 */
export type SerializedPartial<T extends SerializedLexicalNode> = Omit<
  SerializedLexicalNode & Partial<T>,
  '$slots' | 'children' | 'version'
> & {
  /**
   * Slot values are parsed by the same rules, so they relax the same way —
   * and, like the parse entry point, name the declared form too: naming only
   * the indexed `SerializedPartialNode` meant a slot could not hold a value
   * whose type is a declared interface, since TypeScript gives an interface no
   * implicit index signature.
   */
  $slots?: Record<string, SerializedPartialNode | SerializedLexicalNode>;
  /** Omitted by a compact export, like every other restorable property. */
  version?: number;
} & (T extends {children: readonly SerializedLexicalNode[]}
    ? {
        /**
         * An element's children are nodes of the same document, written in the
         * same form, so they relax too: `Partial<T>` alone would make the array
         * optional while still promising that everything in it is fully
         * serialized, which is untrue of every compact element but the leaves.
         */
        children?: SerializedPartialNode[];
      }
    : // Not an element. Intersecting with `unknown` leaves the type alone,
      // rather than giving every node an optional `children` it never has.
      unknown);

/**
 * A node of a compact document read without knowing its type, which is every
 * child: a node cannot declare what kind of children it accepts, so any node
 * may appear under any element and there is no type to name their properties
 * from. The outer node of a {@link SerializedPartial} is refinable — you know
 * what you asked for — and its children never are.
 *
 * So the framework properties are named and a node's own arrive as `unknown`,
 * which a reader narrows by `type` as it would any untrusted JSON. `children`
 * and `$slots` recurse, because a compact export applies to a subtree exactly
 * as it does to its root: naming `SerializedPartial<SerializedLexicalNode>` for
 * them instead would leave a nested element unable to carry the children it has.
 *
 * The index signature is what lets a document be *written*. Without it every
 * node-specific property on a child is an excess-property error, so
 * `editor.parseEditorState({root: {children: [{children: [{text: 'hi', type:
 * 'text'}], …}], …}})` — a hand-authored initial state, the most ordinary
 * literal a caller writes — does not compile, and neither does a fixture, a
 * migration script, or `$parseSerializedNode` on a literal. Closing the type
 * was tried for the misspelling it would catch; excess-property checking fires
 * only on fresh literals, and everything arriving at load comes from
 * `JSON.parse`, so it caught no misspelling that mattered and cost every
 * correct property. Flow's counterpart is inexact for the same reason.
 */
export type SerializedPartialNode = {
  /** The one property every node carries and a reader narrows by. */
  type: string;
  /** Omitted by a compact export, like every other restorable property. */
  version?: number;
  /** Node state, parsed by the same rules whatever the node turns out to be. */
  [NODE_STATE_KEY]?: Record<string, unknown>;
  /** A slot holds a node subtree, so it relaxes exactly as `children` do. */
  $slots?: Record<string, SerializedPartialNode | SerializedLexicalNode>;
  /** Present when the node is an element; the same form all the way down. */
  children?: SerializedPartialNode[];
  /** A node's own properties: there is no type here to name them from. */
  [key: string]: unknown;
};

/**
 * The least a value has to be for {@link $parseSerializedNode} to read it: a
 * `type` to look the class up by, and subtrees of the same shape.
 *
 * A type alias rather than an `interface`, which is what lets it stand in for
 * the internal shape the parse walks: TypeScript gives an alias an implicit
 * index signature and an interface none, and the walk's own parameter carries
 * one. An interface is still assignable *to* it, which is the direction that
 * matters for a caller like `@lexical/clipboard`'s `BaseSerializedNode`.
 *
 * `version` is optional because the parser drops it — it is deprecated and
 * nothing reads it — so requiring it described the caller rather than the
 * parameter. That mattered because {@link SerializedPartialNode} carries an
 * index signature, which an `interface` never satisfies, and
 * {@link SerializedLexicalNode} requires `version`: a caller holding an
 * interface with an optional `version`, such as `@lexical/clipboard`'s
 * `BaseSerializedNode`, matched neither, and the mismatch repeated at every
 * level because `children` and `$slots` recurse.
 */
export type ParsableSerializedNode = {
  /** A slot holds a node subtree, so it relaxes exactly as `children` do. */
  $slots?: Record<string, ParsableSerializedNode>;
  /** Present when the node is an element; the same form all the way down. */
  children?: ParsableSerializedNode[];
  /** The one property every node carries and a reader narrows by. */
  type: string;
  /**
   * @deprecated Dropped when parsing; see {@link SerializedLexicalNode.version}.
   */
  version?: number;
};

/**
 * The shape {@link LexicalNode.updateFromJSON} accepts for a node whose
 * serialized type is `S`, as a schema-driven parser faces it: every
 * node-specific property optional (a compact export omits a default-valued
 * one, and an older document predates a newer one) and `unknown`, with
 * `type`, `version` and `children` dropped.
 *
 * `unknown`, because this is the untrusted-JSON boundary and a parser here is
 * *total*: it validates every property against the schema's domain and
 * substitutes a default for anything outside it. Typing a property as what it
 * parses *to* would claim the caller has already done that validation, which
 * is both untrue and narrower than what is accepted — a schema reads more than
 * it writes wherever it has an alias table or reads a number spelled as a
 * string, so `format: 'bold'` and `width: '640'` are valid input that the
 * narrower type rejected. The property *names* stay, so a misspelled one is
 * still an excess-property error. NodeState and slots keep their declared
 * shapes: neither is a schema-declared property, and each is read structurally
 * by the code that applies it rather than validated against a domain.
 *
 * A node that declares a serialization schema narrows both JSON methods to its
 * own serialized type by declaration merging, which is the one thing a schema
 * cannot do for it:
 *
 * ```ts
 * export interface MarkNode {
 *   exportJSON(compact?: false): SerializedMarkNode;
 *   exportJSON(compact: boolean): SerializedPartial<SerializedMarkNode>;
 *   updateFromJSON(serializedNode: LexicalParseJSON<SerializedMarkNode>): this;
 * }
 * ```
 *
 * A hand-written override that reads its properties typed uses
 * {@link LexicalUpdateJSON} instead, as it always has.
 */
export type LexicalParseJSON<S extends SerializedLexicalNode> = Pick<
  SerializedPartial<S>,
  Extract<keyof SerializedPartial<S>, typeof NODE_STATE_KEY | '$slots'>
> & {
  [K in keyof Omit<
    SerializedPartial<S>,
    '$slots' | 'children' | 'type' | typeof NODE_STATE_KEY | 'version'
  >]?: unknown;
};

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

  $detachNodeWithSelection(
    nodeToRemove.getWritable(),
    restoreSelection && !selectionMoved && $isRangeSelection(selection)
      ? selection
      : null,
  );

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
  /** @internal See {@link LEXICAL_NODE_BRAND}. */
  declare readonly [LEXICAL_NODE_BRAND]: true;
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
  declare [CACHED_TEXT_SIZE_KEY]?: number;

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

    const isSelected = $isKeyInSelectionNodes(targetSelection, this.__key);

    if (!isSelected || $isTextNode(this)) {
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
  getPreviousSibling(): LexicalNode | null {
    const self = this.getLatest();
    const prevKey = self.__prev;
    return prevKey === null ? null : $getNodeByKey(prevKey);
  }

  /**
   * Returns all nodes before this one in the same parent,
   * in document order.
   */
  getPreviousSiblings(): LexicalNode[] {
    return $collectSiblingNodes(
      this.getPreviousSibling(),
      'previous',
    ).reverse();
  }

  /**
   * Returns the node after this one in the same parent, or null
   * if there is no such node.
   */
  getNextSibling(): LexicalNode | null {
    const self = this.getLatest();
    const nextKey = self.__next;
    return nextKey === null ? null : $getNodeByKey(nextKey);
  }

  /**
   * Returns all nodes after this one in the same parent,
   * in document order.
   */
  getNextSiblings(): LexicalNode[] {
    return $collectSiblingNodes(this.getNextSibling(), 'next');
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

  /**
   * Returns a list of nodes that are between this node and
   * the target node in the EditorState.
   *
   * @param targetNode - the node that marks the other end of the range of nodes to be returned.
   */
  getNodesBetween(targetNode: LexicalNode): LexicalNode[] {
    const forward = this.isBefore(targetNode);
    const nodes: LexicalNode[] = [];
    let node: LexicalNode | null = this;
    let entering = true;
    let openElements = 0;
    while (node !== null) {
      // Only ancestors above the starting point lack an enter event. Count
      // open elements to recognize their first visit without a visited Set.
      if (entering || openElements === 0) {
        nodes.push(node);
      }
      if (node.is(targetNode)) {
        break;
      }
      if (!entering && openElements > 0) {
        openElements--;
      }
      const child: LexicalNode | null =
        entering && $isElementNode(node)
          ? forward
            ? node.getFirstChild()
            : node.getLastChild()
          : null;
      if (child !== null) {
        openElements++;
      }
      const adjacent: LexicalNode | null =
        child || (forward ? node.getNextSibling() : node.getPreviousSibling());
      entering = adjacent !== null;
      node = adjacent || node.getParent();
    }
    return forward ? nodes : nodes.reverse();
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
        'Lexical node does not exist in active editor state (key %s, type %s). The reference was probably kept from another read or update, for example in a closure, event handler or component state, and the node has since been removed or is not part of this editor state. Before using a node reference that may be stale, check node.isAttached() or look the node up again with $getNodeByKey(node.getKey()), inside the read or update where it is used.',
        this.__key,
        this.__type,
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
    // Before the clone, whose hooks may read: a node that changes ends an
    // export walk's memo (see INTERNAL_$withExportMemo).
    internalStopExportMemo();
    const editorState = getActiveEditorState();
    const editor = getActiveEditor();
    const key = this.__key;
    const cloneNotNeeded = editor._cloneNotNeeded;
    // Cast: a key always identifies the same node class.
    const writableNode = cloneNotNeeded.get(key) as this | undefined;
    const selection = editorState._selection;
    if (selection !== null) {
      selection.setCachedNodes(null);
    }
    if (writableNode !== undefined) {
      // Transforms clear the dirty node set on each iteration to keep track on newly dirty nodes
      internalMarkNodeAsDirty(writableNode);
      return writableNode;
    }
    const nodeMap = editorState._nodeMap;
    // Cast: the nodeMap entry for this key is always the same node class.
    const latestNode = nodeMap.get(key) as this | undefined;
    invariant(
      latestNode !== undefined,
      'Lexical node does not exist in active editor state (key %s, type %s). The reference was probably kept from another read or update, for example in a closure, event handler or component state, and the node has since been removed or is not part of this editor state. Before using a node reference that may be stale, check node.isAttached() or look the node up again with $getNodeByKey(node.getKey()), inside the read or update where it is used.',
      key,
      this.__type,
    );
    const mutableNode = $cloneWithProperties(latestNode);
    cloneNotNeeded.set(key, mutableNode);
    nodeMap.set(key, mutableNode);
    internalMarkNodeAsDirty(mutableNode);

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
    const element = $getEditorDOMRenderConfig(editor).$createDOM(this, editor);
    return {element};
  }

  /**
   * Controls how the this node is serialized to JSON. This is important for
   * copy and paste between Lexical editors sharing the same namespace. It's also important
   * if you're serializing to JSON for persistent storage somewhere.
   * See [Serialization & Deserialization](https://lexical.dev/docs/serialization/serialization#json).
   *
   * The base implementation writes every property the node's schema declares
   * (its own and those it inherits), reading each through its getter —
   * `get<Prop>` by default, or the name recorded with `withAccessors`. A getter
   * that returns `undefined` omits its property. Override this only for output
   * a schema can not describe, and call `super.exportJSON(compact)` when you do.
   *
   * **This may serialize the instance as-is, without resolving the latest
   * version.** A property declared with {@link withField} is read straight off
   * the node, which is the optimization the serialization walk is built on —
   * every node the walk reaches comes from the EditorState's node map and is
   * already current, so it resolves nothing per node.
   *
   * So on a reference that a `getWritable()` (any `set<Prop>`) has since
   * superseded, this writes pre-mutation values. Which properties do is not
   * something to rely on: a property whose accessor a subclass overrode still
   * goes through that accessor and resolves the latest, so one node can write
   * a current `text` beside a stale `style`. Call
   * `node.getLatest().exportJSON()` whenever you hold such a reference rather
   * than reasoning about which properties resolve.
   *
   * This is a breaking change. Every property previously went through an
   * accessor, and every accessor resolves `getLatest()`, so a stale reference
   * exported current values.
   *
   * @param compact Write the compact form: omit a property the parser derives
   *   rather than reads, one whose value is the schema default parsing would
   *   restore, and the deprecated `version`. The two forms describe the same
   *   document. A node that overrides this and ignores the flag simply keeps
   *   writing the full form, which still parses.
   * */
  exportJSON(compact?: false): SerializedLexicalNode;
  /**
   * The compact form omits properties, so what it returns is the *partial*
   * serialized type — every node-specific property optional — rather than the
   * full one. Passing a `boolean` whose value is not statically known selects
   * this overload too, which is right: neither form can be promised then.
   *
   * @see {@link SerializedPartial}
   */
  exportJSON(compact: boolean): SerializedPartial<SerializedLexicalNode>;
  exportJSON(compact = false): SerializedPartial<SerializedLexicalNode> {
    // One resolution of the class record for both: `$generatedExportJSON`
    // returning `undefined` used to send the walk back to look the same class
    // up again, a second WeakMap read and a second DEV field validation per
    // node per export — on the path every node without generated code takes.
    const json = $exportNodeJSONOnce(this, compact);
    // Neither a generated exporter nor the walk writes NodeState: what a node
    // carries is not known when code is generated, and the walk's table is
    // compiled from the schema alone. Appended here so the two paths cannot
    // disagree about how it is written.
    const state = this.__state ? this.__state.toJSON() : undefined;
    if (state !== undefined) {
      Object.assign(json, state);
    }
    return json as unknown as SerializedLexicalNode;
  }

  /**
   * Controls how the this node is deserialized from JSON. This is usually boilerplate,
   * but provides an abstraction between the node implementation and serialized interface that can
   * be important if you ever make breaking changes to a node schema (by adding or removing properties).
   * See [Serialization & Deserialization](https://lexical.dev/docs/serialization/serialization#json).
   *
   * */
  static importJSON(
    _serializedNode: SerializedPartial<SerializedLexicalNode> &
      Record<string, unknown>,
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
   *
   * The whole schema is applied, so a property the JSON omits is set to
   * its schema default rather than left as it is — that is what lets the
   * compact form omit a default-valued property and have parsing restore it.
   * (A flat NodeState is the exception: it is applied only when present.) Pass
   * the node's complete serialized form unless you mean to reset what you
   * leave out.
   */
  updateFromJSON(
    serializedNode: LexicalParseJSON<SerializedLexicalNode>,
  ): this {
    return $applyJSONSetters(
      $updateStateFromJSON(this, serializedNode),
      serializedNode,
    );
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
    // Detaching repairs the cloned selection's old-parent offsets (#6031).
    const replaceWithOldParent = writableReplaceWith.getParent();
    $detachNodeWithSelection(
      writableReplaceWith,
      $isRangeSelection(selection) ? selection : null,
    );
    const prevSibling = self.getPreviousSibling();
    const nextSibling = self.getNextSibling();
    $removeNode(self, false, true);
    $insertNodeBetween(
      writableParent,
      writableReplaceWith,
      prevSibling && prevSibling.getWritable(),
      nextSibling && nextSibling.getWritable(),
    );
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
      // Children transfer maps element offsets into the replacement's existing
      // children. Other points retain replace's move-to-end behavior.
      for (const point of [selection.anchor, selection.focus]) {
        if (point.key === toReplaceKey) {
          if (includeChildren && point.type === 'element') {
            point.set(
              writableReplaceWith.__key,
              prevSizeBeforeChildrenTransfer + point.offset,
              'element',
            );
          } else {
            $moveSelectionPointToEnd(point, writableReplaceWith);
          }
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
    return $insertSibling(this, 'next', nodeToInsert, restoreSelection);
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
    return $insertSibling(this, 'previous', nodeToInsert, restoreSelection);
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
    return $selectAdjacentNode(
      $getSiblingCaret(this, 'previous'),
      anchorOffset,
      focusOffset,
    );
  }

  /**
   * Moves selection to the next sibling of this node, at the specified offsets.
   *
   * @param anchorOffset - The anchor offset for selection.
   * @param focusOffset -  The focus offset for selection
   * */
  selectNext(anchorOffset?: number, focusOffset?: number): RangeSelection {
    return $selectAdjacentNode(
      $getSiblingCaret(this, 'next'),
      anchorOffset,
      focusOffset,
    );
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
