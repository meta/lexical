/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {effect, namedSignals} from '@lexical/extension';
import {CoreImportExtension, DOMImportExtension} from '@lexical/html';
import {
  configExtension,
  defineExtension,
  mergeRegister,
  safeCast,
} from 'lexical';

import {registerCheckList} from './checkList';
import {ListItemNode} from './LexicalListItemNode';
import {ListNode} from './LexicalListNode';
import {ListImportRules} from './ListImportExtension';
import {registerList, registerListStrictIndentTransform} from './registerList';

export interface ListConfig {
  /**
   * When `true`, enforces strict indentation rules for list items, ensuring consistent structure.
   * When `false` (default), indentation is more flexible.
   */
  hasStrictIndent: boolean;
  shouldPreserveNumbering: boolean;
}

/**
 * Configures {@link ListNode}, {@link ListItemNode} and registers
 * the strict indent transform if `hasStrictIndent` is true (default false).
 */
export const ListExtension = defineExtension({
  build(editor, config, state) {
    return namedSignals(config);
  },
  config: safeCast<ListConfig>({
    hasStrictIndent: false,
    shouldPreserveNumbering: false,
  }),
  dependencies: [
    // DOMImportExtension support for the nodes registered here. Inert
    // unless the editor routes HTML through the pipeline (e.g. via
    // ClipboardDOMImportExtension or $generateNodesFromDOMViaExtension).
    CoreImportExtension,
    configExtension(DOMImportExtension, {
      rules: ListImportRules,
    }),
  ],
  name: '@lexical/list/List',
  nodes: () => [ListNode, ListItemNode],
  register(editor, config, state) {
    const stores = state.getOutput();
    return mergeRegister(
      effect(() => {
        return registerList(editor, {
          restoreNumbering: stores.shouldPreserveNumbering.value,
        });
      }),
      effect(() =>
        stores.hasStrictIndent.value
          ? registerListStrictIndentTransform(editor)
          : undefined,
      ),
    );
  },
});

export interface CheckListConfig {
  disableTakeFocusOnClick: boolean;
}

/**
 * Registers checklist functionality for {@link ListNode} and
 * {@link ListItemNode} with a `INSERT_CHECK_LIST_COMMAND` listener and
 * the expected keyboard and mouse interactions for checkboxes.
 */
export const CheckListExtension = defineExtension({
  build: (editor, config) => namedSignals(config),
  config: safeCast<CheckListConfig>({
    disableTakeFocusOnClick: false,
  }),
  dependencies: [ListExtension],
  name: '@lexical/list/CheckList',
  register: (editor, config, state) =>
    registerCheckList(editor, state.getOutput()),
});

/**
 * Bundles {@link ListImportRules} together with the runtime
 * {@link ListExtension}.
 *
 * @experimental
 * @deprecated {@link ListExtension} now registers
 * {@link ListImportRules} (and `CoreImportExtension`) itself — depend on
 * it directly instead.
 */
export const ListImportExtension = defineExtension({
  dependencies: [ListExtension],
  name: '@lexical/list/Import',
});
