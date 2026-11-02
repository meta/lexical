/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The implementation lives under ./internal and is bundled into this entry;
// `@lexical/y` stays an external sibling.
import {type Doc, encodeStateAsUpdate, mergeUpdates} from '@y/y';
import {
  $getRoot,
  COLLABORATION_TAG,
  type LexicalWarning,
  SKIP_COLLAB_TAG,
} from 'lexical';

import {createYDoc, DEFAULT_ROOT_NAME, YUnsupportedYjsError} from '.';
import {
  closeHeadlessYEditor,
  EDITOR_WARNING,
  FOLLOW_UPS_EXHAUSTED_WARNING,
  type HeadlessYConfig,
  type OpenedHeadlessYEditor,
  openHeadlessYEditor,
  readOnlyError,
  YHeadlessError,
  type YHeadlessErrorCode,
  type YHeadlessWarningCode,
} from './internal/HeadlessEditor';
import {inspectUpdateRoots} from './internal/UpdateRoots';
import {
  createYWriter,
  isYWriter,
  WRITER_NEW_CLIENT_ID_WARNING,
  type YWriter,
} from './internal/Writer';

export type {
  HeadlessYConfig,
  YHeadlessErrorCode,
  YHeadlessWarningCode,
  YWriter,
};
export {
  createYDoc,
  createYWriter,
  EDITOR_WARNING,
  FOLLOW_UPS_EXHAUSTED_WARNING,
  WRITER_NEW_CLIENT_ID_WARNING,
  YHeadlessError,
  YUnsupportedYjsError,
};

/** @experimental The result of {@link editYState}. */
export interface EditYStateResult {
  /**
   * Everything the edit wrote, as one merged update, or null when it changed
   * nothing. Includes what opening the document wrote (a value an
   * extension assigns on open, which a client would also write), which the
   * edit may depend on.
   */
  update: Uint8Array | null;
  /**
   * `state` with `update` applied, garbage collected as clients and Yjs
   * servers store a document (deleted content keeps only its tombstones).
   * When `update` is null, `state` garbage collected the same way.
   */
  state: Uint8Array;
  /**
   * Warnings reported while opening and editing, oldest first (also passed
   * to `config.onWarn`).
   */
  warnings: LexicalWarning[];
  /**
   * The client id the edit wrote under (also when it wrote nothing): the
   * writer's for this document, or a new anonymous one with `writer: null`.
   * Credit it to the writer's author in your attribution, such as a registry
   * of client ids, or attribute the update's ids directly
   * (`createContentIdsFromUpdate(update)` from `@y/y`, when `update` is not
   * null). Never assign it to a `Y.Doc`: two writers under one client id
   * corrupt the document.
   */
  clientID: number;
}

/** @experimental */
export interface EditYStateOptions {
  /**
   * Who the edit is written as. Required, so that every call decides:
   * - a writer from {@link createYWriter} (one per agent or integration,
   *   created once per process): the edit continues the writer's client id
   *   for this document, so the server's edits of a document add one client
   *   id to it, not one per edit. It continues only on a state whose clock
   *   for that id is where the writer's last update there ended (a state
   *   that holds that update); otherwise the edit is written under a new
   *   client id. When the state holds the id but not at its tip (a state
   *   read before that update), or another call with the writer is writing
   *   under it, a {@link WRITER_NEW_CLIENT_ID_WARNING} warning says why; a
   *   state that holds none of the writer's ids (another document, or one
   *   read before the writer's first edit there) gets a new id silently;
   * - `null`: a new anonymous client id for this edit alone. Every edit
   *   that writes adds a client id to the document for good: its state
   *   vector, which every sync sends, and every call's cost grow with them.
   *
   * The result's `clientID` is the client id the edit wrote under.
   */
  writer: YWriter | null;
  /**
   * The shared roots the update may write to; anything else refuses the
   * edit (`'foreign-roots'`). Default: the layout root only. The list
   * replaces the default, so name the layout root in it too.
   */
  allowedRoots?: Iterable<string>;
  /**
   * Writes to other shared types of the document (for example an activity
   * log), run in one Yjs transaction after the edit, under the edit's client
   * id (`doc.clientID`). Their roots must be in `allowedRoots`. It only
   * writes: an update applied to `doc` here refuses the edit
   * (`'imported-items'`), as its items would be credited to the writer.
   * `doc` is released when the call returns: publish the returned `update`,
   * never this document's own events.
   */
  transact?: (doc: Doc) => void;
  /**
   * Update tag(s) of the edit's editor update. `COLLABORATION_TAG` and
   * `SKIP_COLLAB_TAG` are refused (`'ignored-tag'`): the binding does not
   * write an update that carries them, so the edit would be lost.
   */
  tag?: string | string[];
}

