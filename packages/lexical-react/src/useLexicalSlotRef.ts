/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  type LexicalEditor,
  mountSlotContainer,
  type NodeKey,
  unmountSlotContainer,
} from 'lexical';
import {type RefCallback, useCallback} from 'react';

/**
 * Mounts a host's named slot into the host's React-rendered chrome. The
 * reconciler renders every slot subtree synchronously into a hidden
 * placeholder container; attach the returned ref to the element where the
 * slot should live and this hook moves the container there after each
 * render, before paint, revealing it. It re-runs
 * every render and is idempotent (a React wrapper over the
 * framework-independent {@link mountSlotContainer}), so a slot added after
 * the host's first render — or a container recreated by a remove/re-add —
 * is picked up without extra wiring. On unmount (or a nodeKey/slotName
 * change) the previous container is parked back in its host DOM as a hidden
 * placeholder via {@link unmountSlotContainer}.
 */
export function useLexicalSlotRef<T extends HTMLElement = HTMLElement>(
  editor: LexicalEditor,
  nodeKey: NodeKey,
  slotName: string,
): RefCallback<T | null> {
  return useCallback<RefCallback<T | null>>(
    target => {
      if (target) {
        const container = mountSlotContainer(editor, nodeKey, slotName, target);
        if (container) {
          return unmountSlotContainer.bind(null, editor, nodeKey, container);
        }
      }
    },
    [editor, nodeKey, slotName],
  );
}
