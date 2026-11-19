/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {TableCellNode, TableNode} from '@lexical/table';
import {describe, expect, test} from 'vitest';

/**
 * Subclasses that override the accessors the table's field declarations stand
 * in for, to hold each declaration to the one it named.
 *
 * These properties read and write their fields directly, which is the fast
 * path, but a field only ever *stands in for* an accessor, and a subclass that
 * overrides one has said the two are no longer equivalent. The declaration is
 * what says which accessor that is: `frozenColumnCount` and `frozenRowCount`
 * name `setFrozenColumns`/`setFrozenRows` explicitly, because the conventional
 * `setFrozenColumnCount`/`setFrozenRowCount` a field would otherwise assume do
 * not exist — without that, importing into a subclass that clamps wrote the
 * raw count past its override. `rowStriping` and `verticalAlign` are the other
 * half of the same question: they rely on the conventional name matching, and
 * nothing says so out loud, so they are exercised here too.
 */
class CappedTableNode extends TableNode {
  static getType(): string {
    return 'capped-table';
  }
  static clone(node: CappedTableNode): CappedTableNode {
    return new CappedTableNode(node.__key);
  }
  setFrozenColumns(count: number): this {
    return super.setFrozenColumns(Math.min(count, 2));
  }
  setFrozenRows(count: number): this {
    return super.setFrozenRows(Math.min(count, 3));
  }
  // Named by convention rather than by the declaration, which is the case the
  // frozen counts could not use.
  setRowStriping(striping: boolean): this {
    return super.setRowStriping(!striping);
  }
}

class AlignCellNode extends TableCellNode {
  static getType(): string {
    return 'align-cell';
  }
  static clone(node: AlignCellNode): AlignCellNode {
    return new AlignCellNode(
      node.__headerState,
      node.__colSpan,
      node.__width,
      node.__key,
    );
  }
  setVerticalAlign(align: null | undefined | string): this {
    return super.setVerticalAlign(align === 'middle' ? 'bottom' : align);
  }
}

/** An editor that knows the two subclasses and their bases, and nothing else. */
function $withEditor(fn: () => void): void {
  using editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      name: '[table-field-accessors]',
      nodes: [TableNode, CappedTableNode, TableCellNode, AlignCellNode],
    }),
  );
  editor.update(fn, {discrete: true});
}

describe('the accessors the table field declarations stand in for', () => {
  test('a subclass override of a named setter still decides', () => {
    $withEditor(() => {
      const node = CappedTableNode.importJSON({
        children: [],
        direction: null,
        format: '',
        frozenColumnCount: 9,
        frozenRowCount: 9,
        indent: 0,
        type: 'capped-table',
        version: 1,
      } as never) as CappedTableNode;
      expect(node.getFrozenColumns()).toBe(2);
      expect(node.getFrozenRows()).toBe(3);
    });
  });

  test('and one of a setter named only by convention', () => {
    $withEditor(() => {
      const node = CappedTableNode.importJSON({
        children: [],
        direction: null,
        format: '',
        indent: 0,
        rowStriping: true,
        type: 'capped-table',
        version: 1,
      } as never) as CappedTableNode;
      expect(node.getRowStriping()).toBe(false);
    });
  });

  test('including a cell whose vertical alignment is overridden', () => {
    $withEditor(() => {
      const node = AlignCellNode.importJSON({
        children: [],
        colSpan: 1,
        direction: null,
        format: '',
        headerState: 0,
        indent: 0,
        rowSpan: 1,
        type: 'align-cell',
        version: 1,
        verticalAlign: 'middle',
      } as never) as AlignCellNode;
      expect(node.getVerticalAlign()).toBe('bottom');
    });
  });
});
