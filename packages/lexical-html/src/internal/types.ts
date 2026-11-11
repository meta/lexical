/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {DOMImportContextSymbol, DOMRenderContextSymbol} from './constants';
import type {
  BaseSelection,
  DOMExportOutput,
  DOMSlotForNode,
  EditorDOMRenderConfig,
  Klass,
  LexicalEditor,
  LexicalNode,
  StateConfig,
} from 'lexical';

/**
 * @experimental
 *
 * Any ContextSymbol for {@link ContextConfig} (DOM render or DOM import).
 */
export type AnyContextSymbol =
  | typeof DOMRenderContextSymbol
  | typeof DOMImportContextSymbol;

/**
 * @experimental
 *
 * Context with a phantom type for its purpose (such as {@link DOMRenderContextSymbol}).
 *
 * A ContextRecord is a data structure used in the export and import pipelines
 * to allow for information to be passed throughout the chain without explicit
 * argument passing, e.g. to specify whether the intended use case for HTML
 * export is for serialization or for clipboard copy.
 */
export type ContextRecord<_K extends symbol> = Record<string | symbol, unknown>;

/**
 * @experimental
 *
 * A data structure much like StateConfig (they share implementation details)
 * but for managing context during an export or import pipeline rather than
 * individual node state.
 */
export type ContextConfig<Sym extends symbol, V> = StateConfig<symbol, V> & {
  readonly [K in Sym]?: true;
};

/**
 * @experimental
 *
 * Update the context at `cfg` with updater, constructed with {@link contextUpdater}
 */
export type ContextConfigUpdater<Ctx extends AnyContextSymbol, V> = {
  readonly cfg: ContextConfig<Ctx, V>;
  /**
   * @param prev The current or default value
   * @returns The new value
   */
  readonly updater: (prev: V) => V;
};

/**
 * @experimental
 *
 * Set the context at `cfg` to a specific value, constructed with {@link contextValue}
 */
export type ContextConfigPair<Ctx extends AnyContextSymbol, V> = readonly [
  ContextConfig<Ctx, V>,
  V,
];

/**
 * @experimental
 *
 * Set or update a context value, constructed with {@link contextValue} or {@link contextUpdater}
 */
export type ContextPairOrUpdater<Ctx extends AnyContextSymbol, V> =
  | ContextConfigPair<Ctx, V>
  | ContextConfigUpdater<Ctx, V>;

/** @experimental */
export type AnyContextConfigPairOrUpdater<Ctx extends AnyContextSymbol> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ContextPairOrUpdater<Ctx, any>;

/** @experimental */
export interface DOMRenderExtensionOutput {
  /** @internal */
  defaults: undefined | ContextRecord<typeof DOMRenderContextSymbol>;
  /** @internal */
  runtime: DOMRenderRuntime;
}

/**
 * @experimental
 *
 * A read-only view of a render context layer, passed to the
 * {@link DOMOverrideOptions} predicates so they can decide whether an
 * override should be installed based only on context values.
 */
export interface RenderContextReader {
  get<V>(cfg: RenderStateConfig<V>): V;
}

/**
 * @experimental
 * @internal
 *
 * Per-editor runtime state for {@link DOMRenderExtension} that backs the
 * imperative editor context ({@link createRenderState} writes via
 * `$setRenderContextValue`) and the conditional install of overrides.
 */
export interface DOMRenderRuntime {
  /**
   * The mutable, persistent editor-level context record. Reads of a
   * {@link RenderStateConfig} during reconciliation (and as the base layer
   * during a session) fall through to this record. It is also the layer
   * that {@link DOMOverrideOptions.disabledForEditor} predicates read from.
   */
  readonly editorContext: ContextRecord<typeof DOMRenderContextSymbol>;
  /**
   * Imperatively set a value in the editor context. If the change flips any
   * override's `disabledForEditor` result, the resident render config is
   * recompiled and the affected nodes are re-rendered (recreating DOM for
   * structural overrides).
   */
  setContextValue<V>(cfg: RenderStateConfig<V>, value: V): void;
  /**
   * Resolve the {@link EditorDOMRenderConfig} for the current export/generate
   * session, applying any {@link DOMOverrideOptions.disabledForSession}
   * predicates against the active session context. Returns the resident
   * config when no session gating applies.
   */
  getSessionConfig(): EditorDOMRenderConfig;
}

