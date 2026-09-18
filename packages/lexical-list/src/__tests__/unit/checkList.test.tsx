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
import {$getRoot} from 'lexical';
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
