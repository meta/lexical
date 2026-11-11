/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * A registry mapping keys to a per-key activation, reference counted so the
 * activation is created on the first registration for a key and torn down
 * only when the last outstanding registration for that key is released. This
 * lets the same key be driven by more than one caller (or survive a
 * re-entrant / double registration) without double-wiring or premature
 * teardown.
 *
 * Keys are compared by identity (Map semantics), so any object works — a DOM
 * element, a `Document`, a `Window`, or an opaque handle.
 */
export interface RefCountedRegistry<Key, Options = void> {
  /**
   * Register `key` (reference counted) and return an idempotent disposer. The
   * first registration for a key runs the activation; the disposer it returns
   * runs once the last registration for that key is released.
   *
   * `options` configure the activation and are therefore only read on the
   * activating (first) registration for a key. While a key is live, further
   * registrations share that one activation and their `options` are ignored —
   * ref counting models repeat registrations as the *same* logical thing, so
   * registering one key with conflicting options is a caller error, not a
   * merge. Release the key fully before re-registering it with new options.
   */
  register: (key: Key, options?: Options) => () => void;
  /** Dispose every live registration and clear the registry. */
  dispose: () => void;
}

/**
 * Creates a {@link RefCountedRegistry}.
 *
 * @param activate - Wires `key` and returns its teardown. Called on the first
 *   registration of each key.
 * @__NO_SIDE_EFFECTS__
 */
export function createRefCountedRegistry<Key, Options = void>(
  activate: (key: Key, options: Options | undefined) => () => void,
): RefCountedRegistry<Key, Options> {
  interface Entry {
    // The live registrations for the key. Each registration's disposer is its
    // own token; the activation is torn down once the set empties.
    holders: Set<() => void>;
    dispose: () => void;
  }
  const entries = new Map<Key, Entry>();
  return {
    dispose() {
      for (const entry of entries.values()) {
        entry.dispose();
      }
      entries.clear();
    },
    register(key, options) {
      let entry = entries.get(key);
      if (entry === undefined) {
        entry = {dispose: activate(key, options), holders: new Set()};
        entries.set(key, entry);
      }
      // The disposer is its own holder token. It re-resolves the entry by key
      // so it never pins a disposed entry (and its activation cleanup) alive,
      // and so any stale release — a double call, or one after teardown or
      // re-registration — is a no-op: the live entry (if any) does not contain
      // this token, so `Set.delete` returns false. The activation is disposed
      // once the last holder releases.
      const release = () => {
        const current = entries.get(key);
        if (
          current &&
          current.holders.delete(release) &&
          current.holders.size === 0
        ) {
          entries.delete(key);
          current.dispose();
        }
      };
      entry.holders.add(release);
      return release;
    },
  };
}