/**
 * A document's state as clients and Yjs servers store it: encoded from a
 * garbage-collected document, so content deleted by then keeps only its
 * tombstones.
 */
function compactState(state: Uint8Array): Uint8Array {
  const doc = createYDoc(state);
  try {
    return encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/** Tags with which the binding writes nothing: a remote or skipped update. */
const IGNORED_TAGS: ReadonlySet<string> = new Set([
  COLLABORATION_TAG,
  SKIP_COLLAB_TAG,
]);

function refuseIgnoredTags(tag: string | string[] | undefined): void {
  const tags = tag === undefined ? [] : typeof tag === 'string' ? [tag] : tag;
  const ignored = tags.filter(t => IGNORED_TAGS.has(t));
  if (ignored.length > 0) {
    throw new YHeadlessError(
      'ignored-tag',
      `@lexical/y: the binding does not write an update tagged ${ignored
        .map(t => `'${t}'`)
        .join(
          ' or ',
        )}, so the edit would be lost; remove it from options.tag (those tags mark updates the binding makes itself).`,
    );
  }
}

/**
 * The binding refuses a change it cannot store (a named slot on a node that
 * has no Y.Node of its own) and opens read only: nothing of it was written.
 */
function requireWritten(opened: OpenedHeadlessYEditor): void {
  if (opened.handle.binding.status === 'readonly') {
    throw readOnlyError('the change was not written', opened.handle.warnings);
  }
}

/**
 * `options.writer`, which the type requires: a check for callers without
 * types (JavaScript, a cast), whose call would otherwise fail on
 * `undefined` or write under an id nobody chose.
 */
function requireWriter(options: EditYStateOptions | undefined): YWriter | null {
  const writer: unknown = options == null ? undefined : options.writer;
  if (writer === null || isYWriter(writer)) {
    return writer;
  }
  throw new TypeError(
    `@lexical/y: editYState needs options.writer (got ${
      writer === undefined ? 'none' : typeof writer
    }): a writer from createYWriter(author), created once per process and passed to every edit it makes, or null to write this edit under a new anonymous client id.`,
  );
}

function requireInitialized(opened: OpenedHeadlessYEditor): void {
  if (opened.handle.binding.status !== 'active') {
    throw new YHeadlessError(
      'not-initialized',
      '@lexical/y: the state has no layout record; seed the document first, with seedYState(config, $build).',
    );
  }
}

/**
 * @experimental The state of a new document whose content `$build` writes
 * into an empty root: the documented way to seed a document (from a
 * template, an import, or a converter's editor). The content is written as
 * a client's `initialize()` writes its initial content: with a client id
 * derived from the content (53 bits under `'uint53'`, 32 under `'uint32'`)
 * and outside any undo history, with the config's `schemaVersion` recorded.
 * Seeding identical content twice (with the same `schemaVersion`) gives the
 * same bytes, and the two seeds merge into one copy; content with random
 * parts (such as ids an extension draws for new blocks) is not identical.
 * With `BlockIdExtension`, a seed and a client's initialization of the same
 * content name its blocks differently (a client's initial content is a
 * load, named by position; a seed's blocks are named by `generateId`), so
 * they do not merge unless the content gives its blocks fixed ids. The
 * state only holds the layout root, so a converter merges it into the
 * stored document next to an older layout's root. The state is garbage
 * collected, as clients store a document.
 *
 * It takes no writer: the client id is derived from the content, which is
 * what makes identical seeds merge. To credit a seed in your attribution,
 * use the client ids in its state vector
 * (`decodeStateVector(encodeStateVectorFromUpdate(seed))` from `@y/y`): that
 * one id, unless a listener of the config's extensions writes once the
 * content is read (a value it sets on open), which adds the temporary
 * document's own id.
 */
export function seedYState(
  config: HeadlessYConfig,
  $build: () => void,
): Uint8Array {
  const opened = openHeadlessYEditor(config);
  try {
    opened.runUpdate(() => {
      $getRoot().clear();
      $build();
    });
    opened.handle.binding.initialize();
    requireWritten(opened);
    requireInitialized(opened);
    return compactState(encodeStateAsUpdate(opened.handle.doc));
  } finally {
    closeHeadlessYEditor(opened);
  }
}

/**
 * @experimental Run `$edit` (one discrete editor update, plus the updates it
 * makes listeners schedule) on the document at `state` and return the update
 * it makes, written as `options.writer` (required: a writer from
 * {@link createYWriter}, or `null` for a new anonymous client id). The
 * update is checked to write only to `allowedRoots`. Throws a
 * {@link YHeadlessError} when the document is not initialized or is read
 * only, when the update writes elsewhere, or when `options.tag` names a tag
 * with which the binding writes nothing (`COLLABORATION_TAG`,
 * `SKIP_COLLAB_TAG`). Whatever `$edit` throws (any
 * value, an `Error` or not) is rethrown as it is, and nothing is written:
 * `transact` does not run. Warnings (`LexicalWarning`s) are
 * returned in `warnings` and passed to `config.onWarn`; they never refuse
 * the edit.
 *
 * With `$edit` a no-op, the update is what opening the document writes
 * (values an extension assigns on open): store it once before relying on
 * {@link readYState} for such values.
 */
export function editYState(
  state: Uint8Array,
  config: HeadlessYConfig,
  $edit: () => void,
  options: EditYStateOptions,
): EditYStateResult {
  const writer = requireWriter(options);
  refuseIgnoredTags(options.tag);
  // What opening writes is recorded too: the edit may build on it.
  const opened = openHeadlessYEditor({...config, state}, true, writer);
  const {doc, warnings} = opened.handle;
  const updates = opened.writes;
  const lease = opened.lease;
  // Everything this call writes is under this id. Read it now: Yjs draws a
  // new one for `doc` when a transaction that also writes under it applies
  // another update (a `transact` that does), after the writes.
  const clientID = doc.clientID;
  try {
    requireInitialized(opened);
    opened.runUpdate($edit, options.tag);
    requireWritten(opened);
    if (options.transact) {
      const transact = options.transact;
      doc.transact(() => transact(doc));
    }
    let update: Uint8Array | null = null;
    if (updates.length > 0) {
      update = updates.length === 1 ? updates[0] : mergeUpdates(updates);
      const allowed = new Set(
        options.allowedRoots || [config.root || DEFAULT_ROOT_NAME],
      );
      // Resolved against the headless document, which holds every parent
      // and every deleted item (it does not garbage collect).
      const {clients, roots, unresolved} = inspectUpdateRoots(update, doc);
      // Everything the binding and `transact` write is under `clientID`:
      // items under another id were applied from another update.
      const imported = [...clients].filter(id => id !== clientID);
      if (imported.length > 0) {
        throw new YHeadlessError(
          'imported-items',
          `@lexical/y: the update holds items written under other client ids (${imported.join(
            ', ',
          )}): options.transact applied another update to the edit's document, so they would be returned as this edit's and credited to its writer. Apply other updates to your own copy of the document; use transact only to write.`,
        );
      }
      const foreign = [...roots].filter(root => !allowed.has(root));
      if (foreign.length > 0 || unresolved > 0) {
        throw new YHeadlessError(
          'foreign-roots',
          foreign.length > 0
            ? `@lexical/y: the update writes outside the allowed roots (${foreign.join(
                ', ',
              )}); list every root the edit may write to in options.allowedRoots, which replaces the default, so name the layout root ('${
                config.root || DEFAULT_ROOT_NAME
              }') there too.`
            : `@lexical/y: the update writes ${unresolved} item(s) whose root cannot be resolved (their parents are neither in the update nor in the state); pass the complete stored state.`,
        );
      }
    }
    // Checked above on the uncompacted document; what is stored is
    // compacted like the clients' copies (also when nothing changed, so
    // that a returned state always is). `update` is sent as it is.
    const result: EditYStateResult = {
      clientID,
      state: compactState(encodeStateAsUpdate(doc)),
      update,
      warnings: [...warnings],
    };
    // The update is returned: the writer's client id continues from it.
    if (lease !== null) {
      lease.commit(doc);
    }
    return result;
  } finally {
    // Released unless committed above: nothing this call wrote left it.
    if (lease !== null) {
      lease.release();
    }
    closeHeadlessYEditor(opened);
  }
}

/**
 * @experimental The value `$read` returns from the document at `state` (for
 * example its Markdown or `$getEditor().getEditorState().toJSON()`).
 * Nothing is written. Throws a {@link YHeadlessError} when the document is
 * not initialized or is read only.
 *
 * What opening the document writes is discarded: a value an extension
 * assigns on open is read here but never stored, so two reads can
 * disagree. Store the update of a no-op {@link editYState} first.
 * `BlockIdExtension` assigns nothing on open: a block stored without an id,
 * or with an id an earlier block stores or derives, reads the id derived
 * from its Yjs identity, the same in every read.
 */
export function readYState<T>(
  state: Uint8Array,
  config: HeadlessYConfig,
  $read: () => T,
): T {
  const opened = openHeadlessYEditor({...config, state});
  try {
    requireInitialized(opened);
    return opened.handle.editor.read($read);
  } finally {
    closeHeadlessYEditor(opened);
  }
}
