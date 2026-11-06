/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Lexical extends a mouse drag across inline decorators (#7158) by moving the
 * focus of its own selection as the drag moves. In a table, a drag that
 * leaves its cell becomes the table's own selection, which Lexical must leave
 * to the table, also on release: a drag into a cell over an inline decorator
 * (an image, or a chip of text that a browser can put the drag's focus in)
 * selects the cells, and a drag out of the table below it selects the whole
 * table. So does a Shift-click from one cell into the next. Lexical handles
 * it at the release when its selectionchange comes later, except in Firefox,
 * where the table takes the press, and a selectionchange after the release is
 * not the press's.
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $isTableSelection,
  TableExtension,
} from '@lexical/table';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getNearestNodeFromDOMNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  DecoratorNode,
  isDOMTextNode,
  type LexicalEditor,
  registerEventListener,
  registerEventListeners,
} from 'lexical';
import {assert, onTestFinished, test, vi} from 'vitest';
import {commands} from 'vitest/browser';

const SIZE = 40;

class InlineImageNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_table_mouse_drag_image', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    const span = document.createElement('span');
    const img = document.createElement('img');
    img.alt = '';
    img.style.cssText = `display:inline-block;width:${SIZE}px;height:${SIZE}px;background:#888`;
    span.appendChild(img);
    return span;
  }
  updateDOM(): false {
    return false;
  }
  isInline(): true {
    return true;
  }
  decorate(): null {
    return null;
  }
}

/** A chip of text, like a mention. */
class InlineChipNode extends InlineImageNode {
  $config() {
    return this.config('test_table_mouse_drag_chip', {
      extends: InlineImageNode,
    });
  }
  createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.style.cssText = `display:inline-block;width:${SIZE}px;height:${SIZE}px;background:#ccc;overflow:hidden`;
    span.textContent = '@abcdef';
    return span;
  }
}

/**
 * A 1x2 table whose first cell holds "Cell A text" and whose second starts
 * with an inline image, or with `Decorator` between text, above a paragraph
 * of "below the table".
 */
function mount(Decorator: typeof InlineImageNode = InlineImageNode) {
  const root = document.createElement('div');
  root.id = 'table-mouse-drag-root';
  root.contentEditable = 'true';
  root.style.cssText = 'width:380px;padding:10px;font-size:16px';
  document.body.appendChild(root);
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => {
        $getRoot()
          .clear()
          .append(
            $createTableNode().append(
              $createTableRowNode().append(
                $createTableCellNode().append(
                  $createParagraphNode().append($createTextNode('Cell A text')),
                ),
                $createTableCellNode().append(
                  $createParagraphNode().append(
                    ...(Decorator === InlineImageNode
                      ? []
                      : [$createTextNode('B ')]),
                    $create(Decorator),
                    $createTextNode(' B'),
                  ),
                ),
              ),
            ),
            $createParagraphNode().append($createTextNode('below the table')),
          );
      },
      dependencies: [RichTextExtension, TableExtension],
      name: '[table-mouse-drag]',
      nodes: [InlineImageNode, InlineChipNode],
      theme: {tableScrollableWrapper: ''},
    }),
  );
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
  });
  const rootRect = root.getBoundingClientRect();
  const boxOf = (dom: Element | Range) => {
    const rect = dom.getBoundingClientRect();
    return {
      bottom: rect.bottom - rootRect.top,
      left: rect.left - rootRect.left,
      right: rect.right - rootRect.left,
      top: rect.top - rootRect.top,
    };
  };
  const cellText = root.querySelector('td [data-lexical-text]')?.firstChild;
  assert(isDOMTextNode(cellText), 'Expected the text of the first cell');
  const textRange = document.createRange();
  textRange.selectNodeContents(cellText);
  const decorator = root.querySelector('td [data-lexical-decorator]');
  assert(decorator !== null, 'Expected the decorator in the second cell');
  // The image in it, or the chip itself.
  const image = decorator.firstElementChild || decorator;
  const below = root.querySelector(':scope > p');
  assert(below !== null, 'Expected the paragraph below the table');
  return {
    below: boxOf(below),
    cellText,
    cellTextBox: boxOf(textRange),
    editor,
    image: boxOf(image),
  };
}

