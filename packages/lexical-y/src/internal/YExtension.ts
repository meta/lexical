/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {ClientIDRange} from './ClientID';
import type {YDoc} from './YDoc';
import type {Node as YNode} from '@y/y';

import {
  type BlockIdExtension,
  type HMRExtension,
  InitialStateExtension,
  NodeStructureExtension,
  type ReadonlySignal,
  signal,
} from '@lexical/extension';
import invariant from '@lexical/internal/invariant';
import {
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_EDITOR,
  configExtension,
  declarePeerDependency,
  defineExtension,
  mergeRegister,
  REDO_COMMAND,
  safeCast,
  UNDO_COMMAND,
} from 'lexical';

import {isSchemaVersion, YBinding, type YBindingStatus} from './Binding';
import {
  attachCollabBinding,
  collabBindingOf,
  detachCollabBinding,
  hasState,
  type YCollabBinding,
  type YStatus,
} from './CollabBinding';
import {
  isYLayoutUpgradeHandle,
  type YLayoutUpgradeHandle,
} from './LayoutUpgrade';

// YCollabExtension: the binding as an extension. It builds a YBinding for
// the editor, wires collaborative undo to UNDO_COMMAND and REDO_COMMAND, and
// exposes the binding's status as a signal.

/**
 * @experimental What an app writes to configure {@link YCollabExtension}
 * through createYCollabConfig: `doc`, `layoutUpgrade` and `schemaVersion`
 * are required, and every option that has a default is optional, so a later
 * release adds options without breaking code typed with it.
 */
export interface YCollabInput {
  /** See YCollabConfig.doc. */
  readonly doc: YDoc;
  /**
   * Required: how documents below MIN_LAYOUT are upgraded (see y.md
   * "Layout upgrades"). `createYServerLayoutUpgrade()`: the document's
   * server migrates them on load; `null`: they stay read only. The editor
   * opens such a document read only either way.
   */
  readonly layoutUpgrade: YLayoutUpgradeHandle | null;
  /**
   * The version of your editor's nodes: registered node classes, their
   * fields and NodeState. Bump it when you add, remove or change one, not on
   * every release. An integer from 1 (see YCollabConfig.schemaVersion).
   */
  readonly schemaVersion: number;
  readonly root?: YNode | null;
  readonly synced?: boolean;
  readonly captureTimeout?: number | null;
  readonly clientIDRange?: ClientIDRange;
  readonly selfCheck?: boolean | null;
  readonly selfCheckSample?: number | null;
  readonly convert?: boolean;
  readonly onYStatus?: ((status: YStatus) => void) | null;
}

/**
 * @experimental The configuration of {@link YCollabExtension} (what
 * `configExtension` takes, partially, and what the extension reads). Its
 * existing fields stay as they are, and every field a later release adds
 * to it is optional, with its default resolved inside the extension: a
 * complete YCollabConfig written today keeps compiling. New code configures
 * the extension with createYCollabConfig and YCollabInput.
 */
