/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type * as PublicCore from '../..';
import type {YKnownWarning, YKnownWarningCode} from '../../internal/Warnings';
import type * as PublicMigrate from '../../migrate';
import type {YMigrationErrorCode} from '../../migrate';

import {LexicalWarning} from 'lexical';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, test} from 'vitest';

import {
  isYWarning,
  LAYOUT_VERSION,
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
  type YWarning,
  type YWarningCode,
} from '../..';

// An app's own read-only banner, from the warning's fields alone. The base
// YWarning is open (any code, `data` unknown), so the app narrows with
// isYWarning(value, code); every reason switch handles the permanent
// 'other' fallback, and a code the app does not know falls through to the
// last line: a later release (new codes, new conditions under 'other')
// keeps this compiling and working.
function banner(value: unknown): string {
  if (isYWarning(value, UNSUPPORTED_LAYOUT_WARNING)) {
    const data = value.data;
    switch (data.reason) {
      case 'newer':
        return `newer:${data.found}>${data.supported}`;
      case 'older':
        return `older:${data.found}<${data.min}`;
      case 'requires':
        return `requires:${data.features.join(',')}`;
      case 'malformed':
        return `malformed:${data.key}`;
      case 'legacy-roots':
        return `legacy:${data.roots.join(',')}`;
      case 'missing':
      case 'removed':
        return data.reason;
      case 'other':
        return `other:${data.detailCode}`;
      default: {
        const unreachable: never = data;
        return unreachable;
      }
    }
  }
  if (isYWarning(value, UNSUPPORTED_SCHEMA_WARNING)) {
    const data = value.data;
    return data.reason === 'newer'
      ? `schema:${data.found}>${data.supported}`
      : data.reason === 'other'
        ? `other:${data.detailCode}`
        : `schema-malformed:${data.key}`;
  }
  if (isYWarning(value, STORAGE_MISMATCH_WARNING)) {
    const data = value.data;
    return data.reason === 'malformed'
      ? `malformed:${data.key}`
      : data.reason === 'other'
        ? `other:${data.detailCode}`
        : `${data.stored.kind}->${data.declared.kind}`;
  }
  if (
    isYWarning(value, UNKNOWN_NODE_TYPES_WARNING) ||
    isYWarning(value, UNSUPPORTED_SLOTS_WARNING)
  ) {
    const data = value.data;
    return data.reason === 'other'
      ? `other:${data.detailCode}`
      : `${data.reason}:${data.types.join(',')}`;
  }
  if (isYWarning(value, UNSUPPORTED_CONFIG_WARNING)) {
    const data = value.data;
    return data.reason === 'repair-transforms'
      ? data.options.join(',')
      : data.reason;
  }
  if (isYWarning(value, SELF_CHECK_WARNING)) {
    const data = value.data;
    return data.reason === 'other'
      ? `other:${data.detailCode}`
      : `${data.reason}:${data.problems.length}`;
  }
  if (isYWarning(value, NESTED_FALLBACK_WARNING)) {
    const data = value.data;
    return data.reason === 'merge-override'
      ? data.method
      : data.reason === 'other'
        ? `other:${data.detailCode}`
        : data.type;
  }
  if (isYWarning(value, RAW_YJS_WRITE_WARNING)) {
    const data = value.data;
    return data.reason === 'other'
      ? `other:${data.detailCode}`
      : `raw:${data.kind}:${data.key ?? ''}:${data.origin}`;
  }
  if (isYWarning(value, UNSYNCED_VALUE_WARNING)) {
    const data = value.data;
    return data.reason === 'other' ? `other:${data.detailCode}` : data.property;
  }
  if (isYWarning(value, UNSUPPORTED_EDIT_WARNING)) {
    const data = value.data;
    switch (data.reason) {
      case 'read-only':
        return 'read-only';
      case 'refused-at-write':
        // Not a read-only state: the binding may still be active.
        return `refused:${data.record}`;
      case 'held-composition':
        // The binding stays active: no read-only banner.
        return '';
      case 'other':
        return `other:${data.detailCode}`;
      default: {
        const unreachable: never = data;
        return unreachable;
      }
    }
  }
  if (
    isYWarning(value, RECOVERED_READ_WARNING) ||
    isYWarning(value, RECOVERED_WRITE_WARNING)
  ) {
    return value.data.reason;
  }
  // A code this app does not know (a later release's): its code only.
  return isYWarning(value) ? value.code : '';
}

// The open base: `data` is unknown until the code narrows it; codes are any
// string (a later release's included), and so are the runner's error codes.
export function open(warning: YWarning): string {
  // @ts-expect-error the open warning's data is unknown
  void warning.data.reason;
  const later: YWarningCode = '@lexical/y/a-later-code';
  const errorCode: YMigrationErrorCode = 'a-later-code';
  // @ts-expect-error a known code list stays closed (editor completion)
  const notKnown: YKnownWarningCode = '@lexical/y/a-later-code';
  return `${later}${errorCode}${String(notKnown)}`;
}

// N1: the closed lists of codes are internal. A public closed union would
// break an exhaustive switch over it the day a code is added.
export type Unexported = [
  // @ts-expect-error not exported from the package
  PublicCore.YKnownWarningCode,
  // @ts-expect-error not exported from the package
  PublicCore.YKnownWarning,
  // @ts-expect-error not exported from @lexical/y/migrate
  PublicMigrate.YKnownMigrationErrorCode,
];

