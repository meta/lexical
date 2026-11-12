/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {YSessionHandshake} from './Server';
import type {YDoc} from './YDoc';
import type {Transaction} from '@y/y';

import invariant from '@lexical/internal/invariant';
import {
  $getRoot,
  type LexicalWarning,
  type SerializedEditorState,
} from 'lexical';

import {type YBinding, type YCursor} from './Binding';
import {DEFAULT_ROOT_NAME} from './constants';
import {clientHandshake} from './LayoutUpgrade';
import {
  STORAGE_MISMATCH_WARNING,
  UNKNOWN_NODE_TYPES_WARNING,
  UNSUPPORTED_CONFIG_WARNING,
  UNSUPPORTED_LAYOUT_WARNING,
  UNSUPPORTED_SCHEMA_WARNING,
  UNSUPPORTED_SLOTS_WARNING,
} from './Warnings';

// The binding's public API (layout 4 spec, section 11), its types and the
// YCollabBinding over a YBinding; the entry points are in Collab.ts. One way
// to set it up,
// with the choices an app must make required. Start here:
//
//   const doc = createYDoc();
//   const binding = createYBinding(editor, {doc, schemaVersion: 1,
//     synced: false, onStatus});     // or yCollab({...}) in `dependencies`
//   provider.connect({handshake: binding.handshake(generation)});
//   provider.onFirstSync(() => binding.markSynced());
//   fence.onStale(() => store(binding.freeze()));
//
// YBinding (the class) keeps working; this file adds
// the new entry points beside them.

/**
 * @experimental The defaults of the optional fields of {@link YCollabOptions},
 * by name, so code can say which it relies on (`root: Y_DEFAULTS.root`).
 */
export const Y_DEFAULTS: {
  readonly root: string;
  readonly history: {readonly captureTimeout: number};
} = /* @__PURE__ */ Object.freeze({
  history: /* @__PURE__ */ Object.freeze({captureTimeout: 500}),
  root: DEFAULT_ROOT_NAME,
});

declare const GENERATION: unique symbol;

/**
 * @experimental A room generation (D102), as the server issues it
 * (`getYGeneration` on `@lexical/y/server`): a string of its own type, so
 * any other string is not taken for one. Read one received over the wire
 * with {@link parseYGeneration}.
 */
export type YGeneration = string & {readonly [GENERATION]: true};

/**
 * @experimental `value` as a {@link YGeneration} when it has a generation's
 * form (`'unknown'`, or `g1:` and the rest, which stays opaque), else null.
 */
export function parseYGeneration(value: unknown): YGeneration | null {
  // A generation is opaque (compare and store it, never parse it): only its
  // version prefix is checked here.
  return value === 'unknown' ||
    (typeof value === 'string' && value.startsWith('g1:') && value.length > 3)
    ? (value as YGeneration)
    : null;
}

/**
 * @experimental The handshake a client sends before any sync message (D102):
 * see `checkYSession` on `@lexical/y/server`. Built for you by
 * {@link YCollabBinding.handshake}.
 */
export type YHandshake = YSessionHandshake;

/**
 * @experimental The handshake a client sends before syncing, for a server
 * or a test that has no binding (an app sends
 * {@link YCollabBinding.handshake}, which fills `hasLocalEdits` itself).
 */
export function createYHandshake(input: {
  /** The generation the client's local state was made against, or null. */
  readonly generation: YGeneration | null;
  /** Whether the client holds edits or a cached state the server lacks. */
  readonly hasLocalEdits: boolean;
  /** Features beyond this release's (default: this release's own). */
  readonly features?: readonly string[];
}): YHandshake {
  const handshake = clientHandshake({
    generation: input.generation,
    material: input.hasLocalEdits,
  });
  if (input.features === undefined) {
    return handshake;
  }
  return {
    ...handshake,
    features: [
      ...new Set([...(handshake.features ?? []), ...input.features]),
    ].sort(),
  };
}

