/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  defineExtension,
  type EditorState,
  type ExtensionConfigBase,
  HISTORY_MERGE_TAG,
  type LexicalEditor,
  type LexicalExtension,
  safeCast,
} from 'lexical';

import {EditorStateExtension} from './EditorStateExtension';
import {
  deserializeEditorStateFamily,
  isSerializedEditorStateFamily,
  type SerializedEditorStateFamily,
  serializeEditorStateFamily,
} from './editorStateFamily';
import {getPeerDependencyFromEditor} from './getPeerDependencyFromEditor';
import {LexicalBuilder} from './LexicalBuilder';
import {RootElementExtension} from './RootElementExtension';
import {effect, type ReadonlySignal, type Signal, signal} from './signals';
import {WatchEditableExtension} from './WatchEditableExtension';

const __DEV__ = process.env.NODE_ENV !== 'production';

/**
 * Minimal interface for bundler HMR contexts. Satisfied by Vite's
 * `ViteHotContext` and similar bundler HMR contexts. Only the `data`
 * property is read and written; other HMR lifecycle methods are not required.
 *
 * Webpack and Parcel expose `module.hot` instead of `import.meta.hot`. Their
 * `module.hot.data` is populated by dispose handlers and is not directly
 * mutable, so `module.hot` cannot be passed here — a custom adapter using
 * `module.hot.addDisposeHandler` is required for those bundlers.
 */
export interface HotContext {
  readonly data: Record<string, unknown>;
}

/** The state {@link HMRExtension} creates before the editor exists. */
interface HMRInit {
  restoreCount: Signal<number>;
}

/** The output of {@link HMRExtension}. */
export interface HMROutput {
  /**
   * Increments every time this editor's state has been restored from the
   * module instance that was replaced.
   *
   * Anything that derives editor state from somewhere else has to run again
   * afterwards, and can depend on this signal to be told when: a nested editor
   * wired up by `SharedHistoryExtension` re-points its `HistoryState` at its
   * parent's, which a restore would otherwise have replaced with one of its
   * own.
   */
  restoreCount: ReadonlySignal<number>;
}

/** Configuration for {@link HMRExtension}. */
export interface HMRConfig {
  /**
   * The bundler's HMR context, typically `import.meta.hot`. Pass `null`
   * in production or when HMR is not available.
   */
  hot: HotContext | null;
  /**
   * Stable identifier for this editor instance. Must be stable across HMR
   * reloads — do not use `useId()`, `Math.random()`, or any per-mount
   * identifier (these generate a new value on every mount and will fail to
   * match the key from the previous HMR cycle, preventing state restoration).
   * Only needed when multiple editors share both the same `import.meta.hot`
   * context and the same `namespace` (set via
   * `defineExtension({ namespace: '...' })` or
   * `createEditor({ namespace: '...' })`); editors with distinct namespaces
   * are isolated automatically, editors with no configured namespace all share
   * one key, and a nested editor shares its parent's namespace and so needs an
   * `id` of its own. Must be a non-empty string when provided;
   * passing `''` triggers a dev warning and is treated as no `id`. Both are
   * escaped into the key, so either may contain any character.
   */
  id?: string;
}

/**
 * The parts of `@lexical/history` this extension touches, declared here rather
 * than imported from it.
 *
 * `@lexical/history` depends on `@lexical/extension`, not the other way
 * around, and importing even a type across that boundary leaves
 * `@lexical/extension` with an undeclared dependency: anyone type-checking it
 * through its `source` export condition without `@lexical/history` installed
 * gets an unresolved import. History is an optional peer here — an editor
 * without it is restored just the same — so the shapes are described locally.
 * The unit tests assert that they still match the real ones.
 *
 * @internal
 */
export interface HMRHistoryStateEntry {
  editor: LexicalEditor;
  editorState: EditorState;
}

/** @internal See {@link HMRHistoryStateEntry}. */
export interface HMRHistoryState {
  current: null | HMRHistoryStateEntry;
  redoStack: HMRHistoryStateEntry[];
  undoStack: HMRHistoryStateEntry[];
}

/** As much of the `@lexical/history` extension as this one reads. */
type HistoryPeerExtension = LexicalExtension<
  ExtensionConfigBase,
  typeof HISTORY_EXTENSION_NAME,
  {historyState: {peek(): HMRHistoryState; value: HMRHistoryState}},
  unknown
>;

