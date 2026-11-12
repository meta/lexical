/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $deleteTableColumnAtSelection,
  $deleteTableRowAtSelection,
  $findCellNode,
  $findTableNode,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  $isTableSelection,
} from '@lexical/table';
import {
  $getSelection,
  $isRangeSelection,
  FORMAT_ELEMENT_COMMAND,
  type LexicalEditor,
} from 'lexical';

export const TABLE_ACTIONS = [
  {label: 'Insert row above', value: 'rowAbove'},
  {label: 'Insert row below', value: 'rowBelow'},
  {label: 'Insert column left', value: 'columnLeft'},
  {label: 'Insert column right', value: 'columnRight'},
  {label: 'Delete row', value: 'deleteRow'},
  {label: 'Delete column', value: 'deleteColumn'},
  {label: 'Align left', value: 'left'},
  {label: 'Align center', value: 'center'},
  {label: 'Align right', value: 'right'},
  {label: 'Clear alignment', value: ''},
] as const;

export type TableAction = (typeof TABLE_ACTIONS)[number]['value'];

/**
 * Edits the table the selection is in. Export writes a column with the
 * alignment of the content of its header cell.
 */
export function applyTableAction(
  editor: LexicalEditor,
  action: TableAction,
): void {
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection) && !$isTableSelection(selection)) {
      return;
    }
    const anchorCell = $findCellNode(selection.anchor.getNode());
    const focusCell = $findCellNode(selection.focus.getNode());
    // Only a selection within one table.
    const table = anchorCell && $findTableNode(anchorCell);
    if (!table || !focusCell || !table.is($findTableNode(focusCell))) {
      return;
    }
    switch (action) {
      case 'left':
      case 'center':
      case 'right':
      case '':
        editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, action);
        return;
      case 'rowAbove':
      case 'rowBelow':
        $insertTableRowAtSelection(action === 'rowBelow');
        return;
      case 'columnLeft':
      case 'columnRight':
        $insertTableColumnAtSelection(action === 'columnRight');
        return;
      case 'deleteRow':
        $deleteTableRowAtSelection();
        return;
      case 'deleteColumn':
        $deleteTableColumnAtSelection();
    }
  });
}
