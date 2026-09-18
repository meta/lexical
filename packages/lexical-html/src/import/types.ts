/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {DOMImportContextSymbol} from '../constants';
import type {
  AnyContextConfigPairOrUpdater,
  ContextConfig,
  ContextRecord,
} from '../types';
import type {CompiledOverlayRules} from './defineOverlayRules';
import type {LexicalNode} from 'lexical';

/**
 * Phantom-typed branding so consumers cannot construct or mutate a
 * {@link CompiledSelector} directly; the only way to obtain one is via the
 * {@link sel} builder or {@link parseSelector}. The actual runtime shape is
 * an internal implementation detail (see `./sel`).
 *
 * @experimental
 */
export declare const NodeBrand: unique symbol;
/** @experimental */
export declare const CaptureBrand: unique symbol;

/**
 * An opaque, compiled selector used as the `match` field of a
 * {@link DOMImportRule}. The two phantom type parameters carry the matched
 * Node subtype (`N`) and a record of named regex captures (`C`) so the
 * importer body gets correctly-typed `ctx` and `node` arguments without
 * casts.
 *
 * @experimental
 */
export interface CompiledSelector<
  N extends Node = Node,
  C extends Record<string, RegExpMatchArray> = Record<string, RegExpMatchArray>,
> {
  readonly [NodeBrand]?: N;
  readonly [CaptureBrand]?: C;
}

/**
 * The Node subtype matched by a selector (e.g. `HTMLAnchorElement` for
 * `sel.tag('a')`, `Text` for `sel.text()`).
 *
 * @experimental
 */
export type NodeOfSelector<S> =
  S extends CompiledSelector<infer N, Record<string, RegExpMatchArray>>
    ? N
    : Node;

/**
 * The named-capture map for a selector.
 *
 * @experimental
 */
export type CapturesOfSelector<S> =
  S extends CompiledSelector<Node, infer C> ? C : Record<string, never>;

/**
 * Options bag for {@link ElementSelectorBuilder.attr} when the value is a
 * regex. Future options will be added here without breaking existing
 * call-sites.
 *
 * @experimental
 */
export interface AttrMatchOptions<K extends string = string> {
  /**
   * If provided, the {@link RegExpMatchArray} from the successful match is
   * stored on `ctx.captures[capture]` for the importer to consume — saving
   * a second regex execution.
   */
  readonly capture?: K;
}

/**
 * Options bag for {@link ElementSelectorBuilder.styleAny} when the value is a
 * regex. See {@link AttrMatchOptions} for capture semantics.
 *
 * @experimental
 */
export interface StyleMatchOptions<K extends string = string> {
  readonly capture?: K;
}

/**
 * Fluent builder for an element selector. The two type parameters carry the
 * matched element type and the named-capture map; each call refines them.
 *
 * The builder itself implements {@link CompiledSelector} so it can be used
 * directly as the `match` field of a rule — no `.build()` call needed.
 *
 * @experimental
 */
export interface ElementSelectorBuilder<
  E extends HTMLElement,
  C extends Record<string, RegExpMatchArray> = Record<string, never>,
> extends CompiledSelector<E, C> {
  /** Require every listed class to be present on the element. */
  classAll(...classes: readonly string[]): ElementSelectorBuilder<E, C>;
  /** Require at least one of the listed classes to be present. */
  classAny(...classes: readonly string[]): ElementSelectorBuilder<E, C>;
  /** Require the attribute to be present (any value). */
  attr(name: string, value: true): ElementSelectorBuilder<E, C>;
  /** Require the attribute to equal the given string. */
  attr(name: string, value: string): ElementSelectorBuilder<E, C>;
  /**
   * Require the attribute to match the given regex. With
   * `{capture: 'name'}` the match result is exposed on
   * `ctx.captures.name`.
   */
  attr<const O extends AttrMatchOptions>(
    name: string,
    value: RegExp,
    options?: O,
  ): ElementSelectorBuilder<
    E,
    O extends {capture: infer K} ? C & Record<K & string, RegExpMatchArray> : C
  >;
  /** Require the inline-style declaration to equal `value`. */
  styleAny(prop: string, value: string): ElementSelectorBuilder<E, C>;
  /** Require the inline-style declaration to match `value`. */
  styleAny<const O extends StyleMatchOptions>(
    prop: string,
    value: RegExp,
    options?: O,
  ): ElementSelectorBuilder<
    E,
    O extends {capture: infer K} ? C & Record<K & string, RegExpMatchArray> : C
  >;
}

