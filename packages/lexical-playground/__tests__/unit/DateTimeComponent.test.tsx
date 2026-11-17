/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $getRoot,
  $nodesOfType,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, assert, beforeAll, describe, expect, it, vi} from 'vitest';

import {
  $createDateTimeNodeFromValue,
  DateTimeNode,
} from '../../src/nodes/DateTimeNode/DateTimeNode';

// The value of a timed chip at a local time, so the tests hold in any zone
function localInstant(
  year: number,
  month: number,
  day: number,
  hours = 0,
  minutes = 0,
): string {
  return new Date(year, month - 1, day, hours, minutes).toISOString();
}

let editor: LexicalEditor;
let container: HTMLDivElement;
let reactRoot: Root;

function Capture() {
  [editor] = useLexicalComposerContext();
  return null;
}

async function mountChip(value: string): Promise<void> {
  const extension = defineExtension({
    $initialEditorState: () => {
      const node =
        value === '' ? new DateTimeNode() : $createDateTimeNodeFromValue(value);
      assert(node !== null, 'expected a DateTimeNode');
      $getRoot().clear().append($createParagraphNode().append(node));
    },
    dependencies: [RichTextExtension],
    name: '[test-datetime-component]',
    nodes: [DateTimeNode],
  });
  container = document.createElement('div');
  document.body.append(container);
  reactRoot = createRoot(container);
  await act(async () => {
    reactRoot.render(
      <LexicalExtensionComposer extension={extension}>
        <Capture />
      </LexicalExtensionComposer>,
    );
  });
  // The component is loaded with React.lazy
  await act(() =>
    vi.waitFor(() => assert(getChip() !== null, 'expected the chip to render')),
  );
}

beforeAll(async () => {
  // Load the lazy component once, so each test only waits for React
  await import('../../src/nodes/DateTimeNode/DateTimeComponent');
});

afterEach(async () => {
  await act(async () => reactRoot.unmount());
  container.remove();
});

function getChip(): HTMLElement | null {
  return container.querySelector('.dateTimePill');
}

function getCheckbox(): HTMLInputElement {
  const checkbox = document.querySelector('.dateTimePicker [type=checkbox]');
  assert(checkbox instanceof HTMLInputElement, 'expected the checkbox');
  return checkbox;
}

function getTimeInput(): HTMLInputElement {
  const input = document.querySelector('.dateTimePicker [type=time]');
  assert(input instanceof HTMLInputElement, 'expected the time input');
  return input;
}

function readValue(): string {
  return editor.read(() => $nodesOfType(DateTimeNode)[0].getDateTimeValue());
}

function readPicker(): [boolean, string] {
  return [getCheckbox().checked, getTimeInput().value];
}

async function openPicker(): Promise<void> {
  await act(async () => getChip()!.click());
}

async function closePicker(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {bubbles: true, key: 'Escape'}),
    );
  });
}

async function clickCheckbox(): Promise<void> {
  await act(async () => getCheckbox().click());
}

const setInputValue = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'value',
)!.set!;

