/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$getPeerDependency, configExtension} from '@lexical/extension';
import {
  $generateNodesFromDOM,
  $generateNodesFromDOMViaExtension,
  contextValue,
  CoreImportExtension,
  ImportSource,
  ImportSourceDataTransfer,
} from '@lexical/html';
import {
  $createTabNode,
  $getEditor,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  type BaseSelection,
  defineExtension,
  type RangeSelection,
  safeCast,
  shallowMergeConfig,
  tokenizeRawText,
} from 'lexical';

import {
  $generateNodesFromSerializedNodes,
  $insertGeneratedNodes,
  type LexicalClipboardData,
} from './clipboard';

/**
 * A middleware function in a per-MIME-type clipboard-import stack. Mirrors
 * the shape of {@link ExportMimeTypeFunction} on the export side.
 *
 * - `data` is the non-empty string returned by `DataTransfer.getData(mime)`
 *   for this MIME type.
 * - `selection` is the current editor selection at the insertion point.
 * - `$next` defers to the next-lower handler in the stack (i.e. the handler
 *   that was registered earlier). Returns `true` if that handler claimed
 *   the data; `false` if no handler accepted it.
 * - `dataTransfer` is the full {@link DataTransfer} the paste/drop came
 *   from, so a handler can inspect companion MIME types or attached
 *   files in addition to the slot it was invoked for (e.g. peek at
 *   `'application/x-vscode-source'` while handling `'text/html'`). When
 *   threading through the new pipeline, pass this into
 *   `$generateNodesFromDOMViaExtension(dom, {
 *     context: [contextValue(ImportSourceDataTransfer, dataTransfer)],
 *   })` so rules and preprocessors can read it via
 *   `ctx.get(ImportSourceDataTransfer)`.
 *
 * The function should return `true` if it consumed the data (the caller
 * stops trying further handlers for this MIME type and does not move on to
 * the next MIME type). Return `$next()` to delegate. Return `false` if the
 * function decided not to handle the data after inspecting it (e.g. the
 * JSON namespace didn't match) so a lower-priority handler — or the next
 * MIME type — gets a chance.
 *
 * @experimental
 */
export type ImportMimeTypeFunction = (
  data: string,
  selection: BaseSelection,
  $next: () => boolean,
  dataTransfer: DataTransfer,
) => boolean;

/**
 * A mapping from MIME type to a stack of {@link ImportMimeTypeFunction}.
 *
 * Each entry is an ordered array; the function at the highest index runs
 * first and may call `next()` to fall through to the function below it.
 * The default config provides one handler each for
 * `'application/x-lexical-editor'`, `'text/html'`, and `'text/plain'` that
 * matches the legacy {@link $insertDataTransferForRichText} behavior.
 *
 * When {@link ClipboardImportExtension} merges a partial config, new
 * functions are appended to the existing array for each MIME type, so
 * later-registered handlers run before earlier ones (including the
 * defaults) and may delegate to them via `next()`.
 *
 * @experimental
 */

export type ImportMimeTypeConfig = {
  [key in keyof LexicalClipboardData | (string & {})]?:
    | ImportMimeTypeFunction[]
    | undefined;
};

/**
 * Per-MIME-type ordering weights. Lower numbers run first.
 *
 * Composable across extensions: each extension contributes weights for
 * its MIME types without needing to coordinate. A partial config that
 * sets `{'application/vnd.myapp+json': 5}` slots its type between the
 * built-in `application/x-lexical-editor` (0) and `text/html` (10) — no
 * need to enumerate the full ordering. mergeConfig spreads pairs (later
 * keys override earlier ones for the same MIME type, so an extension
 * can also re-rank a built-in by repeating its key with a new weight).
 *
 * Iteration: every MIME type that has a handler stack and is present in
 * the dataTransfer (regardless of whether it has an explicit weight) is
 * tried; MIME types with no explicit weight sort to the end, behind all
 * weighted ones, in lexical order.
 *
 * @experimental
 */
export type ImportMimeTypePriority = {
  readonly [key in keyof LexicalClipboardData | (string & {})]?:
    | number
    | undefined;
};

/**
 * Configuration for {@link ClipboardImportExtension}.
 *
 * @experimental
 */
export interface ClipboardImportConfig {
  /**
   * The per-MIME-type deserializer stacks used by
   * {@link $insertDataTransferForRichText} when handling a paste or drop
   * event.
   *
   * Merged with `[...prev, ...override]` per MIME type, matching the
   * behavior of {@link GetClipboardDataExtension.$exportMimeType}.
   *
   * Apps add a stack under a brand-new key to register a brand-new MIME
   * type. Set a {@link priority} weight to control where in the
   * iteration it sits relative to the built-ins.
   */
  $importMimeType: ImportMimeTypeConfig;
  /**
   * See {@link ImportMimeTypePriority}. Spread-merged across configs —
   * extensions contribute weights without coordinating with each other.
   */
  priority: ImportMimeTypePriority;
}

