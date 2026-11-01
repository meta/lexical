/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The headless editor behind `@lexical/y/headless`. Bundled into that entry
// only; `..` is the public `@lexical/y` entry, which stays external so the
// binding is not bundled twice.
import {
  type BlockIdExtension,
  buildEditorFromExtensions,
} from '@lexical/extension';
import invariant from '@lexical/internal/invariant';
import {applyUpdate, type Doc} from '@y/y';
import {
  type AnyLexicalExtensionArgument,
  type CreateEditorArgs,
  declarePeerDependency,
  defineExtension,
  type LexicalEditor,
  type LexicalEditorWithDispose,
  LexicalWarning,
} from 'lexical';

import {
  type ClientIDRange,
  createYDoc,
  DEFAULT_ROOT_NAME,
  isYWarning,
  YBinding,
  type YWarning,
  type YWarningCode,
} from '..';
import {
  leaseWriterClientID,
  type WRITER_NEW_CLIENT_ID_WARNING,
  type WriterLease,
  type YWriter,
} from './Writer';

/**
 * @experimental A warning the editor reported through its `onWarn` that is
 * not a `LexicalWarning` (Lexical's own, or an extension's), passed on as one
 * with its message. `data`: `{error: Error}` (the warning as reported).
 */
export const EDITOR_WARNING = '@lexical/y/editor-warning';
/**
 * @experimental The edit's listeners kept scheduling updates: after the last
 * follow-up update the helpers commit, the rest were not committed and are
 * not part of the result. `data`: `{limit: number}` (the follow-up updates
 * committed). Once the binding writes, an update that changes content and is
 * made after a commit in the same task (as a listener's is) commits at once,
 * so Lexical's own guard stops such listeners instead ({@link EDITOR_WARNING}).
 */
export const FOLLOW_UPS_EXHAUSTED_WARNING = '@lexical/y/follow-ups-exhausted';

/**
 * @experimental The codes of the warnings the headless helpers report (the
 * `code` of each `LexicalWarning` they return or pass to `onWarn`): the
 * binding's, {@link EDITOR_WARNING}, {@link FOLLOW_UPS_EXHAUSTED_WARNING}
 * and `WRITER_NEW_CLIENT_ID_WARNING`. Codes are never renamed or reused; new
 * ones may be added, so a `switch` over them needs a `default`.
 */
export type YHeadlessWarningCode =
  | YWarningCode
  | typeof EDITOR_WARNING
  | typeof FOLLOW_UPS_EXHAUSTED_WARNING
  | typeof WRITER_NEW_CLIENT_ID_WARNING;

/**
 * @experimental The editor a headless helper binds: the same extensions (or
 * nodes) as the clients' editors, so that the server reads and writes the
 * document the way a client would.
 */
export interface HeadlessYConfig {
  /**
   * The version of the app's document schema, as on the clients
   * (`YCollabExtension`'s `schemaVersion`): the version of the code that
   * runs here. Required. A document a newer version wrote to is read only
   * here: `editYState` and `readYState` refuse it (`'read-only'`, with an
   * `UNSUPPORTED_SCHEMA_WARNING`), and a seed or an edit records this
   * version.
   */
  schemaVersion: number;
  /** Extensions that define the editor: nodes, transforms, NodeState. */
  extensions?: readonly AnyLexicalExtensionArgument[];
  /** Node classes, for an editor that is not defined by extensions. */
  nodes?: CreateEditorArgs['nodes'];
  /** The name of the shared root (default `'lexical-y'`). */
  root?: string;
  /**
   * The range of the client ids the server writes with (default
   * `'uint53'`). Use `'uint32'` when updates pass through yrs before 0.28.
   */
  clientIDRange?: ClientIDRange;
  /**
   * Called with every warning, as a `LexicalWarning` (the same ones the
   * result's `warnings` lists): the binding's (`@lexical/y/...` codes), the
   * editor's (it replaces an `onWarn` of the extensions; other errors come
   * as {@link EDITOR_WARNING}), and {@link FOLLOW_UPS_EXHAUSTED_WARNING}.
   * Warnings never refuse an edit, in any environment, and a throwing
   * handler does not either. Default: `console.warn` outside production,
   * nothing in production.
   */
  onWarn?: (warning: LexicalWarning) => void;
  /**
   * The binding's self-check of its own writes (see `YBindingOptions`).
   * Default: off.
   */
  selfCheck?: boolean;
}