const HMR_KEY = 'lexicalHMR';
const HISTORY_EXTENSION_NAME = '@lexical/history/History';
const HMR_EXTENSION_NAME = '@lexical/extension/HMR';

function getHMRKey(id: string | undefined, namespace: string): string {
  // Escaped, so that a namespace holding the separator cannot be mistaken for
  // a namespace and an id: `{namespace: 'app:sidebar'}` and `{namespace:
  // 'app', id: 'sidebar'}` are two different editors and need two keys.
  const base = `${HMR_KEY}:${encodeURIComponent(namespace)}`;
  return id !== undefined ? `${base}:${encodeURIComponent(id)}` : base;
}

/** The key `editor` saves under, given the `id` its HMRExtension was configured with. */
function getEditorHMRKey(
  editor: LexicalEditor,
  configId: string | undefined,
): string {
  // An unconfigured namespace is a random string that changes on every
  // reload, so it is left out of the key rather than making it unmatchable.
  const namespace = hasConfiguredNamespace(editor)
    ? editor._config.namespace
    : '';
  // Normalize '' to undefined: empty string is invalid and treated as no id.
  return getHMRKey(configId === '' ? undefined : configId, namespace);
}

/**
 * Whether `hmrKey` is also the HMR key of the editor this one is nested
 * inside. A nested editor inherits its parent's namespace, so namespaces do
 * not isolate the two the way they isolate independent editors, and nothing
 * about a nested editor is stable enough across reloads to key it on
 * automatically.
 */
function sharesParentHMRKey(editor: LexicalEditor, hmrKey: string): boolean {
  const parentEditor = editor._parentEditor;
  if (parentEditor === null) {
    return false;
  }
  const peer = getPeerDependencyFromEditor<typeof HMRExtension>(
    parentEditor,
    HMR_EXTENSION_NAME,
  );
  // A parent that does not preserve its own state across reloads is not
  // competing for the key.
  if (peer === undefined) {
    return false;
  }
  return getEditorHMRKey(parentEditor, peer.config.id) === hmrKey;
}

/**
 * True when the editor's namespace was chosen by the application rather than
 * generated for it.
 *
 * `createEditor` falls back to a random `createUID()` namespace, which is a
 * different string on every reload: an HMR key built from it would never match
 * the key the previous instance saved under, so nothing would ever be restored
 * and every reload would leave another orphaned entry (pinning a whole
 * EditorState and its history) in `hot.data`. Such editors are keyed with an
 * empty namespace segment instead, which is stable. Two of them sharing one
 * HMR context then collide on that key, which is what the shared-key warning
 * in the save effect reports.
 */
function hasConfiguredNamespace(editor: LexicalEditor): boolean {
  const builder = LexicalBuilder.maybeFromEditor(editor);
  if (!builder) {
    // An ancestor built by createEditor rather than from extensions: nothing
    // records whether its namespace was chosen or generated. Treating it as
    // generated is the safe way to be wrong — a namespace that was in fact
    // chosen only costs this editor its automatic isolation, which the
    // shared-key warning reports and an `id` settles, where treating a
    // generated one as chosen means nothing is ever restored and every reload
    // orphans another entry.
    return false;
  }
  for (const rep of builder.extensionNameMap.values()) {
    const {namespace} = rep.extension;
    // Only the namespace the editor ended up with counts. `createEditor`
    // generates one for any falsy value, so `namespace: ''` is not a choice of
    // namespace, and the builder resolves several declarations down to one.
    if (namespace && namespace === editor._config.namespace) {
      return true;
    }
  }
  // An editor that configured none of its own inherits its parent's, so the
  // question becomes whether the parent configured one.
  return (
    editor._parentEditor !== null &&
    hasConfiguredNamespace(editor._parentEditor)
  );
}

// Keyed by HMR key, so a collision is reported once per module instance
// instead of on every editor update.
const warnedSharedKeys = new Set<string>();

/**
 * Warns when two editors that are both mounted write to the same HMR key,
 * which means each reload restores one editor's content into both.
 *
 * The editor being replaced by an HMR cycle is not a collision: the composer
 * builds the replacement during render and disposes the old editor in an
 * effect cleanup, so the two overlap by construction. They are told apart by
 * the root element — an editor that React discarded (a StrictMode double
 * render) or disposed has none.
 */