/**
 * Default per-MIME-type weights reproducing the legacy
 * `$insertDataTransferForRichText` ordering:
 *
 * `application/x-lexical-editor` (0) → `text/html` (10) →
 * `text/plain` (20) → `text/uri-list` (30).
 *
 * Gaps between weights let third-party MIME types slot in (e.g. weight
 * 5 to run between lexical and html). Apps can also override built-in
 * weights to demote them.
 *
 * @experimental
 */
export const DEFAULT_IMPORT_MIME_TYPE_PRIORITY: ImportMimeTypePriority = {
  'application/x-lexical-editor': 0,
  'text/html': 10,
  'text/plain': 20,
  'text/uri-list': 30,
};

function trustHTML(html: string): string | TrustedHTML {
  // eslint-disable-next-line no-restricted-syntax
  if (window.trustedTypes && window.trustedTypes.createPolicy) {
    // eslint-disable-next-line no-restricted-syntax
    const policy = window.trustedTypes.createPolicy('lexical', {
      createHTML: input => input,
    });
    return policy.createHTML(html);
  }
  return html;
}

/**
 * Default handler for `'application/x-lexical-editor'`: parse the JSON,
 * verify the namespace, and insert the serialized nodes.
 */
const $defaultLexicalEditorImporter: ImportMimeTypeFunction = (
  data,
  selection,
  $next,
) => {
  try {
    const editor = $getEditor();
    const payload = JSON.parse(data);
    if (
      payload &&
      payload.namespace === editor._config.namespace &&
      Array.isArray(payload.nodes)
    ) {
      const nodes = $generateNodesFromSerializedNodes(payload.nodes);
      $insertGeneratedNodes(editor, nodes, selection);
      return true;
    }
  } catch (error) {
    console.error(error);
  }
  return $next();
};

/**
 * Default handler for `'text/html'`: parse the HTML and run the legacy
 * `$generateNodesFromDOM`. Override (or stack a higher-priority handler
 * on top) to route HTML pastes through {@link DOMImportExtension} or any
 * custom pipeline. See {@link $generateNodesFromDOMViaExtension} for the
 * built-in `DOMImportExtension` adapter.
 */
const $defaultHtmlImporter: ImportMimeTypeFunction = (
  data,
  selection,
  $next,
) => {
  try {
    const editor = $getEditor();
    const parser = new DOMParser();
    const dom = parser.parseFromString(trustHTML(data) as string, 'text/html');
    const nodes = $generateNodesFromDOM(editor, dom);
    $insertGeneratedNodes(editor, nodes, selection);
    return true;
  } catch (error) {
    console.error(error);
    return $next();
  }
};

/**
 * Default handler for `'text/plain'`. On a RangeSelection, drive the
 * insertion off {@link tokenizeRawText} so each `\n` becomes a real
 * paragraph break via `insertParagraph` (preserving current text
 * format / style on the surrounding `insertText` calls). For other
 * selection types, defer to the selection's own `insertRawText`.
 */
const $defaultPlainTextImporter: ImportMimeTypeFunction = (data, selection) => {
  if (!$isRangeSelection(selection)) {
    selection.insertRawText(data);
    return true;
  }
  // Each insertion below reports the caret position that follows it by
  // writing to the editor's selection — a node replacement can even swap
  // the selection object outright (#5954) — so the loop has to re-read
  // $getSelection() between tokens instead of holding a reference that
  // goes stale after the first one. Honoring a caller-supplied selection
  // (#6278) therefore means promoting it to the editor's selection first;
  // otherwise every token lands wherever the editor happens to point.
  // Insertion leaves the selection after the inserted content, which is
  // what the text/html and application/x-lexical-editor handlers already
  // do via $insertGeneratedNodes.
  if (selection !== $getSelection()) {
    $setSelection(selection);
  }
  const withCurrentRange = (fn: (cur: RangeSelection) => void) => {
    const cur = $getSelection();
    if ($isRangeSelection(cur)) {
      fn(cur);
    }
  };
  tokenizeRawText(data, {
    linebreak: () => withCurrentRange(cur => cur.insertParagraph()),
    tab: () => withCurrentRange(cur => cur.insertNodes([$createTabNode()])),
    text: part => withCurrentRange(cur => cur.insertText(part)),
  });
  return true;
};

/**
 * The default per-MIME-type handler stacks reproducing the legacy
 * {@link $insertDataTransferForRichText} behavior exactly. Stacked
 * extensions append on top of these.
 *
 * @experimental
 */
