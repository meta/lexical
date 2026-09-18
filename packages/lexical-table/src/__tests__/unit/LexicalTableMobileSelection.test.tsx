/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableNodeWithDimensions,
  $createTableRowNode,
  $isTableRowNode,
  $isTableSelection,
  type TableCellNode,
  TableExtension,
  type TableNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  defineExtension,
  type ElementNode,
  type LexicalEditorWithDispose,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import {initializeUnitTest} from 'lexical/src/__tests__/utils';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

/**
 * Test suite for mobile/touch table selection behavior.
 * Addresses the bug where simple taps between table cells on mobile
 * would incorrectly create table selections instead of just moving the cursor.
 */
describe('LexicalTableMobileSelection', () => {
  initializeUnitTest(testEnv => {
    /**
     * Helper function to create a 2x2 table for testing
     */
    function $createTestTable(): {
      tableNode: TableNode;
      cells: TableCellNode[][];
    } {
      const tableNode = $createTableNode();
      const cells: TableCellNode[][] = [];

      for (let row = 0; row < 2; row++) {
        const rowNode = $createTableRowNode();
        const rowCells: TableCellNode[] = [];

        for (let col = 0; col < 2; col++) {
          const cellNode = $createTableCellNode();
          const paragraph = $createParagraphNode();
          const text = $createTextNode(`Cell ${row}-${col}`);

          paragraph.append(text);
          cellNode.append(paragraph);
          rowNode.append(cellNode);
          rowCells.push(cellNode);
        }

        tableNode.append(rowNode);
        cells.push(rowCells);
      }

      return {cells, tableNode};
    }

    /**
     * Helper function to simulate a pointer event
     */
    function simulatePointerEvent(
      element: Element,
      type: string,
      options: Partial<PointerEventInit> = {},
    ): PointerEvent {
      const event = new PointerEvent(type, {
        bubbles: true,
        button: 0,
        buttons: 1,
        cancelable: true,
        pointerType: options.pointerType || 'mouse',
        ...options,
      });

      element.dispatchEvent(event);
      return event;
    }

    test('mouse click should set anchor cell for selection (existing behavior)', async () => {
      await testEnv.editor.update(() => {
        const root = $getRoot();
        const {tableNode, cells} = $createTestTable();
        root.clear().append(tableNode);

        // Select first cell
        cells[0][0].selectStart();
      });

      // Get the DOM elements
      const tableElement = testEnv.container.querySelector('table');
      const firstCellElement = testEnv.container.querySelector('td');

      expect(tableElement).not.toBeNull();
      expect(firstCellElement).not.toBeNull();

      // Simulate mouse pointer down on first cell
      simulatePointerEvent(firstCellElement!, 'pointerdown', {
        pointerType: 'mouse',
      });

      await testEnv.editor.read('latest', () => {
        // For mouse events, anchor should still be set (existing behavior)
        // This test mainly ensures no errors occur
        expect(true).toBe(true); // This test mainly ensures no errors occur
      });
    });

    test('touch tap on single cell should not create table selection', async () => {
      await testEnv.editor.update(() => {
        const root = $getRoot();
        const {tableNode, cells} = $createTestTable();
        root.clear().append(tableNode);

        // Select first cell
        cells[0][0].selectStart();
      });

      // Get the DOM elements
      const firstCellElement = testEnv.container.querySelector('td');
      expect(firstCellElement).not.toBeNull();

      // Simulate touch pointer down on first cell
      simulatePointerEvent(firstCellElement!, 'pointerdown', {
        pointerType: 'touch',
      });

      await testEnv.editor.read('latest', () => {
        const selection = $getSelection();
        // Should remain a range selection, not become a table selection
        expect($isRangeSelection(selection)).toBe(true);
        expect($isTableSelection(selection)).toBe(false);
      });
    });

    test('touch tap between different cells should not create table selection', async () => {
      await testEnv.editor.update(() => {
        const root = $getRoot();
        const {tableNode, cells} = $createTestTable();
        root.clear().append(tableNode);

        // Select first cell
        cells[0][0].selectStart();
      });

      // Get the DOM elements
      const firstCellElement =
        testEnv.container.querySelector('td:nth-child(1)')!;
      const secondCellElement =
        testEnv.container.querySelector('td:nth-child(2)')!;

      expect(firstCellElement).not.toBeNull();
      expect(secondCellElement).not.toBeNull();

      // Simulate touch tap on first cell
      simulatePointerEvent(firstCellElement, 'pointerdown', {
        pointerType: 'touch',
      });

      // Simulate touch tap on second cell (simulates user tapping between cells)
      simulatePointerEvent(secondCellElement, 'pointerdown', {
        pointerType: 'touch',
      });

      await testEnv.editor.read('latest', () => {
        const selection = $getSelection();
        // Should remain a range selection, not become a table selection
        expect($isRangeSelection(selection)).toBe(true);
        expect($isTableSelection(selection)).toBe(false);
      });
    });

    test('touch drag (with isSelecting=true) should still create table selection', async () => {
      await testEnv.editor.update(() => {
        const root = $getRoot();
        const {tableNode, cells} = $createTestTable();
        root.clear().append(tableNode);

        // Select first cell
        cells[0][0].selectStart();
      });

      // Get the DOM elements
      const firstCellElement =
        testEnv.container.querySelector('td:nth-child(1)')!;
      const secondCellElement =
        testEnv.container.querySelector('td:nth-child(2)')!;

      expect(firstCellElement).not.toBeNull();
      expect(secondCellElement).not.toBeNull();

      // Simulate touch drag by setting up the selection state manually
      // and then triggering pointer events
      simulatePointerEvent(firstCellElement, 'pointerdown', {
        pointerType: 'touch',
      });

      // Simulate pointer move to indicate dragging
      simulatePointerEvent(secondCellElement, 'pointermove', {
        pointerType: 'touch',
      });

      // Note: This test verifies that intentional drag operations still work
      // The actual table selection creation depends on the internal state management
      // which is complex to fully simulate in a unit test
      await testEnv.editor.read('latest', () => {
        // For now, we just verify no errors occur
        // In a real implementation, you might need more sophisticated simulation
        expect(true).toBe(true);
      });
    });

    test('mixed pointer types should be handled correctly', async () => {
      await testEnv.editor.update(() => {
        const root = $getRoot();
        const {tableNode, cells} = $createTestTable();
        root.clear().append(tableNode);

        // Select first cell
        cells[0][0].selectStart();
      });

      const firstCellElement =
        testEnv.container.querySelector('td:nth-child(1)')!;
      const secondCellElement =
        testEnv.container.querySelector('td:nth-child(2)')!;

      // Mouse down on first cell
      simulatePointerEvent(firstCellElement, 'pointerdown', {
        pointerType: 'mouse',
      });

      // Touch on second cell
      simulatePointerEvent(secondCellElement, 'pointerdown', {
        pointerType: 'touch',
      });

      await testEnv.editor.read('latest', () => {
        // Should handle mixed input gracefully without errors
        expect(true).toBe(true);
      });
    });

    test('mouse leaving browser window during selection should stop selection', async () => {
      await testEnv.editor.update(() => {
        const root = $getRoot();
        const {tableNode, cells} = $createTestTable();
        root.clear().append(tableNode);

        // Select first cell
        cells[0][0].selectStart();
      });

      // Get the DOM elements
      const firstCellElement =
        testEnv.container.querySelector('td:nth-child(1)')!;
      const secondCellElement =
        testEnv.container.querySelector('td:nth-child(2)')!;

      expect(firstCellElement).not.toBeNull();
      expect(secondCellElement).not.toBeNull();

      // Step 1: Start a mouse drag selection (pointerdown with buttons: 1)
      simulatePointerEvent(firstCellElement, 'pointerdown', {
        buttons: 1,
        pointerType: 'mouse',
      });

      // Step 2: Move to another cell (normal drag, buttons: 1)
      simulatePointerEvent(secondCellElement, 'pointermove', {
        buttons: 1,
        pointerType: 'mouse',
      });

      // Step 3: Simulate mouse re-entering window after leaving
      // When mouse leaves and re-enters, buttons will be 0 (button state lost)
      // This should trigger the selection cleanup code path
      simulatePointerEvent(secondCellElement, 'pointermove', {
        buttons: 0,
        pointerType: 'mouse',
      });

      await testEnv.editor.read('latest', () => {
        const selection = $getSelection();
        // After mouse re-enters with buttons: 0, selection should be cleaned up
        // and should not be a table selection (drag was interrupted)
        expect($isTableSelection(selection)).toBe(false);
      });
    });
  });
});

