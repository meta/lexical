/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $computeTableMapSkipCellCheck,
  $createTableNodeWithDimensions,
  $createTableSelectionFrom,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  TableExtension,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isParagraphNode,
  $setSelection,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_EDITOR,
  COPY_COMMAND,
  defineExtension,
  DELETE_LINE_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  type LexicalEditorWithDispose,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

describe('LexicalTableSelectionHelpers', () => {
  describe('regression #8670', () => {
    let editor: LexicalEditorWithDispose;
    let container: HTMLDivElement;

    function $createTableBelowParagraph() {
      const paragraph = $createParagraphNode().append($createTextNode('above'));
      $getRoot()
        .clear()
        .append(paragraph, $createTableNodeWithDimensions(2, 2, false));
      paragraph.selectEnd();
    }

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [TableExtension],
          name: 'regression-8670-test',
          theme: {tableScrollableWrapper: ''},
        }),
      );
      editor.setRootElement(container);
    });

    afterEach(() => {
      editor.dispose();
      document.body.removeChild(container);
    });

    test('selection change ignores the table recorded on ArrowDown when it was removed', () => {
      editor.update($createTableBelowParagraph, {discrete: true});

      // Pressing ArrowDown above the table records the table key to check
      // on the next selection change (the Firefox workaround for scrollable
      // tables, which TableExtension enables by default via
      // hasHorizontalScroll)
      editor.dispatchCommand(
        KEY_ARROW_DOWN_COMMAND,
        new KeyboardEvent('keydown', {key: 'ArrowDown'}),
      );

      // The table is removed before the next selection change occurs
      editor.update(
        () => {
          const root = $getRoot();
          root.getLastChildOrThrow().remove();
          root.selectEnd();
        },
        {discrete: true},
      );

      expect(() =>
        editor.dispatchCommand(SELECTION_CHANGE_COMMAND),
      ).not.toThrow();
    });

    test('selection change self-heals observers for tables removed while the root element was detached', () => {
      editor.update($createTableBelowParagraph, {discrete: true});

      // Removing the table while the root element is detached skips
      // reconciliation, so the TableNode destroyed mutation never fires
      // and the observers registry keeps a stale entry
      editor.setRootElement(null);
      editor.update(
        () => {
          $getRoot().getLastChildOrThrow().remove();
        },
        {discrete: true},
      );
      editor.setRootElement(container);

      // Without self-healing every subsequent selection change throws
      expect(() => {
        editor.dispatchCommand(SELECTION_CHANGE_COMMAND);
        editor.dispatchCommand(SELECTION_CHANGE_COMMAND);
      }).not.toThrow();

      // New tables still work after the registry healed itself
      editor.update(
        () => {
          $getRoot().append($createTableNodeWithDimensions(2, 2, false));
        },
        {discrete: true},
      );
      expect(() =>
        editor.dispatchCommand(SELECTION_CHANGE_COMMAND),
      ).not.toThrow();
    });
  });

  describe('regression #8832', () => {
    let editor: LexicalEditorWithDispose;
    let container: HTMLDivElement;

    beforeEach(() => {
      container = document.createElement('div');
      container.tabIndex = -1;
      document.body.appendChild(container);
      editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [TableExtension],
          name: 'regression-8832-test',
          theme: {tableScrollableWrapper: ''},
        }),
      );
      editor.setRootElement(container);
    });

    afterEach(() => {
      editor.dispose();
      document.body.removeChild(container);
    });

    function $selectAllCells() {
      const table = $getRoot().getFirstChildOrThrow();
      if (!$isTableNode(table)) {
        throw new Error('Expected TableNode');
      }
      const [tableMap] = $computeTableMapSkipCellCheck(table, null, null);
      $setSelection(
        $createTableSelectionFrom(
          table,
          tableMap[0][0].cell,
          tableMap[tableMap.length - 1][tableMap[0].length - 1].cell,
        ),
      );
    }

    test('document-level copy dispatches COPY_COMMAND for table selection in read-only mode', () => {
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createTableNodeWithDimensions(2, 2, false));
          $selectAllCells();
        },
        {discrete: true},
      );

      editor.setEditable(false);
      container.focus();

      let received = false;
      const unregister = editor.registerCommand(
        COPY_COMMAND,
        () => {
          received = true;
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      );

      // Firefox fires copy on document/body, not on contentEditable=false root
      document.dispatchEvent(
        new ClipboardEvent('copy', {bubbles: true, cancelable: true}),
      );

      expect(received).toBe(true);
      unregister();
    });

    test('document-level copy is not dispatched without table selection', () => {
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createTableNodeWithDimensions(2, 2, false));
        },
        {discrete: true},
      );

      editor.setEditable(false);
      container.focus();

      let received = false;
      const unregister = editor.registerCommand(
        COPY_COMMAND,
        () => {
          received = true;
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      );

      // Without a TableSelection, the document-level listener should not
      // intercept the copy event.
      document.dispatchEvent(
        new ClipboardEvent('copy', {bubbles: true, cancelable: true}),
      );

      expect(received).toBe(false);
      unregister();
    });

    test('document-level copy is skipped when event is already defaultPrevented', () => {
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createTableNodeWithDimensions(2, 2, false));
          $selectAllCells();
        },
        {discrete: true},
      );

      editor.setEditable(false);
      container.focus();

      let received = false;
      const unregister = editor.registerCommand(
        COPY_COMMAND,
        () => {
          received = true;
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      );

      const event = new ClipboardEvent('copy', {
        bubbles: true,
        cancelable: true,
      });
      event.preventDefault();
      document.dispatchEvent(event);

      expect(received).toBe(false);
      unregister();
    });

    test('document-level copy is skipped when focus is outside the editor', () => {
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createTableNodeWithDimensions(2, 2, false));
          $selectAllCells();
        },
        {discrete: true},
      );

      editor.setEditable(false);

      // Focus a sibling element instead of the editor container
      const sibling = document.createElement('div');
      sibling.tabIndex = -1;
      document.body.appendChild(sibling);
      sibling.focus();
      expect(document.activeElement).toBe(sibling);

      let received = false;
      const unregister = editor.registerCommand(
        COPY_COMMAND,
        () => {
          received = true;
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      );

      document.dispatchEvent(
        new ClipboardEvent('copy', {bubbles: true, cancelable: true}),
      );

      expect(received).toBe(false);
      unregister();
      document.body.removeChild(sibling);
    });
  });

  describe('DELETE_LINE_COMMAND in table cells', () => {
    let editor: LexicalEditorWithDispose;
    let container: HTMLDivElement;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [TableExtension],
          name: 'delete-line-test',
          theme: {tableScrollableWrapper: ''},
        }),
      );
      editor.setRootElement(container);
    });

    afterEach(() => {
      editor.dispose();
      document.body.removeChild(container);
    });

    test('DELETE_LINE_COMMAND propagates past the table handler in the first cell paragraph', () => {
      editor.update(
        () => {
          const table = $createTableNodeWithDimensions(2, 2, false);
          $getRoot().clear().append(table);
          const firstRow = $assertNodeType(
            table.getFirstChildOrThrow(),
            $isTableRowNode,
          );
          const firstCell = $assertNodeType(
            firstRow.getFirstChildOrThrow(),
            $isTableCellNode,
          );
          const paragraph = $assertNodeType(
            firstCell.getFirstChildOrThrow(),
            $isParagraphNode,
          );
          paragraph.clear().append($createTextNode('hello world'));
          paragraph.selectEnd();
        },
        {discrete: true},
      );

      let propagated = false;
      const unregister = editor.registerCommand(
        DELETE_LINE_COMMAND,
        () => {
          propagated = true;
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      );

      editor.dispatchCommand(DELETE_LINE_COMMAND, true);
      expect(propagated).toBe(true);

      propagated = false;
      editor.dispatchCommand(DELETE_LINE_COMMAND, false);
      expect(propagated).toBe(true);
      unregister();
    });
  });
});
