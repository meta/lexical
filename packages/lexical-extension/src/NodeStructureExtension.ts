/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  defineExtension,
  INTERNAL_registerNodeStructure,
  type LexicalEditor,
  safeCast,
} from 'lexical';

import {namedSignals} from './namedSignals';
import {effect} from './signals';

/**
 * @experimental node-structure
 *
 * Configuration of {@link NodeStructureExtension} (each key is also a
 * signal in its output).
 */
export interface NodeStructureConfig {
  /**
   * `true` stops enforcing the declarations (they are then only read).
   * Turning it back to `false` normalizes the whole document. Default
   * `false`.
   */
  disabled: boolean;
}

/**
 * @experimental node-structure
 *
 * Enforces on `editor` the structure node classes declare in `$config()`,
 * as {@link NodeStructureExtension} does (with the same limits), for code
 * that builds an editor without extensions. The current document is
 * normalized too. Registering more than once is harmless; the normalization
 * stops when every returned function has been called.
 *
 * @returns A function that removes this registration
 */
export function registerNodeStructure(editor: LexicalEditor): () => void {
  return INTERNAL_registerNodeStructure(editor);
}

/**
 * @experimental node-structure
 *
 * Enforces the structure node classes declare in `$config()`:
 * - `children`: a block in a node that holds inline content is lifted out
 *   and the node split around it (a plain paragraph becomes lines of the
 *   node instead), inline content in a node that holds blocks is wrapped in
 *   a paragraph, and a child a list of classes does not allow is wrapped in
 *   the first listed class;
 * - `mergeAdjacent`: equal adjacent siblings are merged.
 *
 * A class that declares `children: 'block'` is also a block container for
 * the structural commands (see `$isBlockContainer` in `lexical`): they
 * convert, wrap, split and insert blocks inside it, as in a shadow root,
 * and never replace or split it.
 *
 * It runs in the same update as the change, after the other transforms of
 * each pass, from the root down along the nodes the update changed, so the
 * result depends on the document only. Repairs only move content; the one
 * thing removed is an inline element left with nothing in it (a link, a
 * mark, an `OverflowNode`), which Lexical removes anyway.
 *
 * An update applied with `skipTransforms` runs no transform, so it is not
 * normalized, and later updates repair only what they change (inline content
 * it leaves at the root is wrapped, as core's own transform wraps it). Code
 * that applies updates with `skipTransforms` calls the normalization itself.
 *
 * Opt-in: without it, the declarations change nothing at runtime.
 */
export const NodeStructureExtension = defineExtension({
  build: (editor, config, state) => namedSignals(config),
  config: safeCast<NodeStructureConfig>({
    disabled: false,
  }),
  name: '@lexical/NodeStructure',
  register: (editor, config, state) => {
    const stores = state.getOutput();
    return effect(() => {
      if (!stores.disabled.value) {
        return registerNodeStructure(editor);
      }
    });
  },
});