/**
 * @experimental
 *
 * Options for {@link domOverride} controlling *whether* an override is
 * installed, based only on render context. Both predicates default to
 * "not disabled".
 */
export interface DOMOverrideOptions {
  /**
   * Gate residency in the editor's render config (used by reconciliation and
   * as the base for export/generate). Evaluated against the persistent editor
   * context at compile time, and re-evaluated when that context changes via
   * `$setRenderContextValue`; a change recompiles the config and re-renders
   * affected nodes. Return `true` to remove the override. Default: not disabled.
   */
  disabledForEditor?: (ctx: RenderContextReader) => boolean;
  /**
   * Gate participation in a single export/generate session. Evaluated once at
   * the start of each session against that session's context. Has no effect on
   * live reconciliation (which is not a session). Return `true` to remove the
   * override for that session. Default: not disabled.
   */
  disabledForSession?: (ctx: RenderContextReader) => boolean;
}

/**
 * @experimental
 *
 * Context configuration for render context, created with {@link createRenderState}
 */
export type RenderStateConfig<V> = ContextConfig<
  typeof DOMRenderContextSymbol,
  V
>;

/**
 * @experimental
 *
 * Any setter or updater for {@link RenderStateConfig}
 */
export type AnyRenderStateConfigPairOrUpdater = AnyContextConfigPairOrUpdater<
  typeof DOMRenderContextSymbol
>;

/**
 * @experimental
 *
 * Any {@link RenderStateConfig}
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRenderStateConfig = RenderStateConfig<any>;

/**
 * @experimental
 *
 * Configuration for {@link DOMRenderExtension}
 */
export interface DOMRenderConfig {
  /**
   * {@link DOMRenderMatch} overrides to customize node behavior,
   * the final priority of these will be based on the following criteria:
   *
   * - Wildcards (`'*'`) have highest priority
   * - Predicates (`$isParagraphNode`) have next priority
   * - Subclasses have higher priority (e.g. `ParagraphNode` before `ElementNode`)
   * - Extensions closer to the root have higher priority
   * - Extensions depended on later have higher priority
   * - Overrides defined later have higher priority
   */
  overrides: AnyDOMRenderMatch[];
  /**
   * Default context to provide in all exports, the configurations are created
   * with {@link createRenderState} and should be created at the module-level.
   *
   * Only specify these if overriding the default value globally, since each
   * configuration has a built-in default value that will be used if not
   * already present in the context.
   */
  contextDefaults: AnyRenderStateConfigPairOrUpdater[];
}

/**
 * @experimental
 * Any {@link DOMRenderMatch}
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDOMRenderMatch = DOMRenderMatch<any>;

/**
 * @experimental
 *
 * Match a node (and any subclass of that node) by its LexicalNode class,
 * or with a guard (e.g. `ElementNode` or `$isElementNode`).
 *
 * Note that using the class compiles to significantly more efficient code
 * than using a guard.
 */
export type NodeMatch<T extends LexicalNode> =
  | Klass<T>
  | ((node: LexicalNode) => node is T);

/**
 * @experimental
 *
 * Used to define overrides for the render and export
 * behavior for nodes matching the `nodes` predicate.
 *
 * All of these overrides are in a middleware style where you may use the
 * result of `$next()` to enhance the result of the default implementation
 * (or a lower priority override) by calling it and manipulating the result,
 * or you may choose not to call `$next()` to entirely replace the behavior.
 *
 * It is not permitted to update the lexical editor state during any of
 * these calls, you should only be doing read-only operations.
 */