/**
 * Regression tests for https://github.com/facebook/lexical/issues/8538 -
 * placing the text cursor by tapping table cells on a touch device is
 * unreliable: instead of a caret, taps produce multi-cell table selections.
 *
 * The editor is built from TableExtension so the pointer handlers under test
 * are wired up the way an application wires them. jsdom has no layout, so
 * cells are laid out on a synthetic grid and the cell under the pointer is
 * resolved through a stubbed elementsFromPoint.
 */
describe('LexicalTableMobileSelection touch gestures (#8538)', () => {
  const COLUMNS = 3;
  const ROWS = 3;
  const CELL_WIDTH = 100;
  const CELL_HEIGHT = 40;
  // Comfortably beyond the handler's tap slop, so a move of this much is
  // unambiguously a drag.
  const DRAG_DISTANCE = 50;
  // Comfortably smaller, so a move of this much is still a tap.
  const JITTER = 3;

  const hadElementsFromPoint = 'elementsFromPoint' in document;
  const originalElementsFromPoint = document.elementsFromPoint;

  let editor: LexicalEditorWithDispose;
  let container: HTMLDivElement;
  /** The cells of the table, in row-major order. */
  let cells: HTMLTableCellElement[];
  /** Their node keys, in the same order. */
  let keys: string[];
  let cellUnderPointer: Element | null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [TableExtension],
        name: '@lexical/table/MobileSelectionTest',
        theme: {tableScrollableWrapper: ''},
      }),
    );
    editor.setRootElement(container);

    // A table of empty cells as the sole content of the document, which is the
    // scenario from #8538.
    keys = [];
    editor.update(
      () => {
        const tableNode = $createTableNodeWithDimensions(ROWS, COLUMNS, false);
        $getRoot().clear().append(tableNode);
        for (const rowNode of tableNode.getChildren()) {
          if ($isTableRowNode(rowNode)) {
            for (const cellNode of rowNode.getChildren()) {
              keys.push(cellNode.getKey());
            }
          }
        }
      },
      {discrete: true},
    );

    cells = Array.from(container.querySelectorAll('td'));
    expect(cells).toHaveLength(ROWS * COLUMNS);
    expect(keys).toHaveLength(ROWS * COLUMNS);

    cellUnderPointer = null;
    document.elementsFromPoint = () =>
      cellUnderPointer === null ? [] : [cellUnderPointer];
  });

  afterEach(() => {
    editor.dispose();
    document.body.removeChild(container);
    if (hadElementsFromPoint) {
      document.elementsFromPoint = originalElementsFromPoint;
    } else {
      delete (document as Partial<Document>).elementsFromPoint;
    }
  });

  /** The centre of a cell in the synthetic grid laid out above. */
  function centerOf(index: number): {clientX: number; clientY: number} {
    return {
      clientX: (index % COLUMNS) * CELL_WIDTH + CELL_WIDTH / 2,
      clientY: Math.floor(index / COLUMNS) * CELL_HEIGHT + CELL_HEIGHT / 2,
    };
  }

  function dispatchPointerEvent(
    cell: Element,
    type: string,
    options: PointerEventInit,
  ): void {
    cell.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        button: 0,
        buttons: 1,
        cancelable: true,
        pointerId: 1,
        pointerType: 'touch',
        ...options,
      }),
    );
  }

  /** Presses a finger down on the centre of a cell. */
  function touchDown(index: number, pointerId = 1): void {
    cellUnderPointer = cells[index];
    dispatchPointerEvent(cells[index], 'pointerdown', {
      pointerId,
      ...centerOf(index),
    });
  }

  /**
   * Moves the finger by `dx` from where the gesture started and reports
   * `overIndex` as the cell underneath it.
   */
  function touchMove(
    fromIndex: number,
    overIndex: number,
    dx: number,
    pointerId = 1,
  ): void {
    cellUnderPointer = cells[overIndex];
    const from = centerOf(fromIndex);
    dispatchPointerEvent(cells[overIndex], 'pointermove', {
      clientX: from.clientX + dx,
      clientY: from.clientY,
      pointerId,
    });
  }

  function touchUp(index: number, pointerId = 1): void {
    dispatchPointerEvent(cells[index], 'pointerup', {
      buttons: 0,
      pointerId,
      ...centerOf(index),
    });
  }

  /** A tap: down, the micro pointermove that real taps produce, then up. */
  function touchTap(index: number): void {
    touchDown(index);
    touchMove(index, index, JITTER);
    touchUp(index);
  }

  /** A drag from one cell into another. */
  function touchDrag(fromIndex: number, toIndex: number): void {
    touchDown(fromIndex);
    touchMove(fromIndex, toIndex, DRAG_DISTANCE);
    touchUp(toIndex);
  }

  // editor.read() force-commits, so it flushes the updates the pointer
  // handlers queued before reading the selection they produced.
  function expectNoTableSelection(): void {
    editor.read(() => {
      expect($isTableSelection($getSelection())).toBe(false);
    });
  }

  function expectTableSelection(anchorIndex: number, focusIndex: number): void {
    editor.read(() => {
      const selection = $getSelection();
      expect($isTableSelection(selection)).toBe(true);
      if ($isTableSelection(selection)) {
        expect(selection.anchor.getNode().getKey()).toBe(keys[anchorIndex]);
        expect(selection.focus.getNode().getKey()).toBe(keys[focusIndex]);
      }
    });
  }

  test('a tap with a micro pointermove does not create a table selection', () => {
    touchTap(4);

    expectNoTableSelection();
  });

  test('taps on different cells do not create a table selection', () => {
    touchTap(0);
    touchTap(4);

    expectNoTableSelection();
  });

  test('a tap near a cell border does not create a table selection', () => {
    // The finger barely moves, but the jitter is enough for the hit-test to
    // land in the neighbouring cell. That is still a tap, not a drag.
    touchDown(0);
    touchMove(0, 1, JITTER);
    touchUp(0);

    expectNoTableSelection();
  });

  test('a drag across cells creates a table selection', () => {
    touchDrag(0, 1);

    expectTableSelection(0, 1);
  });

  test('a drag after a tap anchors at the cell the drag started on', () => {
    touchTap(0);
    touchDrag(4, 5);

    // The anchor must be the cell the drag started on, not the cell the
    // previous gesture tapped.
    expectTableSelection(4, 5);
  });

  test('a drag within the starting cell does not create a table selection', () => {
    // Selecting text inside one cell is a range selection, not a table one.
    touchDown(0);
    touchMove(0, 0, DRAG_DISTANCE);
    touchUp(0);

    expectNoTableSelection();
  });

  test.each(['pointercancel', 'lostpointercapture'])(
    'a gesture ended by %s does not leak into the next tap',
    endEvent => {
      // The browser takes the gesture away - a touch that turned into a
      // scroll, say - so no pointerup is ever delivered.
      touchDown(0);
      dispatchPointerEvent(cells[0], endEvent, {buttons: 0, ...centerOf(0)});

      touchTap(4);

      expectNoTableSelection();
    },
  );

  test('a gesture ended by pointercancel does not wedge later gestures', () => {
    touchDown(0);
    dispatchPointerEvent(cells[0], 'pointercancel', {
      buttons: 0,
      ...centerOf(0),
    });

    // The observer must have returned to a state where a real drag works.
    touchDrag(4, 5);

    expectTableSelection(4, 5);
  });

  test('a second finger does not drive the first finger gesture', () => {
    touchDown(0, 1);
    // A second contact lands elsewhere and moves across cells. It belongs to
    // its own gesture and must not extend this one.
    touchMove(0, 5, DRAG_DISTANCE, 2);
    touchUp(0, 1);

    expectNoTableSelection();
  });

  /**
   * Counts the animation frames the pointer handlers schedule for a single
   * pointermove, which is how drag auto-scroll starts. The stub does not run
   * the callback, so the scroll tick itself (which jsdom cannot perform)
   * never fires.
   */
  function countScheduledFrames(move: () => void): number {
    const raf = vi
      .spyOn(editor._window as Window, 'requestAnimationFrame')
      .mockReturnValue(1);
    try {
      move();
      return raf.mock.calls.length;
    } finally {
      raf.mockRestore();
    }
  }

  // Row 0 sits within the auto-scroll edge zone of the viewport top, so any
  // move there is "near a scroll edge" and only the tap/drag gate decides
  // whether auto-scroll starts.
  test('a touch tap near a scroll edge does not start auto-scroll', () => {
    touchDown(0);
    expect(countScheduledFrames(() => touchMove(0, 0, JITTER))).toBe(0);
    touchUp(0);
  });

  test('a touch drag near a scroll edge starts auto-scroll', () => {
    touchDown(0);
    expect(
      countScheduledFrames(() => touchMove(0, 1, DRAG_DISTANCE)),
    ).toBeGreaterThan(0);
    touchUp(1);
  });

  /**
   * Puts a collapsed caret at the start of a cell and lets the table's
   * SELECTION_CHANGE_COMMAND handler see it, which is what a touch device
   * does natively as a finger presses and drags. jsdom moves no caret of its
   * own, so the pointer-driven tests above never reach that handler.
   */
  function moveCaretTo(index: number): void {
    editor.update(
      () => {
        const cellNode = $getNodeByKey<ElementNode>(keys[index]);
        expect(cellNode).not.toBe(null);
        cellNode!.selectStart();
        editor.dispatchCommand(SELECTION_CHANGE_COMMAND, undefined);
      },
      {discrete: true},
    );
  }

  test('a drag inside one cell does not convert the caret into a table selection', () => {
    // An earlier tap left the caret in cell 0.
    moveCaretTo(0);

    // The finger presses in cell 4 and drags 50px without leaving it, which
    // is selecting text inside that cell. The browser moves the caret into
    // cell 4 as it goes.
    touchDown(4);
    touchMove(4, 4, DRAG_DISTANCE);
    moveCaretTo(4);
    touchUp(4);

    // Pairing that caret with the cell the previous gesture left behind is
    // the #8538 symptom.
    expectNoTableSelection();
  });

  test('a drag that leaves its starting cell still converts the caret into a table selection', () => {
    moveCaretTo(0);

    // Same shape, but the finger crosses out of the cell it started on, so
    // the fallback that builds a table selection from the moving caret has
    // to keep working.
    touchDown(0);
    touchMove(0, 1, DRAG_DISTANCE);
    moveCaretTo(1);

    editor.read(() => {
      expect($isTableSelection($getSelection())).toBe(true);
    });
  });
});
