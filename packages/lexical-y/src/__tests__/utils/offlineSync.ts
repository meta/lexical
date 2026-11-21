/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {YOfflineSession} from '../../offline';

// `markSynced()` is a `'same'` verdict's (D135): these tests keep the last
// one each session's `serverEpoch` answered, and call it where they mark
// the document synced. A test that never confirmed the epoch fails here.

const confirmed = new WeakMap<YOfflineSession, () => void>();

/** `session`, keeping the `markSynced` of every `'same'` verdict it gives. */
export function trackVerdicts<S extends YOfflineSession>(session: S): S {
  const serverEpoch = session.serverEpoch.bind(session);
  session.serverEpoch = async (...args) => {
    const verdict = await serverEpoch(...args);
    if (verdict.kind === 'same') {
      confirmed.set(session, verdict.markSynced);
    }
    return verdict;
  };
  return session;
}

/**
 * The last `'same'` verdict's `markSynced()` of `session`, at once; with
 * none yet, after confirming the session's epoch (`serverEpoch(epoch)`,
 * which answers `'same'` for the epoch it was attached with).
 */
export function markSynced(session: YOfflineSession): Promise<void> | void {
  const confirm = confirmed.get(session);
  if (confirm !== undefined) {
    confirm();
    return;
  }
  const epoch = session.epoch;
  if (epoch === null) {
    throw new Error(
      'markSynced: a session that never synced has no epoch to confirm (call await session.serverEpoch(epoch) first)',
    );
  }
  return session.serverEpoch(epoch).then(verdict => {
    if (verdict.kind !== 'same') {
      throw new Error(`markSynced: serverEpoch answered ${verdict.kind}`);
    }
    verdict.markSynced();
  });
}
