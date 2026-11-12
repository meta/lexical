/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The Yjs-only factory of the documents `@lexical/y` binds and serves (see
// createYDoc, which builds on it): a Doc with Yjs's format cleanup off, and
// nothing else. The migration runner, its steps and the server entry use it
// for every scratch and relay document, so they never load the binding or
// Lexical.
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

import {Doc} from '@y/y';

import {applyStoredState} from './LoadFully';
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
 * @experimental A `Y.Doc` for a relay's, server's or migration's copy of an
 * `@lexical/y` document (exported as `createYDoc` by `@lexical/y/server`):
 * Yjs's format cleanup is turned off (`cleanupFormatting = false`) before
 * anything is applied to it, and nothing else is added. Applying an update
 * to a document with the cleanup on deletes format items the binding keeps,
 * and the stored state then reads differently from what the clients show.
 * A relay never undoes, so it needs nothing the binding adds to a client's
 * document: bind a client's document from `@lexical/y`'s `createYDoc`.
 * `state`, a stored state, is applied when given; `options` are those of
 * `new Y.Doc(options)` (the default document is garbage collected, as
 * clients store one). Throws a `YUnsupportedYjsError`, before the document
 * is made, when the `@y/y` the app loaded is not the one `@lexical/y`
 * supports.
 */
export function createRawYDoc(
  state?: Uint8Array | null,
  options?: YDocOptions,
): YDoc {
  assertSupportedYjs();
  const doc = new Doc(options);
  doc.cleanupFormatting = false;
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
  return doc as YDoc;
}
