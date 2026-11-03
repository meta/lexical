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
// (generationOf), the handshake verdict (checkYSession), the legacy capture
// (captureYSession, legacySignal), quarantine records (quarantineRecord,
// sourceView, hasNewYEdits), and createYDoc for a relay's documents (Yjs
// only: format cleanup off, nothing the binding adds to a client's). No
// Lexical import.

import {
  createRawYDoc as createYDoc,
  type YDoc,
  type YDocOptions,
} from './internal/RawYDoc';
import {
  captureYSession,
  checkYSession,
  describeYRoom,
  generationOf,
  hasNewYEdits,
  legacySignal,
  needsNewIncarnation,
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
  generationOf,
  hasNewYEdits,
  legacySignal,
  needsNewIncarnation,
  prepareYRoom,
  quarantineRecord,
  sourceView,
  UNKNOWN_GENERATION,
};