/** @experimental Why a binding is read only (see {@link YStatus}). */
export type YReadOnlyCause =
  /** The document's layout is older than this release reads: it waits for its server to migrate it. */
  | {readonly code: 'layout-older'; readonly layout: number}
  /** A newer release wrote the document: reload to update. */
  | {readonly code: 'layout-newer'; readonly layout: number}
  /** A newer version of the app's nodes wrote the document: reload to update. */
  | {readonly code: 'schema-newer'; readonly schemaVersion: number}
  /** The document requires features this release does not have. */
  | {readonly code: 'requires-feature'; readonly features: readonly string[]}
  /** A record of the document (layout, schema, epoch, storage) is not well formed, or is missing. */
  | {readonly code: 'malformed-record'; readonly key: string}
  /** The document holds node types the editor does not register. */
  | {readonly code: 'unknown-node-types'; readonly types: readonly string[]}
  /** A node type is stored in another way than the editor declares it. */
  | {
      readonly code: 'storage-mismatch';
      readonly type: string;
      readonly stored: string;
      readonly declared: string;
    }
  /** The document was not made with `createYDoc`, or the editor's configuration cannot write it. */
  | {readonly code: 'unsupported-doc'}
  /** A node class throws on content the document holds. */
  | {readonly code: 'unreadable-content'; readonly type: string}
  /** The editor made a change the layout cannot store (a slot on a line). */
  | {readonly code: 'unstorable-change'; readonly type: string}
  /** The app called `freeze()`. */
  | {readonly code: 'frozen'};

/**
 * @experimental A binding's status: `pending` until `markSynced()`, then
 * `active` (reading and writing) or `readonly` with its cause.
 */
export type YStatus =
  | {readonly kind: 'pending'}
  | {readonly kind: 'active'}
  | {readonly kind: 'readonly'; readonly cause: YReadOnlyCause};

/**
 * @experimental What the app passes to {@link createYBinding} and
 * {@link yCollab}. `synced` and `onStatus` are required: forgetting both
 * `synced` and `markSynced()` leaves an editor nobody can type in, and an
 * app without `onStatus` never tells its user a document is read only, or
 * why.
 *
 * @example
 * ```ts
 * const doc = createYDoc();
 * const binding = createYBinding(editor, {
 *   doc,
 *   history: Y_DEFAULTS.history, // the default
 *   onStatus: status => showStatus(status),
 *   root: Y_DEFAULTS.root, // the default
 *   schemaVersion: SCHEMA_VERSION,
 *   synced: false, // markSynced() after the provider's first sync
 * });
 * ```
 */
export interface YCollabOptions {
  /** The shared document, from `createYDoc()` (or `createYDoc(state)`). */
  readonly doc: YDoc;
  /**
   * The version of your editor's nodes: an integer from 1 (D08). Bump it
   * when you add, remove or change a node class, its fields or its
   * NodeState. A client with a lower version opens the document read only.
   */
  readonly schemaVersion: number;
  /**
   * Whether the document already holds what the server has (headless, tests,
   * a document loaded from storage): `markSynced()` runs at bind. With
   * `false`, call `binding.markSynced()` after the provider's first sync;
   * until then the editor is not editable.
   */
  readonly synced: boolean;
  /**
   * Called when the status changes (once Yjs is idle). Show the user a
   * read-only document and its cause (see {@link YReadOnlyCause}).
   */
  readonly onStatus: (status: YStatus) => void;
  /**
   * The name of the document's root.
   * @defaultValue `Y_DEFAULTS.root` (`'lexical-y'`)
   */
  readonly root?: string;
  /**
   * Collaborative undo: `{captureTimeout}` in ms, or `false` for none.
   * @defaultValue `Y_DEFAULTS.history` (`{captureTimeout: 500}`)
   */
  readonly history?: {readonly captureTimeout: number} | false;
}

