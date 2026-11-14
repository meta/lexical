/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {isTableRowDivider} from '@lexical/markdown';
import {describe, expect, test} from 'vitest';

describe('isTableRowDivider', () => {
  test.each([
    '| --- |',
    '|---|',
    '| - |',
    '| :--- |',
    '| ---: |',
    '| :---: |',
    '| --- | :-: |',
    '| :-- | --: | --- |',
    '| --- | --- | ',
  ])('accepts %j', line => {
    expect(isTableRowDivider(line)).toBe(true);
  });

  test.each([
    // A delimiter cell needs at least one hyphen, so empty cells are body
    // cells, not a delimiter row.
    '|  |  |',
    '| | |',
    '|||',
    '|  | --- |',
    '| --- |  |',
    // A cell can have colons only where a hyphen is also present.
    '| : |',
    '| :: |',
    '| : : |',
    // Text cells are not delimiter cells.
    '| --- | text |',
    '| a | --- |',
    // A leading pipe is required.
    '--- | ---',
    '',
  ])('rejects %j', line => {
    expect(isTableRowDivider(line)).toBe(false);
  });
});
