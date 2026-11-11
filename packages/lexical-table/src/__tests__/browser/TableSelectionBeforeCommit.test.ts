/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNodeWithDimensions,
  $createTableRowNode,
  $createTableSelectionFrom,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  $isTableSelection,
  getTableObserverFromTableElement,
  TableExtension,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_LOW,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import {assert, expect, onTestFinished, test, vi} from 'vitest';
import {userEvent} from 'vitest/browser';

function mount() {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  const editor = buildEditorFromExtensions({
    dependencies: [RichTextExtension, TableExtension],
    name: 'test/table-before-commit',
    theme: {tableCellSelected: 'selected-cell', tableScrollableWrapper: ''},
  });
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
  });
  return {editor, root};
}

function mountTable() {
  const fixture = mount();
  fixture.editor.update(
    () => {
      const table = $createTableNodeWithDimensions(2, 2);
      table.setColWidths([92, 92]);
      $getRoot()
        .clear()
        .append($createParagraphNode(), table, $createParagraphNode());
      table.selectStart();
    },
    {discrete: true},
  );
  window.focus();
  fixture.root.focus();
  return fixture;
}

test('a DOM caret on a col element resolves into the first cell', async () => {
  const {root} = mountTable();
  await userEvent.keyboard('{Tab}{Tab}{Tab}last');
  const cells = root.querySelectorAll('th, td');
  expect(cells[3].textContent).toBe('last');
  const col = root.querySelector('table > colgroup > col');
  assert(col !== null);
  window.getSelection()!.setBaseAndExtent(col, 0, col, 0);
  await expect
    .poll(() => window.getSelection()?.anchorNode?.nodeName ?? null)
    .not.toMatch(/^COL(GROUP)?$/);
  await userEvent.keyboard('X');
  expect(cells[0].textContent).toBe('X');
  expect(cells[3].textContent).toBe('last');
});

test('converts TableSelection to RangeSelection when DOM focus extends onto the editor root (#8584)', async () => {
  const {editor, root} = mountTable();
  editor.update(
    () => {
      const table = $getRoot().getChildAtIndex(1);
      assert($isTableNode(table));
      const rows = table.getChildren();
      assert(rows.every($isTableRowNode));
      const cells = rows.flatMap(row => row.getChildren());
      const first = cells[0];
      const last = cells[3];
      assert($isTableCellNode(first) && $isTableCellNode(last));
      $setSelection($createTableSelectionFrom(table, first, last));
    },
    {discrete: true},
  );
  expect(editor.read(() => $isTableSelection($getSelection()))).toBe(true);
  const firstCell = root.querySelector('th, td')!;
  window
    .getSelection()!
    .setBaseAndExtent(firstCell, 0, root, root.childNodes.length);
  await expect
    .poll(() =>
      editor.read(() => ({
        isRange: $isRangeSelection($getSelection()),
        isTable: $isTableSelection($getSelection()),
      })),
    )
    .toEqual({isRange: true, isTable: false});
});

test.each(['caret', 'range', 'table'])(
  'selects a newly created table before its DOM exists (%s)',
  kind => {
    const {editor, root} = mount();
    const updates = vi.fn();
    editor.registerUpdateListener(updates);
    const previousState = editor.getEditorState();
    const listener = vi.fn(() => {
      expect(root.querySelector('table')).toBe(null);
      expect(editor.getEditorState()).toBe(previousState);
      expect($isTableSelection($getSelection())).toBe(kind !== 'caret');
      return false;
    });
    const unregister = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      listener,
      COMMAND_PRIORITY_LOW,
    );
    editor.update(
      () => {
        const table = $createTableNodeWithDimensions(2, 2);
        $getRoot().clear().append(table);
        const cells = table.getChildren().flatMap(row => {
          assert($isTableRowNode(row));
          return row.getChildren();
        });
        const first = cells[0];
        const last = cells.at(-1)!;
        assert($isTableCellNode(first) && $isTableCellNode(last));
        if (kind === 'caret') {
          first.selectStart();
        } else if (kind === 'table') {
          $setSelection($createTableSelectionFrom(table, first, last));
        } else {
          const selection = $createRangeSelection();
          selection.anchor.set(first.getKey(), 0, 'element');
          selection.focus.set(last.getKey(), 0, 'element');
          $setSelection(selection);
        }
      },
      {discrete: true},
    );
    unregister();
    expect(listener).toHaveBeenCalled();
    expect(updates).toHaveBeenCalledTimes(1);
    const tableDOM = root.querySelector('table');
    assert(tableDOM !== null);
    const observer = getTableObserverFromTableElement(tableDOM);
    assert(observer !== null);
    expect(root.querySelectorAll('.selected-cell')).toHaveLength(
      kind === 'caret' ? 0 : 4,
    );
    expect(observer.tableSelection !== null).toBe(kind !== 'caret');

    // DOM cleanup must preserve the new range selection.
    editor.update(
      () => {
        const paragraph = $createParagraphNode().append(
          $createTextNode('After'),
        );
        $getRoot().append(paragraph);
        paragraph.selectStart();
      },
      {discrete: true},
    );
    editor.read(() => expect($isRangeSelection($getSelection())).toBe(true));
    expect(root.querySelectorAll('.selected-cell')).toHaveLength(0);
    expect(observer.tableSelection).toBe(null);
    expect(updates).toHaveBeenCalledTimes(2);
  },
);