/**
 * Argument to {@link DOMImportContext.branch} / `$importChildren({context})`
 * — see {@link ContextConfigPair} / {@link ContextConfigUpdater}.
 *
 * @experimental
 */
export type ImportContextPairOrUpdater = AnyContextConfigPairOrUpdater<
  typeof DOMImportContextSymbol
>;

/**
 * A typed context-state key for the import pipeline. Create with
 * {@link createImportState}.
 *
 * @experimental
 */
export type ImportStateConfig<V> = ContextConfig<
  typeof DOMImportContextSymbol,
  V
>;

/**
 * A mutable, document-order-shared store for the import pipeline. Lets a
 * rule visited early in the document write information that rules visited
 * later can read — e.g. parse `<style>` or `<meta>` and influence
 * subsequent matching.
 *
 * Implemented as the root-layer {@link ContextRecord} of the import walk:
 * `ctx.session.set(cfg, v)` mutates the slot on that root record, and
 * every unshadowed `ctx.get(cfg)` read in any branch picks it up. A
 * `$importChildren({context: [...]})` branch that explicitly writes the
 * same slot shadows the session value for the duration of that branch.
 *
 * @experimental
 */
export interface ImportSession {
  /** Read the current value, returning the config's default if unset. */
  get<V>(cfg: ImportStateConfig<V>): V;
  /** Write `value` into the slot. */
  set<V>(cfg: ImportStateConfig<V>, value: V): void;
  /** Read-modify-write. */
  update<V>(cfg: ImportStateConfig<V>, updater: (prev: V) => V): void;
  /** Returns `true` if the slot has been written since session creation. */
  has<V>(cfg: ImportStateConfig<V>): boolean;
}

/**
 * Context exposed to a rule's `$import` function. Mirrors the existing render
 * context (see {@link RenderContext}) but is import-scoped.
 *
 * @experimental
 */
export interface DOMImportContext<
  C extends Record<string, RegExpMatchArray> = Record<string, never>,
> {
  /** Captures from this rule's selector. Fresh per rule invocation. */
  readonly captures: Readonly<C>;
  /**
   * Mutable, document-order-shared store. Use to make information from
   * earlier-visited nodes available to later-visited ones (e.g. a
   * `<style>` or `<meta>` at the top of the document influencing how
   * later elements are interpreted). One {@link ImportSession} instance
   * is created per top-level `$generateNodesFromDOM` call and is shared
   * across all recursive `$importChildren` / `$importOne` invocations.
   */
  readonly session: ImportSession;

  /** Read a typed context value. */
  get<V>(cfg: ImportStateConfig<V>): V;

  /**
   * Recursively import every child of `parent` and return the produced
   * lexical nodes, optionally enforcing a {@link ChildSchema} and/or
   * branching the import context for the duration of the call (via
   * `opts.context`).
   */
  $importChildren(parent: ParentNode, opts?: ImportChildrenOpts): LexicalNode[];

  /**
   * Recursively import a single DOM node.
   */
  $importOne(node: Node, opts?: ImportNodeOpts): LexicalNode[];
}

/**
 * Options accepted by {@link DOMImportContext.$importChildren}. The combination
 * of `schema`, `$onChild`, and `$after` is sufficient to express every
 * child-handling pattern in the legacy `forChild` / `after` / wrap-continuous
 * machinery.
 *
 * @experimental
 */
export interface ImportChildrenOpts {
  /**
   * How to validate and (re)package produced children. Defaults to whichever
   * schema the parent's importer passed; the top-level entry uses
   * {@link BlockSchema}.
   */
  readonly schema?: ChildSchema;
  /**
   * Called for each produced lexical child immediately after its rule
   * returned, with the chance to substitute or drop it. Equivalent to the
   * old `forChild` hook but scoped to one `$importChildren` call.
   */
  readonly $onChild?: (child: LexicalNode) => LexicalNode | null | undefined;
  /**
   * Called once with the full child array after all DOM children have been
   * recursively imported but before {@link ChildSchema.$packageRun} is
   * applied. Equivalent to the old `after` hook.
   */
  readonly $after?: (children: LexicalNode[]) => LexicalNode[];
  /** Context overrides scoped to the children traversal. */
  readonly context?: readonly ImportContextPairOrUpdater[];
  /**
   * Additional {@link DOMImportRule}s active only for this children
   * traversal (and any nested `$importChildren` calls that don't push
   * their own overlay). Overlays form a stack: the most recently pushed
   * one is checked first, then the ones below it, then the main
   * dispatcher — so an overlay's rules take precedence over everything
   * in {@link DOMImportConfig.rules}. Within one overlay, rules are
   * tried in their own list order. Calling `$next()` from an overlay
   * rule falls through to the next overlay-or-main rule.
   *
   * Use this to scope cost-bearing rules to where they apply. For
   * example, a GitHub code-table rule installs an overlay that
   * unwraps `<tr>` / `<td>` inside the table, without paying that
   * predicate cost on every other `<tr>` / `<td>` paste.
   *
   * The value must be produced by
   * {@link defineOverlayRules}; this forces the dispatcher to be
   * compiled once at module scope and reused across
   * `$importChildren` calls, instead of being recompiled per invocation.
   */
  readonly rules?: CompiledOverlayRules;
}

