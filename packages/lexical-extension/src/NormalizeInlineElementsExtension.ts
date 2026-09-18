/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $isElementNode,
  defineExtension,
  ElementNode,
  type LexicalNode,
  safeCast,
} from 'lexical';

import {namedSignals} from './namedSignals';
import {effect} from './signals';

const __DEV__ = process.env.NODE_ENV !== 'production';

export interface NormalizeInlineElementsConfig {
  disabled: boolean;
}

function deleteEmptyInline(node: LexicalNode) {
  if ($isElementNode(node) && node.isInline() && node.isEmpty()) {
    node.remove();
    if (__DEV__ && node.canBeEmpty()) {
      console.warn(
        `Empty inline elements are removed from the EditorState, so returning 'true' from ${node.constructor.name}.canBeEmpty() is not allowed`,
      );
    }
  }
}

/**
 * This extension removes empty inline nodes from the EditorState.
 * This extension is designed to facilitate a smooth migration from
 * the plugin API with the option to disable it, but it may be removed
 * in the future and integrated into the core
 */
export const NormalizeInlineElementsExtension = defineExtension({
  build: (editor, config, state) => namedSignals(config),
  config: safeCast<NormalizeInlineElementsConfig>({
    disabled: false,
  }),
  name: '@lexical/NormalizeInlineElements',
  register: (editor, config, state) => {
    const stores = state.getOutput();
    return effect(() => {
      if (!stores.disabled.value) {
        const disposeTransformers: VoidFunction[] = [];
        for (const {klass, transforms} of editor._nodes.values()) {
          if (
            klass.prototype instanceof ElementNode &&
            klass.prototype.isInline !== ElementNode.prototype.isInline
          ) {
            transforms.add(deleteEmptyInline);
            disposeTransformers.push(() =>
              transforms.delete(deleteEmptyInline),
            );
          }
        }
        return () => disposeTransformers.forEach(fn => fn());
      }
    });
  },
});
