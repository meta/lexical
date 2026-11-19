/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {createRefCountedRegistry} from 'lexical';
import {describe, expect, test, vi} from 'vitest';

describe('createRefCountedRegistry', () => {
  test('activates on the first registration and passes options through', () => {
    const activate = vi.fn((_key: string, _options?: {n: number}) => () => {});
    const registry = createRefCountedRegistry<string, {n: number}>(activate);

    registry.register('a', {n: 1});
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith('a', {n: 1});
  });

  test('reference counts: activates once, disposes only after the last release', () => {
    const dispose = vi.fn();
    const activate = vi.fn(() => dispose);
    const registry = createRefCountedRegistry<string>(activate);

    const releaseA = registry.register('k');
    const releaseB = registry.register('k');
    expect(activate).toHaveBeenCalledTimes(1);

    releaseA();
    expect(dispose).not.toHaveBeenCalled();

    releaseB();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test('distinct keys activate and dispose independently', () => {
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    const registry = createRefCountedRegistry<string>(key =>
      key === 'a' ? disposeA : disposeB,
    );

    registry.register('a');
    const releaseB = registry.register('b');
    releaseB();

    expect(disposeA).not.toHaveBeenCalled();
    expect(disposeB).toHaveBeenCalledTimes(1);
  });

  test('the disposer is idempotent', () => {
    const dispose = vi.fn();
    const registry = createRefCountedRegistry<string>(() => dispose);

    const release = registry.register('k');
    release();
    release();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test('re-registering a released key creates a fresh activation', () => {
    const dispose = vi.fn();
    const activate = vi.fn(() => dispose);
    const registry = createRefCountedRegistry<string>(activate);

    registry.register('k')();
    expect(dispose).toHaveBeenCalledTimes(1);
    registry.register('k');
    expect(activate).toHaveBeenCalledTimes(2);
  });

  test('a stale disposer does not affect a fresh entry for the same key', () => {
    const dispose1 = vi.fn();
    const dispose2 = vi.fn();
    let call = 0;
    const registry = createRefCountedRegistry<string>(() =>
      ++call === 1 ? dispose1 : dispose2,
    );

    const staleRelease = registry.register('k');
    staleRelease(); // entry #1 torn down
    registry.register('k'); // entry #2 active
    staleRelease(); // idempotent + guarded: must not touch entry #2

    expect(dispose1).toHaveBeenCalledTimes(1);
    expect(dispose2).not.toHaveBeenCalled();
  });

  test('dispose() tears down every live registration', () => {
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    const registry = createRefCountedRegistry<string>(key =>
      key === 'a' ? disposeA : disposeB,
    );

    registry.register('a');
    registry.register('b');
    registry.register('b'); // count 2 — still one activation
    registry.dispose();

    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).toHaveBeenCalledTimes(1);
  });

  test('a disposer held after registry.dispose() is a no-op', () => {
    const dispose = vi.fn();
    const registry = createRefCountedRegistry<string>(() => dispose);

    const release = registry.register('k');
    registry.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);

    // The outstanding disposer must not run the already-run teardown again.
    release();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
