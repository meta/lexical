/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The documents `@lexical/y` binds and serves (see createYDoc).
//
// Invariant: a document the binding writes never runs Yjs's format cleanup,
// from its creation on. Why: after a remote change, the cleanup deletes the
// format items it finds redundant, among them the ones left where text was
// deleted. The binding keeps those (see Cursor#delete): text a
// collaborator types into the deleted text at the same time keeps the
// formats it was typed with only while they are there. The cleanup is also
// a write of this client's that reaches every peer. A document that ran it
// before the binding attached (a stored state applied first) may already
// have deleted some, so the binding refuses to write to one that runs it
// (see UNSUPPORTED_CONFIG_WARNING, `'cleanup-formatting'`).

import {applyUpdate, Doc} from '@y/y';

import {assertSupportedYjs} from './YjsContract';

/**
 * The key of {@link YDoc}'s phantom brand. Declared rather than defined: it
 * exists only in the type system, so nothing is emitted for it. Named so
 * that tsc's message for a document made another way reads as the fix:
 * "Property '[createdByCreateYDoc]' is missing in type 'Doc' but required in
 * type 'YDoc'".
 */
declare const createdByCreateYDoc: unique symbol;

/**
 * @experimental A `Y.Doc` made by {@link createYDoc}: Yjs's format cleanup
 * is off from its creation, so applying an update to it never deletes
 * format items of its own accord.
 */
export interface YDoc extends Doc {
  /** Phantom brand: only `createYDoc` makes a YDoc. */
  readonly [createdByCreateYDoc]: true;
}

/** @experimental The options of `new Y.Doc(options)`. */
export type YDocOptions = ConstructorParameters<typeof Doc>[0];

/**
 * @experimental A `Y.Doc` for `@lexical/y`: a client's (`YCollabExtension`'s
 * `doc`), or a relay's or server's that loads a document's state (to store,
 * compact or merge it). Yjs's format cleanup is turned off
 * (`cleanupFormatting = false`) before anything is applied to it: applying
 * an update to a document with it on deletes format items the binding keeps,
 * and the document then reads differently from its peers once someone types
 * there. `state`, a stored state, is applied when given; `options` are those
 * of `new Y.Doc(options)` (the default document is garbage collected, as
 * clients store one). Merging updates with `mergeUpdates` needs no document.
 * Throws a `YUnsupportedYjsError`, before the document is made, when the
 * `@y/y` the app loaded is not the one `@lexical/y` supports.
 */
export function createYDoc(
  state?: Uint8Array | null,
  options?: YDocOptions,
): YDoc {
  assertSupportedYjs();
  const doc = new Doc(options);
  doc.cleanupFormatting = false;
  if (state != null) {
    try {
      applyUpdate(doc, state);
    } catch (error) {
      doc.destroy();
      throw error;
    }
  }
  return doc as YDoc;
}
