/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The names and versions a document is recognized by: the shared root's
// default name, the layout record (see LAYOUT_PREFIX), and the older
// layouts' roots.

/**
 * @experimental The default name of the shared root, which `@lexical/yjs`
 * clients never write to (they use `root` and `root-v2`).
 */
export const DEFAULT_ROOT_NAME = 'lexical-y';
/**
 * Prefix of the root attributes that record the layout versions a document
 * needs (internal): `lexical-y:<version>` = true, one per version. The record
 * only grows: a writer records a version in the same transaction as the
 * first content that needs it (a new document's version 1 before its
 * content), so no client receives that content without it, and the binding
 * never deletes one. A reader takes the highest version recorded, so two
 * clients that upgrade a document at once agree on it. Any change to how a
 * stored shape is read is a new version.
 */
export const LAYOUT_PREFIX = 'lexical-y:';
/**
 * @experimental The newest layout version this binding reads and writes.
 * A new document records version 1; the first member entry of a set-valued
 * NodeState written into a document also records 2 (clients that only read
 * version 1 then open it read only instead of missing the members).
 */
export const LAYOUT_VERSION = 2;
/**
 * @experimental The oldest layout version this binding reads and writes. A
 * root below it binds read only (UNSUPPORTED_LAYOUT_WARNING, `'older'`)
 * until it is migrated (see @lexical/y/migrate); the migration runner's
 * default target.
 */
export const MIN_LAYOUT = 1;
/** The version a new document records. */
export const BASE_LAYOUT_VERSION = 1;
/**
 * @experimental The layout a new document's seed records (written by
 * `initialize()` and `seedYState`): what a client sends as `seed` in the
 * handshake of @lexical/y/server, so an authority admits a seeder of a
 * pristine room only at its own seed layout (D22).
 */
export const SEED_LAYOUT = BASE_LAYOUT_VERSION;
/**
 * The version of a document holding member entries of set-valued NodeState
 * (`s:<key>\u001f<member>` = true).
 */
export const SET_MEMBERS_LAYOUT_VERSION = 2;
/**
 * The root attribute a layout migration records (see @lexical/y/migrate):
 * `{v: 1, layout, client, clock, step, revision}`, where `(client, clock)`
 * is the id of the migration transaction's first item (its layout record).
 * Outside the layout records' namespace (LAYOUT_PREFIX), so no layout gate
 * parses it; it only grows with each migration, and nothing else writes it.
 */
export const EPOCH_KEY = 'lexical-y-epoch';
/**
 * Prefix of the root attributes that record the versions of the app's own
 * schema (`schemaVersion`: its node types and their stored fields) that
 * wrote to a document (internal): `lexical-y-schema:<version>` = true, one
 * per version. Like the layout record, it only grows: a client records its
 * version in the same transaction as its first write to the document (a new
 * document's before its content), undo never deletes it, and a reader takes
 * the highest, so two clients that write at once agree on it. A client whose
 * `schemaVersion` is lower opens the document read only.
 */
export const SCHEMA_PREFIX = 'lexical-y-schema:';
/** The roots of the Yjs 13 bindings' layouts. */
export const LEGACY_ROOTS: readonly string[] = ['root', 'root-v2'];
