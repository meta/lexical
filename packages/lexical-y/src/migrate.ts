/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @lexical/y/migrate: EXPERIMENTAL layout migrations of stored documents
// (DECISIONS D102, y.md "Changing the layout and migrating").
//
// A frozen step per layout (`@lexical/y/migrate/1to2`, ...) moves a root
// from layout N to N + 1 in place. The runner here runs a chain of them on
// an observer-free copy, each in one transaction under a client id hashed
// from every input, recording the new layout (`lexical-y:<N + 1>`) and the
// epoch (`lexical-y-epoch`); it checks every result before anything is
// stored or applied. A server migrates stored bytes (migrateYState); an
// editor tab may migrate the live room it has open (migrateYDoc), whose
// update syncs to the other peers. The binding never imports this entry or a
// step.

import {MIN_LAYOUT} from './internal/constants';
import {type YMigrationEpoch} from './internal/Layouts';
import {
  getYLayoutInfo,
  loadStepsWith,
  migrateYDoc,
  migrateYState,
  MIGRATION_ORIGIN,
  type YLayoutInfo,
  type YLayoutMigration,
  type YMigrateOptions,
  type YMigrateStateOptions,
  YMigrationError,
  type YMigrationErrorCode,
  type YMigrationLoaders,
  type YMigrationReceipt,
  type YMigrationResult,
  type YMigrationRootReceipt,
  type YMigrationStepInput,
  type YMigrationStepReceipt,
} from './internal/Runner';
import {STEP_LOADERS} from './internal/StepLoaders';

/** @experimental Options of loadYMigrationSteps (a later version may add some). */
export interface YLoadYMigrationStepsOptions {
  /** One loader per layout (`() => import(...)`); default: the published steps. */
  readonly loaders?: YMigrationLoaders;
}

/**
 * @experimental Load the steps a root at layout `from` needs to reach `to`
 * (default MIN_LAYOUT), only those, in parallel: by default the published
 * steps (`@lexical/y/migrate/<n>to<n+1>`, each its own chunk), or
 * `loaders` (one per layout, `() => import(...)`). Rejects with a
 * 'missing-step' YMigrationError when a link has no loader, 'invalid-steps'
 * when a loader gives something else than the step from that layout.
 */
export function loadYMigrationSteps(
  from: number,
  to: number = MIN_LAYOUT,
  {loaders = STEP_LOADERS}: YLoadYMigrationStepsOptions = {},
): Promise<YLayoutMigration[]> {
  return loadStepsWith(loaders, from, to);
}

export type {
  YLayoutInfo,
  YLayoutMigration,
  YMigrateOptions,
  YMigrateStateOptions,
  YMigrationEpoch,
  YMigrationErrorCode,
  YMigrationLoaders,
  YMigrationReceipt,
  YMigrationResult,
  YMigrationRootReceipt,
  YMigrationStepInput,
  YMigrationStepReceipt,
};
export {
  getYLayoutInfo,
  migrateYDoc,
  migrateYState,
  MIGRATION_ORIGIN,
  YMigrationError,
};
