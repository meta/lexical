/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The pending-material choice of migrateYState and prepareYRoom (D135),
// shared by the migrate and server entries (each bundles its copy).

/**
 * @experimental What a migration does with the input's pending material
 * (pending structs, a pending delete set, and what follows a skipped range):
 * it is never migrated or kept in `state`, so the caller says where it goes.
 * - `'return'`: the result's `pending` holds it. Store it where it can be
 *   recovered (a `pending` quarantine record, `createYQuarantineRecord` on
 *   `@lexical/y/server`): dropping it drops edits the stored state holds.
 * - `'discard'`: the result's `pending` is null. Only for a copy nothing
 *   stores (a read, a preview).
 */
export type YPendingMaterial = 'return' | 'discard';

/**
 * @internal Throws, naming the fix, when `pending` is not a
 * {@link YPendingMaterial}: a caller without types (JavaScript, a cast) that
 * left it out would otherwise drop the material without deciding to.
 */
export function requirePendingMaterial(
  entry: string,
  pending: unknown,
): asserts pending is YPendingMaterial {
  if (pending !== 'return' && pending !== 'discard') {
    throw new TypeError(
      `@lexical/y: ${entry} needs options.pending (got ${String(
        pending,
      )}): 'return' to get the pending material the migrated state never holds and store it (a 'pending' quarantine record, createYQuarantineRecord on @lexical/y/server), or 'discard' for a copy nothing stores (a read).`,
    );
  }
}
