/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  CheckListExtension,
} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {$createParagraphNode, $createTextNode, $getRoot} from 'lexical';
import {invariant} from 'lexical/src/__tests__/utils';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

describe('CheckListExtension mobile tap toggle', () => {
  // jsdom does not implement getComputedStyle with pseudo-elements
  // (https://github.com/jsdom/jsdom/issues/1928), but the checklist
  // hit-test reads the ::before width to size the marker area. Stub a
  // 16px width so the bounds check resolves to a concrete number.
  const originalGetComputedStyle = window.getComputedStyle;
  beforeAll(() => {
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element: Element, pseudoElement?: string | null) => {
        if (pseudoElement === '::before') {
          return {width: '16px'} as unknown as CSSStyleDeclaration;
        }
        return originalGetComputedStyle.call(window, element, pseudoElement);
      },
    );
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  const checkListExtension = defineExtension({
    $initialEditorState: () => {
      const list = $createListNode('check');
      list.append($createListItemNode(false));
      list.append($createListItemNode(false));
      $getRoot().append(list);
    },
    dependencies: [CheckListExtension, RichTextExtension],
    name: '[checklist-test]',
  });

  let container: HTMLDivElement;
  let rootElement: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    rootElement = document.createElement('div');
    rootElement.contentEditable = 'true';
    container.appendChild(rootElement);
  });
  afterEach(() => {
    document.body.removeChild(container);
  });

  function buildEditor() {
    const editor = buildEditorFromExtensions(checkListExtension);
    editor.setRootElement(rootElement);
    return editor;
  }

  function getCheckListItem(index = 0): HTMLLIElement {
    const items = rootElement.querySelectorAll('li');
    const li = items[index];
    invariant(li !== undefined, `No <li> at index ${index}`);
    return li as HTMLLIElement;
  }

  function readChecked(
    editor: ReturnType<typeof buildEditor>,
    index: number,
  ): boolean {
    return editor.read(() => {
      const list = $getRoot().getFirstChildOrThrow();
      invariant($isListNode(list), 'Expected a ListNode at root');
      const item = list.getChildAtIndex(index);
      invariant($isListItemNode(item), `Expected ListItemNode at ${index}`);
      return item.getChecked() === true;
    });
  }

  it('touch pointerup over the marker area toggles the item', () => {
    using editor = buildEditor();
    expect(readChecked(editor, 0)).toBe(false);

    const li = getCheckListItem(0);
    // clientX is well inside the marker hit area for any plausible
    // ::before width / touch padding combination.
    li.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 5,
        pointerType: 'touch',
      }),
    );

    expect(readChecked(editor, 0)).toBe(true);
  });

  // Touch pointers are captured by the element they went down on, so the
  // pointerup of a swipe that starts on a check mark is still dispatched to
  // its item, at the point where the finger lifted.
  function touch(
    target: HTMLLIElement,
    type: 'pointerdown' | 'pointerup',
    clientY: number,
    clientX = 10,
  ) {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        pointerId: 1,
        pointerType: 'touch',
      }),
    );
  }

  it('a touch that moves before lifting does not toggle the item', () => {
    using editor = buildEditor();
    const li = getCheckListItem(0);
    touch(li, 'pointerdown', 5);
    touch(li, 'pointerup', 205);
    expect(readChecked(editor, 0)).toBe(false);
  });

  it('a tap that moves a few pixels still toggles the item', () => {
    using editor = buildEditor();
    const li = getCheckListItem(0);
    // 8px along each axis, as core's tap detection allows
    touch(li, 'pointerdown', 5, 10);
    touch(li, 'pointerup', 13, 18);
    expect(readChecked(editor, 0)).toBe(true);
  });

  it('mouse pointerup is ignored (click stays the desktop path)', () => {
    using editor = buildEditor();
    expect(readChecked(editor, 0)).toBe(false);

    const li = getCheckListItem(0);
    li.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 5,
        pointerType: 'mouse',
      }),
    );

    expect(readChecked(editor, 0)).toBe(false);
  });

  it('pointerup followed by a synthesized click does not double-toggle', () => {
    using editor = buildEditor();
    expect(readChecked(editor, 0)).toBe(false);

    const li = getCheckListItem(0);
    const baseTimeStamp = 1000;
    const pointerUp = new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 5,
      pointerType: 'touch',
    });
    Object.defineProperty(pointerUp, 'timeStamp', {value: baseTimeStamp});
    li.dispatchEvent(pointerUp);
    expect(readChecked(editor, 0)).toBe(true);

    // Browsers where touchstart preventDefault did not suppress click
    // also fire it shortly after. The dedup window must absorb it.
    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 5,
    });
    Object.defineProperty(click, 'timeStamp', {value: baseTimeStamp + 50});
    li.dispatchEvent(click);

    expect(readChecked(editor, 0)).toBe(true);
  });

  it('rapid taps on two different items toggle both within the dedup window', () => {
    using editor = buildEditor();
    expect(readChecked(editor, 0)).toBe(false);
    expect(readChecked(editor, 1)).toBe(false);

    const baseTimeStamp = 1000;
    const tap = (target: HTMLLIElement, offsetMs: number) => {
      const event = new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 5,
        pointerType: 'touch',
      });
      Object.defineProperty(event, 'timeStamp', {
        value: baseTimeStamp + offsetMs,
      });
      target.dispatchEvent(event);
    };

    tap(getCheckListItem(0), 0);
    // 100ms later: well inside DEDUP_WINDOW_MS, tap a different box.
    tap(getCheckListItem(1), 100);

    expect(readChecked(editor, 0)).toBe(true);
    expect(readChecked(editor, 1)).toBe(true);
  });

  it('rapid mouse clicks on the same item all toggle (desktop not throttled)', () => {
    using editor = buildEditor();
    expect(readChecked(editor, 0)).toBe(false);

    const baseTimeStamp = 1000;
    const click = (offsetMs: number) => {
      const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 5,
      });
      Object.defineProperty(event, 'timeStamp', {
        value: baseTimeStamp + offsetMs,
      });
      getCheckListItem(0).dispatchEvent(event);
    };

    // Two rapid mouse clicks within the dedup window must both toggle.
    click(0);
    click(100);

    expect(readChecked(editor, 0)).toBe(false);
  });

  it('rapid touch taps on the same item are throttled (mobile preserved)', () => {
    using editor = buildEditor();
    expect(readChecked(editor, 0)).toBe(false);

    const baseTimeStamp = 1000;
    const tap = (offsetMs: number) => {
      const event = new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 5,
        pointerType: 'touch',
      });
      Object.defineProperty(event, 'timeStamp', {
        value: baseTimeStamp + offsetMs,
      });
      getCheckListItem(0).dispatchEvent(event);
    };

    // First tap toggles, second tap within DEDUP_WINDOW_MS is throttled.
    tap(0);
    tap(100);

    expect(readChecked(editor, 0)).toBe(true);
  });
});

