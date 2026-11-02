/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {LexicalWarning} from 'lexical';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, test} from 'vitest';

import {
  isYWarning,
  LAYOUT_VERSION,
  NESTED_FALLBACK_WARNING,
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

// An app's own read-only banner, from the warning's fields alone: every code
// handled, so a code added in a later release fails to type-check here.
function banner(warning: YWarning): string {
  switch (warning.code) {
    case UNSUPPORTED_LAYOUT_WARNING:
      switch (warning.data.reason) {
        case 'newer':
          return `newer:${warning.data.found}>${warning.data.supported}`;
        case 'malformed':
          return `malformed:${warning.data.key}`;
        case 'legacy-roots':
          return `legacy:${warning.data.roots.join(',')}`;
        case 'missing':
        case 'removed':
          return warning.data.reason;
      }
      break;
    case UNSUPPORTED_SCHEMA_WARNING:
      return warning.data.reason === 'newer'
        ? `schema:${warning.data.found}>${warning.data.supported}`
        : `schema-malformed:${warning.data.key}`;
    case STORAGE_MISMATCH_WARNING:
      return warning.data.reason === 'malformed'
        ? `malformed:${warning.data.key}`
        : `${warning.data.stored.kind}->${warning.data.declared.kind}`;
    case UNKNOWN_NODE_TYPES_WARNING:
    case UNSUPPORTED_SLOTS_WARNING:
      return `${warning.data.reason}:${warning.data.types.join(',')}`;
    case UNSUPPORTED_CONFIG_WARNING:
      return warning.data.reason === 'repair-transforms'
        ? warning.data.options.join(',')
        : warning.data.reason;
    case UNSUPPORTED_EDIT_WARNING:
      return warning.data.reason;
    case SELF_CHECK_WARNING:
      return `${warning.data.reason}:${warning.data.problems.length}`;
    case RECOVERED_READ_WARNING:
    case RECOVERED_WRITE_WARNING:
      return warning.data.reason;
    case NESTED_FALLBACK_WARNING:
      return warning.data.reason === 'merge-override'
        ? warning.data.method
        : warning.data.type;
    case UNSYNCED_VALUE_WARNING:
      return warning.data.property;
    default: {
      const unreachable: never = warning;
      return unreachable;
    }
  }
  return '';
}

// A switch that leaves codes out does not type-check as exhaustive.
export function partial(warning: YWarning): string {
  switch (warning.code) {
    case UNSUPPORTED_LAYOUT_WARNING:
      return warning.data.reason;
    default: {
      // @ts-expect-error not every code is handled
      const unreachable: never = warning;
      return String(unreachable);
    }
  }
}

// Each reason carries its own fields.
export function fields(warning: YWarning): void {
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
    const codes: YWarningCode[] = [
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
    ];
    for (const code of codes) {
      expect(isYWarning(new LexicalWarning(code, 'm', {}))).toBe(true);
    }
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
    expect(isYWarning(warning) ? banner(warning) : '').toBe(
      `newer:9>${LAYOUT_VERSION}`,
    );
    const schema = new LexicalWarning(
      UNSUPPORTED_SCHEMA_WARNING,
      `schema 3 is newer than 2. A newer version of your app (a higher schemaVersion) wrote this document, so this editor is read only: load the newer app version to edit it`,
      {found: 3, reason: 'newer', supported: 2},
    );
    expect(isYWarning(schema) ? banner(schema) : '').toBe('schema:3>2');
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
