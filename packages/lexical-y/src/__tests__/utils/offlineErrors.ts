/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {YOfflineError, YOfflineResult} from '../../offline';

/** The error of a failed result, narrowed to `code` (throws otherwise). */
export function offlineError<C extends YOfflineError['code']>(
  result: YOfflineResult<unknown>,
  code: C,
): Extract<YOfflineError, {readonly code: C}> {
  if (result.ok) {
    throw new Error(`expected a '${code}' error, got a value`);
  }
  if (result.error.code !== code) {
    throw new Error(
      `expected a '${code}' error, got '${result.error.code}': ${result.error.message}`,
    );
  }
  return result.error as Extract<YOfflineError, {readonly code: C}>;
}

/** The error of a failed result, narrowed to a corrupt slot (throws otherwise). */
export function corruptSlotError(
  result: YOfflineResult<unknown>,
): Extract<YOfflineError, {readonly where: 'slot'}> {
  const error = offlineError(result, 'corrupt');
  if (error.where !== 'slot') {
    throw new Error(`expected a corrupt slot, got corrupt ${error.where}`);
  }
  return error;
}