export const DEFAULT_IMPORT_MIME_TYPE: ImportMimeTypeConfig = {
  'application/x-lexical-editor': [$defaultLexicalEditorImporter],
  'text/html': [$defaultHtmlImporter],
  'text/plain': [$defaultPlainTextImporter],
  // `text/uri-list` is a Webkit-only payload that drops behave-like text;
  // reuse the plain-text handler so a URL drop on a rich-text editor
  // inserts as plain text rather than being ignored.
  'text/uri-list': [$defaultPlainTextImporter],
};

/**
 * Output of {@link ClipboardImportExtension}: the merged configuration
 * plus a self-contained {@link $insertDataTransfer} function that owns
 * the entire paste-side iteration over the priority list. Apps look this
 * up via peer-dependency and call it directly; {@link
 * $insertDataTransferForRichText} delegates to it.
 *
 * @experimental
 */
export interface ClipboardImportOutput extends ClipboardImportConfig {
  /**
   * Try every MIME type in `priority` order against the `DataTransfer`,
   * invoking the configured stack for the first one that has a non-empty
   * payload. Returns `true` if any stack claimed the data.
   */
  $insertDataTransfer(
    dataTransfer: DataTransfer,
    selection: BaseSelection,
  ): boolean;
}

function $callImportMimeTypeFunctionStack(
  fns: ImportMimeTypeFunction[] | undefined,
  data: string,
  selection: BaseSelection,
  dataTransfer: DataTransfer,
): boolean {
  if (!fns) {
    return false;
  }
  const callAt = (i: number): boolean =>
    fns[i]
      ? fns[i](data, selection, callAt.bind(null, i - 1), dataTransfer)
      : false;
  return callAt(fns.length - 1);
}

/**
 * Sort the MIME types that have a registered handler stack by their
 * configured priority weight (ascending). Types with no explicit weight
 * sort after all weighted types, in lexical order, so unknown types
 * remain reachable but never preempt a known one.
 */
function orderedMimeTypes(config: ClipboardImportConfig): string[] {
  const mimes = Object.keys(config.$importMimeType).filter(
    k => config.$importMimeType[k] !== undefined,
  );
  return mimes.sort((a, b) => {
    const wa = config.priority[a];
    const wb = config.priority[b];
    if (wa === undefined && wb === undefined) {
      return a < b ? -1 : a > b ? 1 : 0;
    }
    if (wa === undefined) {
      return 1;
    }
    if (wb === undefined) {
      return -1;
    }
    return wa - wb;
  });
}

function $runImport(
  config: ClipboardImportConfig,
  dataTransfer: DataTransfer,
  selection: BaseSelection,
): boolean {
  // Read once for the iOS Safari heuristic that skips text/html when it
  // matches text/plain verbatim (iOS Safari autocorrect produces a
  // text/html payload identical to the plain text).
  const plainString = dataTransfer.getData('text/plain');
  for (const mime of orderedMimeTypes(config)) {
    const data = dataTransfer.getData(mime);
    if (!data) {
      continue;
    }
    if (mime === 'text/html' && data === plainString) {
      continue;
    }
    if (
      $callImportMimeTypeFunctionStack(
        config.$importMimeType[mime],
        data,
        selection,
        dataTransfer,
      )
    ) {
      return true;
    }
  }
  return false;
}

const DEFAULT_OUTPUT: ClipboardImportOutput = {
  $importMimeType: DEFAULT_IMPORT_MIME_TYPE,
  $insertDataTransfer: (dataTransfer, selection) =>
    $runImport(
      {
        $importMimeType: DEFAULT_IMPORT_MIME_TYPE,
        priority: DEFAULT_IMPORT_MIME_TYPE_PRIORITY,
      },
      dataTransfer,
      selection,
    ),
  priority: DEFAULT_IMPORT_MIME_TYPE_PRIORITY,
};

/**
 * @internal
 *
 * Look up the {@link ClipboardImportOutput} on the active editor. Returns
 * a static default-backed output when no {@link ClipboardImportExtension}
 * is configured, so callers can always invoke `output.$insertDataTransfer`
 * regardless of whether the editor opted in.
 */
export function $getImportOutput(): ClipboardImportOutput {
  const dep = $getPeerDependency<typeof ClipboardImportExtension>(
    ClipboardImportExtension.name,
  );
  return dep ? dep.output : DEFAULT_OUTPUT;
}