/** @experimental A binding's collaborative undo (see {@link YCollabBinding}). */
export interface YHistory {
  undo(): boolean;
  redo(): boolean;
  clear(): void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Called whenever `canUndo` or `canRedo` may have changed. */
  subscribe(listener: () => void): () => void;
}

/** @experimental What `freeze()` hands the app (11.6). */
export interface YLocalEdits {
  /** The whole document as this client holds it (a Yjs update). */
  readonly state: Uint8Array;
  /** The editor's content as Lexical JSON: what the user sees. */
  readonly json: SerializedEditorState;
  /** The plain text of `json`, for copy-to-recover. */
  readonly text: string;
  /** Whether the editor holds edits the document does not (refused ones). */
  readonly differs: boolean;
}

/**
 * @experimental A bound editor: from {@link createYBinding}, or the
 * `collab` output of YCollabExtension configured with {@link yCollab}.
 */
export interface YCollabBinding {
  readonly status: YStatus;
  /**
   * Call once, after the provider's first sync (or pass `synced: true`): an
   * empty document is seeded with the editor's content, a document with
   * content is read. A second call does nothing.
   */
  markSynced(): void;
  /**
   * The handshake to send before any sync message, with the generation the
   * client's local state was made against (null for none): it fills
   * `hasLocalEdits` and this release's layouts and features.
   */
  handshake(generation: YGeneration | null): YHandshake;
  /** Null when `history` is false. */
  readonly history: YHistory | null;
  /** The selection as relative positions, for an awareness cursor. */
  getCursor(): YCursor | null;
  /**
   * Stop reading and writing (status `readonly`, cause `frozen`) and hand
   * the app its local edits to store (11.6). Call it when the server says
   * the room moved on (a stale generation), before any forced reload.
   */
  freeze(): YLocalEdits;
  /** Disconnect from the document and the editor. */
  dispose(): void;
  /** The YBinding underneath (the existing API). */
  readonly binding: YBinding;
}

/** The read-only cause a binding's warning gives. */
function causeOf(warning: LexicalWarning | null): YReadOnlyCause {
  const data = (warning === null ? {} : warning.data) as Record<
    string,
    unknown
  >;
  const num = (value: unknown) => (typeof value === 'number' ? value : 0);
  const strings = (value: unknown): readonly string[] =>
    Array.isArray(value) ? value.map(String) : [];
  const key = (value: unknown, fallback: string) =>
    typeof value === 'string' ? value : fallback;
  switch (warning === null ? null : warning.code) {
    case UNSUPPORTED_LAYOUT_WARNING:
      switch (data.reason) {
        case 'older':
          return {code: 'layout-older', layout: num(data.found)};
        case 'newer':
          return {code: 'layout-newer', layout: num(data.found)};
        case 'requires':
          return {code: 'requires-feature', features: strings(data.features)};
        default:
          // 'malformed', 'missing', 'removed', 'legacy-roots'.
          return {code: 'malformed-record', key: key(data.key, 'layout')};
      }
    case UNSUPPORTED_SCHEMA_WARNING:
      return data.reason === 'newer'
        ? {code: 'schema-newer', schemaVersion: num(data.found)}
        : {code: 'malformed-record', key: key(data.key, 'schema')};
    case UNKNOWN_NODE_TYPES_WARNING:
      return data.reason === 'unreadable'
        ? {code: 'unreadable-content', type: strings(data.types)[0] ?? ''}
        : {code: 'unknown-node-types', types: strings(data.types)};
    case STORAGE_MISMATCH_WARNING: {
      if (data.reason === 'declaration-changed') {
        const kind = (value: unknown) =>
          typeof value === 'object' && value !== null
            ? String((value as {kind?: unknown}).kind)
            : '';
        return {
          code: 'storage-mismatch',
          declared: kind(data.declared),
          stored: kind(data.stored),
          type: String(data.type),
        };
      }
      return {code: 'malformed-record', key: key(data.key, 'storage')};
    }
    case UNSUPPORTED_SLOTS_WARNING:
      return {code: 'unstorable-change', type: strings(data.types)[0] ?? ''};
    case UNSUPPORTED_CONFIG_WARNING:
    default:
      return {code: 'unsupported-doc'};
  }
}

