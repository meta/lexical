/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Doc} from '@y/y';

// Client ids in a document's range (see ClientIDRange). Invariant: under
// 'uint32', the document's client id fits in 32 bits, also after Yjs draws a
// new one. Why: a server that reads ids as 32-bit numbers would store the
// author's content under a truncated id.

/**
 * @experimental The range of the client ids a document writes with.
 * - `'uint53'`: Yjs 14's default (random 53-bit ids).
 * - `'uint32'`: ids that fit in 32 bits, for servers that read client ids
 *   as 32-bit numbers (yrs before 0.28, e.g. y-crdt relays on 0.23): with a
 *   53-bit id, such a server stores the author's content under a truncated
 *   id, and the author receives its own content back as another client's on
 *   reconnect, duplicating the document.
 */
export type ClientIDRange = 'uint53' | 'uint32';

const MAX_UINT32 = 0xffffffff;

function randomUint32(): number {
  const c = globalThis.crypto;
  if (c !== undefined && typeof c.getRandomValues === 'function') {
    const a = new Uint32Array(1);
    c.getRandomValues(a);
    return a[0] === 0 ? 1 : a[0];
  }
  return Math.floor(Math.random() * MAX_UINT32) + 1;
}

/**
 * Keep `doc`'s client id in 32 bits: now, and whenever Yjs draws a new one
 * (it does when it receives an update with the doc's own id). Returns a
 * function that stops watching.
 */
export function constrainClientID(doc: Doc): () => void {
  const fix = () => {
    if (doc.clientID > MAX_UINT32) {
      doc.clientID = randomUint32();
    }
  };
  fix();
  doc.on('afterAllTransactions', fix);
  return () => doc.off('afterAllTransactions', fix);
}
