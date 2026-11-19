/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Properties of the DateTimeNode value, checked against an independent
// Gregorian calendar and against how values were read before date-only
// values became all-day dates. Set DATETIME_PROPERTY_RUNS to run more cases.

import * as fc from 'fast-check';
import {describe, expect, test} from 'vitest';

import {normalizeDateTime} from '../../src/nodes/DateTimeNode/DateTimeNode';

const RUNS = Number(process.env.DATETIME_PROPERTY_RUNS || 200);
const SEED = 20261117;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

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

function formatDateOnly(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(
    2,
    '0',
  )}-${String(day).padStart(2, '0')}`;
}

// How every value was read before: as an instant, or not at all
function readAsInstant(value: string): string {
  return Number.isNaN(Date.parse(value)) ? '' : new Date(value).toISOString();
}

const year = fc.integer({max: 9999, min: 0});
const month = fc.integer({max: 12, min: 1});

const calendarDate = fc
  .tuple(year, month, fc.integer({max: 31, min: 1}))
  .map(([y, m, d]) => formatDateOnly(y, m, Math.min(d, daysInMonth(y, m))));

const notACalendarDate = fc.oneof(
  fc
    .tuple(year, month, fc.integer({max: 99, min: 29}))
    .filter(([y, m, d]) => d > daysInMonth(y, m))
    .map(([y, m, d]) => formatDateOnly(y, m, d)),
  fc
    .tuple(year, fc.constantFrom(0, 13, 99), fc.integer({max: 28, min: 1}))
    .map(([y, m, d]) => formatDateOnly(y, m, d)),
  fc.tuple(year, month).map(([y, m]) => formatDateOnly(y, m, 0)),
);

// February 29 of any year, with century years mixed in so the 100- and
// 400-year rules are reached in every run
const february29 = fc
  .oneof(
    year,
    fc.integer({max: 99, min: 0}).map(century => century * 100),
  )
  .map(y => formatDateOnly(y, 2, 29));

const instant = fc
  .date({
    max: new Date('+010000-01-01T00:00:00.000Z'),
    min: new Date('-000100-01-01T00:00:00.000Z'),
    noInvalidDate: true,
  })
  .chain(date =>
    fc.constantFrom(
      date.toISOString(),
      date.toString(),
      date.toUTCString(),
      date.toISOString().replace('Z', '+09:00'),
      date.toISOString().slice(0, 19),
      date.toISOString().slice(0, 16),
    ),
  );

const notDateOnly = fc
  .oneof(instant, fc.string(), fc.string({unit: 'grapheme-ascii'}))
  .filter(value => !DATE_ONLY.test(value));

const options = {numRuns: RUNS, seed: SEED};

describe('DateTimeNode value properties', () => {
  test('keeps every calendar date as written', () => {
    fc.assert(
      fc.property(calendarDate, value => {
        expect(normalizeDateTime(value)).toBe(value);
      }),
      options,
    );
  });

  test('drops a date-only value that is not a calendar date', () => {
    fc.assert(
      fc.property(notACalendarDate, value => {
        expect(normalizeDateTime(value)).toBe('');
      }),
      options,
    );
  });

  test('keeps February 29 only in a leap year', () => {
    fc.assert(
      fc.property(february29, value => {
        const leap = isLeapYear(Number(value.slice(0, 4)));
        expect(normalizeDateTime(value)).toBe(leap ? value : '');
      }),
      options,
    );
  });

  test('reads every other value as an instant, the same as before', () => {
    fc.assert(
      fc.property(notDateOnly, value => {
        expect(normalizeDateTime(value)).toBe(readAsInstant(value));
      }),
      options,
    );
  });

  test('gives the same value when normalized again', () => {
    fc.assert(
      fc.property(
        fc.oneof(calendarDate, notACalendarDate, february29, notDateOnly),
        value => {
          const normalized = normalizeDateTime(value);
          expect(normalizeDateTime(normalized)).toBe(normalized);
        },
      ),
      options,
    );
  });
});