const PENDING: YStatus = /* @__PURE__ */ Object.freeze({kind: 'pending'});
const ACTIVE: YStatus = /* @__PURE__ */ Object.freeze({kind: 'active'});

/**
 * Each YCollabBinding by its YBinding: what the extension starts and stops
 * listening with its binding (see attachCollabBinding).
 */
const instances = new WeakMap<YBinding, CollabBinding>();

/** The YCollabBinding over a YBinding (shared by both entry points). */
class CollabBinding implements YCollabBinding {
  /** The plain text of the editor when freeze() first ran. */
  private frozenText: string | null = null;
  /** Set when freeze() starts: the status it reports is already `frozen`. */
  private freezing = false;
  private wroteLocally = false;
  private historyView: YHistory | null | undefined = undefined;
  private stopListening: (() => void) | null = null;

  constructor(
    readonly binding: YBinding,
    private readonly hadState: boolean,
    private readonly stop: (() => void) | null,
    private readonly notify: ((status: YStatus) => void) | null,
  ) {
    instances.set(binding, this);
  }

  /** Listen for this client's writes (see hasLocalEdits); idempotent. */
  listen(): void {
    if (this.stopListening !== null) {
      return;
    }
    const binding = this.binding;
    const doc = binding.doc;
    // Any local transaction that writes (an edit, an undo, a value an
    // extension sets on open), and the binding's own writes applied as
    // updates (the seed of an empty document, under its content's client
    // id): not what a provider applies. Read after each transaction, not from
    // `update` events, so that a document with no provider is not made to
    // encode an update per transaction.
    const onTransaction = (tr: Transaction) => {
      if (
        (tr.insertSet.clients.size > 0 || tr.deleteSet.clients.size > 0) &&
        (tr.local ||
          tr.origin === binding ||
          (typeof tr.origin === 'object' &&
            tr.origin !== null &&
            (tr.origin as {binding?: unknown}).binding === binding))
      ) {
        this.wroteLocally = true;
      }
    };
    doc.on('afterTransaction', onTransaction);
    this.stopListening = () => doc.off('afterTransaction', onTransaction);
  }

  /** Stop listening (see listen). */
  unlisten(): void {
    if (this.stopListening !== null) {
      this.stopListening();
      this.stopListening = null;
    }
  }

  get status(): YStatus {
    if (this.freezing) {
      return {cause: {code: 'frozen'}, kind: 'readonly'};
    }
    switch (this.binding.status) {
      case 'pending':
        return PENDING;
      case 'active':
        return ACTIVE;
      default:
        return {
          cause: causeOf(this.binding.readOnlyWarning),
          kind: 'readonly',
        };
    }
  }

  markSynced(): void {
    this.binding.initialize();
  }

  handshake(generation: YGeneration | null): YHandshake {
    invariant(
      generation === null || parseYGeneration(generation) !== null,
      '@lexical/y: handshake(generation) takes the generation your server issued (getYGeneration on @lexical/y/server; parseYGeneration() reads one received over the wire), or null when the client has no local state; got %s',
      String(generation),
    );
    return createYHandshake({
      generation,
      hasLocalEdits: this.hadState || this.wroteLocally,
    });
  }

  get history(): YHistory | null {
    if (this.historyView === undefined) {
      const um = this.binding.undoManager;
      this.historyView =
        um === null
          ? null
          : {
              get canRedo() {
                return um.canRedo();
              },
              get canUndo() {
                return um.canUndo();
              },
              clear: () => um.clear(),
              redo: () => this.binding.redo(),
              subscribe: (listener: () => void) => {
                um.on('stack-item-added', listener);
                um.on('stack-item-popped', listener);
                um.on('stack-cleared', listener);
                return () => {
                  um.off('stack-item-added', listener);
                  um.off('stack-item-popped', listener);
                  um.off('stack-cleared', listener);
                };
              },
              undo: () => this.binding.undo(),
            };
    }
    return this.historyView;
  }