// Internally, the known warnings, one member per code: a switch over `code`
// narrows `data`.
export function knownSwitch(warning: YKnownWarning): string {
  switch (warning.code) {
    case UNSUPPORTED_LAYOUT_WARNING:
      return warning.data.reason;
    default:
      return warning.code;
  }
}

// Each reason carries its own fields.
export function fields(warning: YKnownWarning): void {
  if (warning.code === UNSUPPORTED_LAYOUT_WARNING) {
    if (warning.data.reason === 'missing') {
      // @ts-expect-error a missing record has no value found
      void warning.data.found;
    }
    if (warning.data.reason === 'newer') {
      const found: number = warning.data.found;
      void found;
    }
  }
  if (warning.code === UNSUPPORTED_SCHEMA_WARNING) {
    // @ts-expect-error `key` is only on a malformed record
    void warning.data.key;
    if (warning.data.reason === 'newer') {
      const found: number = warning.data.found;
      const supported: number = warning.data.supported;
      void found;
      void supported;
    }
  }
  if (warning.code === STORAGE_MISMATCH_WARNING) {
    // @ts-expect-error `stored` is only on a declaration change
    void warning.data.stored;
  }
  if (warning.code === UNSUPPORTED_CONFIG_WARNING) {
    // @ts-expect-error `options` are only on 'repair-transforms'
    void warning.data.options;
  }
}

describe('typed warnings', () => {
  test('isYWarning accepts the binding codes only', () => {
    const codes: YKnownWarningCode[] = [
      UNSUPPORTED_LAYOUT_WARNING,
      UNKNOWN_NODE_TYPES_WARNING,
      STORAGE_MISMATCH_WARNING,
      SELF_CHECK_WARNING,
      RECOVERED_READ_WARNING,
      RECOVERED_WRITE_WARNING,
      NESTED_FALLBACK_WARNING,
      UNSYNCED_VALUE_WARNING,
      UNSUPPORTED_SLOTS_WARNING,
      UNSUPPORTED_CONFIG_WARNING,
      UNSUPPORTED_EDIT_WARNING,
      UNSUPPORTED_SCHEMA_WARNING,
      RAW_YJS_WRITE_WARNING,
    ];
    for (const code of codes) {
      expect(isYWarning(new LexicalWarning(code, 'm', {}))).toBe(true);
      expect(isYWarning(new LexicalWarning(code, 'm', {}), code)).toBe(true);
    }
    // With a code: only that code.
    expect(
      isYWarning(
        new LexicalWarning(UNSUPPORTED_EDIT_WARNING, 'm', {}),
        UNSUPPORTED_LAYOUT_WARNING,
      ),
    ).toBe(false);
    // As an array predicate (the index is no code).
    expect(
      [new LexicalWarning(UNSUPPORTED_EDIT_WARNING, 'm', {})].filter(
        isYWarning,
      ),
    ).toHaveLength(1);
    expect(isYWarning(new LexicalWarning('@example/pkg/x', 'm'))).toBe(false);
    expect(isYWarning(new Error('m'))).toBe(false);
    expect(isYWarning(null)).toBe(false);
  });

  test('a banner from the fields alone', () => {
    const warning = new LexicalWarning(
      UNSUPPORTED_LAYOUT_WARNING,
      'layout 9 is newer',
      {found: 9, reason: 'newer', supported: LAYOUT_VERSION},
    );
    expect(banner(warning)).toBe(`newer:9>${LAYOUT_VERSION}`);
    const schema = new LexicalWarning(
      UNSUPPORTED_SCHEMA_WARNING,
      `schema 3 is newer than 2. A newer version of your app (a higher schemaVersion) wrote this document, so this editor is read only: load the newer app version to edit it`,
      {found: 3, reason: 'newer', supported: 2},
    );
    expect(banner(schema)).toBe('schema:3>2');
    expect(
      banner(
        new LexicalWarning(UNSUPPORTED_EDIT_WARNING, 'm', {
          reason: 'refused-at-write',
          record: 'layout',
        }),
      ),
    ).toBe('refused:layout');
    // A refusal while a composition holds a collaborator's text: the binding
    // stays active, so no banner.
    expect(
      banner(
        new LexicalWarning(UNSUPPORTED_EDIT_WARNING, 'm', {
          reason: 'held-composition',
        }),
      ),
    ).toBe('');
    expect(
      banner(
        new LexicalWarning(UNSUPPORTED_EDIT_WARNING, 'm', {
          reason: 'read-only',
        }),
      ),
    ).toBe('read-only');
    // The permanent fallback, under a known code.
    expect(
      banner(
        new LexicalWarning(UNSUPPORTED_LAYOUT_WARNING, 'm', {
          detailCode: 'a-later-condition',
          reason: 'other',
        }),
      ),
    ).toBe('other:a-later-condition');
  });

  test('messages name no package', () => {
    // Messages are for developers and carry no product wording; apps render
    // their own text from `code` and `data`.
    const dir = path.resolve(__dirname, '../../internal');
    for (const file of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const call of src.matchAll(
        /(?:this\.warn|noteOnce|warnOnce)\(\s*[^,]*,\s*([`'][^`']*[`'])/g,
      )) {
        expect(call[1]).not.toMatch(/@lexical\//);
      }
    }
  });
});
