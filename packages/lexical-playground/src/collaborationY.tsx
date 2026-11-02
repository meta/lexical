/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Collab Y: `@lexical/y` (Yjs 14, `@y/y`) over `@y/websocket`.
//
// This module is only loaded (as its own chunk) when the playground runs with
// `?isCollab=true&useCollabY=true`, so the default playground never pulls in
// a second Yjs. Run its server with `pnpm run collab:y` (port 1235).
//
// What this mode leaves out, compared with collab v1:
// - remote cursors and selections (the binding does not use awareness);
// - comments (CommentPlugin keeps its threads in a Yjs 13 document; Editor.tsx
//   turns it off, as in collab v2). MarkNodes in the document still sync;
// - nested editors (image captions, sticky notes): `@lexical/y` syncs a
//   snapshot of them when their node is written, not their edits, so they
//   are read only here (see hooks/useCollabYNestedEditor.ts);
// - version history (VersionsPlugin is collab v2 only).
// Playground nodes without collab declarations fall back to the binding's
// nested storage (a shared node per Lexical node, its JSON fields as
// attributes), which syncs them.

import {
  AutoFocusExtension,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
  type Signal,
  signal,
} from '@lexical/extension';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {ReactExtension} from '@lexical/react/ReactExtension';
import {ReactProviderExtension} from '@lexical/react/ReactProviderExtension';
import {useSignalValue} from '@lexical/react/useExtensionSignalValue';
import {
  createYDoc,
  isYWarning,
  STORAGE_MISMATCH_WARNING,
  UNKNOWN_NODE_TYPES_WARNING,
  UNSUPPORTED_CONFIG_WARNING,
  UNSUPPORTED_LAYOUT_WARNING,
  UNSUPPORTED_SCHEMA_WARNING,
  UNSUPPORTED_SLOTS_WARNING,
  YCollabExtension,
  type YDoc,
  type YWarning,
} from '@lexical/y';
import {CONNECTED_COMMAND, TOGGLE_CONNECT_COMMAND} from '@lexical/yjs';
import {WebsocketProvider} from '@y/websocket';
import {
  type AnyLexicalExtensionArgument,
  COMMAND_PRIORITY_LOW,
  configExtension,
  defineExtension,
  type LexicalEditorWithDispose,
  LexicalWarning,
} from 'lexical';
import {type JSX, useEffect, useRef} from 'react';

const params = new URLSearchParams(window.location.search);
const WEBSOCKET_ENDPOINT =
  params.get('collabEndpoint') || 'ws://localhost:1235';
const WEBSOCKET_SLUG = 'playground-y';
const WEBSOCKET_ID = params.get('collabId') || '0';
/**
 * The version of the playground's document schema (its node types and their
 * stored fields): bump it whenever a node's stored fields or node types
 * change, so that a tab still running the older playground opens documents
 * the newer one edited read only instead of editing what it cannot read in
 * full. `?collabYSchemaVersion=<n>` overrides it, to try the gate with two
 * tabs.
 */
const SCHEMA_VERSION = Number(params.get('collabYSchemaVersion')) || 1;

export interface CollabYSession {
  doc: YDoc;
  editor: LexicalEditorWithDispose;
  provider: WebsocketProvider;
  /**
   * The binding's warning that explains why it is read only (a newer
   * version of the app, a layout, a node type or a slot it cannot store, a
   * configuration it cannot write with), for the read-only notice's text.
   */
  readOnlyWarning: Signal<YWarning | null>;
}

/** The binding's warnings that come with (or explain) its read-only state. */
const READ_ONLY_WARNING_CODES: ReadonlySet<string> = new Set([
  UNSUPPORTED_SCHEMA_WARNING,
  UNSUPPORTED_LAYOUT_WARNING,
  UNKNOWN_NODE_TYPES_WARNING,
  STORAGE_MISMATCH_WARNING,
  UNSUPPORTED_SLOTS_WARNING,
  UNSUPPORTED_CONFIG_WARNING,
]);

/**
 * Whether `warning` says the document needs a newer playground: what it
 * lacks (node types, how they are stored) then follows from that, so later
 * warnings do not replace it in the notice.
 */
function needsNewerApp(warning: YWarning | null): boolean {
  return (
    warning !== null &&
    (warning.code === UNSUPPORTED_SCHEMA_WARNING ||
      warning.code === UNSUPPORTED_LAYOUT_WARNING) &&
    warning.data.reason === 'newer'
  );
}

let session: CollabYSession | null = null;

/**
 * The page's collab Y editor, built once.
 *
 * The editor is built here rather than by `LexicalExtensionComposer`: building
 * an editor registers its extensions, and React (Strict Mode) builds a memoized
 * editor twice and drops one. A dropped editor would keep a second binding on
 * the shared document. The collab settings only change with a page reload, so
 * one editor per page is enough.
 */
