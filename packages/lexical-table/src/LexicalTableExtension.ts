/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditor} from 'lexical';

import {effect, namedSignals} from '@lexical/extension';
import {CoreImportExtension, DOMImportExtension} from '@lexical/html';
import {
  $fullReconcile,
  configExtension,
  defineExtension,
  isHTMLElement,
  mergeRegister,
  safeCast,
} from 'lexical';

import {TableCellNode} from './LexicalTableCellNode';
import {
  $isScrollableTablesActive,
  attachStickyScrollbarListeners,
  findStickyScrollbarElements,
  setScrollableTablesActive,
  type StickyScrollbarElements,
  syncStickyScrollbar,
  TableNode,
} from './LexicalTableNode';
import {
  registerTableCellUnmergeTransform,
  registerTablePlugin,
  registerTableSelectionObserver,
} from './LexicalTablePluginHelpers';
import {TableRowNode} from './LexicalTableRowNode';
import {TableImportRules} from './TableImportExtension';

export interface TableConfig {
  /**
   * When `false` (default `true`), merged cell support (colspan and rowspan) will be disabled and all
   * tables will be forced into a regular grid with 1x1 table cells.
   */
  hasCellMerge: boolean;
  /**
   * When `false` (default `true`), the background color of TableCellNode will always be removed.
   */
  hasCellBackgroundColor: boolean;
  /**
   * When `true` (default `true`), the tab key can be used to navigate table cells.
   */
  hasTabHandler: boolean;
  /**
   * When `true` (default `true`), tables will be wrapped in a `<div>` to enable horizontal scrolling
   */
  hasHorizontalScroll: boolean;
  /**
   * When `true` (default `false`), a sticky scrollbar is rendered below each table that overflows horizontally.
   * Requires `hasHorizontalScroll` to be `true`. The native scrollbar is hidden via inline
   * `scrollbar-width: none` (Firefox/Chromium). Themed consumers providing a `tableScrollableWrapper`
   * class should also add `::-webkit-scrollbar { display: none }` for Safari/WebKit.
   * A themed scrollbar is expected to guarantee its own visible height (the
   * playground does this with `::-webkit-scrollbar { height: ... }`); the
   * unthemed fallback depends on classic native scrollbars, so on platforms
   * where those render with no thickness (overlay scrollbars, and non-layout
   * environments like jsdom) it is disabled at runtime and the wrapper's
   * native scrollbar is restored.
   */
  hasStickyScrollbar: boolean;
  /**
   * When `true` (default `false`), nested tables will be allowed.
   *
   * @experimental Nested tables are not officially supported.
   */
  hasNestedTables: boolean;
}

function registerStickyScrollbar(editor: LexicalEditor) {
  const attached = new Map<
    string,
    {cleanup: () => void; parts: StickyScrollbarElements}
  >();
  const detachAll = () => {
    for (const {cleanup} of attached.values()) {
      cleanup();
    }
    attached.clear();
  };
  return mergeRegister(
    detachAll,
    editor.registerMutationListener(
      TableNode,
      nodeMutations => {
        for (const [nodeKey, mutation] of nodeMutations) {
          const prev = attached.get(nodeKey);
          if (mutation === 'destroyed') {
            if (prev) {
              prev.cleanup();
              attached.delete(nodeKey);
            }
            continue;
          }
          const dom = editor.getElementByKey(nodeKey);
          const parts =
            dom && isHTMLElement(dom) ? findStickyScrollbarElements(dom) : null;
          if (
            prev &&
            parts &&
            prev.parts.scrollable === parts.scrollable &&
            prev.parts.scrollbar === parts.scrollbar &&
            prev.parts.tableElement === parts.tableElement
          ) {
            // Same DOM: keep the listeners, but resync since the
            // update may still change scrollability (e.g. a frozen
            // rows toggle switches the wrapper to overflow-x: clip).
            syncStickyScrollbar(parts.scrollable, parts.scrollbar);
            continue;
          }
          if (prev) {
            prev.cleanup();
            attached.delete(nodeKey);
          }
          if (parts) {
            attached.set(nodeKey, {
              cleanup: attachStickyScrollbarListeners(parts),
              parts,
            });
          }
        }
      },
      {skipInitialization: false},
    ),
  );
}

/**
 * Configures {@link TableNode}, {@link TableRowNode}, {@link TableCellNode} and
 * registers table behaviors (see {@link TableConfig})
 */
export const TableExtension = defineExtension({
  build(editor, config, state) {
    return namedSignals(config);
  },
  config: safeCast<TableConfig>({
    hasCellBackgroundColor: true,
    hasCellMerge: true,
    hasHorizontalScroll: true,
    hasNestedTables: false,
    hasStickyScrollbar: false,
    hasTabHandler: true,
  }),
  dependencies: [
    // DOMImportExtension support for the nodes registered here. Inert
    // unless the editor routes HTML through the pipeline (e.g. via
    // ClipboardDOMImportExtension or $generateNodesFromDOMViaExtension).
    CoreImportExtension,
    configExtension(DOMImportExtension, {
      rules: TableImportRules,
    }),
  ],
  name: '@lexical/table/Table',
  nodes: () => [TableNode, TableRowNode, TableCellNode],
  register(editor, config, state) {
    const stores = state.getOutput();
    let prevStickyScrollbar = false;
    return mergeRegister(
      effect(() => {
        const hasHorizontalScroll = stores.hasHorizontalScroll.value;
        const hasStickyScrollbar =
          stores.hasStickyScrollbar.value && hasHorizontalScroll;
        const hadHorizontalScroll = $isScrollableTablesActive(editor);
        if (hadHorizontalScroll !== hasHorizontalScroll) {
          setScrollableTablesActive(editor, hasHorizontalScroll);
        }
        if (
          hadHorizontalScroll !== hasHorizontalScroll ||
          prevStickyScrollbar !== hasStickyScrollbar
        ) {
          // Re-render existing tables through the new scroll-wrapper config
          // without cloning every TableNode the way marking them dirty would. A
          // full reconcile marks no nodes dirty, so it's deferred (no
          // synchronous render from this effect) and produces no history entry.
          editor.update($fullReconcile);
        }
        prevStickyScrollbar = hasStickyScrollbar;
      }),
      registerTablePlugin(editor, stores),
      effect(() =>
        registerTableSelectionObserver(editor, stores.hasTabHandler.value),
      ),
      effect(() => {
        if (
          stores.hasStickyScrollbar.value &&
          stores.hasHorizontalScroll.value
        ) {
          return editor.registerRootListener(rootElement => {
            if (rootElement) {
              return registerStickyScrollbar(editor);
            }
          });
        }
      }),
      effect(() =>
        stores.hasCellMerge.value
          ? undefined
          : registerTableCellUnmergeTransform(editor),
      ),
      effect(() =>
        stores.hasCellBackgroundColor.value
          ? undefined
          : editor.registerNodeTransform(TableCellNode, node => {
              if (node.getBackgroundColor() !== null) {
                node.setBackgroundColor(null);
              }
            }),
      ),
    );
  },
});

/**
 * Bundles {@link TableImportRules} together with the runtime
 * {@link TableExtension}.
 *
 * @experimental
 * @deprecated {@link TableExtension} now registers
 * {@link TableImportRules} (and `CoreImportExtension`) itself — depend on
 * it directly instead.
 */
export const TableImportExtension = defineExtension({
  dependencies: [TableExtension],
  name: '@lexical/table/Import',
});