export interface YCollabConfig {
  /**
   * The shared document, made by `createYDoc` (with a stored state:
   * `createYDoc(state)`). Required.
   */
  doc: YDoc | null;
  /**
   * The version of your editor's nodes: registered node classes, their
   * fields and NodeState. Bump it when you add, remove or change one, not on
   * every release. Required: start at 1. The document records the highest
   * version that wrote to it, and a client whose version is lower opens it
   * read only (`UNSUPPORTED_SCHEMA_WARNING`), so an out-of-date client never
   * edits content it cannot read in full. An integer from 1; the extension
   * throws without one.
   */
  schemaVersion: number;
  /** The shared root; defaults to `doc.get('lexical-y')`. */
  root: YNode | null;
  /**
   * Initialize as soon as the binding starts: use it when the document is
   * already synced (a headless writer, a converter, tests). Otherwise call
   * `binding.initialize()` after the provider's first sync.
   */
  synced: boolean;
  /** Undo capture timeout in ms; null disables collaborative undo. */
  captureTimeout: number | null;
  /** See YBindingOptions.clientIDRange (default 'uint53'). */
  clientIDRange: ClientIDRange;
  /**
   * See YBindingOptions.selfCheck; null keeps the default (off). Warnings
   * go to the editor's `onWarn`.
   */
  selfCheck: boolean | null;
  /** See YBindingOptions.selfCheckSample; null keeps the default (1). */
  selfCheckSample: number | null;
  /** See YBindingOptions.convert (default false). */
  convert: boolean;
  /**
   * See YCollabInput.layoutUpgrade. Left out (a config written without
   * createYCollabConfig), a document below MIN_LAYOUT is read only and
   * also brings UNSUPPORTED_CONFIG_WARNING `'missing-layout-upgrade'`.
   */
  layoutUpgrade?: YLayoutUpgradeHandle | null;
  /**
   * Called with the binding's {@link YStatus} when it changes (what
   * yCollab's required `onStatus` sets). Default: none.
   */
  onYStatus?: ((status: YStatus) => void) | null;
}

/**
 * @experimental The configured YCollabExtension, for an editor's
 * `dependencies`: `createYCollabConfig({doc, schemaVersion, layoutUpgrade})`.
 * The way to configure the extension: its input type requires every
 * decision the app must make (`layoutUpgrade` included), and options a
 * later release adds are optional.
 */
export function createYCollabConfig(input: YCollabInput) {
  invariant(
    input.layoutUpgrade === undefined ||
      input.layoutUpgrade === null ||
      isYLayoutUpgradeHandle(input.layoutUpgrade),
    '@lexical/y: layoutUpgrade is a handle from createYServerLayoutUpgrade(), or null',
  );
  return configExtension(YCollabExtension, input);
}

/**
 * @experimental Binds the editor to a Yjs 14 document with the block-marker
 * layout, and provides collaborative undo (UNDO_COMMAND / REDO_COMMAND,
 * CAN_UNDO_COMMAND / CAN_REDO_COMMAND). Its output has the binding and a
 * `status` signal ('pending' until the layout record is read, then 'active'
 * or 'readonly'). It conflicts with the history extensions.
 *
 * The binding starts once the editor has its initial state: after every
 * extension has registered, and after InitialStateExtension has applied
 * `$initialEditorState`. That state is only ever the content of an empty
 * document (`initialize()` writes it there; called while extensions
 * register, it runs when the binding starts). On a document that has
 * content, the editor shows the document. An extension that depends on this
 * one and changes content in its own `afterRegistration` makes an edit.
 */
