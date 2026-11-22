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
  $createTableNodeWithDimensions,
  $isTableCellNode,
  $isTableRowNode,
  $isTableSelection,
  TableExtension,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKeyOrThrow,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  KEY_BACKSPACE_COMMAND,
} from 'lexical';
import {assert, expect, onTestFinished, test} from 'vitest';

function mount(text = '') {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  const editor = buildEditorFromExtensions({
    dependencies: [RichTextExtension, TableExtension],
    name: 'test/empty-cell-touch-selection',
    theme: {tableScrollableWrapper: ''},
  });
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
  });
  let paragraphKey = '';
  let outsideKey = '';
  editor.update(
    () => {
      const before = $createTextNode('Before the table');
      outsideKey = before.getKey();
      const table = $createTableNodeWithDimensions(2, 2, false);
      const firstRow = table.getFirstChildOrThrow();
      const lastRow = table.getLastChildOrThrow();
      assert($isTableRowNode(firstRow) && $isTableRowNode(lastRow));
      const firstCell = firstRow.getFirstChildOrThrow();
      const lastCell = lastRow.getLastChildOrThrow();
      assert($isTableCellNode(firstCell) && $isTableCellNode(lastCell));
      firstCell
        .clear()
        .append($createParagraphNode().append($createTextNode('Another cell')));
      const paragraph = $createParagraphNode();
      paragraphKey = paragraph.getKey();
      if (text) {
        paragraph.append($createTextNode(text));
      }
      lastCell.clear().append(paragraph);
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append(before),
          table,
          $createParagraphNode().append($createTextNode('After the table')),
        );
      paragraph.selectStart();
    },
    {discrete: true},
  );
  const cell = root.querySelectorAll('td')[3];
  const paragraph = cell.firstElementChild!;
  const outside = root.firstElementChild!.firstChild!.firstChild!;

  function pointer(
    type: string,
    options: PointerEventInit = {},
    target: Element = cell,
  ) {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: 100,
        clientY: 100,
        pointerId: 1,
        pointerType: 'touch',
        ...options,
      }),
    );
    editor.read(() => {});
  }

  function tap(options: PointerEventInit = {}) {
    pointer('pointerdown', options);
    pointer('pointerup', options);
  }

  // Replay the native range reported by iOS, without synthesizing a second
  // pointerdown: WebKit can produce only selectionchange for the second tap.
  function nativeRange(backward = false, other: Node = outside) {
    const domSelection = window.getSelection()!;
    const inside =
      paragraph.firstChild!.nodeType === Node.TEXT_NODE
        ? paragraph.firstChild!
        : paragraph;
    domSelection.setBaseAndExtent(
      backward ? inside : other,
      0,
      backward ? other : inside,
      0,
    );
    document.dispatchEvent(new Event('selectionchange'));
    editor.read(() => {});
  }

  function expectCaret() {
    editor.read('latest', () => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      expect(selection.isCollapsed()).toBe(true);
      expect(selection.anchor.key).toBe(paragraphKey);
      expect(selection.anchor.offset).toBe(0);
    });
    expect(window.getSelection()!.isCollapsed).toBe(true);
  }

  function expectRange() {
    editor.read('latest', () => {
      const selection = $getSelection();
      assert($isRangeSelection(selection) || $isTableSelection(selection));
      expect(selection.isCollapsed()).toBe(false);
    });
  }

  return {
    cell,
    editor,
    expectCaret,
    expectRange,
    nativeRange,
    outsideKey,
    paragraphKey,
    pointer,
    root,
    tap,
  };
}

test.each([false, true])(
  'repairs an empty-cell touch range in either direction (backward=%s)',
  backward => {
    const fixture = mount();
    fixture.tap();
    fixture.nativeRange(backward);
    fixture.expectCaret();
  },
);

test.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  'repairs a range from multiple empty paragraphs (emptyBefore=%s, backward=%s)',
  (emptyBefore, backward) => {
    const fixture = mount();
    fixture.editor.update(
      () => {
        const paragraph = $getNodeByKeyOrThrow(fixture.paragraphKey);
        const empty = $createParagraphNode();
        if (emptyBefore) {
          paragraph.insertBefore(empty);
        } else {
          paragraph.insertAfter(empty);
        }
      },
      {discrete: true},
    );
    fixture.tap();
    fixture.nativeRange(backward);
    fixture.expectCaret();
  },
);

test.each([false, true])(
  'preserves a range from an empty paragraph with text elsewhere in its cell (textBefore=%s)',
  textBefore => {
    const fixture = mount();
    fixture.editor.update(
      () => {
        const paragraph = $getNodeByKeyOrThrow(fixture.paragraphKey);
        const text = $createParagraphNode().append($createTextNode('Text'));
        if (textBefore) {
          paragraph.insertBefore(text);
        } else {
          paragraph.insertAfter(text);
        }
      },
      {discrete: true},
    );
    fixture.tap();
    fixture.nativeRange();
    fixture.expectRange();
  },
);

test.each(['cell', 'after'])(
  'repairs a touch range reaching another %s',
  endpoint => {
    const fixture = mount();
    fixture.tap();
    const other =
      endpoint === 'cell'
        ? fixture.root.querySelector('td span')!.firstChild!
        : fixture.root.lastElementChild!.firstChild!.firstChild!;
    fixture.nativeRange(false, other);
    fixture.expectCaret();
  },
);

test('repairs the range when iOS also synthesizes a double click', () => {
  const fixture = mount();
  fixture.tap();
  for (const type of ['mousedown', 'dblclick']) {
    fixture.cell.dispatchEvent(
      new MouseEvent(type, {bubbles: true, cancelable: true, detail: 2}),
    );
  }
  fixture.nativeRange();
  fixture.expectCaret();
});

