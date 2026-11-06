/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {Identifier} from 'estree';

import {describe, expect, it} from 'vitest';

import {buildMatcher} from '../../util/buildMatcher';

function id(name: string): Identifier {
  return {
    name,
    type: 'Identifier',
  };
}

function callMatcher(
  matcher: ReturnType<typeof buildMatcher>,
  name: string,
): boolean {
  const node = id(name);
  return matcher(node);
}

describe('buildMatcher', () => {
  it('handles degenerate case', () => {
    expect(callMatcher(buildMatcher(), '')).toBe(false);
  });
  it('can do an exact match', () => {
    const matcher = buildMatcher('read');
    expect(callMatcher(matcher, 'read')).toBe(true);
    expect(callMatcher(matcher, 'readx')).toBe(false);
    expect(callMatcher(matcher, 'xread')).toBe(false);
  });
  it('can do two exact matches', () => {
    const matcher = buildMatcher('read', 'update');
    expect(callMatcher(matcher, 'read')).toBe(true);
    expect(callMatcher(matcher, 'readx')).toBe(false);
    expect(callMatcher(matcher, 'xread')).toBe(false);
    expect(callMatcher(matcher, 'update')).toBe(true);
  });
  it('can use regex syntax', () => {
    const matcher = buildMatcher('^read', '(update$)');
    expect(callMatcher(matcher, 'read')).toBe(true);
    expect(callMatcher(matcher, 'readx')).toBe(true);
    expect(callMatcher(matcher, 'xread')).toBe(false);
    expect(callMatcher(matcher, 'update')).toBe(true);
    expect(callMatcher(matcher, 'updatex')).toBe(false);
    expect(callMatcher(matcher, 'xupdate')).toBe(true);
  });
});
