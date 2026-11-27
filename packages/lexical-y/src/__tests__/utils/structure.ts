/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import * as Y from '@y/y';

/**
 * The items of `doc` whose list links are broken (`client:clock` of each): a
 * left or right neighbour that belongs to another shared type (or another key
 * of a map), or that does not link back to the item. A well-formed document
 * has none. An item linked into one type's list while it names another as its
 * parent, or one a forward walk of its list skips, is held only by the
 * document that wrote it (every other client integrates it from its origin),
 * and that document's reads then go wrong.
 */
export function misLinkedItems(doc: Y.Doc): string[] {
  const out: string[] = [];
  for (const structs of doc.store.clients.values()) {
    for (const s of structs) {
      if (!(s instanceof Y.Item)) {
        continue;
      }
      const {left, right} = s;
      if (
        (left !== null &&
          (left.parent !== s.parent ||
            left.parentSub !== s.parentSub ||
            left.right !== s)) ||
        (right !== null &&
          (right.parent !== s.parent ||
            right.parentSub !== s.parentSub ||
            right.left !== s))
      ) {
        out.push(`${s.id.client}:${s.id.clock}`);
      }
    }
  }
  return out;
}
