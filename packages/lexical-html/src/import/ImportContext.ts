/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {ContextRecord} from '../types';
import type {CompiledOverlayRules} from './defineOverlayRules';
import type {DOMImportExtension} from './DOMImportExtension';
import type {
  ImportContextPairOrUpdater,
  ImportSession,
  ImportStateConfig,
} from './types';

import {getPeerDependencyFromEditor} from '@lexical/extension';
import {
  $getEditor,
  isBlockDomNode,
  isDOMTextNode,
  isHTMLElement,
  isInlineDomNode,
  type LexicalEditor,
} from 'lexical';

import {DOMImportContextSymbol, DOMImportExtensionName} from '../constants';
import {
  $withContext,
  createContextState,
  getContextRecord,
  getContextValue,
} from '../ContextRecord';

type ImportContextRecord = ContextRecord<typeof DOMImportContextSymbol>;

/**
 * Create an import context state. The phantom symbol prevents accidental
 * use of a render-context state in an import context (and vice versa).
 *
 * Note: to support the value-or-updater pattern, `V` cannot be a function
 * type; wrap it in an array or object if needed.
 *
 * `getDefaultValue` is called **once at state creation** and the result is
 * shared between every session that reads the state without first writing
 * a value. Defaults must therefore be immutable (primitives, frozen
 * objects, or read-only arrays / records). If your state needs mutable
 * per-session storage, lazily initialize it inside your rule (e.g.
 * `if (!ctx.session.has(cfg)) ctx.session.set(cfg, new …())`).
 *
 * @experimental
 * @__NO_SIDE_EFFECTS__
 */
export function createImportState<V>(
  name: string,
  getDefaultValue: () => V,
  isEqual?: (a: V, b: V) => boolean,
): ImportStateConfig<V> {
  return createContextState(
    DOMImportContextSymbol,
    name,
    getDefaultValue,
    isEqual,
  );
}

/**
 * The kind of operation that produced this import. Lets rules adapt
 * their behavior (e.g. preserve more whitespace on `'paste'`).
 * Defaults to `'unknown'`. Apps that need a different vocabulary can
 * define their own {@link ImportStateConfig} with whatever value type
 * they want.
 *
 * @experimental
 */
export type ImportSourceKind = 'paste' | 'unknown';

/**
 * Built-in import-context state identifying how this import was initiated.
 * Callers of `$generateNodesFromDOM` should set it via the `context` option.
 *
 * @experimental
 */
export const ImportSource: ImportStateConfig<ImportSourceKind> =
  createImportState<ImportSourceKind>('importSource', () => 'unknown');

/**
 * Built-in import-context state holding the {@link DataTransfer} the
 * import was sourced from, if any. `null` outside paste/drop flows.
 *
 * The clipboard import pipeline passes the original `DataTransfer`
 * through to its per-MIME-type handler stack (see
 * {@link ImportMimeTypeFunction}); handlers that route HTML through
 * the {@link DOMImportExtension} pipeline should forward it into the
 * walk via `context: [contextValue(ImportSourceDataTransfer,
 * dataTransfer)]` so rules and preprocessors can call
 * `ctx.get(ImportSourceDataTransfer)` to inspect companion MIME types
 * (e.g. an `'application/rtf'` alternative or an attached
 * `'application/x-officedrawing'` payload), the file list, or any
 * custom drag-and-drop slot.
 *
 * Use sparingly: the safer pattern is to decide *which* MIME-type
 * payload to walk in the clipboard handler stack and hand a finalized
 * DOM to the rules; only fall back to peeking at `ImportSourceDataTransfer`
 * when the source-detection signal genuinely lives in a companion
 * slot.
 *
 * @experimental
 */
export const ImportSourceDataTransfer: ImportStateConfig<DataTransfer | null> =
  createImportState<DataTransfer | null>(
    'importSourceDataTransfer',
    () => null,
  );