/**
 * Records the DOM selection writes made from here until the test finishes,
 * each with whether the editor held a TableSelection when it was made. The
 * table removes the DOM ranges for its own selection, so these are Lexical's
 * own writes: the reconciler's, and those that carry a drag across inline
 * decorators.
 */
function recordDOMSelectionWrites(editor: LexicalEditor) {
  const writes: {anchorNode: Node; isTableSelected: boolean}[] = [];
  let isTableSelected = false;
  onTestFinished(
    editor.registerUpdateListener(({editorState}) => {
      isTableSelected = editorState.read(
        () => $isTableSelection($getSelection()),
        {editor},
      );
    }),
  );
  const {extend, setBaseAndExtent} = Selection.prototype;
  const setBaseAndExtentSpy = vi
    .spyOn(Selection.prototype, 'setBaseAndExtent')
    .mockImplementation(function (
      this: Selection,
      anchorNode,
      anchorOffset,
      focusNode,
      focusOffset,
    ) {
      writes.push({anchorNode, isTableSelected});
      setBaseAndExtent.call(
        this,
        anchorNode,
        anchorOffset,
        focusNode,
        focusOffset,
      );
    });
  const extendSpy = vi
    .spyOn(Selection.prototype, 'extend')
    .mockImplementation(function (this: Selection, node, offset) {
      const {anchorNode} = this;
      assert(anchorNode !== null, 'Expected a DOM selection to extend');
      writes.push({anchorNode, isTableSelected});
      extend.call(this, node, offset);
    });
  onTestFinished(() => {
    setBaseAndExtentSpy.mockRestore();
    extendSpy.mockRestore();
  });
  return writes;
}

function describeWrites(
  writes: ReturnType<typeof recordDOMSelectionWrites>,
): string {
  return writes
    .map(
      ({anchorNode, isTableSelected}) =>
        `${anchorNode.nodeName}${isTableSelected ? '(table)' : ''}`,
    )
    .join(' ');
}

test.each([
  ['an inline image', InlineImageNode],
  ['a chip of text', InlineChipNode],
])(
  'a drag from a cell to %s in the next cell leaves the cells to the table',
  async (_name, Decorator) => {
    const {cellTextBox, editor, image} = mount(Decorator);
    const writes = recordDOMSelectionWrites(editor);
    const textY = (cellTextBox.top + cellTextBox.bottom) / 2;
    const imageY = (image.top + image.bottom) / 2;
    await commands.mouseDrag(
      '#table-mouse-drag-root',
      [
        [cellTextBox.left + 20, textY],
        [cellTextBox.right - 5, textY],
        [image.left + SIZE / 4, imageY],
        [image.left + SIZE / 2, imageY],
        [image.left + SIZE / 4, imageY],
      ],
      {maxStep: SIZE / 2},
    );
    await vi.waitFor(() =>
      assert(
        editor.read('latest', () => $isTableSelection($getSelection())),
        'expected a table selection',
      ),
    );
    assert(
      !writes.some(({isTableSelected}) => isTableSelected),
      `expected no DOM selection writes once the table selected the cells, got ${describeWrites(writes)}`,
    );
  },
);