function warnOnSharedKey(
  hmrKey: string,
  prev: HMRSavedState,
  editor: LexicalEditor,
): void {
  const owner = prev.owner;
  if (
    owner === undefined ||
    owner === editor ||
    prev.mounted !== true ||
    owner.getRootElement() === null ||
    warnedSharedKeys.has(hmrKey)
  ) {
    return;
  }
  warnedSharedKeys.add(hmrKey);
  console.warn(
    `HMR: Two mounted editors are sharing the HMR key "${hmrKey}", so they will overwrite each other's saved state. ` +
      'Give each editor a distinct `namespace`, or a distinct `HMRConfig.id`.',
  );
}

/**
 * What is stashed in `hot.data` between module instances.
 *
 * The states are stored by reference, not serialized. Serializing on every
 * editor update is far too expensive for a document of any size (the whole
 * document plus every undo and redo entry, on every keystroke), and it is
 * wasted work in the common case where no reload ever happens. The previous
 * module instance stays alive for as long as `hot.data` holds these
 * references, so `serialize` — its own function, closing over its own states
 * and running with the `lexical` module that created them — is called once, by
 * the next module instance, at the moment HMR actually takes place.
 */
interface HMRSavedState {
  editable: boolean;
  /** The live EditorState of the editor that is being replaced. */
  editorState: EditorState;
  /**
   * Serializes the editor state together with the undo/redo history as one
   * family, so that what those states shared comes back shared. Optional: a
   * payload written by an older build has none.
   */
  serialize?: () => unknown;
  /** The editor that wrote this snapshot, for the shared-key warning. */
  owner?: LexicalEditor;
  /** Whether `owner` had a root element when it wrote this snapshot. */
  mounted?: boolean;
}

/**
 * The plain-data form of a saved editor: every state whose NodeKeys have to
 * stay aligned with the others, and where the history's entries are to be
 * found among them.
 */
interface SerializedHMRState {
  family: SerializedEditorStateFamily;
  /** Indices into `family.states`, whose first entry is the editor state. */
  history: {
    current: null | number;
    redoStack: number[];
    undoStack: number[];
  } | null;
}

function getSavedHMRState(hot: HotContext, key: string): unknown {
  return hot.data[key];
}

/**
 * Structural check rather than `$isEditorState`: the saved value was created
 * by the module instance that HMR replaced. When `lexical` itself is part of
 * the HMR graph (as it is for an app that builds it from source), the previous
 * `EditorState` class is a different object than the current one, so
 * `instanceof` would reject a perfectly usable state.
 */
function isEditorStateLike(raw: unknown): raw is EditorState {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as EditorState).toJSON === 'function' &&
    typeof (raw as EditorState).isEmpty === 'function'
  );
}

function isValidHMRSavedState(raw: unknown): raw is HMRSavedState {
  if (raw == null || typeof raw !== 'object') {
    return false;
  }
  const s = raw as Record<string, unknown>;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(s, k);
  return (
    has('editable') &&
    has('editorState') &&
    typeof s.editable === 'boolean' &&
    isEditorStateLike(s.editorState)
  );
}

function isSerializedHMRState(raw: unknown): raw is SerializedHMRState {
  if (raw == null || typeof raw !== 'object') {
    return false;
  }
  const {family, history} = raw as Record<string, unknown>;
  if (!isSerializedEditorStateFamily(family)) {
    return false;
  }
  if (history == null) {
    return true;
  }
  const isIndex = (value: unknown): boolean =>
    typeof value === 'number' && value >= 0 && value < family.states.length;
  const {current, redoStack, undoStack} = history as Record<string, unknown>;
  return (
    (current === null || isIndex(current)) &&
    Array.isArray(redoStack) &&
    redoStack.every(isIndex) &&
    Array.isArray(undoStack) &&
    undoStack.every(isIndex)
  );
}

/**
 * Serializes `editorState` together with the states of `historyState`. They go
 * in as one family so that the nodes they share stay shared, and so that every
 * version of a node keeps answering to one key: undo is a reconciliation
 * against the state that is current when it happens, which can only diff what
 * actually changed if the two agree about keys.
 *
 * Only the entries `editor` itself recorded are kept. `SharedHistoryExtension`
 * gives a nested editor its parent's `HistoryState` object, so one stack can
 * hold entries from several editors, and each entry names the editor that
 * undoing it applies the state to. Those other editors do not survive the
 * reload, and re-labelling their entries with this one would make undo replace
 * this editor's document with a nested editor's content.
 */
