/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The implementation lives under ./internal and is bundled into this entry
// (the package has no other public entry), so this module imports and
// exports rather than re-exporting from private files.
import {
  YBinding,
  type YBindingOptions,
  type YBindingStatus,
  type YCursor,
  type YQuiescedState,
} from './internal/Binding';
import {type ClientIDRange} from './internal/ClientID';
import {
  DEFAULT_ROOT_NAME,
  LAYOUT_VERSION,
  MIN_LAYOUT,
  SEED_LAYOUT,
} from './internal/constants';
import {describeStorage} from './internal/Describe';
import {onYMigrationEpoch, type YMigrationEpoch} from './internal/Layouts';
import {
  createYServerLayoutUpgrade,
  isYLayoutUpgradeHandle,
  type YClientSession,
  type YLayoutUpgradeHandle,
  type YServerLayoutUpgradeOptions,
} from './internal/LayoutUpgrade';
import {type StorageKind} from './internal/Schema';
import {SUPPORTED_YJS_VERSION} from './internal/SupportedYjs';
import {
  isYWarning,
  NESTED_FALLBACK_WARNING,
  RAW_YJS_WRITE_WARNING,
  RECOVERED_READ_WARNING,
  RECOVERED_WRITE_WARNING,
  SELF_CHECK_WARNING,
  STORAGE_MISMATCH_WARNING,
  UNKNOWN_NODE_TYPES_WARNING,
  UNSUPPORTED_CONFIG_WARNING,
  UNSUPPORTED_EDIT_WARNING,
  UNSUPPORTED_LAYOUT_WARNING,
  UNSUPPORTED_SCHEMA_WARNING,
  UNSUPPORTED_SLOTS_WARNING,
  UNSYNCED_VALUE_WARNING,
  type YNestedFallbackData,
  type YNestedFallbackReason,
  type YOtherWarningData,
  type YRawYjsWriteData,
  type YRecoveredReadData,
  type YRecoveredWriteData,
  type YSelfCheckData,
  type YStorageMismatchData,
  type YStoredAs,
  type YUnknownNodeTypesData,
  type YUnreadableContentData,
  type YUnsupportedConfigData,
  type YUnsupportedEditData,
  type YUnsupportedLayoutData,
  type YUnsupportedSchemaData,
  type YUnsupportedSlotsData,
  type YUnsyncedValueData,
  type YWarning,
  type YWarningCode,
  type YWarningData,
} from './internal/Warnings';
import {createYDoc, type YDoc, type YDocOptions} from './internal/YDoc';
import {
  createYCollabConfig,
  type YCollabConfig,
  YCollabExtension,
  type YCollabInput,
} from './internal/YExtension';
import {
  UNSUPPORTED_YJS_ERROR,
  type YUnsupportedYjsData,
  YUnsupportedYjsError,
  type YUnsupportedYjsReason,
} from './internal/YjsContract';

export type {
  ClientIDRange,
  StorageKind,
  YBindingOptions,
  YBindingStatus,
  YClientSession,
  YCollabConfig,
  YCollabInput,
  YCursor,
  YDoc,
  YDocOptions,
  YLayoutUpgradeHandle,
  YMigrationEpoch,
  YNestedFallbackData,
  YNestedFallbackReason,
  YOtherWarningData,
  YQuiescedState,
  YRawYjsWriteData,
  YRecoveredReadData,
  YRecoveredWriteData,
  YSelfCheckData,
  YServerLayoutUpgradeOptions,
  YStorageMismatchData,
  YStoredAs,
  YUnknownNodeTypesData,
  YUnreadableContentData,
  YUnsupportedConfigData,
  YUnsupportedEditData,
  YUnsupportedLayoutData,
  YUnsupportedSchemaData,
  YUnsupportedSlotsData,
  YUnsupportedYjsData,
  YUnsupportedYjsReason,
  YUnsyncedValueData,
  YWarning,
  YWarningCode,
  YWarningData,
};
export {
  createYCollabConfig,
  createYDoc,
  createYServerLayoutUpgrade,
  DEFAULT_ROOT_NAME,
  describeStorage,
  isYLayoutUpgradeHandle,
  isYWarning,
  LAYOUT_VERSION,
  MIN_LAYOUT,
  NESTED_FALLBACK_WARNING,
  onYMigrationEpoch,
  RAW_YJS_WRITE_WARNING,
  RECOVERED_READ_WARNING,
  RECOVERED_WRITE_WARNING,
  SEED_LAYOUT,
  SELF_CHECK_WARNING,
  STORAGE_MISMATCH_WARNING,
  SUPPORTED_YJS_VERSION,
  UNKNOWN_NODE_TYPES_WARNING,
  UNSUPPORTED_CONFIG_WARNING,
  UNSUPPORTED_EDIT_WARNING,
  UNSUPPORTED_LAYOUT_WARNING,
  UNSUPPORTED_SCHEMA_WARNING,
  UNSUPPORTED_SLOTS_WARNING,
  UNSUPPORTED_YJS_ERROR,
  UNSYNCED_VALUE_WARNING,
  YBinding,
  YCollabExtension,
  YUnsupportedYjsError,
};