export const YCollabExtension = defineExtension({
  build(editor, config) {
    invariant(
      config.doc !== null,
      '@lexical/y: YCollabExtension needs a doc: pass doc: createYDoc() in its config, the document your provider syncs',
    );
    // A config key cannot be required by its type (configExtension takes a
    // partial config), so the app's decision is checked here.
    invariant(
      isSchemaVersion(config.schemaVersion),
      "@lexical/y: YCollabExtension needs schemaVersion (got %s): start at 1 and increase it whenever a node's stored fields or node types change",
      // 0 is the default, which no app sets.
      config.schemaVersion === 0 ? 'none' : String(config.schemaVersion),
    );
    invariant(
      config.layoutUpgrade === undefined ||
        config.layoutUpgrade === null ||
        isYLayoutUpgradeHandle(config.layoutUpgrade),
      '@lexical/y: layoutUpgrade is a handle from createYServerLayoutUpgrade(), or null',
    );
    const status = signal<YBindingStatus>('pending');
    const onYStatus = config.onYStatus ?? null;
    const hadState = hasState(config.doc);
    let collab: YCollabBinding | null = null;
    const binding = new YBinding(editor, config.doc, {
      captureTimeout: config.captureTimeout,
      clientIDRange: config.clientIDRange,
      convert: config.convert,
      layoutUpgrade: config.layoutUpgrade,
      onStatus: value => {
        status.value = value;
        if (onYStatus !== null && collab !== null) {
          onYStatus(collab.status);
        }
      },
      root: config.root || undefined,
      schemaVersion: config.schemaVersion,
      selfCheck: config.selfCheck ?? undefined,
      selfCheckSample: config.selfCheckSample ?? undefined,
    });
    // The extension starts and stops the binding (afterRegistration);
    // collab.dispose() disposes it too.
    // It listens from afterRegistration, when the binding starts.
    collab = collabBindingOf(binding, hadState, null, onYStatus, false);
    return {
      binding,
      /** The binding's public API (see YCollabBinding). */
      collab,
      status: status as ReadonlySignal<YBindingStatus>,
    };
  },
  // Invariant: the binding starts here, after InitialStateExtension's
  // afterRegistration (a dependency's hooks run first). Why: what the editor
  // holds before the binding starts is its initial state, which a document
  // with content replaces and only initialize() writes into an empty one.
  // Once the binding is active, an update is an edit: `$initialEditorState`
  // applied then would be written over the shared content, or next to it.
  // eslint-disable-next-line sort-keys-fix/sort-keys-fix -- `build` comes first: TypeScript infers the output type from it in order
  afterRegistration(editor, config, state) {
    const {binding} = state.getOutput();
    attachCollabBinding(binding);
    const stop = binding.start();
    const um = binding.undoManager;
    if (um !== null) {
      const update = () => {
        editor.dispatchCommand(CAN_UNDO_COMMAND, um.canUndo());
        editor.dispatchCommand(CAN_REDO_COMMAND, um.canRedo());
      };
      um.on('stack-item-added', update);
      um.on('stack-item-popped', update);
      um.on('stack-cleared', update);
      // An edit written while the binding started (a listener's follow-up
      // of the initialization start() runs) has made a step already.
      if (um.canUndo() || um.canRedo()) {
        update();
      }
    }
    if (config.synced) {
      binding.initialize();
    }
    return () => {
      detachCollabBinding(binding);
      stop();
    };
  },
  config: safeCast<YCollabConfig>({
    captureTimeout: 500,
    clientIDRange: 'uint53',
    convert: false,
    doc: null,
    onYStatus: null,
    root: null,
    // Not a version: the app must set its own (see build).
    schemaVersion: 0,
    selfCheck: null,
    selfCheckSample: null,
    synced: false,
  }),
  conflictsWith: ['@lexical/history/History', '@lexical/history/SharedHistory'],
  // Every peer must hold the normalized tree the node declarations describe;
  // the initial state is applied before the binding starts (see
  // afterRegistration).
  dependencies: [NodeStructureExtension, InitialStateExtension],
  name: '@lexical/y/Collab',
  // Where the editor also has block ids, the update that names the blocks a
  // remote change brings only sets their ids. Every client that receives the
  // change makes that update, no one's edit, which may set attributes or
  // delete (see Writer#followUp). With transforms it would also change what
  // the change brought (lift a block, pad a table) in ways clients can
  // derive differently: the binding refuses to write with that setting
  // (UNSUPPORTED_CONFIG_WARNING, read only).
  //
  // HMRExtension restores the previous editor's state in its
  // afterRegistration (a development reload): it runs before the binding
  // starts too, so the restored state is the editor's initial state.
  peerDependencies: [
    declarePeerDependency<typeof BlockIdExtension>(
      '@lexical/extension/BlockId',
      {repairTransforms: false},
    ),
    declarePeerDependency<typeof HMRExtension>('@lexical/extension/HMR'),
  ],
  register(editor, _config, state) {
    const {binding} = state.getOutput();
    // Nothing to undo or redo until the binding has written an edit.
    editor.dispatchCommand(CAN_UNDO_COMMAND, false);
    editor.dispatchCommand(CAN_REDO_COMMAND, false);
    return mergeRegister(
      editor.registerCommand(
        UNDO_COMMAND,
        () => {
          binding.undo();
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
      editor.registerCommand(
        REDO_COMMAND,
        () => {
          binding.redo();
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
    );
  },
});
