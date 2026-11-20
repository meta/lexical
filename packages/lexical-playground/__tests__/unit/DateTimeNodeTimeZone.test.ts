/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {execFileSync} from 'node:child_process';
import * as path from 'node:path';
import {describe, expect, test} from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CHILD = path.join(__dirname, 'fixtures', 'dateTimeTimeZoneChild.ts');

interface ChildResult {
  decoratedDateTime: number[];
  e2eDateValue: string[];
  exportedText: string[];
  getDateTime: number[];
  getDateTime1942: number[];
  htmlImport: string[];
  offsetless: [string, string];
  setAllDayDate: string[];
  text: string[];
  timeValue: [string, string];
  timeZone: string;
}

// A test worker keeps the time zone it started with, so each zone runs in
// its own process with TZ set before Node starts.
function runInTimeZone(timeZone: string): ChildResult {
  return JSON.parse(
    execFileSync(process.execPath, ['--import', 'tsx', CHILD], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {...process.env, TZ: timeZone},
    }),
  );
}

// Shown for 2026-11-04, 0000-02-29, 0050-06-01, 2011-12-30 and 2026-09-06
const ALL_DAY_TEXT = [
  'Wed Nov 04 2026',
  'Tue Feb 29 0000',
  'Wed Jun 01 0050',
  'Fri Dec 30 2011',
  'Sun Sep 06 2026',
];

describe('DateTimeNode in other time zones', () => {
  test.for([
    // West of UTC: a date-only value read as UTC would be the day before
    'America/New_York',
    // East of UTC
    'Asia/Seoul',
    // 2026-09-06 starts at 01:00 (daylight saving begins at midnight)
    'America/Santiago',
    // 2011-12-30 did not exist (the zone skipped from the 29th to the 31st)
    'Pacific/Apia',
    // Local midnight exists on 1942-04-25, but 23:00 the day before did not
    'Atlantic/Azores',
  ])('keeps an all-day date in %s', timeZone => {
    const result = runInTimeZone(timeZone);
    expect(result.timeZone).toBe(timeZone);
    expect(result.text).toEqual(ALL_DAY_TEXT);
    expect(result.exportedText).toEqual(ALL_DAY_TEXT);
    expect(result.htmlImport).toEqual(['2011-12-30']);
    expect(result.setAllDayDate).toEqual(['2026-11-04', '2027-01-01']);
    expect(result.decoratedDateTime).toEqual([2026, 10, 4]);
    expect(result.e2eDateValue).toEqual(['2026-11-04', '2027-01-01']);
    expect(result.timeValue).toEqual(['', '09:05']);
    // A value without an offset is still a local instant
    expect(result.offsetless[0]).toBe(result.offsetless[1]);
    expect(result.getDateTime).toEqual([2026, 10, 4, 0, 0]);
    expect(result.getDateTime1942).toEqual([25, 0]);
  });
}, 30_000);