  getCursor(): YCursor | null {
    return this.binding.getCursor();
  }

  freeze(): YLocalEdits {
    const wasFreezing = this.freezing;
    const wasReadOnly = this.binding.status === 'readonly';
    this.freezing = true;
    let quiesced;
    try {
      // Every call returns its own copies (the binding keeps the first
      // result: a later call writes nothing).
      quiesced = this.binding.quiesce();
    } catch (error) {
      this.freezing = wasFreezing;
      throw error;
    }
    if (this.frozenText === null) {
      this.frozenText = this.textOf(quiesced.draft.json);
    }
    if (!wasFreezing && wasReadOnly && this.notify !== null) {
      // The binding's status did not change (it was read only already), so
      // it reports nothing: the cause did. A listener's throw is rethrown
      // apart, as the binding does, so the capture is still returned.
      const notify = this.notify;
      const status = this.status;
      const report = () => {
        try {
          notify(status);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      };
      // Once Yjs is idle, as the binding reports (never inside a
      // transaction or its cleanups).
      const doc = this.binding.doc;
      if (doc._transaction !== null || doc._transactionCleanups.length > 0) {
        doc.once('afterAllTransactions', report);
      } else {
        report();
      }
    }
    return {
      differs: quiesced.draft.differs,
      json: quiesced.draft.json,
      state: quiesced.state,
      text: this.frozenText,
    };
  }

  /**
   * The plain text of what the user saw: the draft's (refused edits
   * included), else, where a node class cannot read the draft back, the
   * editor's.
   */
  private textOf(json: SerializedEditorState): string {
    const editor = this.binding.editor;
    try {
      return editor
        .parseEditorState(json)
        .read(() => $getRoot().getTextContent());
    } catch {
      return editor.getEditorState().read(() => $getRoot().getTextContent());
    }
  }

  dispose(): void {
    this.unlisten();
    instances.delete(this.binding);
    if (this.stop !== null) {
      this.stop();
    } else {
      this.binding.dispose();
    }
  }
}

/** @internal Whether a document holds any state yet (a cached or loaded one). */
export const hasState = (doc: YDoc): boolean =>
  doc.store.clients.size > 0 ||
  // Structs or deletes waiting for what they depend on are state too.
  doc.store.pendingStructs !== null ||
  doc.store.pendingDs !== null;

/**
 * @internal The YCollabBinding over `binding`. `stop` ends what the caller
 * started (null: dispose the binding itself); `notify` is the app's
 * onStatus, for a status change the binding does not report (freeze on a
 * binding already read only).
 */
export function collabBindingOf(
  binding: YBinding,
  hadState: boolean,
  stop: (() => void) | null,
  notify: ((status: YStatus) => void) | null,
  listenNow: boolean,
): YCollabBinding {
  const collab = new CollabBinding(binding, hadState, stop, notify);
  if (listenNow) {
    collab.listen();
  }
  return collab;
}

/**
 * @internal Start the document listener of the YCollabBinding over
 * `binding`: for an owner that starts the binding itself (the extension, once
 * the editor is registered), so a binding never started leaves no listener.
 */
export function attachCollabBinding(binding: YBinding): void {
  const collab = instances.get(binding);
  if (collab !== undefined) {
    collab.listen();
  }
}

/**
 * @internal Remove the document listener of the YCollabBinding over
 * `binding`, if any: for an owner that stops the binding itself (the
 * extension, when the editor is disposed).
 */
export function detachCollabBinding(binding: YBinding): void {
  const collab = instances.get(binding);
  if (collab !== undefined) {
    collab.unlisten();
  }
}

export {causeOf as INTERNAL_causeOf};
