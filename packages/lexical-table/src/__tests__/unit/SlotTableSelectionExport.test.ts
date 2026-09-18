/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$generateJSONFromSelectedNodes} from '@lexical/clipboard';
import {buildEditorFromExtensions} from '@lexical/extension';
import {$generateHtmlFromNodes} from '@lexical/html';
import {
  $computeTableMapSkipCellCheck,
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $createTableSelectionFrom,
  TableExtension,
} from '@lexical/table';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $setSelection,
  $setSlot,
  defineExtension,
  ElementNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

// A shadow-root block used as a slot value, mirroring the shape a slot host
// holds in production.
class PlainShadowRootNode extends ElementNode {
  $config() {
    return this.config('plain_shadow_root_table', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
  isShadowRoot(): boolean {
    return true;
  }
}

const CELL_TEXT = 'SlotTableTarget';

function buildEditorWithSlottedTable() {
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [TableExtension],
      name: '[slot-table-selection-export]',
      nodes: [PlainShadowRootNode],
      theme: {tableScrollableWrapper: ''},
    }),
  );
  editor.update(
    () => {
      const table = $createTableNode();
      for (let r = 0; r < 2; r++) {
        const row = $createTableRowNode();
        for (let c = 0; c < 2; c++) {
          row.append(
            $createTableCellNode().append(
              $createParagraphNode().append(
                $createTextNode(`${CELL_TEXT}-${r}${c}`),
              ),
            ),
          );
        }
        table.append(row);
      }
      const host = $createParagraphNode();
      $setSlot(host, 'media', $create(PlainShadowRootNode).append(table));
      $getRoot().append(host);

      const [tableMap] = $computeTableMapSkipCellCheck(table, null, null);
      $setSelection(
        $createTableSelectionFrom(
          table,
          tableMap[0][0].cell,
          tableMap[1][1].cell,
        ),
      );
    },
    {discrete: true},
  );
  return editor;
}

// A TableSelection is neither a RangeSelection nor a NodeSelection, so the
// slot frame redirect has to key off the nodes it reports rather than off a
// selection-type check. Without that, copying cells from a table nested in a
// slot walks the root's children, never reaches the slot subtree, and both
// clipboard channels come out empty.
describe('slot frame redirect for a TableSelection', () => {
  test('text/html export contains the selected cells', () => {
    const editor = buildEditorWithSlottedTable();
    using disposableEditor = editor;

    disposableEditor.read(() => {
      expect(
        $generateHtmlFromNodes(disposableEditor, $getSelection()),
      ).toContain(CELL_TEXT);
    });
  });

  test('application/x-lexical-editor export contains the selected cells', () => {
    const editor = buildEditorWithSlottedTable();
    using disposableEditor = editor;

    disposableEditor.read(() => {
      const {nodes} = $generateJSONFromSelectedNodes(
        disposableEditor,
        $getSelection(),
      );
      expect(JSON.stringify(nodes)).toContain(CELL_TEXT);
    });
  });
});
