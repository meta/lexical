/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node
import {} from '@lexical/extension';
import {describe, expect, it} from 'vitest';

import {deepThemeMergeInPlace} from '../../internal/deepThemeMergeInPlace';

describe('deepThemeMergeInPlace', () => {
  it('merges recursively', () => {
    const a = {a: 'a', nested: {a: 1}};
    const b = {b: 'b', nested: {b: 2}};
    const rval = deepThemeMergeInPlace(a, b);
    expect(a).toBe(rval);
    expect(a).toEqual({a: 'a', b: 'b', nested: {a: 1, b: 2}});
  });

  it('does not pollute the prototype via __proto__', () => {
    // A `__proto__` key as produced by JSON.parse is an own enumerable
    // property, which a naive merge would funnel into Object.prototype.
    const malicious = JSON.parse(
      '{"paragraph":"x","__proto__":{"polluted":1}}',
    );
    const target: Record<string, unknown> = {paragraph: 'base'};

    deepThemeMergeInPlace(target, malicious);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(target).toEqual({paragraph: 'x'});
  });

  it('does not pollute via constructor/prototype keys', () => {
    const malicious = JSON.parse(
      '{"constructor":{"prototype":{"polluted":1}},"prototype":{"polluted":1}}',
    );
    const target: Record<string, unknown> = {};

    deepThemeMergeInPlace(target, malicious);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});