/** @experimental Error codes of {@link YHeadlessError}. */
export type YHeadlessErrorCode =
  /** The state has no layout record yet: seed it first. */
  | 'not-initialized'
  /**
   * The binding is read only: the document uses a newer layout, a newer
   * version of the app's schema wrote to it, it holds content without a
   * layout record, or node types the editor does not register; or
   * it refused the edit, which holds a named slot the document cannot store.
   * The error's `warnings` are the binding's warnings that say which.
   */
  | 'read-only'
  /** The update writes to a root that is not allowed, or cannot be resolved. */
  | 'foreign-roots'
  /**
   * The update holds items written under another client id: `transact`
   * applied another update to the edit's document. Those items would be
   * returned as the edit's, credited to its writer.
   */
  | 'imported-items'
  /**
   * The edit's `tag` makes the binding write nothing (`COLLABORATION_TAG`,
   * `SKIP_COLLAB_TAG`): the edit would be lost.
   */
  | 'ignored-tag';

/** @experimental The error the headless helpers throw when they refuse. */
export class YHeadlessError extends Error {
  readonly code: YHeadlessErrorCode;
  /**
   * For `'read-only'`: the binding's warnings that say why, typed (narrow on
   * `code`, then on `data.reason`), so an app can say why without parsing
   * the message. Empty for the other codes.
   */
  readonly warnings: readonly YWarning[];
  constructor(
    code: YHeadlessErrorCode,
    message: string,
    warnings: readonly YWarning[] = [],
  ) {
    super(message);
    this.name = 'YHeadlessError';
    this.code = code;
    this.warnings = warnings;
  }
}

/**
 * A `'read-only'` {@link YHeadlessError}: a short message followed by the
 * binding's warnings' messages (the reasons, which say what to do), and the
 * warnings themselves as data.
 */
export function readOnlyError(
  message: string,
  warnings: readonly LexicalWarning[],
): YHeadlessError {
  const reasons = warnings.filter(isYWarning);
  // The message names the reasons too, so that an uncaught error says why
  // and what to do; programs read `warnings` (code and data) instead.
  return new YHeadlessError(
    'read-only',
    reasons.length > 0
      ? `@lexical/y: ${message}: ${reasons.map(w => w.message).join('; ')}`
      : `@lexical/y: ${message}`,
    reasons,
  );
}

/**
 * What the headless helpers call on a binding that its published type does
 * not offer (`private` there, a type-only modifier).
 */
interface BindingInternals {
  flushPending(): boolean;
}

/** @internal */
export interface CreateHeadlessYEditorOptions extends HeadlessYConfig {
  /** A Yjs update (usually the stored state) to load before binding. */
  state?: Uint8Array | null;
}

/**
 * @internal A headless editor bound to its own Yjs 14 document, with
 * collaborative undo off. `dispose` (or `using`) releases the binding, the
 * editor and the document.
 */
export interface HeadlessYEditor extends Disposable {
  readonly editor: LexicalEditor;
  readonly doc: Doc;
  readonly binding: YBinding;
  /** Warnings reported so far, oldest first. */
  readonly warnings: readonly LexicalWarning[];
  dispose(): void;
}

/** Follow-up updates committed after an update before giving up on them. */
export const MAX_FOLLOW_UPS = 8;