function serializeHMRState(
  editor: LexicalEditor,
  editorState: EditorState,
  historyState: HMRHistoryState | null,
): SerializedHMRState {
  const states: EditorState[] = [editorState];
  let foreign = 0;
  const own = (entry: HMRHistoryStateEntry): boolean => {
    const isOwn = entry.editor === editor;
    if (!isOwn) {
      foreign++;
    }
    return isOwn;
  };
  const add = (entry: HMRHistoryStateEntry): number =>
    states.push(entry.editorState) - 1;
  const addStack = (stack: readonly HMRHistoryStateEntry[]): number[] =>
    stack.filter(own).map(add);
  const history = historyState
    ? {
        current:
          historyState.current && own(historyState.current)
            ? add(historyState.current)
            : null,
        redoStack: addStack(historyState.redoStack),
        undoStack: addStack(historyState.undoStack),
      }
    : null;
  if (__DEV__ && foreign > 0) {
    console.warn(
      `HMR: Left behind ${foreign} undo/redo ${
        foreign === 1 ? 'entry' : 'entries'
      } recorded by another editor sharing this history. They can only be applied to the editor that recorded them, which this reload replaced.`,
    );
  }
  return {family: serializeEditorStateFamily(states), history};
}

/**
 * Rebuilds the undo/redo history from the states of a restored family. An
 * entry whose state could not be rebuilt is dropped on its own rather than
 * costing the whole history.
 */
function restoreHistoryState(
  history: NonNullable<SerializedHMRState['history']>,
  states: readonly (EditorState | null)[],
  editor: LexicalEditor,
): HMRHistoryState {
  let dropped = 0;
  const restoreEntry = (index: number): HMRHistoryStateEntry | null => {
    const editorState = states[index];
    if (editorState == null || editorState.isEmpty()) {
      dropped++;
      return null;
    }
    return {editor, editorState};
  };
  const restoreStack = (indices: readonly number[]): HMRHistoryStateEntry[] =>
    indices
      .map(restoreEntry)
      .filter((entry): entry is HMRHistoryStateEntry => entry !== null);
  const current =
    history.current === null ? null : restoreEntry(history.current);
  const undoStack = restoreStack(history.undoStack);
  const redoStack = restoreStack(history.redoStack);
  if (__DEV__ && dropped > 0) {
    console.warn(
      `HMR: Dropped ${dropped} undo/redo ${
        dropped === 1 ? 'entry' : 'entries'
      } that could not be restored.`,
    );
  }
  return {current, redoStack, undoStack};
}

