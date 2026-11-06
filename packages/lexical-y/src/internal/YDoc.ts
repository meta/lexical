/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The documents `@lexical/y` binds: built on the Yjs-only factory
// (createRawYDoc, see RawYDoc), which the migration runner and the server
// entry use alone. Whatever a client's document needs beyond it (for the
// binding) is added here, never there.

import {installCopyRepair} from './Ident';
import {applyStoredState} from './LoadFully';
import {createRawYDoc, type YDoc, type YDocOptions} from './RawYDoc';

export type {YDoc, YDocOptions};

/**
 * @experimental A `Y.Doc` for `@lexical/y`: a client's (`YCollabExtension`'s
 * `doc`), or a relay's or server's that loads a document's state (to store,
 * compact or merge it). Yjs's format cleanup is turned off
 * (`cleanupFormatting = false`) before anything is applied to it: applying
 * an update to a document with it on deletes format items the binding keeps,
 * and the document then reads differently from its peers once someone types
 * there (on layout 3 the cleanup also makes loading a stored state several
 * times slower). Servers and relays create their documents with it: the
 * package ships no relay helper. `state`, a stored state, is applied when
 * given; `options` are those of `new Y.Doc(options)` (the default document
 * is garbage collected, as clients store one). Merging updates with
 * `mergeUpdates` needs no document.
 * Throws a `YUnsupportedYjsError`, before the document is made, when the
 * `@y/y` the app loaded is not the one `@lexical/y` supports.
 */
export function createYDoc(
  state?: Uint8Array | null,
  options?: YDocOptions,
): YDoc {
  const doc = createRawYDoc(null, options);
  // What a client's document needs beyond the raw one goes here, before
  // anything is applied and before any observer the app adds.
  // Copy repair (see Ident.installCopyRepair): a client's document only,
  // never a raw one (relays and migration scratch documents never undo).
  installCopyRepair(doc);
  if (state != null) {
    try {
      // What the document that encoded `state` showed, a struct it
      // integrated across a clock gap included (see LoadFully).
      applyStoredState(doc, state);
    } catch (error) {
      doc.destroy();
      throw error;
    }
  }
  return doc;
}
