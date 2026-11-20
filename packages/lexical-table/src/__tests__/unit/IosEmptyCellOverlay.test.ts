/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {$generateHtmlFromNodes} from '@lexical/html';
import {
  $createTableNodeWithDimensions,
  type TableCellNode,
  TableExtension,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getNearestNodeFromDOMNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  defineExtension,
  type ElementNode,
  isDOMUnmanaged,
  type LexicalEditorWithDispose,
} from 'lexical';
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

// `vi.mock` is hoisted above all imports, so @lexical/table sees iOS.
vi.mock('lexical/src/environment', async importOriginal => ({
  ...(await importOriginal<typeof import('lexical/src/environment')>()),
  IS_IOS: true,
}));

const OVERLAY = '[data-lexical-table-empty-cell-overlay]';

// After a touch tap in an empty cell, the cell is briefly covered so the
// second tap of a double tap never lands on editable text (#9347).
describe('iOS empty table cell overlay', () => {
  let container: HTMLDivElement;
  let editor: LexicalEditorWithDispose;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    container.contentEditable = 'true';
    document.body.appendChild(container);
    editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [TableExtension],
        name: '@lexical/table/IosEmptyCellOverlayTest',
        theme: {tableScrollableWrapper: ''},
      }),
    );
    editor.setRootElement(container);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('before')),
            $createTableNodeWithDimensions(1, 2, false),
          );
      },
      {discrete: true},
    );
    // Cell 0 stays empty; cell 1 has text.
    editor.update(
      () => {
        $paragraph(1).append($createTextNode('word'));
      },
      {discrete: true},
    );
  });

  afterEach(() => {
    editor.dispose();
    document.body.removeChild(container);
    vi.useRealTimers();
  });

  function cellDOM(index: number): HTMLElement {
    return container.querySelectorAll('td')[index];
  }

  function overlayOf(index: number): HTMLElement | null {
    return cellDOM(index).querySelector(`:scope > ${OVERLAY}`);
  }

  function $cell(index: number): TableCellNode {
    return $getNearestNodeFromDOMNode(cellDOM(index)) as TableCellNode;
  }

  function $paragraph(index: number): ElementNode {
    const paragraph = $cell(index).getFirstChildOrThrow();
    assert($isElementNode(paragraph), 'expected the cell to hold a block');
    return paragraph;
  }

  function pointer(
    target: Element,
    type: string,
    pointerType = 'touch',
    clientX = 0,
  ): PointerEvent {
    const event = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      pointerType,
    });
    target.dispatchEvent(event);
    return event;
  }

  function touch(target: EventTarget, type: string): void {
    const event = new Event(type, {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'touches', {value: {length: 0}});
    // Lexical's own iOS touchend listener reads changedTouches.
    Object.defineProperty(event, 'changedTouches', {value: []});
    target.dispatchEvent(event);
  }

  function paragraphOf(index: number): HTMLElement {
    return cellDOM(index).querySelector('p')!;
  }

  function tapCell(index: number, pointerType = 'touch'): void {
    pointer(paragraphOf(index), 'pointerdown', pointerType);
    pointer(paragraphOf(index), 'pointerup', pointerType);
  }

  test('a tap covers an empty cell for the double-tap window', () => {
    expect(container.querySelectorAll(OVERLAY)).toHaveLength(0);
    const position = cellDOM(0).style.position;
    tapCell(0);
    const overlay = overlayOf(0)!;
    expect(overlay.getAttribute('contenteditable')).toBe('false');
    expect(isDOMUnmanaged(overlay)).toBe(true);
    expect(cellDOM(0).lastElementChild).toBe(overlay);
    expect(cellDOM(0).style.position).toBe('relative');
    vi.advanceTimersByTime(500);
    // Uncovered again, so a later long press reaches editable content.
    expect(overlayOf(0)).toBe(null);
    expect(cellDOM(0).style.position).toBe(position);
  });

  test('the cell holding the caret is covered on pointerdown', () => {
    // A touch elsewhere waits for pointerup.
    pointer(paragraphOf(0), 'pointerdown');
    expect(overlayOf(0)).toBe(null);
    // iOS holds back this tap's pointerup until the next tap has started.
    document.getSelection()!.collapse(paragraphOf(0), 0);
    pointer(paragraphOf(0), 'pointerdown');
    const overlay = overlayOf(0);
    expect(overlay).not.toBe(null);
    // The same tap's pointerup keeps that overlay rather than rebuilding it.
    pointer(paragraphOf(0), 'pointerup');
    expect(overlayOf(0)).toBe(overlay);
  });

  test.each([
    [
      'a drag',
      () => {
        pointer(paragraphOf(0), 'pointerdown', 'touch', 0);
        pointer(paragraphOf(0), 'pointerup', 'touch', 80);
      },
    ],
    [
      'a long press',
      () => {
        pointer(paragraphOf(0), 'pointerdown');
        vi.advanceTimersByTime(700);
        pointer(paragraphOf(0), 'pointerup');
      },
    ],
    [
      'a touch iOS takes over',
      () => {
        pointer(paragraphOf(0), 'pointerdown');
        pointer(paragraphOf(0), 'pointercancel');
        const touchEnd = new Event('touchend', {
          bubbles: true,
          cancelable: true,
        });
        // Lexical's own iOS touchend listener reads changedTouches.
        Object.defineProperty(touchEnd, 'changedTouches', {value: []});
        paragraphOf(0).dispatchEvent(touchEnd);
      },
    ],
    ['a mouse click', () => tapCell(0, 'mouse')],
    [
      'a tap while read-only',
      () => {
        editor.setEditable(false);
        tapCell(0);
      },
    ],
  ])('leaves the cell uncovered after %s', (_, act) => {
    act();
    expect(overlayOf(0)).toBe(null);
  });

  test('a tap in a cell with text, or in another cell, uncovers', () => {
    tapCell(1);
    expect(overlayOf(1)).toBe(null);
    editor.update(
      () => {
        $paragraph(1).clear();
      },
      {discrete: true},
    );
    tapCell(0);
    tapCell(1);
    expect(overlayOf(0)).toBe(null);
    expect(overlayOf(1)).not.toBe(null);
  });

  test('a tap on the overlay keeps focus and places the caret in its cell', () => {
    tapCell(0);
    const overlay = overlayOf(0)!;
    // Not letting the tap blur the editor keeps the iOS keyboard up.
    expect(pointer(overlay, 'pointerdown').defaultPrevented).toBe(true);
    pointer(overlay, 'pointerup');
    overlay.dispatchEvent(
      new MouseEvent('click', {bubbles: true, cancelable: true, detail: 2}),
    );
    expect(document.activeElement).toBe(container);
    editor.read(() => {
      const selection = $getSelection();
      expect(
        $isRangeSelection(selection) &&
          selection.isCollapsed() &&
          $cell(0).isParentOf(selection.anchor.getNode()),
      ).toBe(true);
    });
  });

  test('a touch on the overlay that outlasts it still restores the caret', () => {
    tapCell(0);
    const overlay = overlayOf(0)!;
    vi.advanceTimersByTime(420);
    touch(overlay, 'touchstart');
    expect(container.style.caretColor).toBe('transparent');
    // The window ends and the overlay goes while the finger is still down.
    vi.advanceTimersByTime(150);
    expect(overlay.isConnected).toBe(false);
    // The lift is dispatched to the detached overlay only.
    touch(overlay, 'touchend');
    expect(container.style.caretColor).toBe('');
  });

  test('stays after managed children, out of exported HTML, and goes once the cell has text', () => {
    tapCell(0);
    editor.update(
      () => {
        $cell(0).append($createParagraphNode());
      },
      {discrete: true},
    );
    expect(Array.from(cellDOM(0).children).map(child => child.tagName)).toEqual(
      ['P', 'P', 'DIV'],
    );
    const html = editor.read(() => $generateHtmlFromNodes(editor));
    expect(html).not.toContain('data-lexical-table-empty-cell-overlay');
    expect(html).toMatch(/<td[^>]*>\s*<p/);
    editor.update(
      () => {
        $paragraph(0).append($createTextNode('typed'));
      },
      {discrete: true},
    );
    expect(overlayOf(0)).toBe(null);
  });
});