/** @internal */
export interface OpenedHeadlessYEditor {
  readonly handle: HeadlessYEditor;
  /**
   * The writer's client id the document writes under, set before anything
   * was written (null without a writer: the document's own random id).
   */
  readonly lease: WriterLease | null;
  /** Updates written since `state` was loaded (only when recording). */
  readonly writes: Uint8Array<ArrayBuffer>[];
  /**
   * Run `$fn` in one discrete update, then commit the updates it made
   * listeners schedule and the binding's own updates that wait for the
   * editor to be idle (at most {@link MAX_FOLLOW_UPS} follow-up updates). Whatever `fn`
   * throws (any value, not only an `Error`) is rethrown after the update,
   * which then writes nothing.
   */
  runUpdate(fn: () => void, tag?: string | string[]): void;
}

/**
 * The editor of {@link openHeadlessYEditor}, built in a scope of its own: the
 * editor keeps the handlers it is configured with, and Lexical keeps the
 * editor until a commit it scheduled in a microtask runs (after the helper
 * returns). Handlers that shared a scope with the document and the binding
 * would keep those too, so a synchronous loop of calls would hold every
 * document it opened until it yields.
 */
function buildHeadlessEditor(
  options: HeadlessYConfig,
  warnings: LexicalWarning[],
): {
  editor: LexicalEditorWithDispose;
  report: (warning: LexicalWarning) => void;
  sink: {captured: Error[] | null};
} {
  // While an internal update runs, errors are collected and rethrown after
  // it, so Lexical restores the previous state (nothing is written).
  const sink: {captured: Error[] | null} = {captured: null};
  const onError = (error: Error) => {
    if (sink.captured === null) {
      throw error;
    }
    sink.captured.push(error);
  };
  // The binding, Lexical and the extensions report through the editor's
  // onWarn: everything is collected here, with the helpers' own. A warning
  // never refuses an edit, so this never throws (a throwing config.onWarn
  // included: its error is rethrown in a microtask).
  const onWarn = options.onWarn;
  const report = (warning: LexicalWarning) => {
    warnings.push(warning);
    try {
      if (onWarn) {
        onWarn(warning);
      } else if (process.env.NODE_ENV !== 'production') {
        console.warn(warning.message);
      }
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  };
  const editor: LexicalEditorWithDispose = buildEditorFromExtensions(
    defineExtension({
      dependencies: options.extensions ? [...options.extensions] : [],
      name: '@lexical/y/headless',
      nodes: options.nodes,
      onError,
      onWarn: (error: Error) =>
        report(
          error instanceof LexicalWarning
            ? error
            : new LexicalWarning(EDITOR_WARNING, error.message, {error}),
        ),
      // BlockIdExtension configured as YCollabExtension configures it on the
      // clients (see there): the update that names blocks runs no
      // transforms, so the server writes what a client would.
      peerDependencies: [
        declarePeerDependency<typeof BlockIdExtension>(
          '@lexical/extension/BlockId',
          {repairTransforms: false},
        ),
      ],
    }),
  );
  return {editor, report, sink};
}

/** The content a disposed editor is left with: one empty paragraph. */
const RELEASED_STATE =
  '{"root":{"children":[{"children":[],"type":"paragraph","version":1}],"type":"root","version":1}}';

/** What {@link createDispose} releases; emptied when it does. */
interface DisposableParts {
  binding: YBinding | null;
  collect: ((update: Uint8Array) => void) | null;
  doc: Doc | null;
  editor: LexicalEditorWithDispose | null;
}

/**
 * The `dispose` of a headless editor, made in a scope of its own that keeps
 * only `parts`, which it empties before releasing them. Disposing the editor
 * creates an `Error` (an abort reason) whose stack keeps every function on
 * the stack, with its scope, and the editor keeps that error until a commit
 * Lexical scheduled in a microtask runs, after the helper returns. A
 * function there whose scope still held the document would keep the
 * document (all of its content) until the caller yields, so a synchronous
 * loop over many documents would hold all of them.
 */
function createDispose(parts: DisposableParts): () => void {
  return () => {
    const {binding, collect, doc, editor} = parts;
    parts.binding = null;
    parts.collect = null;
    parts.doc = null;
    parts.editor = null;
    if (doc === null || editor === null) {
      return;
    }
    if (collect !== null) {
      doc.off('update', collect);
    }
    if (binding !== null) {
      binding.dispose();
    }
    editor.dispose();
    doc.destroy();
    // Lexical may still keep the editor until a commit it scheduled in a
    // microtask runs (the binding's start schedules one): drop its content
    // now, so that a synchronous loop of calls does not hold every document
    // it opened until it yields. Nothing listens any more.
    editor.setEditorState(editor.parseEditorState(RELEASED_STATE));
  };
}

/**
 * @internal Dispose what {@link openHeadlessYEditor} opened, from a frame
 * that keeps none of it (see {@link createDispose}): calling
 * `opened.handle.dispose()` would keep the handle, as that frame's receiver.
 */
export function closeHeadlessYEditor(opened: OpenedHeadlessYEditor): void {
  const {dispose} = opened.handle;
  dispose();
}

/**
 * @internal Open `options.state` in a headless editor and binding. Throws a
 * {@link YHeadlessError} (`'read-only'`) when the binding cannot write the
 * document. With `record`, every update written after the state was loaded
 * (opening included) is collected in `writes`. With `writer`, everything is
 * written under the writer's client id for this document (see
 * `leaseWriterClientID`), chosen once the state is loaded.
 */
export function openHeadlessYEditor(
  options: CreateHeadlessYEditorOptions,
  record = false,
  writer: YWriter | null = null,
): OpenedHeadlessYEditor {
  // Checked before anything is built (the binding checks it too, with the
  // name of the option it knows).
  invariant(
    options != null &&
      Number.isSafeInteger(options.schemaVersion) &&
      options.schemaVersion >= 1,
    "@lexical/y/headless: the config needs schemaVersion (got %s): start at 1 and increase it whenever a node's stored fields or node types change, as the clients' YCollabExtension does",
    String(options == null ? undefined : options.schemaVersion),
  );
  // No garbage collection, only so that the root check of an edit's update
  // (editYState) can resolve deleted items: this document is temporary, and
  // the states the helpers return are garbage collected. The binding keeps
  // the client id in range (`clientIDRange`) from `start()`; nothing is
  // written before that. No format cleanup either, as on every document the
  // binding writes (see createYDoc): loading the state would otherwise
  // delete format items the clients keep, and those deletions would be in
  // the returned state but not in the update. Made before the editor, so
  // that createYDoc's check of the app's @y/y refuses before any extension
  // is built or registered.
  const doc = createYDoc(null, {gc: false});
  const warnings: LexicalWarning[] = [];
  let built: ReturnType<typeof buildHeadlessEditor>;
  try {
    built = buildHeadlessEditor(options, warnings);
  } catch (error) {
    doc.destroy();
    throw error;
  }
  const {editor, report, sink} = built;
  const writes: Uint8Array<ArrayBuffer>[] = [];
  const collect = (update: Uint8Array) => {
    writes.push(new Uint8Array(update));
  };
  let binding: YBinding | null = null;
  const parts: DisposableParts = {binding: null, collect, doc, editor};
  const dispose = createDispose(parts);
  const updateOnce = (fn: () => void, tag?: string | string[]) => {
    const errors: Error[] = [];
    // What `fn` throws is kept as it is: Lexical passes only its own realm's
    // `Error`s to `onError` and drops any other thrown value, which would
    // make a failed edit look like one that changed nothing.
    const failure: {failed: boolean; thrown: unknown} = {
      failed: false,
      thrown: undefined,
    };
    sink.captured = errors;
    try {
      editor.update(
        () => {
          try {
            fn();
          } catch (thrown) {
            failure.failed = true;
            failure.thrown = thrown;
            throw thrown;
          }
        },
        {discrete: true, tag},
      );
    } finally {
      sink.captured = null;
    }
    if (failure.failed) {
      throw failure.thrown;
    }
    if (errors.length > 0) {
      throw errors[0];
    }
  };
  const hasPending = () =>
    editor._pendingEditorState !== null || editor._updates.length > 0;
  // The binding's own updates (its refreshes, the author's normalization,
  // re-reads) wait until the editor is idle, in a microtask: run them now
  // (once nothing is pending), errors collected as in updateOnce. Returns
  // whether any still waits.
  const flushBinding = (): boolean => {
    if (binding === null) {
      return false;
    }
    if (hasPending()) {
      return true;
    }
    const errors: Error[] = [];
    sink.captured = errors;
    let waiting: boolean;
    try {
      waiting = (binding as unknown as BindingInternals).flushPending();
    } finally {
      sink.captured = null;
    }
    if (errors.length > 0) {
      throw errors[0];
    }
    return waiting;
  };
  // Commit the updates the last one made listeners schedule (an extension
  // that gives new blocks ids) and the binding's own, so that what they
  // write is part of this edit rather than lost when the editor is disposed.
  const settle = (tag?: string | string[]) => {
    for (let i = 0; ; i++) {
      const waiting = flushBinding();
      if (!waiting && !hasPending()) {
        return;
      }
      if (i === MAX_FOLLOW_UPS) {
        report(
          new LexicalWarning(
            FOLLOW_UPS_EXHAUSTED_WARNING,
            `@lexical/y: listeners kept scheduling updates; after ${MAX_FOLLOW_UPS} follow-up updates the rest were not committed and are not part of the result. An update listener changes the document after every commit, so it never settles: have it write only what is missing, values that stay the same when it runs again (a counter or a timestamp per commit never settles).`,
            {limit: MAX_FOLLOW_UPS},
          ),
        );
        return;
      }
      updateOnce(() => {}, tag);
    }
  };
  const runUpdate = (fn: () => void, tag?: string | string[]) => {
    updateOnce(fn, tag);
    settle(tag);
  };
  // Everything opened so far (the editor and its extensions, the document,
  // the binding) is released when opening fails: a state that does not
  // decode, a binding that throws, a document that is read only here.
  let lease: WriterLease | null = null;
  try {
    if (options.state) {
      applyUpdate(doc, options.state);
    }
    if (writer !== null) {
      // After the state is loaded (Yjs draws a new client id when it loads
      // writes under the document's own) and before anything is written,
      // opening included.
      lease = leaseWriterClientID(
        writer,
        doc,
        options.clientIDRange || 'uint53',
      );
      if (lease.warning !== null) {
        report(lease.warning);
      }
    }
    if (record) {
      doc.on('update', collect);
    }
    const bound = new YBinding(editor, doc, {
      captureTimeout: null,
      clientIDRange: options.clientIDRange,
      root: doc.get(options.root || DEFAULT_ROOT_NAME),
      schemaVersion: options.schemaVersion,
      selfCheck: options.selfCheck,
    });
    binding = bound;
    parts.binding = bound;
    bound.start();
    // Commit any update the first read scheduled (refreshes, block ids).
    runUpdate(() => {});
    if (bound.status === 'readonly') {
      throw readOnlyError('the document is read only here', warnings);
    }
    return {
      handle: {
        binding: bound,
        dispose,
        doc,
        editor,
        [Symbol.dispose]: dispose,
        warnings,
      },
      lease,
      runUpdate,
      writes,
    };
  } catch (error) {
    if (lease !== null) {
      lease.release();
    }
    dispose();
    throw error;
  }
}

/**
 * @internal A headless editor bound to a new Yjs 14 document holding
 * `state`, after the layout record has been read. Throws a
 * {@link YHeadlessError} (`'read-only'`) when the binding cannot write the
 * document (a newer layout, unknown node types). With no state (or an empty
 * one) the binding is `'pending'`: write content and call
 * `binding.initialize()` to seed it. Not exported from
 * `@lexical/y/headless`: servers use `seedYState`, `editYState` and
 * `readYState`; the tests use it to inspect a handle.
 */
export function createHeadlessYEditor(
  options: CreateHeadlessYEditorOptions,
): HeadlessYEditor {
  return openHeadlessYEditor(options).handle;
}
