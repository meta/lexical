/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// How a warning's `data` is narrowed (checked by the type check, `tsc`):
// `isYWarning(value, CODE)` types it by the code. Comparing the code after
// `isYWarning(value)` does not, because the code is open (a later version
// may add codes, so no closed union of codes is public): that pattern
// leaves `data` unknown, as y.md's Warnings section says.

import {LexicalWarning} from 'lexical';
import {expect, expectTypeOf, test} from 'vitest';

import {
  isYWarning,
  SELF_CHECK_WARNING,
  type YOtherWarningData,
  type YSelfCheckData,
} from '../..';

function narrowed(value: unknown): string | null {
  if (isYWarning(value, SELF_CHECK_WARNING)) {
    expectTypeOf(value.data).toEqualTypeOf<
      YSelfCheckData | YOtherWarningData
    >();
    return value.data.reason;
  }
  return null;
}

function comparedCode(value: unknown): unknown {
  if (isYWarning(value) && value.code === SELF_CHECK_WARNING) {
    expectTypeOf(value.data).toBeUnknown();
    // @ts-expect-error the open code does not narrow data
    void value.data.reason;
    return value.data;
  }
  return null;
}

test('isYWarning(value, CODE) types data by the code; comparing the code after isYWarning(value) leaves it unknown', () => {
  const data = {detailCode: 'probe', reason: 'other'} as const;
  const warning = new LexicalWarning(SELF_CHECK_WARNING, 'a probe', data);
  expect(narrowed(warning)).toBe('other');
  expect(comparedCode(warning)).toBe(data);
  expect(narrowed(new Error('not a warning'))).toBeNull();
});