async function typeTime(time: string): Promise<void> {
  await act(async () => {
    const input = getTimeInput();
    setInputValue.call(input, time);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
}

// Clicks a day other than the selected one and returns it as YYYY-MM-DD
async function pickOtherDay(): Promise<string> {
  const day = Array.from(
    document.querySelectorAll('.dateTimePicker [data-day]'),
  ).find(cell => cell.getAttribute('aria-selected') !== 'true');
  const button = day?.querySelector('button');
  assert(day && button, 'expected a day to pick');
  await act(async () => button.click());
  return day.getAttribute('data-day')!;
}

function localInstantOn(day: string, hours: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return localInstant(year, month, date, hours);
}

// What undo, redo and a collaborator do: the node changes from outside
async function setValueFromOutside(value: string): Promise<void> {
  await act(async () => {
    editor.update(
      () => {
        const node = $nodesOfType(DateTimeNode)[0];
        if (value.length === 10) {
          const [year, month, day] = value.split('-').map(Number);
          node.setAllDayDate(new Date(year, month - 1, day));
        } else {
          node.setDateTime(new Date(value));
        }
      },
      {discrete: true, tag: 'collaboration'},
    );
  });
}

async function restoreState(
  state: ReturnType<LexicalEditor['getEditorState']>,
): Promise<void> {
  await act(async () => editor.setEditorState(state));
}

describe('DateTimeComponent', () => {
  it('shows the chip text from the node', async () => {
    await mountChip('2026-11-04');
    expect(getChip()!.textContent).toBe('Wed Nov 04 2026');
  });

  it('shows the time of a timed chip', async () => {
    const value = localInstant(2026, 11, 4, 9);
    await mountChip(value);
    expect(getChip()!.textContent).toBe(
      `${new Date(value).toDateString()} 09:00`,
    );
  });

  it('(a) keeps a picked day all-day after checking the time box', async () => {
    await mountChip('2026-11-04');
    await openPicker();
    await clickCheckbox();
    expect(readPicker()).toEqual([true, '']);
    expect(readValue()).toBe('2026-11-04');
    const day = await pickOtherDay();
    expect(readValue()).toBe(day);
    expect(readPicker()).toEqual([true, '']);
  });

  it('(b) makes a timed chip all-day when the time box is cleared', async () => {
    await mountChip(localInstant(2026, 11, 4, 9));
    await openPicker();
    expect(readPicker()).toEqual([true, '09:00']);
    await clickCheckbox();
    expect(readPicker()).toEqual([false, '']);
    expect(readValue()).toBe('2026-11-04');
    await clickCheckbox();
    expect(readPicker()).toEqual([true, '']);
    expect(readValue()).toBe('2026-11-04');
  });

  it('(c) keeps typing when the time passes through 00:00', async () => {
    await mountChip('2026-11-04');
    await openPicker();
    await clickCheckbox();
    for (const time of ['01:00', '00:00', '12:30']) {
      await typeTime(time);
      expect(readPicker()).toEqual([true, time]);
    }
    expect(readValue()).toBe(localInstant(2026, 11, 4, 12, 30));
  });

  it('(n) keeps a typed 00:00 when a day is picked', async () => {
    await mountChip('2026-11-04');
    await openPicker();
    await clickCheckbox();
    await typeTime('00:00');
    const day = await pickOtherDay();
    expect(readValue()).toBe(localInstantOn(day, 0));
    expect(readPicker()).toEqual([true, '00:00']);
  });

  it('(o) keeps the time box checked when a timed chip is set to 00:00', async () => {
    await mountChip(localInstant(2026, 11, 4, 9));
    await openPicker();
    await typeTime('00:00');
    expect(readPicker()).toEqual([true, '00:00']);
    expect(readValue()).toBe(localInstant(2026, 11, 4));
  });

  // An instant at local midnight shows without a time, but it can be a time
  // set in another time zone (09:00 in Seoul is 00:00 in London) or a typed
  // 00:00, so picking a day must not turn it into an all-day date
  it('(p) keeps a timed chip at local midnight timed when a day is picked', async () => {
    await mountChip(localInstant(2026, 11, 4));
    await openPicker();
    const day = await pickOtherDay();
    expect(readValue()).toBe(localInstantOn(day, 0));
  });

  it('(q) keeps a typed 00:00 when a day is picked after reopening', async () => {
    await mountChip('2026-11-04');
    await openPicker();
    await clickCheckbox();
    await typeTime('00:00');
    await closePicker();
    await openPicker();
    const day = await pickOtherDay();
    expect(readValue()).toBe(localInstantOn(day, 0));
  });

  it('(d) keeps the stored time when the time field is empty', async () => {
    await mountChip(localInstant(2026, 11, 4, 9));
    await openPicker();
    await typeTime('');
    expect(readPicker()).toEqual([true, '']);
    expect(readValue()).toBe(localInstant(2026, 11, 4, 9));
    const day = await pickOtherDay();
    expect(readValue()).toBe(localInstantOn(day, 9));
  });

  it('(e) gives a chip without a date an all-day date', async () => {
    await mountChip('');
    await openPicker();
    await clickCheckbox();
    await clickCheckbox();
    expect(readValue()).toBe('');
    const day = await pickOtherDay();
    expect(readValue()).toBe(day);
  });

  it('(f) drops the typed time when the picker closes', async () => {
    await mountChip(localInstant(2026, 11, 4, 9));
    await openPicker();
    await typeTime('');
    await closePicker();
    await openPicker();
    expect(readPicker()).toEqual([true, '09:00']);
  });

  it('(k) clears the time box and keeps the next day all-day', async () => {
    await mountChip('2026-11-04');
    await openPicker();
    await clickCheckbox();
    await typeTime('10:00');
    await clickCheckbox();
    expect(readPicker()).toEqual([false, '']);
    expect(readValue()).toBe('2026-11-04');
    const day = await pickOtherDay();
    expect(readValue()).toBe(day);
  });

  // In Pacific/Apia, 2011-12-30 has no local midnight to round-trip through
  it('(m) does not rewrite an all-day date when the time box is toggled', async () => {
    await mountChip('2011-12-30');
    await openPicker();
    await clickCheckbox();
    await clickCheckbox();
    expect(readValue()).toBe('2011-12-30');
  });
});

describe('DateTimeComponent with outside changes', () => {
  it('(g) unchecks to the date another user picked', async () => {
    await mountChip(localInstant(2026, 11, 4, 9));
    await openPicker();
    await setValueFromOutside(localInstant(2026, 11, 7, 10));
    await clickCheckbox();
    expect(readValue()).toBe('2026-11-07');
  });

  it('(h) drops a checked time box when the date changes outside', async () => {
    await mountChip('2026-11-04');
    await openPicker();
    await clickCheckbox();
    await setValueFromOutside('2026-11-07');
    expect(readPicker()).toEqual([false, '']);
  });

  it('(i) shows the new time over an emptied time field', async () => {
    await mountChip(localInstant(2026, 11, 4, 9));
    await openPicker();
    await typeTime('');
    await setValueFromOutside(localInstant(2026, 11, 4, 8));
    expect(readPicker()).toEqual([true, '08:00']);
  });

  it('(j) follows undo between all-day and timed', async () => {
    await mountChip('2026-11-04');
    const allDay = editor.getEditorState();
    await openPicker();
    await clickCheckbox();
    await typeTime('10:00');
    const timed = editor.getEditorState();
    await restoreState(allDay);
    expect(readPicker()).toEqual([false, '']);
    expect(getChip()!.textContent).toBe('Wed Nov 04 2026');
    await restoreState(timed);
    expect(readPicker()).toEqual([true, '10:00']);
  });

  it('(l) treats a redo of its own earlier change as an outside change', async () => {
    await mountChip('2026-11-04');
    await openPicker();
    const before = editor.getEditorState();
    await pickOtherDay();
    const after = editor.getEditorState();
    await restoreState(before);
    await clickCheckbox();
    expect(readPicker()).toEqual([true, '']);
    await restoreState(after);
    expect(readPicker()).toEqual([false, '']);
  });
});
