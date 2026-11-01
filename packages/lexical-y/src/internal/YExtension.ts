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
  declarePeerDependency,
  defineExtension,
  mergeRegister,
  REDO_COMMAND,
  safeCast,
  UNDO_COMMAND,
} from 'lexical';

import {isSchemaVersion, YBinding, type YBindingStatus} from './Binding';

// YCollabExtension: the binding as an extension. It builds a YBinding for
// the editor, wires collaborative undo to UNDO_COMMAND and REDO_COMMAND, and
// exposes the binding's status as a signal.

/** @experimental The configuration of {@link YCollabExtension}. */
export interface YCollabConfig {
  /**
   * The shared document, made by `createYDoc` (with a stored state:
   * `createYDoc(state)`). Required.
   */
  doc: YDoc | null;
  /**
   * The version of the app's document schema: its node types and the fields
   * they store. Required: start at 1 and increase it whenever a node's
   * stored fields or node types change. The document records the highest
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
    const status = signal<YBindingStatus>('pending');
    return {
      binding: new YBinding(editor, config.doc, {
        captureTimeout: config.captureTimeout,
        clientIDRange: config.clientIDRange,
        convert: config.convert,
        onStatus: value => {
          status.value = value;
        },
        root: config.root || undefined,
        schemaVersion: config.schemaVersion,
        selfCheck: config.selfCheck ?? undefined,
        selfCheckSample: config.selfCheckSample ?? undefined,
      }),
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
    return stop;
  },
  config: safeCast<YCollabConfig>({
    captureTimeout: 500,
    clientIDRange: 'uint53',
    convert: false,
    doc: null,
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
