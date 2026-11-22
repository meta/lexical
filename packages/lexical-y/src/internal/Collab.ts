/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import invariant from '@lexical/internal/invariant';
import {
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_EDITOR,
  configExtension,
  type LexicalEditor,
  mergeRegister,
  REDO_COMMAND,
  UNDO_COMMAND,
} from 'lexical';

import {isSchemaVersion, YBinding} from './Binding';
import {
  collabBindingOf,
  hasState,
  Y_DEFAULTS,
  type YCollabBinding,
  type YCollabOptions,
} from './CollabBinding';
import {createYServerLayoutUpgrade} from './LayoutUpgrade';
import {YCollabExtension} from './YExtension';

// The entry points of the binding's public API (layout 4 spec, section 11):
// createYBinding for an editor built without extensions, yCollab for one
// built from them. Their types are in CollabBinding.ts.

const SETUP_HINT =
  'createYBinding(editor, {doc: createYDoc(), schemaVersion: 1, synced: false, onStatus}) and binding.markSynced() after the first sync';

/** Throws, naming the fix, when `options` lacks a required choice. */
function checkOptions(entry: string, options: YCollabOptions): void {
  invariant(
    typeof options === 'object' && options !== null,
    '@lexical/y: %s needs options: %s',
    entry,
    SETUP_HINT,
  );
  invariant(
    options.doc != null,
    '@lexical/y: %s needs doc: pass the document your provider syncs, made with createYDoc()',
    entry,
  );
  invariant(
    isSchemaVersion(options.schemaVersion),
    '@lexical/y: %s needs schemaVersion, an integer from 1 (got %s): start at 1 and bump it when your nodes change',
    entry,
    String(options.schemaVersion),
  );
  invariant(
    typeof options.synced === 'boolean',
    '@lexical/y: %s needs synced: true when the document is already synced (headless, tests, loaded from storage), false to call binding.markSynced() after the provider first syncs (until then nobody can type)',
    entry,
  );
  invariant(
    typeof options.onStatus === 'function',
    "@lexical/y: %s needs onStatus: a function that shows the user the binding's status, so a read-only document and its cause are never silent",
    entry,
  );
  invariant(
    options.root === undefined || typeof options.root === 'string',
    '@lexical/y: %s takes root as a name (default Y_DEFAULTS.root)',
    entry,
  );
  invariant(
    options.history === undefined ||
      options.history === false ||
      (typeof options.history === 'object' &&
        options.history !== null &&
        typeof options.history.captureTimeout === 'number'),
    '@lexical/y: %s takes history as {captureTimeout} or false (default Y_DEFAULTS.history)',
    entry,
  );
}

/**
 * @experimental Bind an editor that is not built from extensions to a Yjs
 * document. Start here:
 *
 * 1. `const doc = createYDoc()`;
 * 2. `const binding = createYBinding(editor, {doc, schemaVersion: 1, synced: false, onStatus})`;
 * 3. connect your provider, sending `binding.handshake(generation)` first;
 * 4. `binding.markSynced()` after its first sync;
 * 5. `binding.freeze()` when the server's fence says the room moved on.
 *
 * It starts at once, `pending` (nothing written, the editor not editable)
 * until `markSynced()`. Editors built from extensions use {@link yCollab}.
 */
export function createYBinding(
  editor: LexicalEditor,
  options: YCollabOptions,
): YCollabBinding {
  checkOptions('createYBinding', options);
  const {doc} = options;
  const hadState = hasState(doc);
  let collab: YCollabBinding | null = null;
  const history = options.history ?? Y_DEFAULTS.history;
  const binding = new YBinding(editor, doc, {
    captureTimeout: history === false ? null : history.captureTimeout,
    // A document below MIN_LAYOUT is read only until its server migrates it
    // (status cause 'layout-older'); the handshake tells the server.
    layoutUpgrade: createYServerLayoutUpgrade(),
    onStatus: () => {
      if (collab !== null) {
        options.onStatus(collab.status);
      }
    },
    root: doc.get(options.root ?? Y_DEFAULTS.root),
    schemaVersion: options.schemaVersion,
  });
  let stopBinding = () => {};
  let stopHistory = () => {};
  // Made before the binding starts: starting reads a document with content,
  // and the status it reports then goes through `collab`.
  const made = collabBindingOf(
    binding,
    hadState,
    () => {
      stopHistory();
      stopBinding();
    },
    options.onStatus,
    true,
  );
  collab = made;
  // Nothing to undo or redo until the binding has written an edit.
  editor.dispatchCommand(CAN_UNDO_COMMAND, false);
  editor.dispatchCommand(CAN_REDO_COMMAND, false);
  stopBinding = binding.start();
  // The binding dispatches CAN_UNDO and CAN_REDO, as the extension does.
  const um = binding.undoManager;
  if (um !== null) {
    const update = () => {
      editor.dispatchCommand(CAN_UNDO_COMMAND, um.canUndo());
      editor.dispatchCommand(CAN_REDO_COMMAND, um.canRedo());
    };
    um.on('stack-item-added', update);
    um.on('stack-item-popped', update);
    um.on('stack-cleared', update);
    // An edit written while the binding started (a listener's follow-up)
    // has made a step already.
    if (um.canUndo() || um.canRedo()) {
      update();
    }
    // And handles UNDO_COMMAND and REDO_COMMAND, as the extension does.
    const stopCommands = mergeRegister(
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
    stopHistory = () => {
      um.off('stack-item-added', update);
      um.off('stack-item-popped', update);
      um.off('stack-cleared', update);
      stopCommands();
    };
  }
  if (options.synced) {
    made.markSynced();
  }
  return made;
}

/**
 * @experimental YCollabExtension configured for an editor's `dependencies`.
 * Start here:
 *
 * 1. `const doc = createYDoc()`;
 * 2. `dependencies: [yCollab({doc, schemaVersion: 1, synced: false, onStatus})]`;
 * 3. connect your provider, sending `collab.handshake(generation)` first
 *    (`collab` from the extension's output);
 * 4. `collab.markSynced()` after its first sync;
 * 5. `collab.freeze()` when the server's fence says the room moved on.
 */
export function yCollab(options: YCollabOptions) {
  checkOptions('yCollab', options);
  const history = options.history ?? Y_DEFAULTS.history;
  return configExtension(YCollabExtension, {
    captureTimeout: history === false ? null : history.captureTimeout,
    doc: options.doc,
    layoutUpgrade: createYServerLayoutUpgrade(),
    onYStatus: options.onStatus,
    root: options.doc.get(options.root ?? Y_DEFAULTS.root),
    schemaVersion: options.schemaVersion,
    synced: options.synced,
  });
}