test('includes newly inserted cells when synchronizing selection DOM', () => {
  const {editor, root} = mount();
  editor.update(
    () => {
      const table = $createTableNodeWithDimensions(1, 2);
      $getRoot().clear().append(table);
      table.selectStart();
    },
    {discrete: true},
  );
  const updates = vi.fn();
  editor.registerUpdateListener(updates);
  editor.update(
    () => {
      const table = $getRoot().getFirstChildOrThrow();
      assert($isTableNode(table));
      const row = $createTableRowNode();
      const firstNewCell = $createTableCellNode().append(
        $createParagraphNode(),
      );
      const lastNewCell = $createTableCellNode().append($createParagraphNode());
      row.append(firstNewCell, lastNewCell);
      table.append(row);
      const selection = $createRangeSelection();
      selection.anchor.set(firstNewCell.getKey(), 0, 'element');
      selection.focus.set(lastNewCell.getKey(), 0, 'element');
      $setSelection(selection);
    },
    {discrete: true},
  );
  expect(root.querySelectorAll('tr')).toHaveLength(2);
  expect(root.querySelectorAll('.selected-cell')).toHaveLength(2);
  expect(updates).toHaveBeenCalledTimes(1);
});

test('retains selection highlights when selected cells are replaced during reconciliation', () => {
  const {editor, root} = mount();
  editor.update(
    () => {
      const table = $createTableNodeWithDimensions(2, 2);
      $getRoot().clear().append(table);
      const rows = table.getChildren();
      assert(rows.every($isTableRowNode));
      const cells = rows.flatMap(row => row.getChildren());
      const first = cells[0];
      const last = cells[3];
      assert($isTableCellNode(first) && $isTableCellNode(last));
      $setSelection($createTableSelectionFrom(table, first, last));
    },
    {discrete: true},
  );
  const selection = editor.read(() => $getSelection());
  const previousCell = root.querySelector('th');
  editor.update(
    () => {
      const current = $getSelection();
      assert($isTableSelection(current));
      for (const cell of current.getNodes().filter($isTableCellNode)) {
        cell.setBackgroundColor('rgb(242, 243, 245)');
      }
    },
    {discrete: true},
  );
  expect(root.querySelector('th')).not.toBe(previousCell);
  expect(root.querySelectorAll('.selected-cell')).toHaveLength(4);
  expect(editor.read(() => $getSelection()!.is(selection))).toBe(true);
});

test('preserves the pointerdown anchor while the native caret enters its cell', () => {
  const {editor, root} = mount();
  editor.update(
    () => {
      const table = $createTableNodeWithDimensions(2, 3);
      $getRoot().clear().append(table);
      table.selectStart();
    },
    {discrete: true},
  );
  const tableDOM = root.querySelector('table');
  assert(tableDOM !== null);
  const observer = getTableObserverFromTableElement(tableDOM);
  assert(observer !== null);
  const anchorCell = observer.table.domRows[0]?.[1];
  const focusCell = observer.table.domRows[1]?.[2];
  assert(anchorCell !== undefined);
  assert(focusCell !== undefined);
  const pointer = {
    bubbles: true,
    button: 0,
    buttons: 1,
    pointerId: 1,
    pointerType: 'mouse',
  };
  anchorCell.elem.dispatchEvent(new PointerEvent('pointerdown', pointer));
  // The browser moves its caret after pointerdown. This range notification
  // must keep the prepared drag anchor even though no cells are highlighted.
  editor.update(
    () => {
      observer.$getAnchorTableCellOrThrow().selectStart();
    },
    {discrete: true},
  );
  expect(observer.anchorCell?.elem).toBe(anchorCell.elem);
  expect(observer.isHighlightingCells).toBe(false);
  expect(root.querySelectorAll('.selected-cell')).toHaveLength(0);

  const rect = focusCell.elem.getBoundingClientRect();
  focusCell.elem.dispatchEvent(
    new PointerEvent('pointermove', {
      ...pointer,
      clientX: rect.x + rect.width / 2,
      clientY: rect.y + rect.height / 2,
    }),
  );
  editor.read(() => {
    const selection = $getSelection();
    assert($isTableSelection(selection));
    expect(selection.getShape()).toEqual({fromX: 1, fromY: 0, toX: 2, toY: 1});
    expect(observer.anchorCell?.elem).toBe(anchorCell.elem);
    expect(observer.focusCell?.elem).toBe(focusCell.elem);
  });
  expect(root.querySelectorAll('.selected-cell')).toHaveLength(4);
  focusCell.elem.dispatchEvent(
    new PointerEvent('pointerup', {...pointer, buttons: 0}),
  );
});

