/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  buildEditorFromExtensions,
  NestedEditorExtension,
} from '@lexical/extension';
import {
  $computeTableMapSkipCellCheck,
  $createTableNodeWithDimensions,
  $createTableSelectionFrom,
  $isTableNode,
  $isTableSelection,
  getTableObserverFromTableElement,
  TableExtension,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  DecoratorNode,
  defineExtension,
  type LexicalEditorWithDispose,
  type NodeKey,
} from 'lexical';
import {afterEach, assert, beforeEach, describe, expect, test} from 'vitest';

// A block decorator whose DOM hosts the root element of a nested editor, the
// way a decorator component mounts one.
class NestedEditorHostNode extends DecoratorNode<null> {
  $config() {
    return this.config('nested_editor_host', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    return $getDocument().createElement('div');
  }
  updateDOM(): false {
    return false;
  }
  isInline(): boolean {
    return false;
  }
  decorate(): null {
    return null;
  }
}

function pointerDown(target: Element): void {
  target.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      buttons: 1,
      cancelable: true,
      pointerType: 'mouse',
    }),
  );
}

describe('a table in an editor nested in a decorator (#9355)', () => {
  let container: HTMLDivElement;
  let parentEditor: LexicalEditorWithDispose;
  let childEditor: LexicalEditorWithDispose;
  let parentErrors: Error[];
  let childErrors: Error[];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    parentErrors = [];
    childErrors = [];
    parentEditor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [TableExtension],
        name: 'nested-table-parent',
        nodes: [NestedEditorHostNode],
        onError: error => {
          parentErrors.push(error);
        },
        // The child inherits this theme through NestedEditorExtension.
        theme: {tableScrollableWrapper: ''},
      }),
    );
    parentEditor.setRootElement(container);
    childEditor = parentEditor.read(() =>
      buildEditorFromExtensions(
        defineExtension({
          dependencies: [NestedEditorExtension, TableExtension],
          name: 'nested-table-child',
          onError: error => {
            childErrors.push(error);
          },
        }),
      ),
    );
  });

  afterEach(() => {
    childEditor.dispose();
    parentEditor.dispose();
    document.body.removeChild(container);
  });

  /**
   * Fills the parent with a paragraph (selected), optionally a table of its
   * own, and a decorator that hosts the child editor, then gives the child a
   * 2x2 table. Returns the child's table element and its first cell.
   */
  function mountNestedTable({withParentTable}: {withParentTable: boolean}) {
    let hostKey: NodeKey = '';
    parentEditor.update(
      () => {
        const paragraph = $createParagraphNode().append(
          $createTextNode('Parent text'),
        );
        const host = new NestedEditorHostNode();
        hostKey = host.getKey();
        $getRoot().clear().append(paragraph);
        if (withParentTable) {
          $getRoot().append($createTableNodeWithDimensions(2, 2, false));
        }
        $getRoot().append(host, $createParagraphNode());
        paragraph.select(0, 0);
      },
      {discrete: true},
    );
    const hostElement = parentEditor.getElementByKey(hostKey);
    assert(hostElement !== null, 'Expected the decorator DOM');
    const childRoot = document.createElement('div');
    hostElement.appendChild(childRoot);
    childEditor.setRootElement(childRoot);
    childEditor.update(
      () => {
        $getRoot()
          .clear()
          .append($createTableNodeWithDimensions(2, 2, false));
      },
      {discrete: true},
    );
    const tableElement = childRoot.querySelector('table');
    const cellElement = childRoot.querySelector('td');
    assert(tableElement !== null, 'Expected the nested table');
    assert(cellElement !== null, 'Expected a nested table cell');
    return {cellElement, tableElement};
  }

  test('the parent leaves a pointerdown on a nested table cell to the nested editor', () => {
    const {cellElement, tableElement} = mountNestedTable({
      withParentTable: false,
    });
    const selectionBefore = parentEditor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'Expected a RangeSelection');
      return selection.clone();
    });

    pointerDown(cellElement);

    parentEditor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'Expected a RangeSelection');
      expect(selection.is(selectionBefore)).toBe(true);
    });
    expect(parentErrors).toEqual([]);
    expect(childErrors).toEqual([]);
    // The nested editor still handles the pointerdown in its own table.
    const childObserver = getTableObserverFromTableElement(tableElement);
    assert(childObserver !== null, 'Expected the nested TableObserver');
    expect(childObserver.anchorCell?.elem).toBe(cellElement);
  });

  test('the parent still clears its own table selection', () => {
    const {cellElement} = mountNestedTable({withParentTable: true});
    parentEditor.update(
      () => {
        const table = $getRoot().getChildAtIndex(1);
        assert($isTableNode(table), 'Expected the parent table');
        const [map] = $computeTableMapSkipCellCheck(table, null, null);
        $setSelection(
          $createTableSelectionFrom(table, map[0][0].cell, map[1][1].cell),
        );
      },
      {discrete: true},
    );
    expect(parentEditor.read(() => $isTableSelection($getSelection()))).toBe(
      true,
    );

    pointerDown(cellElement);

    expect(parentEditor.read(() => $getSelection())).toBe(null);
    expect(parentErrors).toEqual([]);
    expect(childErrors).toEqual([]);
  });

  test('a nested editor in a parent table cell leaves that table to the parent', () => {
    let hostKey: NodeKey = '';
    parentEditor.update(
      () => {
        const table = $createTableNodeWithDimensions(2, 2, false);
        const [map] = $computeTableMapSkipCellCheck(table, null, null);
        const host = new NestedEditorHostNode();
        hostKey = host.getKey();
        map[0][0].cell.append(host);
        $getRoot().clear().append(table);
      },
      {discrete: true},
    );
    const hostElement = parentEditor.getElementByKey(hostKey);
    assert(hostElement !== null, 'Expected the decorator DOM');
    const parentCellElement = hostElement.closest('td');
    const parentTableElement = container.querySelector('table');
    assert(parentCellElement !== null, 'Expected the parent table cell');
    assert(parentTableElement !== null, 'Expected the parent table');
    const childRoot = document.createElement('div');
    hostElement.appendChild(childRoot);
    childEditor.setRootElement(childRoot);
    childEditor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('Child')));
      },
      {discrete: true},
    );
    const paragraphElement = childRoot.querySelector('p');
    assert(paragraphElement !== null, 'Expected the nested paragraph');

    pointerDown(paragraphElement);

    expect(parentErrors).toEqual([]);
    expect(childErrors).toEqual([]);
    // The parent still handles the pointerdown in its own cell.
    const parentObserver = getTableObserverFromTableElement(parentTableElement);
    assert(parentObserver !== null, 'Expected the parent TableObserver');
    expect(parentObserver.anchorCell?.elem).toBe(parentCellElement);
  });
});