test('a drag out of a table below it leaves the table selected whole', async () => {
  const {below, cellText, cellTextBox, editor} = mount();
  const writes = recordDOMSelectionWrites(editor);
  const textY = (cellTextBox.top + cellTextBox.bottom) / 2;
  const belowY = (below.top + below.bottom) / 2;
  await commands.mouseDrag(
    '#table-mouse-drag-root',
    [
      [cellTextBox.left + 20, textY],
      [cellTextBox.left + 20, belowY],
      [below.left + 60, belowY],
      [below.left + 120, belowY],
    ],
    {maxStep: SIZE / 2},
  );
  await vi.waitFor(() =>
    assert(
      editor.read('latest', () => {
        const selection = $getSelection();
        return (
          $isRangeSelection(selection) &&
          !selection.isCollapsed() &&
          selection.anchor.getNode().getType() === 'tablecell'
        );
      }),
      'expected the anchor at the start of the table',
    ),
  );
  // The table moves the anchor to its start when the drag leaves it, and the
  // drag must not move it back into the cell.
  const firstTableAnchor = writes.findIndex(
    ({anchorNode}) => anchorNode.nodeName === 'TD',
  );
  assert(
    firstTableAnchor === -1 ||
      !writes
        .slice(firstTableAnchor)
        .some(({anchorNode}) => anchorNode === cellText),
    `expected the anchor to stay at the start of the table, got ${describeWrites(writes)}`,
  );
});

/**
 * The Shift-click of the tests below. With `isSelectionChangeLate`, the editor
 * gets none of the selectionchanges of the press before its click.
 */
async function shiftClickIntoNextCell(isSelectionChangeLate: boolean) {
  const {cellTextBox, editor, image} = mount();
  const textY = (cellTextBox.top + cellTextBox.bottom) / 2;
  await commands.mouseDrag('#table-mouse-drag-root', [
    [cellTextBox.left + 20, textY],
  ]);
  const root = editor.getRootElement();
  assert(root !== null, 'Expected the root element');
  // A table selection removes the native one, and macOS Chromium then puts a
  // caret at the start of the focused editor as it handles the release. The
  // selectionchange of a click as quick as a test's comes after that, and
  // the editor, which handled the press at the release, must not take that
  // caret for the press's selection.
  onTestFinished(
    registerEventListener(window, 'click', () => {
      const domSelection = window.getSelection();
      if (domSelection !== null && domSelection.rangeCount === 0) {
        domSelection.collapse(root, 0);
      }
    }),
  );
  if (isSelectionChangeLate) {
    // Firefox reports the changes made until it dispatches a selectionchange
    // in that one, so the editor gets none from the press before the click,
    // and then one that reports the caret.
    let isPressed = false;
    onTestFinished(
      registerEventListeners(
        window,
        {
          click: () => {
            isPressed = false;
          },
          pointerdown: () => {
            isPressed = true;
          },
          selectionchange: event => {
            if (isPressed) {
              event.stopImmediatePropagation();
            }
          },
        },
        true,
      ),
    );
  }
  const cellBox = root.querySelectorAll('td')[1].getBoundingClientRect();
  await commands.mouseDrag(
    '#table-mouse-drag-root',
    [
      [
        cellBox.right - root.getBoundingClientRect().left - 8,
        (image.top + image.bottom) / 2,
      ],
    ],
    {modifiers: ['Shift'], quickStart: true},
  );
  editor.read('latest', () => {
    const selection = $getSelection();
    assert(
      $isTableSelection(selection),
      `expected a table selection, got ${selection && selection.constructor.name}`,
    );
    const [cellA, cellB] = Array.from(root.querySelectorAll('td'), cell =>
      $getNearestNodeFromDOMNode(cell),
    );
    assert(
      selection.anchor.getNode().is(cellA) &&
        selection.focus.getNode().is(cellB),
      'expected the selection from the first cell to the second',
    );
  });
}

test('a caret put at the start of the editor after a Shift-click into the next cell leaves the cells selected', () =>
  shiftClickIntoNextCell(false));

// In Firefox the table makes its selection of the cells at the press, which
// it cancels, so that the browser selects nothing from it. The release and
// its click can come before the selectionchange of the native selection that
// the table removed, when Firefox draws a frame in between, and that
// selectionchange then reports the caret. Chromium and WebKit select from the
// press, which the table does not cancel there, and the editor takes their
// selection at the release when the selectionchange comes later: the first
// case only reaches that path when the timing allows (never in WebKit here),
// and this one always does.
test('a caret put at the start of the editor after a Shift-click into the next cell, whose selectionchange comes after its click, leaves the cells selected', () =>
  shiftClickIntoNextCell(true));