export function getCollabYSession(
  id: string,
  buildApp: () => AnyLexicalExtensionArgument,
): CollabYSession {
  if (session === null) {
    const doc = createYDoc();
    const readOnlyWarning = signal<YWarning | null>(null);
    const provider = new WebsocketProvider(
      WEBSOCKET_ENDPOINT,
      WEBSOCKET_SLUG + '/' + WEBSOCKET_ID + '/' + id,
      doc,
      {
        connect: false,
        // Every update goes through the server, also between the two frames
        // of the split view, so that "Disconnect" takes a frame offline.
        disableBc: true,
      },
    );
    const editor = buildEditorFromExtensions(
      defineExtension({
        // What LexicalExtensionComposer adds around its extension.
        dependencies: [
          ReactProviderExtension,
          configExtension(ReactExtension, {contentEditable: null}),
          buildApp(),
          // The binding's self-check (off by default) reads its writes
          // back in development builds: a mismatch is a warning, which the
          // collab Y e2e specs fail on. It is keyed on the build mode, as
          // Lexical's own `__DEV__` is (scripts/vite/lexicalMonorepoPlugin.ts),
          // and not on `import.meta.env.DEV`, which Vite derives from
          // NODE_ENV: `vite build --mode development`, the build the e2e CI
          // job tests, has NODE_ENV production and DEV false.
          configExtension(YCollabExtension, {
            doc,
            schemaVersion: SCHEMA_VERSION,
            selfCheck: import.meta.env?.MODE !== 'production',
          }),
        ],
        name: '@lexical/playground/collab-y',
        // The binding's warnings (a document opened read only, a
        // self-check mismatch) are logged rather than thrown, as Lexical's
        // default onWarn does in development.
        onWarn: error => {
          if (
            isYWarning(error) &&
            READ_ONLY_WARNING_CODES.has(error.code) &&
            (needsNewerApp(error) || !needsNewerApp(readOnlyWarning.peek()))
          ) {
            readOnlyWarning.value = error;
          }
          console.warn(
            error instanceof LexicalWarning
              ? `${error.message} (${error.code})`
              : error,
          );
        },
      }),
    );
    session = {doc, editor, provider, readOnlyWarning};
  }
  return session;
}

/**
 * Connects the provider, initializes the binding after the first sync, wires
 * the toolbar's connect button, and shows the binding's read-only state.
 */
export function CollabYPlugin({
  provider,
  readOnlyWarning,
}: {
  provider: WebsocketProvider;
  readOnlyWarning: Signal<YWarning | null>;
}): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const {binding, status} = getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output;
  const statusValue = useSignalValue(status);
  const warning = useSignalValue(readOnlyWarning);

  useEffect(() => {
    const onSync = (isSynced: boolean) => {
      if (isSynced) {
        // A no-op after the first time.
        binding.initialize();
      }
    };
    const onStatus = ({status: value}: {status: string}) => {
      editor.dispatchCommand(CONNECTED_COMMAND, value === 'connected');
    };
    provider.on('sync', onSync);
    provider.on('status', onStatus);
    const unregister = editor.registerCommand(
      TOGGLE_CONNECT_COMMAND,
      shouldConnect => {
        if (shouldConnect) {
          provider.connect();
        } else {
          provider.disconnect();
        }
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );
    // Connect in a task so that React Strict Mode's mount, unmount and mount
    // in development opens one socket instead of closing a connecting one.
    const connect = setTimeout(() => provider.connect());
    return () => {
      clearTimeout(connect);
      unregister();
      provider.off('sync', onSync);
      provider.off('status', onStatus);
      provider.disconnect();
    };
  }, [binding, editor, provider]);

  // The binding keeps the editor non-editable until it has read the
  // document, and while it is read only (a layout it cannot write). Anything
  // that turns the editor editable then (the toolbar's read-only toggle,
  // which ActionsPlugin also disables) would let the user type into an
  // editor whose edits the binding does not write: they would be replaced by
  // the first sync, or lost on reload. Keep it non-editable until then.
  useEffect(
    () =>
      editor.registerEditableListener(editable => {
        if (editable && binding.status !== 'active') {
          editor.setEditable(false);
        }
      }),
    [binding, editor],
  );

  // The editor is read only until the binding has read the document, so
  // AutoFocusExtension's focus on load does nothing: focus it once it is
  // editable instead.
  const didAutoFocus = useRef(false);
  useEffect(() => {
    if (statusValue !== 'active' || didAutoFocus.current) {
      return;
    }
    didAutoFocus.current = true;
    const autoFocus = getExtensionDependencyFromEditor(
      editor,
      AutoFocusExtension,
    ).output;
    if (!autoFocus.disabled.peek()) {
      editor.focus(undefined, {
        defaultSelection: autoFocus.defaultSelection.peek(),
      });
    }
  }, [editor, statusValue]);

  if (statusValue !== 'readonly') {
    return null;
  }
  // The app's own text, chosen from the warning's typed `code` and
  // `reason`; the code and reason are also on the element, for the e2e
  // specs.
  const text =
    warning === null || !needsNewerApp(warning)
      ? "This document can't be opened for editing here. It is read only."
      : warning.code === UNSUPPORTED_SCHEMA_WARNING
        ? 'This document was edited with a newer version of the playground. Reload the page to get the latest version; until then it is read only here.'
        : 'This document was written by a newer version of the playground. It is read only here.';
  return (
    <div
      className="collab-y-notice"
      role="status"
      data-code={warning === null ? undefined : warning.code}
      data-reason={warning === null ? undefined : warning.data.reason}>
      {text}
    </div>
  );
}