/**
 * Built-in import-context state holding the bit-packed
 * {@link TextFormatType} formats that should apply to {@link TextNode}s
 * produced during the current subtree. Used by inline-format wrappers
 * (`<b>`, `<i>`, `<u>`, …) to propagate formatting through the context
 * record instead of via the legacy `forChild` chain.
 *
 * @experimental
 */
export const ImportTextFormat: ImportStateConfig<number> = createImportState(
  'textFormat',
  () => 0,
);

/**
 * Built-in import-context state holding a parsed CSS-style record
 * (the {@link getStyleObjectFromCSS} shape) that should apply to
 * {@link TextNode}s produced during the current subtree. Mirrors the
 * format-bit propagation in {@link ImportTextFormat} for properties
 * that don't fit into the format bit mask — `color`, `font-family`,
 * `font-size`, etc.
 *
 * Ancestor rules that contribute a style branch the context with a
 * merged record; the core `#text` rule materializes the non-empty
 * record to a CSS string and calls `setStyle` on the new TextNode.
 * Once TextNode adopts a parsed style record, the materialization
 * step will go away.
 *
 * @experimental
 */
export const ImportTextStyle: ImportStateConfig<
  Readonly<Record<string, string>>
> = createImportState<Readonly<Record<string, string>>>(
  'textStyle',
  () => ({}),
);

/**
 * Determines whether a given DOM element should be treated as preserving
 * whitespace (i.e. text content under it is not collapsed and is split on
 * `\n` / `\t` into `LineBreakNode` / `TabNode`). The default matches the
 * legacy behavior: the element itself is `<pre>` or its inline
 * `white-space` style begins with `'pre'`.
 *
 * @experimental
 */
export type IsPreserveWhitespaceDom = (node: Node) => boolean;

/**
 * Determines whether a given DOM node sits on the same visual line as its
 * adjacent text siblings, governing whether leading/trailing whitespace in
 * a `#text` is collapsed against neighbors. The default consults
 * {@link isInlineDomNode} from `lexical` (style.display or a fixed inline
 * tag-name set) and additionally treats elements with an explicit
 * non-inline `display` style as block.
 *
 * @experimental
 */
export type IsInlineForWhitespace = (node: Node) => boolean;

/**
 * Configuration for the core text whitespace-collapse logic. Override via
 * {@link ImportWhitespaceConfig} either as a `contextDefaults` entry on
 * the {@link DOMImportExtension} or per-call on `$generateNodesFromDOM`'s
 * `context` option.
 *
 * @experimental
 */
export interface WhitespaceImportConfig {
  /** See {@link IsPreserveWhitespaceDom}. */
  readonly preservesWhitespace: IsPreserveWhitespaceDom;
  /** See {@link IsInlineForWhitespace}. */
  readonly isInline: IsInlineForWhitespace;
}

/**
 * Default {@link WhitespaceImportConfig.preservesWhitespace}: matches
 * `<pre>` and any element with `white-space: pre*`.
 *
 * @experimental
 */
export function defaultPreservesWhitespace(node: Node): boolean {
  if (!isHTMLElement(node)) {
    return false;
  }
  if (node.nodeName === 'PRE') {
    return true;
  }
  const ws = node.style.whiteSpace;
  return typeof ws === 'string' && ws.startsWith('pre');
}

/**
 * Default {@link WhitespaceImportConfig.isInline}: treats an element as
 * inline iff its inline `display` style is `inline*` OR (no explicit
 * non-inline display) its nodeName is a known inline tag (`isInlineDomNode`).
 * Text nodes are always inline; comments and other non-elements are not.
 *
 * @experimental
 */
export function defaultIsInline(node: Node): boolean {
  if (isDOMTextNode(node)) {
    return true;
  }
  if (!isHTMLElement(node)) {
    return false;
  }
  const display = node.style.display;
  if (display) {
    return display.startsWith('inline');
  }
  if (isBlockDomNode(node)) {
    return false;
  }
  return isInlineDomNode(node);
}