test.each([
  ['insert', false],
  ['delete', false],
  ['insert', true],
  ['delete', true],
] as const)(
  '%s after the second tap preserves the table and surrounding text (multipleParagraphs=%s)',
  (action, multipleParagraphs) => {
    const fixture = mount();
    if (multipleParagraphs) {
      fixture.editor.update(
        () => {
          $getNodeByKeyOrThrow(fixture.paragraphKey).insertAfter(
            $createParagraphNode(),
          );
        },
        {discrete: true},
      );
    }
    fixture.tap();
    fixture.nativeRange();
    fixture.editor.update(
      () => {
        if (action === 'insert') {
          fixture.editor.dispatchCommand(
            CONTROLLED_TEXT_INSERTION_COMMAND,
            'x',
          );
        } else {
          fixture.editor.dispatchCommand(
            KEY_BACKSPACE_COMMAND,
            new KeyboardEvent('keydown', {key: 'Backspace'}),
          );
        }
      },
      {discrete: true},
    );
    expect(fixture.root.querySelectorAll('td')).toHaveLength(4);
    expect(fixture.root.firstElementChild!.textContent).toBe(
      'Before the table',
    );
    expect(fixture.cell.textContent).toBe(action === 'insert' ? 'x' : '');
  },
);

test.each(['mouse', 'pen'])('preserves ranges from a %s', pointerType => {
  const fixture = mount();
  fixture.tap({pointerType});
  fixture.nativeRange();
  fixture.expectRange();
});

test.each([
  'pointercancel',
  'drag',
  'finished drag',
  'keyboard',
  'outside pointer',
  'shift tap',
])('preserves intentional ranges after %s', action => {
  const fixture = mount();
  fixture.pointer('pointerdown');
  if (action === 'pointercancel') {
    fixture.pointer('pointercancel');
  } else if (action === 'drag' || action === 'finished drag') {
    // Target outside the table avoids needing layout/hit-test mocks.
    fixture.pointer('pointermove', {clientX: 150}, fixture.root);
    if (action === 'finished drag') {
      fixture.pointer('pointerup', {clientX: 150});
    }
  } else {
    fixture.pointer('pointerup');
    if (action === 'keyboard') {
      fixture.root.dispatchEvent(
        new KeyboardEvent('keydown', {bubbles: true, key: 'Shift'}),
      );
    } else if (action === 'outside pointer') {
      fixture.pointer(
        'pointerdown',
        {pointerType: 'mouse', shiftKey: true},
        fixture.root.firstElementChild!,
      );
    } else {
      fixture.tap({shiftKey: true});
    }
  }
  fixture.nativeRange();
  fixture.expectRange();
});

test('preserves programmatic ranges after a touch tap', () => {
  const fixture = mount();
  fixture.tap();
  fixture.editor.update(
    () => {
      const selection = $createRangeSelection();
      selection.anchor.set(fixture.outsideKey, 0, 'text');
      selection.focus.set(fixture.paragraphKey, 0, 'element');
      $setSelection(selection);
    },
    {discrete: true},
  );
  fixture.expectRange();
});

test('preserves a programmatic cross-cell range after a touch tap', () => {
  const fixture = mount();
  fixture.tap();
  fixture.editor.update(
    () => {
      const paragraph = $getNodeByKeyOrThrow(fixture.paragraphKey);
      const previousCell = paragraph.getParentOrThrow().getPreviousSibling();
      assert($isTableCellNode(previousCell));
      const other = previousCell.getFirstChildOrThrow();
      const selection = $createRangeSelection();
      selection.anchor.set(fixture.paragraphKey, 0, 'element');
      selection.focus.set(other.getKey(), 0, 'element');
      $setSelection(selection);
    },
    {discrete: true},
  );
  fixture.expectRange();
});

test('preserves keyboard selection when a root listener stops propagation', () => {
  const fixture = mount();
  fixture.tap();
  fixture.root.addEventListener('keydown', event => event.stopPropagation(), {
    once: true,
  });
  fixture.root.dispatchEvent(
    new KeyboardEvent('keydown', {bubbles: true, key: 'Shift'}),
  );
  fixture.nativeRange();
  fixture.expectRange();
});

test('repairs an escaped native range whose DOM endpoint is the cell', () => {
  const fixture = mount();
  fixture.tap();
  window
    .getSelection()!
    .setBaseAndExtent(
      fixture.root.firstElementChild!.firstChild!.firstChild!,
      0,
      fixture.cell,
      0,
    );
  document.dispatchEvent(new Event('selectionchange'));
  fixture.editor.read(() => {});
  fixture.expectCaret();
});

test('preserves selection-handle changes to an existing range', () => {
  const fixture = mount();
  fixture.tap();
  fixture.editor.update(
    () => {
      const selection = $createRangeSelection();
      selection.anchor.set(fixture.outsideKey, 0, 'text');
      selection.focus.set(fixture.outsideKey, 6, 'text');
      $setSelection(selection);
    },
    {discrete: true},
  );
  fixture.nativeRange();
  fixture.expectRange();
});

test('preserves a range from a nonempty cell', () => {
  const fixture = mount('Text');
  fixture.tap();
  fixture.nativeRange();
  fixture.expectRange();
});

test('does not mistake a different empty cell for the tapped cell', () => {
  const fixture = mount();
  fixture.tap();
  fixture.editor.update(
    () => {
      const paragraph = $getNodeByKeyOrThrow(fixture.paragraphKey);
      const previousCell = paragraph.getParentOrThrow().getPreviousSibling();
      assert($isTableCellNode(previousCell));
      previousCell.selectStart();
    },
    {discrete: true},
  );
  fixture.nativeRange();
  fixture.expectRange();
});