/**
 * Preserves editor state, the selection, editability, and undo/redo history
 * across Hot Module Replacement (HMR) cycles. When `HistoryExtension` is
 * present as a peer, undo/redo stacks are preserved as well.
 *
 * Passing `hot: null` is a safe no-op, so `import.meta.hot ?? null` works
 * correctly in both development and production without a build-time
 * conditional. If a saved state cannot be parsed, the extension warns in dev
 * and falls back to `$initialEditorState` rather than throwing.
 *
 * Editor updates only stash a reference to the current `EditorState` (and to
 * the `HistoryState`, which `@lexical/history` mutates in place), so the
 * per-update cost does not grow with the size of the document or of the undo
 * stack. Everything is serialized once, by the module instance that replaces
 * this one, when it restores the saved state.
 *
 * The editor state and the history entries are serialized as one family rather
 * than one at a time, so that the nodes they shared come back shared and every
 * version of a node keeps answering to one key — see `editorStateFamily`. That
 * is what makes an undo after a reload a diff of what changed rather than a
 * rebuild of the document, and it is why the selection can be carried by key.
 *
 * @example
 * Basic usage
 * ```ts
 * import {buildEditorFromExtensions, configExtension, defineExtension, HMRExtension} from '@lexical/extension';
 * import {RichTextExtension} from '@lexical/rich-text';
 * import {HistoryExtension} from '@lexical/history';
 *
 * const editor = buildEditorFromExtensions(
 *   defineExtension({
 *     name: '[root]',
 *     namespace: 'my-editor',
 *     dependencies: [
 *       RichTextExtension,
 *       HistoryExtension,
 *       configExtension(HMRExtension, {hot: import.meta.hot ?? null}),
 *     ],
 *   }),
 * );
 * ```
 *
 * @example
 * Multiple editors sharing an HMR context
 * Editors with distinct `namespace` values are isolated automatically. Only
 * add `id` when two editors share both the same `import.meta.hot` context
 * and the same `namespace`.
 * ```ts
 * // Different namespaces — automatic isolation, no `id` needed
 * defineExtension({ name: '[main]', namespace: 'main', dependencies: [configExtension(HMRExtension, {hot: import.meta.hot ?? null})] })
 * defineExtension({ name: '[sidebar]', namespace: 'sidebar', dependencies: [configExtension(HMRExtension, {hot: import.meta.hot ?? null})] })
 *
 * // Same namespace — use `id` to distinguish
 * defineExtension({ name: '[first]', namespace: 'shared', dependencies: [configExtension(HMRExtension, {hot: import.meta.hot ?? null, id: 'first'})] })
 * defineExtension({ name: '[second]', namespace: 'shared', dependencies: [configExtension(HMRExtension, {hot: import.meta.hot ?? null, id: 'second'})] })
 * ```
 *
 * Only the undo/redo entries this editor recorded are preserved. With
 * `SharedHistoryExtension` a nested editor pushes onto its parent's stacks, and
 * an entry can only be applied to the editor that recorded it — editors the
 * reload replaced, so those entries are left behind rather than re-pointed at
 * whichever editor happens to restore the history.
 *
 * A nested editor inherits its parent's namespace, so namespaces do not
 * isolate it from its parent: give it a distinct `id` (or its own
 * `namespace`), which is warned about in dev when both use HMRExtension.
 *
 * An editor that was given no `namespace` at all is keyed without one, because
 * the namespace `createEditor` generates for it is a fresh random string on
 * every reload — a key built from that would never match what the previous
 * instance saved. Such editors all share one key, so give each editor a
 * `namespace` (or an `id`) as soon as a page has more than one.
 *
 * Saved state belongs to the key for as long as the page lives, not to the
 * reload that produced it. An editor that is unmounted and later remounted
 * under the same key during development restores what the previous one had
 * rather than its own `$initialEditorState`, so two editors showing different
 * documents need distinct namespaces (or ids) even when they are never on
 * screen at the same time.
 */
// The type arguments are explicit because `afterRegistration` is declared
// before `build`, and inferring the output from a later property while an
// earlier one already needs it collapses the output to `{}` — which a peer
// reading `restoreCount` would then not find.
export const HMRExtension = defineExtension<
  HMRConfig,
  typeof HMR_EXTENSION_NAME,
  HMROutput,
  HMRInit