/** @experimental */
export interface ImportNodeOpts {
  readonly context?: readonly ImportContextPairOrUpdater[];
}

/**
 * A {@link ChildSchema} encodes which lexical nodes a parent accepts as
 * children and how to package or reject the rest. The legacy
 * `wrapContinuousInlines` / `ArtificialNode__DO_NOT_USE` logic is the
 * `BlockSchema` and `NestedBlockSchema` cases of this primitive.
 *
 * A schema only controls how the *children* are assembled before being
 * appended to the parent the calling rule already chose. It cannot
 * change the parent itself. Cases where the parent's shape needs to
 * change in response to its children — e.g. an inline `<a>` that
 * encloses a block `<h1>`, which must be lifted so the heading takes
 * the link's place and the link is redistributed onto the heading's
 * inline contents — belong in the rule body, not the schema. See the
 * "Lifting blocks out of an inline parent" section of the docs.
 *
 * @experimental
 */
export interface ChildSchema {
  /** Optional name for debug output. */
  readonly name?: string;
  /**
   * Returns `true` if `child` is a valid child of `parent` in this position.
   */
  $accepts(child: LexicalNode, parent: LexicalNode | null): boolean;
  /**
   * Package a maximal run of non-accepted siblings into zero or more
   * accepted nodes. The returned nodes replace the rejected run at the
   * same position in the child list and are not re-checked against
   * `$accepts` — the caller is trusted to return valid children. If
   * omitted, or if it returns an empty array, {@link ChildSchema.onReject}
   * is consulted instead.
   */
  $packageRun?(
    rejected: LexicalNode[],
    parent: LexicalNode | null,
    domParent: Node | null,
  ): LexicalNode[];
  /**
   * Fallback strategy for a run of non-accepted children when
   * `$packageRun` is missing or returns an empty array:
   *
   * - `'drop'` (default) — silently discards the run. Use when the
   *   schema is strict and rejected content is meaningless in this
   *   position (e.g. text between table rows).
   * - `'hoist'` — emits the rejected nodes unchanged at the same
   *   position in the assembled child list. The caller's parent then
   *   receives them as-is, which is only useful if the calling rule
   *   intends to surface mixed content to *its* parent (a less common
   *   pattern; usually `$packageRun` should re-shape the run first).
   *
   * `'hoist'` does NOT lift the run all the way up out of the calling
   * rule's parent — that requires the rule itself to detect the
   * situation and emit a different parent structure (see the
   * "Lifting blocks out of an inline parent" section).
   */
  readonly onReject?: 'hoist' | 'drop';
  /**
   * Final pass over the assembled child list (after `$packageRun`). Returns
   * the children to actually attach. Use to enforce structural invariants
   * (e.g. drop empty runs, pad short table rows).
   */
  $finalize?(
    children: LexicalNode[],
    parent: LexicalNode | null,
  ): LexicalNode[];
}

/**
 * The middleware signature of an import rule. Call `$next()` to delegate to
 * the next-matching rule for this node (returning its result, which may then
 * be inspected or wrapped); return `[]` to drop the node.
 *
 * "Next" means the next rule in `DOMImportConfig.rules` order — rules are
 * tried front to back, there is no numeric priority. Since each
 * extension's contribution is prepended to its dependencies'
 * contributions, `$next()` from a rule typically lands on the equivalent
 * rule from a lower-level package, and finally on
 * `DefaultHoistRule`. See {@link DOMImportConfig.rules}.
 *
 * @experimental
 */
export type DOMImportFn<
  E extends Node,
  C extends Record<string, RegExpMatchArray> = Record<string, never>,