/**
 * @experimental
 *
 * Mirror of {@link GetClipboardDataExtension} for the import direction.
 * Holds a per-MIME-type stack of {@link ImportMimeTypeFunction}s.
 *
 * @example
 * Route `text/html` pastes through {@link DOMImportExtension}, leaving the
 * defaults for other MIME types untouched:
 * ```ts
 * import {configExtension, defineExtension, $getEditor} from 'lexical';
 * import {
 *   ClipboardImportExtension,
 *   $insertGeneratedNodes,
 * } from '@lexical/clipboard';
 * import {
 *   contextValue,
 *   DOMImportExtension,
 *   ImportSource,
 *   ImportSourceDataTransfer,
 *   $generateNodesFromDOMViaExtension,
 * } from '@lexical/html';
 *
 * defineExtension({
 *   name: 'app',
 *   dependencies: [
 *     DOMImportExtension,
 *     configExtension(ClipboardImportExtension, {
 *       $importMimeType: {
 *         'text/html': [
 *           (html, selection, _$next, dataTransfer) => {
 *             const parser = new DOMParser();
 *             const dom = parser.parseFromString(html, 'text/html');
 *             const nodes = $generateNodesFromDOMViaExtension(dom, {
 *               context: [
 *                 contextValue(ImportSource, 'paste'),
 *                 contextValue(ImportSourceDataTransfer, dataTransfer),
 *               ],
 *             });
 *             $insertGeneratedNodes($getEditor(), nodes, selection);
 *             return true;
 *           },
 *         ],
 *       },
 *     }),
 *   ],
 * });
 * ```
 */
export const ClipboardImportExtension = defineExtension({
  build: (_editor, config): ClipboardImportOutput => ({
    $importMimeType: config.$importMimeType,
    $insertDataTransfer: (dataTransfer, selection) =>
      $runImport(config, dataTransfer, selection),
    priority: config.priority,
  }),
  config: safeCast<ClipboardImportConfig>({
    $importMimeType: DEFAULT_IMPORT_MIME_TYPE,
    priority: DEFAULT_IMPORT_MIME_TYPE_PRIORITY,
  }),
  mergeConfig(config, partial) {
    const merged = shallowMergeConfig(config, partial);
    if (partial.$importMimeType) {
      const $importMimeType: ImportMimeTypeConfig = {...config.$importMimeType};
      for (const [k, v] of Object.entries(partial.$importMimeType)) {
        if (v) {
          const prev = $importMimeType[k];
          $importMimeType[k] = prev ? [...prev, ...v] : v;
        }
      }
      merged.$importMimeType = $importMimeType;
    }
    if (partial.priority) {
      // Spread-merge weights. Per-MIME-type keys in `partial` override
      // any matching key in `config` (so an extension can rerank a
      // built-in MIME type) and new keys are simply added (so multiple
      // extensions can each contribute their own MIME types without
      // having to coordinate).
      merged.priority = {...config.priority, ...partial.priority};
    }
    return merged;
  },
  name: '@lexical/clipboard/Import',
});

/**
 * @experimental
 *
 * Drop-in extension that routes `text/html` clipboard pastes and drops
 * through the {@link DOMImportExtension} pipeline (rules, schemas,
 * preprocessors, overlays) instead of the legacy
 * {@link $generateNodesFromDOM}. Node-providing extensions
 * (`RichTextExtension`, `ListExtension`, `LinkExtension`,
 * `TableExtension`, `CodeExtension`, …) register their own import rules,
 * so adding this extension to an editor built from them is all it takes
 * to activate the pipeline for pastes. {@link CoreImportExtension} (the
 * paragraph/text/inline-format baseline) is a dependency of this
 * extension, so even an editor with no rule-contributing node extensions
 * gets sensible text handling.
 *
 * The original {@link DataTransfer} and `'paste'` source kind are forwarded
 * into the import context so rules and preprocessors can read them via
 * `ctx.get(ImportSourceDataTransfer)` / `ctx.get(ImportSource)`.
 *
 * Equivalent to stacking this `text/html` handler manually via
 * `configExtension(ClipboardImportExtension, {...})`.
 *
 * @example
 * ```ts
 * import {defineExtension} from 'lexical';
 * import {ClipboardDOMImportExtension} from '@lexical/clipboard';
 * import {RichTextExtension} from '@lexical/rich-text';
 *
 * defineExtension({
 *   name: 'app',
 *   dependencies: [
 *     RichTextExtension,
 *     ClipboardDOMImportExtension,
 *   ],
 * });
 * ```
 */
export const ClipboardDOMImportExtension = defineExtension({
  dependencies: [
    CoreImportExtension,
    configExtension(ClipboardImportExtension, {
      $importMimeType: {
        'text/html': [
          (html, selection, _$next, dataTransfer) => {
            const parser = new DOMParser();
            const dom = parser.parseFromString(
              trustHTML(html) as string,
              'text/html',
            );
            const nodes = $generateNodesFromDOMViaExtension(dom, {
              context: [
                contextValue(ImportSource, 'paste'),
                contextValue(ImportSourceDataTransfer, dataTransfer),
              ],
            });
            $insertGeneratedNodes($getEditor(), nodes, selection);
            return true;
          },
        ],
      },
    }),
  ],
  name: '@lexical/clipboard/DOMImport',
});
