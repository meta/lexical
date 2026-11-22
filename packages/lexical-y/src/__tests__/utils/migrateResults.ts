/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {YMigrationReceipt, YMigrationResult} from '../../migrate';
import type {YPreparedRoom} from '../../server';

/**
 * A migration result as one shape, for tests that check both parts: the
 * migrated state (`integrated` when split) and the pending material (null
 * when not split).
 */
export function flat(result: YMigrationResult): {
  readonly state: Uint8Array;
  readonly update: Uint8Array | null;
  readonly pending: Uint8Array | null;
  readonly receipt: YMigrationReceipt;
} {
  return result.split
    ? {
        pending: result.pending,
        receipt: result.receipt,
        state: result.integrated,
        update: result.update,
      }
    : {
        pending: null,
        receipt: result.receipt,
        state: result.state,
        update: result.update,
      };
}

/** A prepared room as one shape (null base and pending when unchanged). */
export function flatRoom(prepared: YPreparedRoom): {
  readonly changed: boolean;
  readonly state: Uint8Array;
  readonly generation: string;
  readonly base: {
    readonly generation: string;
    readonly state: Uint8Array;
  } | null;
  readonly pending: Uint8Array | null;
  readonly receipt: YMigrationReceipt;
} {
  return prepared.changed
    ? {...prepared.write, changed: true, receipt: prepared.receipt}
    : {...prepared, base: null, pending: null};
}
