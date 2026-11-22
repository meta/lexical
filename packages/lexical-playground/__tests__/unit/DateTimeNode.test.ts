/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $generateHtmlFromNodes,
  $generateNodesFromDOMViaExtension,
} from '@lexical/html';
import {
  $create,
  $createParagraphNode,
  $getRoot,
  $insertNodes,
  $nodesOfType,
  $parseSerializedNode,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {assert, describe, expect, it, test} from 'vitest';

import {
  $createDateTimeNodeFromValue,
  DateTimeNode,
  getTimeValue,
  normalizeDateTime,
} from '../../src/nodes/DateTimeNode/DateTimeNode';
import {
  DateTimeExtension,
  INSERT_DATETIME_COMMAND,
} from '../../src/plugins/DateTimeExtension';

const DateTimeTestExtension = defineExtension({
  $initialEditorState: null,
  dependencies: [DateTimeExtension],
  name: '[test-datetime-node]',
});

function $getDateTimeNode(): DateTimeNode {
  const [node] = $nodesOfType(DateTimeNode);
  assert(node !== undefined, 'expected a DateTimeNode');
  return node;
}

// Builds the node from JSON the way a stored document, the JSON clipboard
// or a collaborator would, so `dateTime` can be any JSON value or missing.
function $importDateTimeJSON(dateTime: unknown): DateTimeNode {
  const node = $parseSerializedNode(
    JSON.parse(
      JSON.stringify({...$create(DateTimeNode).exportJSON(), dateTime}),
    ),
  );
  assert(node instanceof DateTimeNode, 'expected a DateTimeNode');
  return node;
}

function buildEditorWithDateTime(dateTime: unknown) {
  const editor = buildEditorFromExtensions(DateTimeTestExtension);
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append($createParagraphNode().append($importDateTimeJSON(dateTime)));
    },
    {discrete: true},
  );
  return editor;
}

function exportDateTimeJSON(editor: LexicalEditor) {
  return editor.read(() => $getDateTimeNode().exportJSON());
}

function countDirtyUpdates(editor: LexicalEditor): {count: number} {
  const counter = {count: 0};
  editor.registerUpdateListener(({dirtyLeaves}) => {
    if (dirtyLeaves.size > 0) {
      counter.count++;
    }
  });
  return counter;
}

function importHtml(editor: LexicalEditor, html: string) {
  editor.update(
    () => {
      $getRoot().clear().select();
      const dom = new DOMParser().parseFromString(html, 'text/html');
      $insertNodes($generateNodesFromDOMViaExtension(dom));
    },
    {discrete: true},
  );
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  return month === 2
    ? isLeapYear(year)
      ? 29
      : 28
    : [4, 6, 9, 11].includes(month)
      ? 30
      : 31;
}

