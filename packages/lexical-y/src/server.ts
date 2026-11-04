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
// (getYGeneration), the handshake verdict (describeYRoom, checkYSession),
// the legacy capture (createYSessionCapture), quarantine records
// (createYQuarantineRecord, sourceView) and createYDoc for a relay's
// documents (Yjs only: format cleanup off, nothing the binding adds to a
// client's). No Lexical import.

// The layout constants a server needs, from the constants module alone:
// a server never needs the core entry (which loads the binding).
import {LAYOUT_VERSION, MIN_LAYOUT, SEED_LAYOUT} from './internal/constants';
import {
  createRawYDoc as createYDoc,
  type YDoc,
  type YDocOptions,
} from './internal/RawYDoc';
import {
  checkYSession,
  createYQuarantineRecord,
  createYSessionCapture,
  describeYRoom,
  getYGeneration,
  prepareYRoom,
  sourceView,
  UNKNOWN_GENERATION,
  type YDraft,
  type YLegacySignal,
  type YPendingRecordInput,
  type YPreparedRoom,
  type YPrepareRoomOptions,
  type YQuarantineRecord,
  type YQuarantineRecordInput,
  type YQuarantineRecordKind,
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
  YPendingRecordInput,
  YPreparedRoom,
  YPrepareRoomOptions,
  YQuarantineRecord,
  YQuarantineRecordInput,
  YQuarantineRecordKind,
  YRecordAcknowledgement,
  YRecordSource,
  YRoomDescription,
  YSessionCapture,
  YSessionHandshake,
  YSessionVerdict,
};
export {
  checkYSession,
  createYDoc,
  createYQuarantineRecord,
  createYSessionCapture,
  describeYRoom,
  getYGeneration,
  LAYOUT_VERSION,
  MIN_LAYOUT,
  prepareYRoom,
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
