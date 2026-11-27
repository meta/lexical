/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  ElementNode,
  type LexicalEditor,
  LineBreakNode,
  RootNode,
  TextNode,
} from 'lexical';

import {type StorageKind, storageKindOf, withPins} from './Schema';

// describeStorage: how @lexical/y stores each node type, for tools and docs.

/**
 * @experimental
 *
 * How `@lexical/y` stores each node type: `'line'`, `'format'`, `'group'` or
 * `'nested'` for elements (derived from the classes' `$config()`
 * declarations, or the kind a document recorded when `binding` is given),
 * `'text'` for text and line breaks, `'nested'` for decorators. The root is
 * left out.
 */
export function describeStorage(
  editor: LexicalEditor,
  binding?: {readonly pins: ReadonlyMap<string, {readonly kind: StorageKind}>},
): Record<string, StorageKind | 'text'> {
  return withPins(binding ? binding.pins : null, () => {
    const out: Record<string, StorageKind | 'text'> = {};
    for (const [type, {klass}] of editor._nodes) {
      if (klass === RootNode || klass.prototype instanceof RootNode) {
        continue;
      }
      if (
        klass === TextNode ||
        klass.prototype instanceof TextNode ||
        klass === LineBreakNode ||
        klass.prototype instanceof LineBreakNode
      ) {
        out[type] = 'text';
      } else if (klass.prototype instanceof ElementNode) {
        out[type] = storageKindOf(klass);
      } else {
        out[type] = 'nested';
      }
    }
    return out;
  });
}