/**
 * Built-in import-context state controlling text-node whitespace handling
 * (collapse vs. preserve, what counts as an inline sibling). Override per
 * editor via {@link DOMImportConfig.contextDefaults} or per call via
 * {@link GenerateNodesFromDOMOptions.context}.
 *
 * @experimental
 */
export const ImportWhitespaceConfig: ImportStateConfig<WhitespaceImportConfig> =
  createImportState<WhitespaceImportConfig>('whitespaceConfig', () => ({
    isInline: defaultIsInline,
    preservesWhitespace: defaultPreservesWhitespace,
  }));

/**
 * Built-in session slot for runtime overlay rules that should be in
 * effect for the entire walk. A preprocessor writes here when it wants
 * to conditionally install handling for a particular paste source
 * (e.g. "if the Microsoft Word generator meta tag is present, push the
 * Word-paste overlay"). Each entry contributes an overlay dispatcher
 * to the runtime's overlay stack; later array entries are higher
 * priority. Use `ctx.session.update(ImportOverlays, prev => […])` to
 * append.
 *
 * This is the walk-wide counterpart to
 * `$importChildren({rules: …})` (which scopes an overlay to one
 * subtree): write to {@link ImportOverlays} when the overlay should
 * apply for the whole document; use `$importChildren`'s `rules` when
 * the overlay should only apply for a deeper region.
 *
 * @experimental
 */
export const ImportOverlays: ImportStateConfig<
  readonly CompiledOverlayRules[]
> = createImportState<readonly CompiledOverlayRules[]>(
  'importOverlays',
  () => [],
);

/**
 * The session IS the root-layer {@link ContextRecord} of the walk. Reads
 * fall through the prototype chain to the editor's `contextDefaults`,
 * writes mutate the record's own properties, and any branch pushed by
 * `$importChildren({context})` sits above this layer and can shadow
 * (but does not overwrite) slots.
 *
 * @internal
 */
export class ImportSessionImpl implements ImportSession {
  constructor(readonly record: ImportContextRecord) {}
  get<V>(cfg: ImportStateConfig<V>): V {
    return getContextValue(this.record, cfg);
  }
  set<V>(cfg: ImportStateConfig<V>, value: V): void {
    this.record[cfg.key] = value;
  }
  update<V>(cfg: ImportStateConfig<V>, updater: (prev: V) => V): void {
    this.record[cfg.key] = updater(getContextValue(this.record, cfg));
  }
  has<V>(cfg: ImportStateConfig<V>): boolean {
    return Object.prototype.hasOwnProperty.call(this.record, cfg.key);
  }
}

function getDefaultImportContext(
  editor: LexicalEditor,
): undefined | ContextRecord<typeof DOMImportContextSymbol> {
  const dep = getPeerDependencyFromEditor<typeof DOMImportExtension>(
    editor,
    DOMImportExtensionName,
  );
  return dep ? dep.output.defaults : undefined;
}

function getImportContext(
  editor: LexicalEditor,
): undefined | ContextRecord<typeof DOMImportContextSymbol> {
  return (
    getContextRecord(DOMImportContextSymbol, editor) ||
    getDefaultImportContext(editor)
  );
}

/**
 * Read an import context value during an import operation.
 * @experimental
 */
export function $getImportContextValue<V>(
  cfg: ImportStateConfig<V>,
  editor: LexicalEditor = $getEditor(),
): V {
  return getContextValue(getImportContext(editor), cfg);
}

/**
 * Run `f` with the given context pairs applied on top of the editor's
 * current import context.
 *
 * @experimental
 */
export const $withImportContext: (
  cfg: readonly ImportContextPairOrUpdater[],
  editor?: LexicalEditor,
) => <T>(f: () => T) => T = $withContext(
  DOMImportContextSymbol,
  getDefaultImportContext,
);
