/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @lexical/y/server: EXPERIMENTAL pieces of a server or relay that stores
// `@lexical/y` documents (D102, y-server.md "Migrating stored documents"):
// the load-time migration (prepareYRoom), the generation of a stored state
// (getYGeneration), the handshake verdict (checkYSession), the legacy capture
// (captureYSession, legacySignal), quarantine records (quarantineRecord,
// sourceView, hasNewYEdits), and createYDoc for a relay's documents (Yjs
// only: format cleanup off, nothing the binding adds to a client's). No
// Lexical import.

// The layout constants a server needs, from the constants module alone:
// a server never needs the core entry (which loads the binding).
import {LAYOUT_VERSION, MIN_LAYOUT, SEED_LAYOUT} from './internal/constants';
import {
  createRawYDoc as createYDoc,
  type YDoc,
  type YDocOptions,
} from './internal/RawYDoc';
import {
  captureYSession,
  checkYSession,
  describeYRoom,
  getYGeneration,
  hasNewYEdits,
  legacySignal,
  needsNewIncarnation,
  pendingYRecord,
  prepareYRoom,
  quarantineRecord,
  sourceView,
  UNKNOWN_GENERATION,
  type YDraft,
  type YLegacySignal,
  type YPreparedRoom,
  type YPrepareRoomOptions,
  type YQuarantineRecord,
  type YQuarantineRecordInput,
  type YRecordAcknowledgement,
  type YRecordSource,
  type YRoomDescription,
  type YSessionCapture,
  type YSessionHandshake,
  type YSessionVerdict,
} from './internal/Server';

export type {
  YDoc,
  YDocOptions,
  YDraft,
  YLegacySignal,
  YPreparedRoom,
  YPrepareRoomOptions,
  YQuarantineRecord,
  YQuarantineRecordInput,
  YRecordAcknowledgement,
  YRecordSource,
  YRoomDescription,
  YSessionCapture,
  YSessionHandshake,
  YSessionVerdict,
};
export {
  captureYSession,
  checkYSession,
  createYDoc,
  describeYRoom,
  getYGeneration,
  hasNewYEdits,
  LAYOUT_VERSION,
  legacySignal,
  MIN_LAYOUT,
  needsNewIncarnation,
  pendingYRecord,
  prepareYRoom,
  quarantineRecord,
  SEED_LAYOUT,
  sourceView,
  UNKNOWN_GENERATION,
};

// The layout upgrade handle (see y.md "Layout upgrades"), the same as
// @lexical/y's: a test or a server builds a client's handshake with it.
export {
  createYServerLayoutUpgrade,
  isYLayoutUpgradeHandle,
  type YClientSession,
  type YLayoutUpgradeHandle,
  type YServerLayoutUpgradeOptions,
} from './internal/LayoutUpgrade';