> = (
  ctx: DOMImportContext<C>,
  node: E,
  $next: () => readonly LexicalNode[],
) => readonly LexicalNode[];

/**
 * An importer for a DOM node, dispatched by `match` and implemented by
 * `$import`.
 *
 * @experimental
 */
export interface DOMImportRule<S extends CompiledSelector = CompiledSelector> {
  /**
   * Optional identifier surfaced in dev-mode logs, error messages, and
   * introspection devtools. Convention: `'@scope/package/rule-id'` for
   * library rules.
   */
  readonly name?: string;
  /** A {@link CompiledSelector} produced by the {@link sel} builder. */
  readonly match: S;
  /** Middleware that converts the matched DOM node into lexical nodes. */
  readonly $import: DOMImportFn<NodeOfSelector<S>, CapturesOfSelector<S>>;
}

/** @experimental */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDOMImportRule = DOMImportRule<any>;

/**
 * Context exposed to a {@link DOMPreprocessFn}. Lets the preprocessor:
 *
 * - Write to the per-import {@link ImportSession} (the same
 *   `ctx.session` rules see during the walk). Writes mutate the
 *   root-layer context record, so they are visible to every scoped
 *   `ctx.get(cfg)` read that hasn't been shadowed by a branch.
 *
 * @experimental
 */
export interface DOMPreprocessContext {
  /**
   * Document-order-shared store, same instance as `ctx.session` in
   * rules. Use to pass info from the DOM preprocess phase (e.g.
   * inspected `<meta>` tags, collected `<style>` text) to the
   * importer rules.
   */
  readonly session: ImportSession;
}

/**
 * A middleware step in the DOM-preprocess chain. Runs before walking
 * begins and may:
 *
 * - Mutate the input DOM in place (e.g. inline stylesheets, strip
 *   unsafe elements, normalize attributes).
 * - Write to {@link DOMPreprocessContext.session} for rules to read
 *   (and for unshadowed scoped reads to pick up).
 * - Call `$next()` to defer to the next-lower preprocessor in the
 *   stack; omit the call to short-circuit and skip the rest.
 *
 * The preprocess phase runs inside the same editor read / update
 * context as the walk that follows, so a preprocess function may call
 * `$`-prefixed Lexical APIs (e.g. `$getState`, `$getRoot`) as needed.
 * The `$next` parameter is named with a `$` prefix to make that
 * editor-context expectation visible to readers and lints.
 *
 * Append-style merge applies: an extension's preprocessors are appended
 * to the existing stack and the stack is run from its END, so the last
 * entry runs first and may delegate to the entries below it via
 * `$next()`. Because configs merge in dependency order, that means an
 * extension's preprocessors wrap those of its dependencies, and the
 * built-in `$inlineStylesFromStyleSheets` runs last. Same convention as
 * {@link ExportMimeTypeFunction} on the export side.
 *
 * @experimental
 */
export type DOMPreprocessFn = (
  dom: Document | ParentNode,
  ctx: DOMPreprocessContext,
  $next: () => void,
) => void;

/**
 * Per-call options to the extension's `$generateNodesFromDOM`.
 *
 * @experimental
 */
export interface GenerateNodesFromDOMOptions {
  /**
   * Context pairs/updaters applied for the duration of this import only —
   * use to communicate per-call info such as the {@link ImportSource}.
   */
  readonly context?: readonly ImportContextPairOrUpdater[];
  /**
   * Additional preprocessors to run on this call only, appended to the
   * extension's configured {@link DOMImportConfig.preprocess}. The stack
   * is run from its end, so per-call preprocessors run BEFORE the
   * configured ones and can wrap them via `$next()`; the last entry of
   * this array is the very first function to run.
   */
  readonly preprocess?: readonly DOMPreprocessFn[];
}

/**
 * Output of {@link DOMImportExtension}.
 *
 * @experimental
 */
export interface DOMImportExtensionOutput {
  /**
   * Convert a {@link Document} or {@link ParentNode} into lexical nodes,
   * using the dispatcher compiled from this extension's configured
   * {@link DOMImportRule}s.
   *
   * Must be called within an `editor.update()` or `editor.read()` because
   * the importers may invoke `$create...` helpers.
   */
  $generateNodesFromDOM(
    dom: Document | ParentNode,
    options?: GenerateNodesFromDOMOptions,
  ): LexicalNode[];
  /** @internal */
  readonly defaults: undefined | ContextRecord<typeof DOMImportContextSymbol>;
}