describe('DateTimeNode dateTime value', () => {
  test.for([
    // A date-only value is an all-day date and is kept as written
    ['2026-11-04', '2026-11-04'],
    ['2024-02-29', '2024-02-29'],
    ['0000-02-29', '0000-02-29'],
    ['0050-06-01', '0050-06-01'],
    ['9999-12-31', '9999-12-31'],
    // A date-only value that is not a calendar date is dropped
    ['2026-02-30', undefined],
    ['2025-02-29', undefined],
    ['1900-02-29', undefined],
    // Every other value is read as an instant, the same as before
    ['2026-11-04T05:00:00.000Z', '2026-11-04T05:00:00.000Z'],
    ['2026-11-04T10:00:00+09:00', '2026-11-04T01:00:00.000Z'],
    ['-000001-01-01T00:00:00.000Z', '-000001-01-01T00:00:00.000Z'],
    ['+010000-01-01T00:00:00.000Z', '+010000-01-01T00:00:00.000Z'],
    ['2026-11-04T10:30:00', new Date('2026-11-04T10:30:00').toISOString()],
    ['2026-11-04 ', new Date('2026-11-04 ').toISOString()],
    ['x2026-11-04', undefined],
    ['+002026-11-04', '2026-11-04T00:00:00.000Z'],
    // Values that are not dates are omitted rather than throwing
    ['', undefined],
    ['not a date', undefined],
    [1730000000000, undefined],
    [null, undefined],
    [undefined, undefined],
  ] as const)('imports %j as %j', ([input, expected]) => {
    using editor = buildEditorWithDateTime(input);
    const json = exportDateTimeJSON(editor);
    if (expected === undefined) {
      expect(json).not.toHaveProperty('dateTime');
    } else {
      expect(json).toHaveProperty('dateTime', expected);
    }
  });

  it('keeps exactly the calendar dates around every month end', () => {
    const mismatches: string[] = [];
    for (let year = 0; year <= 9999; year++) {
      for (let month = 1; month <= 12; month++) {
        for (let day = 28; day <= 32; day++) {
          const value = `${String(year).padStart(4, '0')}-${String(
            month,
          ).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const expected = day <= daysInMonth(year, month) ? value : '';
          if (normalizeDateTime(value) !== expected) {
            mismatches.push(value);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  test.for([
    ['2026-01-01', 'Thu Jan 01 2026'],
    ['2026-02-01', 'Sun Feb 01 2026'],
    ['2026-03-01', 'Sun Mar 01 2026'],
    ['2026-04-01', 'Wed Apr 01 2026'],
    ['2026-05-01', 'Fri May 01 2026'],
    ['2026-06-01', 'Mon Jun 01 2026'],
    ['2026-07-01', 'Wed Jul 01 2026'],
    ['2026-08-01', 'Sat Aug 01 2026'],
    ['2026-09-01', 'Tue Sep 01 2026'],
    ['2026-10-01', 'Thu Oct 01 2026'],
    ['2026-11-04', 'Wed Nov 04 2026'],
    ['2026-12-01', 'Tue Dec 01 2026'],
    ['0000-02-29', 'Tue Feb 29 0000'],
    ['0050-06-01', 'Wed Jun 01 0050'],
    ['', 'Invalid Date'],
  ] as const)('shows %j as %j', ([value, text]) => {
    using editor = buildEditorWithDateTime(value);
    expect(editor.read(() => $getDateTimeNode().getTextContent())).toBe(text);
    const html = editor.read(() => $generateHtmlFromNodes(editor, null));
    expect(
      new DOMParser().parseFromString(html, 'text/html').body.textContent,
    ).toBe(text);
  });

  it('still shows an instant with its local time, hiding midnight', () => {
    const afterMidnight = new Date(2026, 10, 4, 0, 30);
    const morning = new Date(2026, 10, 4, 9, 5);
    const midnight = new Date(2026, 10, 4);
    using editor = buildEditorWithDateTime(morning.toISOString());
    expect(editor.read(() => $getDateTimeNode().getTextContent())).toBe(
      `${morning.toDateString()} 09:05`,
    );
    editor.update(() => void $getDateTimeNode().setDateTime(midnight), {
      discrete: true,
    });
    expect(editor.read(() => $getDateTimeNode().getTextContent())).toBe(
      midnight.toDateString(),
    );
    editor.update(() => void $getDateTimeNode().setDateTime(afterMidnight), {
      discrete: true,
    });
    expect(editor.read(() => $getDateTimeNode().getTextContent())).toBe(
      `${afterMidnight.toDateString()} 00:30`,
    );
  });

  it('gives an all-day date as local midnight, including years 0-99', () => {
    using editor = buildEditorWithDateTime('0050-06-01');
    const dateTime = editor.read(() => $getDateTimeNode().getDateTime());
    expect([
      dateTime.getFullYear(),
      dateTime.getMonth(),
      dateTime.getDate(),
      dateTime.getHours(),
      dateTime.getMinutes(),
    ]).toEqual([50, 5, 1, 0, 0]);
  });

  test.for([
    ['2026-11-04', ''],
    ['', ''],
    [new Date(2026, 10, 4, 9, 5).toISOString(), '09:05'],
    [new Date(2026, 10, 4, 0, 30).toISOString(), '00:30'],
    [new Date(2026, 10, 4).toISOString(), ''],
  ] as const)('getTimeValue(%j) is %j', ([value, time]) => {
    expect(getTimeValue(value)).toBe(time);
  });
});

describe('DateTimeNode setters', () => {
  it('writes an all-day date from the local calendar fields', () => {
    using editor = buildEditorWithDateTime('2026-11-04T05:00:00.000Z');
    const yearZero = new Date(2000, 0, 1);
    yearZero.setFullYear(0, 1, 29);
    editor.update(
      () => void $getDateTimeNode().setAllDayDate(new Date(2026, 10, 5, 13)),
      {discrete: true},
    );
    expect(
      editor.read(() => [
        $getDateTimeNode().getDateTimeValue(),
        $getDateTimeNode().isAllDay(),
      ]),
    ).toEqual(['2026-11-05', true]);
    editor.update(() => void $getDateTimeNode().setAllDayDate(yearZero), {
      discrete: true,
    });
    expect(
      editor.read(() => [
        $getDateTimeNode().getDateTimeValue(),
        $getDateTimeNode().isAllDay(),
      ]),
    ).toEqual(['0000-02-29', true]);
  });

  test.for([
    [9999, '9999-12-31', true],
    [10000, null, false],
    [-1, null, false],
  ] as const)(
    'writes year %d as an all-day date only within 0-9999',
    ([year, expected, allDay]) => {
      using editor = buildEditorWithDateTime('2026-11-04');
      const date = new Date(2000, 0, 1);
      date.setFullYear(year, 11, 31);
      editor.update(() => void $getDateTimeNode().setAllDayDate(date), {
        discrete: true,
      });
      expect(
        editor.read(() => [
          $getDateTimeNode().getDateTimeValue(),
          $getDateTimeNode().isAllDay(),
        ]),
      ).toEqual([expected ?? date.toISOString(), allDay]);
    },
  );

  it('ignores an invalid all-day date', () => {
    using editor = buildEditorWithDateTime('2026-11-04');
    editor.update(() => void $getDateTimeNode().setAllDayDate(new Date(NaN)), {
      discrete: true,
    });
    expect(editor.read(() => $getDateTimeNode().getDateTimeValue())).toBe(
      '2026-11-04',
    );
  });

  it('stores an invalid instant as no value', () => {
    using editor = buildEditorWithDateTime('2026-11-04');
    editor.update(() => void $getDateTimeNode().setDateTime(new Date(NaN)), {
      discrete: true,
    });
    expect(editor.read(() => $getDateTimeNode().getDateTimeValue())).toBe('');
    expect(exportDateTimeJSON(editor)).not.toHaveProperty('dateTime');
  });

  it('does not write when the value would not change', () => {
    using editor = buildEditorWithDateTime('2026-11-04');
    const dirty = countDirtyUpdates(editor);
    editor.update(
      () => {
        const node = $getDateTimeNode();
        node.setAllDayDate(node.getDateTime());
        node.setDateTime(dateTime => dateTime);
      },
      {discrete: true},
    );
    expect(dirty.count).toBe(0);
    expect(editor.read(() => $getDateTimeNode().getDateTimeValue())).toBe(
      '2026-11-04',
    );
  });

  it('does not write or throw for an unchanged node without a value', () => {
    using editor = buildEditorWithDateTime('');
    const dirty = countDirtyUpdates(editor);
    editor.update(
      () => void $getDateTimeNode().setDateTime(dateTime => dateTime),
      {discrete: true},
    );
    expect(dirty.count).toBe(0);
  });

  it('writes what an updater returns, even after changing its argument', () => {
    using editor = buildEditorWithDateTime('2026-11-04');
    const expected = new Date(2026, 10, 4, 5);
    editor.update(
      () =>
        void $getDateTimeNode().setDateTime(dateTime => {
          dateTime.setHours(5);
          return dateTime;
        }),
      {discrete: true},
    );
    expect(editor.read(() => $getDateTimeNode().getDateTimeValue())).toBe(
      expected.toISOString(),
    );
    editor.update(
      () => void $getDateTimeNode().setDateTime(() => new Date(NaN)),
      {discrete: true},
    );
    expect(editor.read(() => $getDateTimeNode().getDateTimeValue())).toBe('');
  });
});

describe('DateTimeNode entry paths', () => {
  it('inserts an instant or an all-day date from the command', () => {
    using editor = buildEditorFromExtensions(DateTimeTestExtension);
    const dateTime = new Date(2026, 10, 4, 15, 30);
    editor.update(
      () => void $getRoot().clear().append($createParagraphNode()).selectEnd(),
      {discrete: true},
    );
    editor.dispatchCommand(INSERT_DATETIME_COMMAND, {dateTime});
    editor.dispatchCommand(INSERT_DATETIME_COMMAND, {allDay: true, dateTime});
    expect(
      editor.read(() =>
        $nodesOfType(DateTimeNode).map(node => node.getDateTimeValue()),
      ),
    ).toEqual([dateTime.toISOString(), '2026-11-04']);
    expect(editor.read(() => $generateHtmlFromNodes(editor, null))).toContain(
      'data-lexical-datetime="2026-11-04"',
    );
  });

  test.for([
    [
      'command',
      (editor: LexicalEditor) => {
        editor.update(
          () =>
            void $getRoot().clear().append($createParagraphNode()).selectEnd(),
          {discrete: true},
        );
        editor.dispatchCommand(INSERT_DATETIME_COMMAND, {
          allDay: true,
          dateTime: new Date(2026, 10, 4, 15, 30),
        });
      },
    ],
    [
      'JSON',
      (editor: LexicalEditor) =>
        editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append(
                  $importDateTimeJSON('2026-11-04'),
                ),
              );
          },
          {discrete: true},
        ),
    ],
    [
      'HTML',
      (editor: LexicalEditor) =>
        importHtml(
          editor,
          '<p><span data-lexical-datetime="2026-11-04">x</span></p>',
        ),
    ],
    [
      'value',
      (editor: LexicalEditor) =>
        editor.update(
          () => {
            const node = $createDateTimeNodeFromValue('2026-11-04');
            assert(node !== null, 'expected a DateTimeNode');
            $getRoot().clear().append($createParagraphNode().append(node));
          },
          {discrete: true},
        ),
    ],
  ] as const)('stores the same all-day value from %s', ([, $insert]) => {
    using editor = buildEditorFromExtensions(DateTimeTestExtension);
    $insert(editor);
    expect(
      editor.read(() => [
        $getDateTimeNode().getDateTimeValue(),
        $getDateTimeNode().isAllDay(),
      ]),
    ).toEqual(['2026-11-04', true]);
  });

  it('does not create a node from a value that is not a date', () => {
    using editor = buildEditorFromExtensions(DateTimeTestExtension);
    expect(
      editor.read(() => [
        $createDateTimeNodeFromValue('not a date'),
        $createDateTimeNodeFromValue('2026-02-30'),
      ]),
    ).toEqual([null, null]);
  });
});