describe('CheckListExtension Space after a click on a check mark', () => {
  // A click on a check mark focuses its item and leaves the caret where it
  // was, here at the end of the paragraph above the list.
  const extension = defineExtension({
    $initialEditorState: () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('Owners sign off')),
        $createListNode('check').append(
          $createListItemNode(false).append($createTextNode('Task')),
        ),
      );
    },
    dependencies: [CheckListExtension, RichTextExtension],
    name: '[checklist-space-test]',
  });

  let rootElement: HTMLDivElement;
  beforeEach(() => {
    rootElement = document.createElement('div');
    rootElement.contentEditable = 'true';
    document.body.appendChild(rootElement);
  });
  afterEach(() => {
    rootElement.remove();
  });

  function focusItemWithCaret(
    editor: ReturnType<typeof buildEditorFromExtensions>,
    $placeCaret: () => void,
  ): HTMLLIElement {
    editor.setRootElement(rootElement);
    editor.update($placeCaret, {discrete: true});
    const li = rootElement.querySelector('li');
    invariant(li !== null, 'No <li>');
    li.focus();
    expect(document.activeElement).toBe(li);
    return li;
  }

  function pressSpace(target: HTMLElement): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: ' ',
    });
    target.dispatchEvent(event);
    return event;
  }

  function isChecked(
    editor: ReturnType<typeof buildEditorFromExtensions>,
  ): boolean {
    return editor.read(() => {
      const list = $getRoot().getLastChildOrThrow();
      invariant($isListNode(list), 'Expected a ListNode');
      const item = list.getFirstChildOrThrow();
      invariant($isListItemNode(item), 'Expected a ListItemNode');
      return item.getChecked() === true;
    });
  }

  it('leaves the item alone and gives the Space to a caret in another block', () => {
    using editor = buildEditorFromExtensions(extension);
    const li = focusItemWithCaret(editor, () => {
      $getRoot().getFirstChildOrThrow().selectEnd();
    });
    const event = pressSpace(li);
    expect(isChecked(editor)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(rootElement);
  });

  it.each([
    ['from the paragraph into the item', false],
    ['from the item into the paragraph', true],
  ])('gives the Space to a selection that reaches %s', (_, isBackward) => {
    using editor = buildEditorFromExtensions(extension);
    const li = focusItemWithCaret(editor, () => {
      const [paragraphText, itemText] = $getRoot().getAllTextNodes();
      invariant(
        paragraphText !== undefined && itemText !== undefined,
        'Expected text in the paragraph and the item',
      );
      const inParagraph = [paragraphText.getKey(), 6] as const;
      const inItem = [itemText.getKey(), 2] as const;
      const [anchor, focus] = isBackward
        ? [inItem, inParagraph]
        : [inParagraph, inItem];
      const selection = $getRoot().select();
      selection.anchor.set(anchor[0], anchor[1], 'text');
      selection.focus.set(focus[0], focus[1], 'text');
    });
    const event = pressSpace(li);
    expect(isChecked(editor)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(rootElement);
  });

  it('toggles the item when the caret is in it', () => {
    using editor = buildEditorFromExtensions(extension);
    const li = focusItemWithCaret(editor, () => {
      $getRoot().getLastChildOrThrow().selectStart();
    });
    const event = pressSpace(li);
    expect(isChecked(editor)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });
});
