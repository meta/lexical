/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {isTableRowDivider} from '@lexical/markdown';
import {describe, expect, it} from 'vitest';

describe('isTableRowDivider', () => {
  it('recognizes valid delimiter rows', () => {
    expect(isTableRowDivider('| --- |')).toBe(true);
    expect(isTableRowDivider('| --- | --- |')).toBe(true);
    expect(isTableRowDivider('| :--- | :---: | ---: |')).toBe(true);
    expect(isTableRowDivider('| - | - |')).toBe(true);
    expect(isTableRowDivider('| --- | --- | ')).toBe(true);
  });

  it('rejects rows of empty cells without hyphens', () => {
    expect(isTableRowDivider('|  |  |')).toBe(false);
    expect(isTableRowDivider('| | |')).toBe(false);
    expect(isTableRowDivider('|||')).toBe(false);
    expect(isTableRowDivider('| |')).toBe(false);
    expect(isTableRowDivider('|  | --- |')).toBe(false);
    expect(isTableRowDivider('| --- |  |')).toBe(false);
  });

  it('rejects rows with only colons and no hyphens', () => {
    expect(isTableRowDivider('| : |')).toBe(false);
    expect(isTableRowDivider('| :: |')).toBe(false);
    expect(isTableRowDivider('| : | : |')).toBe(false);
  });
});
