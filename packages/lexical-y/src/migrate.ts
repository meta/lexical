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
// stored or applied. Only an authority migrates a shared document (a server
// or relay that owns its storage, with every session evicted, or a reseed
// tool). The binding never imports this entry or a step.

import {type YMigrationEpoch} from './internal/Layouts';
import {
  layoutEpoch,
  loadYMigrationSteps,
  migrateYState,
  recordedLayout,
  type YKnownMigrationErrorCode,
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

export type {
  YKnownMigrationErrorCode,
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
  layoutEpoch,
  loadYMigrationSteps,
  migrateYState,
  recordedLayout,
  YMigrationError,
};