>({
  afterRegistration(editor, {hot, id: configId}, state) {
    if (!hot) {
      return () => {};
    }

    const hmrKey = getEditorHMRKey(editor, configId);

    if (__DEV__) {
      if (configId === '') {
        console.warn(
          'HMR: `id` must not be an empty string. ' +
            'Use a stable non-empty string literal (e.g. `"main"`, `"sidebar"`).',
        );
      }
      if (sharesParentHMRKey(editor, hmrKey)) {
        console.warn(
          `HMR: This editor is nested inside another and inherits its namespace, so both use the HMR key "${hmrKey}" and will overwrite each other. ` +
            'Give the nested editor a distinct `HMRConfig.id` (or its own `namespace`).',
        );
      }
    }

    const historyPeer = getPeerDependencyFromEditor<HistoryPeerExtension>(
      editor,
      HISTORY_EXTENSION_NAME,
    );

    let restored = false;
    const saved = getSavedHMRState(hot, hmrKey);
    if (isValidHMRSavedState(saved)) {
      try {
        editor.setEditable(saved.editable);
        // The only place the previous states are serialized. HMR has just
        // happened, so the cost is paid once per reload rather than on every
        // editor update, and it is paid by the module instance that owns them.
        const serialized =
          typeof saved.serialize === 'function' ? saved.serialize() : null;
        if (!isSerializedHMRState(serialized)) {
          // A payload this build cannot read — one written by a different
          // version of this extension, say. Falling back to
          // $initialEditorState is the right move, but doing it quietly is
          // not: from the outside the document simply vanished.
          if (__DEV__) {
            console.warn(
              'HMR: The saved state could not be read — it was written by a different build of HMRExtension. Starting fresh.',
            );
          }
        } else {
          const states = deserializeEditorStateFamily(
            serialized.family,
            editor,
          );
          const restoredState = states[0];
          if (restoredState == null) {
            // Some node of the document no longer rebuilds — a class the
            // reload removed, say. There is nothing to restore, and that is
            // worth saying rather than quietly starting over.
            if (__DEV__) {
              console.warn(
                'HMR: Could not restore previous editor state. Starting fresh.',
              );
            }
          } else if (!restoredState.isEmpty()) {
            // This is the one state whose JSON the new node classes have never
            // seen, so let setEditorState normalize it the way it normalizes
            // anything freshly parsed. The history entries deliberately keep
            // the flag clear: they are reproductions of states that were once
            // live, and every undo into one would otherwise dirty-mark the
            // whole document and re-run every transform over it.
            restoredState._parsed = true;
            editor.setEditorState(restoredState, {tag: HISTORY_MERGE_TAG});
            // `!= null`, matching the validator: a payload from another
            // build may have no `history` at all rather than a null one.
            if (serialized.history != null) {
              if (historyPeer) {
                historyPeer.output.historyState.value = restoreHistoryState(
                  serialized.history,
                  states,
                  editor,
                );
              } else if (__DEV__) {
                console.warn(
                  'HMR: Saved undo/redo history discarded — HistoryExtension is no longer configured.',
                );
              }
            }
            // Last, so that a restore that threw on its way here is not
            // announced as one that happened: the catch below reports it as a
            // fresh start, and anything re-deriving state from the counter
            // would otherwise act on an editor that was never restored.
            restored = true;
          }
        }
      } catch (e) {
        if (__DEV__) {
          console.warn(
            'HMR: Could not restore previous editor state. Starting fresh.',
            e,
          );
        }
      }
    }

    if (restored) {
      // Announced after everything this extension restores is in place, so
      // that an extension re-deriving state from it (SharedHistoryExtension,
      // say) sees the finished editor rather than a half-restored one.
      state.getInitResult().restoreCount.value++;
    }

    const editorStateSignal = state.getDependency(EditorStateExtension).output;
    const editableSignal = state.getDependency(WatchEditableExtension).output;
    const rootElementSignal = state.getDependency(RootElementExtension).output;
    // What the last write described, so that a root element coming or going
    // can be told apart from a change worth saving.
    let written: {editable: boolean; editorState: EditorState} | null = null;
    return effect(() => {
      const editorState = editorStateSignal.value;
      const editable = editableSignal.value;
      const mounted = rootElementSignal.value !== null;
      const prev = getSavedHMRState(hot, hmrKey);
      if (__DEV__ && mounted && isValidHMRSavedState(prev)) {
        warnOnSharedKey(hmrKey, prev, editor);
      }
      if (
        written !== null &&
        written.editorState === editorState &&
        written.editable === editable
      ) {
        // Only the root element changed — this editor mounting, unmounting, or
        // being disposed. There is nothing new to save, and writing here would
        // overwrite the snapshot of the editor that replaced this one: the
        // composer builds the replacement during render and disposes this one
        // afterwards, and disposing clears the root element.
        if (isValidHMRSavedState(prev) && prev.owner === editor) {
          // Still ours, so keep the diagnostic current.
          prev.mounted = mounted;
        }
        return;
      }
      written = {editable, editorState};
      // On first mount the state is empty before $initialEditorState runs;
      // keep the previously saved state instead of overwriting with empty.
      const validPrev =
        editorState.isEmpty() && isValidHMRSavedState(prev) ? prev : null;
      // Only references are stored, so this stays cheap no matter how large
      // the document or the undo stack gets.
      const nextState: HMRSavedState = {
        ...(validPrev ?? {
          editorState,
          serialize: () =>
            serializeHMRState(
              editor,
              editorState,
              // peek() — avoid subscribing this effect to historyState
              // changes; @lexical/history mutates the HistoryState in place,
              // so this reads the latest history when it is finally called.
              historyPeer ? historyPeer.output.historyState.peek() : null,
            ),
        }),
        editable,
        mounted,
        owner: editor,
      };
      hot.data[hmrKey] = nextState;
    });
  },
  build: (_editor, _config, state): HMROutput => state.getInitResult(),
  config: safeCast<HMRConfig>({hot: null}),
  dependencies: [
    EditorStateExtension,
    RootElementExtension,
    WatchEditableExtension,
  ],
  init: (): HMRInit => ({restoreCount: signal(0)}),
  name: HMR_EXTENSION_NAME,
});