export interface DOMRenderMatch<T extends LexicalNode> {
  /**
   * '*' for all nodes, or an array of `NodeClass | $isNodeGuard` to match
   * nodes more specifically. Using classes is more efficient, but will
   * also target subclasses.
   */
  readonly nodes: '*' | readonly NodeMatch<T>[];
  /**
   * Control where an ElementNode's children are inserted into the DOM,
   * this is useful to add a wrapping node or accessory nodes before or
   * after the children. The root of the node returned by createDOM must
   * still be exactly one HTMLElement.
   *
   * Generally you will call `$next()` to get a slot and then use its methods
   * to create a new one. The slot type is narrowed via {@link DOMSlotForNode}:
   * for `ElementNode` it resolves to {@link ElementDOMSlot} with
   * children-management semantics; for non-Element nodes the base
   * {@link DOMSlot} pointing at the keyed DOM.
   *
   * @param node The LexicalNode
   * @param dom The rendered HTMLElement
   * @param $next Call the next implementation
   * @param editor The editor
   * @returns The slot for this node
   */
  $getDOMSlot?: (
    node: T,
    dom: HTMLElement,
    $next: () => DOMSlotForNode<T>,
    editor: LexicalEditor,
  ) => DOMSlotForNode<T>;
  /**
   * Called during the reconciliation process to determine which nodes
   * to insert into the DOM for this Lexical Node. This is also the default
   * implementation of `$exportDOM` for most nodes.
   *
   * This method must return exactly one `HTMLElement`.
   *
   * Nested elements are not supported except with `DecoratorNode`
   * (which have unmanaged contents) or `ElementNode` using an appropriate
   * `$getDOMSlot` return value.
   *
   * @param node The LexicalNode
   * @param $next Call the next implementation
   * @param editor The editor
   * @returns The HTMLElement for this node to be rendered in the editor
   */
  $createDOM?: (
    node: T,
    $next: () => HTMLElement,
    editor: LexicalEditor,
  ) => HTMLElement;
  /**
   * Called when a node changes and should update the DOM
   * in whatever way is necessary to make it align with any changes that might
   * have happened during the update.
   *
   * Returning `true` here will cause lexical to unmount and recreate the DOM
   * node (by calling `$createDOM`). You would need to do this if the element
   * tag changes, for instance.
   *
   * @param nextNode The current version of this node
   * @param prevNode The previous version of this node
   * @param dom The previously rendered HTMLElement for this node
   * @param $next Call the next implementation
   * @param editor The editor
   * @returns `false` if no update needed or was performed in-place, `true` if `$createDOM` should be called to re-create the node
   */
  $updateDOM?: (
    nextNode: T,
    prevNode: T,
    dom: HTMLElement,
    $next: () => boolean,
    editor: LexicalEditor,
  ) => boolean;
  /**
   * Called after a node is created or updated and should make any in-place
   * updates to the DOM in whatever way is necessary to make it align with
   * any changes that might have happened during the `$createDOM` or
   * `$updateDOM`. This also runs after any children have been reconciled.
   *
   * Use this when you have code that you would need to duplicate in both
   * methods, or if there is a need to ensure that the children are also
   * reconciled before performing this in-place update.
   *
   * Unlike other overrides, all applicable `$decorateDOM` functions are
   * called unconditionally. There is no `$next` argument, because there
   * are no known use cases for avoiding the next implementation and due
   * to the void return value it would be error-prone and add boilerplate
   * to require calling it.
   *
   * The ordering here is equivalent to an implicit `$next` call *first*.
   *
   * @param nextNode The current version of this node
   * @param prevNode The previous version of this node if `$updateDOM` returned `false`, or `null` if `$createDOM` was just called
   * @param dom The previously rendered `HTMLElement` for this node
   * @param editor The editor
   */
  $decorateDOM?: (
    nextNode: T,
    prevNode: null | T,
    dom: HTMLElement,
    editor: LexicalEditor,
  ) => void;
  /**
   * Controls how the this node is serialized to HTML. This is important for
   * copy and paste between Lexical and non-Lexical editors, or Lexical
   * editors with different namespaces, in which case the primary transfer
   * format is HTML. It's also important if you're serializing to HTML for
   * any other reason via {@link @lexical/html!$generateHtmlFromNodes}.
   *
   * @param node The LexicalNode
   * @param $next Call the next implementation
   * @param editor The editor
   * @returns A {@link DOMExportOutput} structure that defines how the node should be exported to HTML
   */
  $exportDOM?: (
    node: T,
    $next: () => DOMExportOutput,
    editor: LexicalEditor,
  ) => DOMExportOutput;
  /**
   * Equivalent to `ElementNode.excludeFromCopy`, if it returns `true` this
   * lexical node will not be exported to DOM (but if it's an `ElementNode`
   * its children may still be inserted in its place).
   *
   * Has higher precedence than `$shouldInclude` and `$extractWithChild`.
   *
   * @param node The LexicalNode
   * @param selection The current selection
   * @param $next The next implementation
   * @param editor The editor
   * @returns true to exclude this node, false otherwise
   */
  $shouldExclude?: (
    node: T,
    selection: null | BaseSelection,
    $next: () => boolean,
    editor: LexicalEditor,
  ) => boolean;
  /**
   * Return `true` if this node should be included in the export, typically based
   * on the current selection (all nodes by default are included when there
   * is no selection).
   *
   * The default implementation is equivalent to
   * `selection ? node.isSelected(selection) : true`.
   *
   * This has lower precedence than `$extractWithChild` and `$shouldExclude`.
   *
   * @param node The current node
   * @param selection The current selection
   * @param $next The next implementation
   * @param editor The editor
   * @returns `true` if this node should be included in the export, `false` otherwise
   */
  $shouldInclude?: (
    node: T,
    selection: null | BaseSelection,
    $next: () => boolean,
    editor: LexicalEditor,
  ) => boolean;
  /**
   * Return `true` if this node should be included in the export based on
   * `childNode`, even if it would not otherwise be included based on its
   * `$shouldInclude` result.
   *
   * Typically used to ensure that required wrapping nodes are always
   * present with its children, e.g. a ListNode when some of its ListItemNode
   * children are selected.
   *
   * This has higher precedence than `$extractWithChild` and lower precedence
   * than `$shouldExclude`.
   *
   * @param node The lexical node
   * @param childNode A child of this lexical node
   * @param selection The current selection
   * @param destination Currently always `'html'`
   * @param $next The next implementation
   * @param editor The editor
   * @returns true if this
   */
  $extractWithChild?: (
    node: T,
    childNode: LexicalNode,
    selection: null | BaseSelection,
    destination: 'clone' | 'html',
    $next: () => boolean,
    editor: LexicalEditor,
  ) => boolean;
  /**
   * Where a named slot's container should attach, for hosts rendered
   * entirely in-lexical (no chrome framework). Consulted by the
   * reconciler whenever it creates or reconciles the slot's container,
   * synchronously within the same commit: a non-null return attaches
   * the container to that element and reveals it (returning `hostDom`
   * reveals the slot in its default slots-first position). Call
   * `$next()` to defer to lower-priority overrides / the default
   * (null — a hidden placeholder for explicit imperative mounting via
   * `mountSlotContainer` or lexical-react's `useLexicalSlotRef`).
   *
   * @experimental named-slots
   */
  $getSlotTargetElement?: (
    node: T,
    slotName: string,
    hostDom: HTMLElement,
    $next: () => HTMLElement | null,
    editor: LexicalEditor,
  ) => HTMLElement | null;
  /**
   * Set via {@link domOverride}'s options argument, not directly. See
   * {@link DOMOverrideOptions.disabledForEditor}.
   */
  disabledForEditor?: (ctx: RenderContextReader) => boolean;
  /**
   * Set via {@link domOverride}'s options argument, not directly. See
   * {@link DOMOverrideOptions.disabledForSession}.
   */
  disabledForSession?: (ctx: RenderContextReader) => boolean;
}

/**
 * @experimental
 *
 * The hook fields of a {@link DOMRenderMatch} — i.e. without `nodes` or the
 * {@link DOMOverrideOptions} predicates, which are passed separately to
 * {@link domOverride}.
 */
export type DOMRenderMatchConfig<T extends LexicalNode> = Omit<
  DOMRenderMatch<T>,
  'nodes' | keyof DOMOverrideOptions
>;