test('caret movement outside tables does not rebuild their DOM grids', () => {
  const {editor, root} = mount();
  editor.update(
    () => {
      const paragraph = $createParagraphNode().append(
        $createTextNode('outside'),
      );
      $getRoot()
        .clear()
        .append(
          paragraph,
          $createTableNodeWithDimensions(10, 10),
          $createTableNodeWithDimensions(10, 10),
        );
      paragraph.selectStart();
    },
    {discrete: true},
  );
  const tables = [...root.querySelectorAll('table')];
  expect(tables).toHaveLength(2);
  const queries = tables.map(table => vi.spyOn(table, 'querySelector'));
  editor.update(
    () => {
      $getRoot().getAllTextNodes()[0].select(3, 3);
    },
    {discrete: true},
  );
  for (const query of queries) {
    expect(
      query.mock.calls.filter(([selector]) => selector === 'tr'),
    ).toHaveLength(0);
  }
});

test('converging notifications synchronize the selected table once per commit', () => {
  const {editor, root} = mount();
  editor.update(
    () => {
      const table = $createTableNodeWithDimensions(1, 3);
      $getRoot().clear().append(table);
      table.selectStart();
    },
    {discrete: true},
  );
  const tableDOM = root.querySelector('table');
  assert(tableDOM !== null);
  const queries = vi.spyOn(tableDOM, 'querySelector');
  const listener = vi.fn(() => {
    const selection = $getSelection();
    if ($isTableSelection(selection)) {
      const table = $getRoot().getFirstChildOrThrow();
      assert($isTableNode(table));
      const row = table.getFirstChildOrThrow();
      assert($isTableRowNode(row));
      const cells = row.getChildren();
      const first = cells[0];
      const last = cells[2];
      assert($isTableCellNode(first) && $isTableCellNode(last));
      if (selection.focus.key !== last.getKey()) {
        $setSelection($createTableSelectionFrom(table, first, last));
      }
    }
    return false;
  });
  editor.registerCommand(
    SELECTION_CHANGE_COMMAND,
    listener,
    COMMAND_PRIORITY_LOW,
  );
  editor.update(
    () => {
      const table = $getRoot().getFirstChildOrThrow();
      assert($isTableNode(table));
      const row = table.getFirstChildOrThrow();
      assert($isTableRowNode(row));
      const cells = row.getChildren();
      const first = cells[0];
      const second = cells[1];
      assert($isTableCellNode(first) && $isTableCellNode(second));
      $setSelection($createTableSelectionFrom(table, first, second));
    },
    {discrete: true},
  );
  expect(listener).toHaveBeenCalledTimes(2);
  expect(root.querySelectorAll('.selected-cell')).toHaveLength(3);
  expect(
    queries.mock.calls.filter(([selector]) => selector === 'tr'),
  ).toHaveLength(1);
});

test('only an unchanged table selection follows a native drag outside the table', () => {
  const {editor, root} = mount();
  editor.update(
    () => {
      const table = $createTableNodeWithDimensions(1, 2);
      const row = table.getFirstChildOrThrow();
      assert($isTableRowNode(row));
      const first = row.getFirstChildOrThrow();
      assert($isTableCellNode(first));
      first
        .clear()
        .append($createParagraphNode().append($createTextNode('inside')));
      $getRoot()
        .clear()
        .append(
          table,
          $createParagraphNode().append($createTextNode('outside')),
        );
      first.selectStart();
    },
    {discrete: true},
  );
  const domSelection = window.getSelection()!;
  const inside = root.querySelector('td p span, th p span')!.firstChild!;
  const outside = root.lastElementChild!.firstChild!.firstChild!;
  const selectOutside = () =>
    domSelection.setBaseAndExtent(inside, 0, outside, 3);
  selectOutside();
  editor.update(
    () => {
      const table = $getRoot().getFirstChildOrThrow();
      assert($isTableNode(table));
      const row = table.getFirstChildOrThrow();
      assert($isTableRowNode(row));
      const first = row.getFirstChildOrThrow();
      const last = row.getLastChildOrThrow();
      assert($isTableCellNode(first) && $isTableCellNode(last));
      $setSelection($createTableSelectionFrom(table, first, last));
    },
    {discrete: true},
  );
  // The old DOM range must not override a newly installed model selection.
  editor.read('latest', () =>
    expect($isTableSelection($getSelection())).toBe(true),
  );
  selectOutside();
  editor.update(
    () => {
      // A native gesture can leave the model TableSelection unchanged. Its
      // forced notification must still convert the escaped DOM range.
      editor.dispatchCommand(SELECTION_CHANGE_COMMAND);
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      expect(selection.focus.getNode().getTextContent()).toBe('outside');
      expect(selection.focus.offset).toBe(3);
    },
    {discrete: true},
  );
});
