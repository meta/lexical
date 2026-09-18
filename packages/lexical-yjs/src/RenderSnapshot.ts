/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {BindingV2} from './Bindings';

import invariant from '@lexical/internal/invariant';
import {$getRoot, $getState, createState, type LexicalNode} from 'lexical';
import {
  emptySnapshot,
  type ID,
  iterateDeletedStructs,
  PermanentUserData,
  type Snapshot,
  snapshot as createSnapshot,
} from 'yjs';

import {$createOrUpdateNodeFromYElement} from './SyncV2';

const STATE_KEY = 'ychange';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type YChange<UserT = any> = {
  id: ID;
  type: 'removed' | 'added';
  user: UserT | null;
};

const ychangeState = createState<typeof STATE_KEY, YChange | null>(STATE_KEY, {
  isEqual: (a, b) => a === b,
  parse: value => (value as YChange) ?? null,
});

export function $getYChangeState<UserT = unknown>(
  node: LexicalNode,
): YChange<UserT> | null {
  return $getState(node, ychangeState);
}

// Not exposing $setState because it should only be created by SyncV2.ts.

/**
 * Replaces the editor content with a view that compares the state between two given snapshots.
 * Any added or removed nodes between the two snapshots will have {@link YChange} attached to them.
 *
 * @param binding Yjs binding
 * @param snapshot Ending snapshot state (default: current state of the Yjs document)
 * @param prevSnapshot Starting snapshot state (default: empty snapshot)
 */
export const renderSnapshot__EXPERIMENTAL = (
  binding: BindingV2,
  snapshot: Snapshot = createSnapshot(binding.doc),
  prevSnapshot: Snapshot = emptySnapshot,
) => {
  // The document that contains the full history of this document.
  const {doc} = binding;
  invariant(!doc.gc, 'GC must be disabled to render snapshot');

  doc.transact(transaction => {
    // Before rendering, we are going to sanitize ops and split deleted ops
    // if they were deleted by separate users.
    const pud = new PermanentUserData(doc);
    if (pud) {
      pud.dss.forEach(ds => {
        iterateDeletedStructs(transaction, ds, _item => {});
      });
    }

    const computeYChange = (type: 'removed' | 'added', id: ID): YChange => {
      const user =
        type === 'added'
          ? pud.getUserByClientId(id.client)
          : pud.getUserByDeletedId(id);
      return {
        id,
        type,
        user: user ?? null,
      };
    };

    binding.mapping.clear();
    binding.editor.update(() => {
      $getRoot().clear();
      $createOrUpdateNodeFromYElement(
        binding.root,
        binding,
        null,
        true,
        snapshot,
        prevSnapshot,
        computeYChange,
      );
    });
  }, binding);
};
