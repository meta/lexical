/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import * as Y from '@y/y';

/**
 * The items of `doc` whose left or right neighbour belongs to another shared
 * type (`client:clock` of each). A well-formed document has none: such an item
 * is linked into one type's list while it names another as its parent, which
 * only the document that wrote it holds (every other client integrates it
 * from its origin), and that document's reads then go wrong.
 */
export function misLinkedItems(doc: Y.Doc): string[] {
  const out: string[] = [];
  for (const structs of doc.store.clients.values()) {
    for (const s of structs) {
      if (!(s instanceof Y.Item)) {
        continue;
      }
      if (
        (s.left !== null && s.left.parent !== s.parent) ||
        (s.right !== null && s.right.parent !== s.parent)
      ) {
        out.push(`${s.id.client}:${s.id.clock}`);
      }
    }
  }
  return out;
}
