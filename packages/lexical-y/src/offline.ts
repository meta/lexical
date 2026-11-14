/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// `@lexical/y/offline`: local persistence for Yjs 14 documents (IndexedDB,
// by document key and epoch) and the offline session on top of it (capture
// on a moved epoch, the report, the replay). The implementation lives under
// ./internal (OfflineStore, OfflineSession) and is bundled into this entry; `@lexical/y` and
// `@lexical/y/headless` stay external siblings.
import {
  attachYOfflineSession,
  describeYOfflineCapture,
  loadYOffline,
  recoverYOfflineEdits,
  replayUnsyncedEdits,
  Y_OFFLINE_STAGES,
  type YOfflineBinding,
  type YOfflineDescribeOptions,
  type YOfflineLoaded,
  type YOfflineRecovered,
  type YOfflineReport,
  type YOfflineSession,
  type YOfflineSessionOptions,
  type YOfflineStage,
  type YOfflineVerdict,
  type YReplayResult,
  type YReplaySkipReason,
} from './internal/OfflineSession';
import {
  openYOfflineStore,
  Y_OFFLINE_DEFAULTS,
  type YOfflineCapture,
  type YOfflineError,
  type YOfflineErrorCode,
  type YOfflineLimits,
  type YOfflineLocks,
  type YOfflineResult,
  type YOfflineSalvage,
  type YOfflineSlot,
  type YOfflineSlotInfo,
  type YOfflineStore,
  type YOfflineStored,
  type YOfflineStoreOptions,
} from './internal/OfflineStore';

export type {
  YOfflineBinding,
  YOfflineCapture,
  YOfflineDescribeOptions,
  YOfflineError,
  YOfflineErrorCode,
  YOfflineLimits,
  YOfflineLoaded,
  YOfflineLocks,
  YOfflineRecovered,
  YOfflineReport,
  YOfflineResult,
  YOfflineSalvage,
  YOfflineSession,
  YOfflineSessionOptions,
  YOfflineSlot,
  YOfflineSlotInfo,
  YOfflineStage,
  YOfflineStore,
  YOfflineStored,
  YOfflineStoreOptions,
  YOfflineVerdict,
  YReplayResult,
  YReplaySkipReason,
};
export {
  attachYOfflineSession,
  describeYOfflineCapture,
  loadYOffline,
  openYOfflineStore,
  recoverYOfflineEdits,
  replayUnsyncedEdits,
  Y_OFFLINE_DEFAULTS,
  Y_OFFLINE_STAGES,
};
