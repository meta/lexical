/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getNodeByKey,
  $getSelection,
  defineExtension,
  type NodeKey,
} from 'lexical';

import {EditorStateExtension} from './EditorStateExtension';
import {computed, effect, type ReadonlySignal, signal} from './signals';
import {watchedSignal} from './watchedSignal';

const EMPTY_SET = new Set<NodeKey>();

/**
 * An extension that provides a `watchNodeKey` output that
 * returns a signal for the selection state of a node.
 *
 * Typically used for tracking whether a DecoratorNode is
 * currently selected or not. A framework independent
 * alternative to {@link useLexicalNodeSelection}.
 */
export const NodeSelectionExtension = defineExtension({
  build(editor, config, state) {
    const editorStateStore = state.getDependency(EditorStateExtension).output;
    const watchedNodeStore = signal({
      watchedNodeKeys: new Map<NodeKey, Set<ReadonlySignal<boolean>>>(),
    });
    const selectedNodeKeys = watchedSignal<undefined | Set<NodeKey>>(
      () => undefined,
      () =>
        effect(() => {
          const prevSelectedNodeKeys = selectedNodeKeys.peek();
          const {watchedNodeKeys} = watchedNodeStore.value;
          let nextSelectedNodeKeys: undefined | Set<string>;
          let didChange = false;
          editorStateStore.value.read(() => {
            const selection = $getSelection();
            if (selection) {
              for (const [key, listeners] of watchedNodeKeys.entries()) {
                if (listeners.size === 0) {
                  // We intentionally mutate this without firing a signal, to
                  // avoid re-triggering this effect. There are no subscribers
                  // so nothing can observe whether key was in the set or not
                  watchedNodeKeys.delete(key);
                  continue;
                }
                const node = $getNodeByKey(key);
                const isSelected = (node && node.isSelected()) || false;
                didChange =
                  didChange ||
                  isSelected !==
                    (prevSelectedNodeKeys
                      ? prevSelectedNodeKeys.has(key)
                      : false);
                if (isSelected) {
                  nextSelectedNodeKeys = nextSelectedNodeKeys || new Set();
                  nextSelectedNodeKeys.add(key);
                }
              }
            }
          });
          if (
            !(
              !didChange &&
              nextSelectedNodeKeys &&
              prevSelectedNodeKeys &&
              nextSelectedNodeKeys.size === prevSelectedNodeKeys.size
            )
          ) {
            selectedNodeKeys.value = nextSelectedNodeKeys;
          }
        }),
    );
    function watchNodeKey(key: NodeKey) {
      const watcher = computed(() =>
        (selectedNodeKeys.value || EMPTY_SET).has(key),
      );
      const {watchedNodeKeys} = watchedNodeStore.peek();
      let listeners = watchedNodeKeys.get(key);
      const hadListener = listeners !== undefined;
      listeners = listeners || new Set();
      listeners.add(watcher);
      if (!hadListener) {
        watchedNodeKeys.set(key, listeners);
        watchedNodeStore.value = {watchedNodeKeys};
      }
      return watcher;
    }
    return {watchNodeKey};
  },
  dependencies: [EditorStateExtension],
  name: '@lexical/extension/NodeSelection',
});
