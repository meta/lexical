/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {InitialEditorStateType} from './LexicalComposer';
import type {LexicalEditor} from 'lexical';
import type {Doc, XmlElement, XmlText} from 'yjs';

import {
  type CollaborationContextType,
  useCollaborationContext,
} from '@lexical/react/LexicalCollaborationContext';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {
  type Binding,
  createYjsBinding,
  type ExcludedProperties,
  type Provider,
  type SyncCursorPositionsFn,
} from '@lexical/yjs';
import {type JSX, useEffect, useRef, useState} from 'react';

import {
  type CursorsContainerRef,
  useYjsCollaboration,
  useYjsCollaborationV2__EXPERIMENTAL,
  useYjsCursors,
  useYjsFocusTracking,
  useYjsHistory,
  useYjsHistoryV2,
} from './shared/useYjsCollaboration';

type ProviderFactory = (id: string, yjsDocMap: Map<string, Doc>) => Provider;

type CollaborationPluginProps = {
  id: string;
  providerFactory: ProviderFactory;
  /**
   * Seed the document with an empty paragraph (or `initialEditorState`) once
   * the provider reports `sync` and the document is still empty.
   *
   * At most one client may pass `true` for a given document. The seed is an
   * ordinary Yjs insert rather than a compare-and-set, so two clients that both
   * observe an empty document each insert a paragraph and Yjs keeps both,
   * leaving every client with a spurious leading empty block. This is easy to
   * hit with a nested editor (an image caption, a sticky note), where every
   * client mounts the editor -- and so connects to its document -- at the same
   * moment the node itself syncs. Prefer bootstrapping the document
   * server-side; see the collaboration docs.
   */
  shouldBootstrap: boolean;
  username?: string;
  cursorColor?: string;
  cursorsContainerRef?: CursorsContainerRef;
  initialEditorState?: InitialEditorStateType;
  excludedProperties?: ExcludedProperties;
  // `awarenessData` parameter allows arbitrary data to be added to the awareness.
  awarenessData?: object;
  syncCursorPositionsFn?: SyncCursorPositionsFn;
  /** Opt in to the new CSS Highlights-based selection rendering (if supported by the browser).
   * Fallback to legacy method if not enabled or not supported.
   */
  selectionHighlight?: boolean;
  /** Customize the Yjs shared-type key used for the root `XmlText`. Defaults to `'root'`. */
  rootName?: string;
  /**
   * Resolve the root `XmlText` from the `Doc` yourself, for roots that are not
   * a top-level shared type (e.g. an `XmlText` held in a `Y.Map` or `Y.Array`,
   * as when one `Doc` stores many independently editable documents). Takes
   * precedence over `rootName`.
   *
   * Read when the binding is created: this prop and `rootName` cannot repoint
   * a mounted editor at another document. Remount the editor (a React `key` on
   * the component that owns it) to edit a different one — a remount of this
   * plugin alone would leave the previous document's content in the editor and
   * write it into the new root.
   */
  getXmlText?: (doc: Doc) => XmlText;
};

/**
 * Connects the editor to a Yjs document for real-time collaboration, syncing
 * editor state and rendering remote users' cursors and selections. Provide a
 * `providerFactory` that creates the Yjs {@link Provider} for the given
 * document `id`. Must be used within a {@link LexicalCollaboration} provider.
 *
 * @returns The element that renders collaborators' cursors (or an empty
 * fragment until the provider and binding are initialized).
 */
export function CollaborationPlugin({
  id,
  providerFactory,
  shouldBootstrap,
  username,
  cursorColor,
  cursorsContainerRef,
  initialEditorState,
  excludedProperties,
  awarenessData,
  syncCursorPositionsFn,
  selectionHighlight,
  rootName,
  getXmlText,
}: CollaborationPluginProps): JSX.Element {
  const isBindingInitialized = useRef(false);
  // The inputs that produced the current Provider. A ref rather than the effect
  // deps alone because the effect must be idempotent: React StrictMode (and
  // React 18+ remounts in general) re-runs the effect with unchanged inputs and
  // must not create a second Provider.
  const providerInputs = useRef<null | {
    id: string;
    providerFactory: ProviderFactory;
    yjsDocMap: Map<string, Doc>;
  }>(null);
  const providerRef = useRef<Provider | null>(null);

  const collabContext = useCollaborationContext(username, cursorColor);
  const {yjsDocMap, name, color} = collabContext;

  const [editor] = useLexicalComposerContext();

  useCollabActive(collabContext, editor);

  const [provider, setProvider] = useState<Provider>();
  const [doc, setDoc] = useState<Doc>();

  useEffect(() => {
    const prevInputs = providerInputs.current;
    if (
      prevInputs !== null &&
      prevInputs.id === id &&
      prevInputs.providerFactory === providerFactory &&
      prevInputs.yjsDocMap === yjsDocMap
    ) {
      return;
    }

    providerInputs.current = {id, providerFactory, yjsDocMap};

    const newProvider = providerFactory(id, yjsDocMap);
    const previousProvider = providerRef.current;
    // Disconnected here rather than from this effect's cleanup, and only when
    // something really did replace it. A `providerFactory` declared inline --
    // the shape this package's own test harness uses -- has a fresh identity
    // every render, so a cleanup-based disconnect tears down the live provider
    // on every parent render; and when such a factory hands back a cached
    // provider, setProvider() bails on the identical value, nothing re-runs,
    // and the editor is left permanently disconnected.
    if (previousProvider !== null && previousProvider !== newProvider) {
      previousProvider.disconnect();
    }
    providerRef.current = newProvider;
    setProvider(newProvider);
    setDoc(yjsDocMap.get(id));
  }, [id, providerFactory, yjsDocMap]);

  useEffect(() => {
    return () => {
      const currentProvider = providerRef.current;
      if (currentProvider !== null) {
        providerRef.current = null;
        currentProvider.disconnect();
      }
    };
  }, []);

  const [binding, setBinding] = useState<Binding>();

  useEffect(() => {
    if (!provider) {
      return;
    }

    if (isBindingInitialized.current) {
      return;
    }

    const resolvedDoc = doc || yjsDocMap.get(id);
    if (!resolvedDoc) {
      return;
    }

    isBindingInitialized.current = true;
    const newBinding = createYjsBinding({
      doc: resolvedDoc,
      docMap: yjsDocMap,
      editor,
      excludedProperties,
      getXmlText,
      id,
      rootName,
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBinding(newBinding);
    // `excludedProperties`, `rootName` and `getXmlText` configure the binding
    // and are read on the pass that creates it (which is not necessarily the
    // first one -- the effect returns early until the provider exists, so a
    // root that only resolves after mount is still picked up). They are
    // deliberately not dependencies: a binding cannot be reconfigured or
    // repointed once it exists, and re-running this effect would only tear the
    // editor's binding down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, provider, id, yjsDocMap, doc]);

  // Destroying the binding belongs to unmount, not to this effect's cleanup:
  // the binding is created once, so a cleanup on the creation effect would
  // destroy it on any input change without building a replacement.
  useEffect(() => {
    if (binding === undefined) {
      return;
    }
    return () => {
      binding.root.destroy(binding);
    };
  }, [binding]);

  if (!provider || !binding) {
    return <></>;
  }

  return (
    <YjsCollaborationCursors
      awarenessData={awarenessData}
      binding={binding}
      collabContext={collabContext}
      color={color}
      cursorsContainerRef={cursorsContainerRef}
      editor={editor}
      id={id}
      initialEditorState={initialEditorState}
      name={name}
      provider={provider}
      setDoc={setDoc}
      shouldBootstrap={shouldBootstrap}
      yjsDocMap={yjsDocMap}
      syncCursorPositionsFn={syncCursorPositionsFn}
      selectionHighlight={selectionHighlight}
    />
  );
}

function YjsCollaborationCursors({
  editor,
  id,
  provider,
  yjsDocMap,
  name,
  color,
  shouldBootstrap,
  cursorsContainerRef,
  initialEditorState,
  awarenessData,
  collabContext,
  binding,
  setDoc,
  syncCursorPositionsFn,
  selectionHighlight,
}: {
  editor: LexicalEditor;
  id: string;
  provider: Provider;
  yjsDocMap: Map<string, Doc>;
  name: string;
  color: string;
  shouldBootstrap: boolean;
  binding: Binding;
  setDoc: React.Dispatch<React.SetStateAction<Doc | undefined>>;
  cursorsContainerRef?: CursorsContainerRef | undefined;
  initialEditorState?: InitialEditorStateType | undefined;
  awarenessData?: object;
  collabContext: CollaborationContextType;
  syncCursorPositionsFn?: SyncCursorPositionsFn;
  /** Opt in to the new CSS Highlights-based selection rendering (if supported by the browser).
   * Fallback to legacy method if not enabled or not supported.
   */
  selectionHighlight?: boolean;
}) {
  const cursors = useYjsCollaboration(
    editor,
    id,
    provider,
    yjsDocMap,
    name,
    color,
    shouldBootstrap,
    binding,
    setDoc,
    cursorsContainerRef,
    initialEditorState,
    awarenessData,
    syncCursorPositionsFn,
    selectionHighlight,
  );

  useYjsHistory(editor, binding);
  useYjsFocusTracking(editor, provider, name, color, awarenessData);

  return cursors;
}

type CollaborationPluginV2Props = {
  id: string;
  doc: Doc;
  provider: Provider;
  __shouldBootstrapUnsafe?: boolean;
  username?: string;
  cursorColor?: string;
  cursorsContainerRef?: CursorsContainerRef;
  excludedProperties?: ExcludedProperties;
  // `awarenessData` parameter allows arbitrary data to be added to the awareness.
  awarenessData?: object;
  /** Opt in to the new CSS Highlights-based selection rendering (if supported by the browser).
   * Fallback to legacy method if not enabled or not supported.
   */
  selectionHighlight?: boolean;
  /** Customize the Yjs shared-type key used for the root `XmlElement`. Defaults to `'root-v2'`. */
  rootName?: string;
  /**
   * Resolve the root `XmlElement` from the `Doc` yourself, for roots that are
   * not a top-level shared type (e.g. an `XmlElement` held in a `Y.Map` or
   * `Y.Array`, as when one `Doc` stores many independently editable
   * documents). The element must be created as `new XmlElement()` without a
   * `nodeName`. Takes precedence over `rootName`.
   *
   * Read when the binding is created: this prop and `rootName` cannot repoint
   * a mounted editor at another document. Remount the editor (a React `key` on
   * the component that owns it) to edit a different one — a remount of this
   * plugin alone would leave the previous document's content in the editor and
   * write it into the new root.
   */
  getXmlElement?: (doc: Doc) => XmlElement;
};

/**
 * A variant of {@link CollaborationPlugin} that takes an already-created Yjs
 * `doc` and {@link Provider} directly instead of a provider factory, giving the
 * application full control over their lifecycle. Must be used within a
 * {@link LexicalCollaboration} provider.
 *
 * @experimental The API may change in a future release.
 * @returns The element that renders collaborators' cursors.
 */
export function CollaborationPluginV2__EXPERIMENTAL({
  id,
  doc,
  provider,
  __shouldBootstrapUnsafe,
  username,
  cursorColor,
  cursorsContainerRef,
  excludedProperties,
  awarenessData,
  selectionHighlight,
  rootName,
  getXmlElement,
}: CollaborationPluginV2Props): JSX.Element {
  const collabContext = useCollaborationContext(username, cursorColor);
  const {yjsDocMap, name, color} = collabContext;

  const [editor] = useLexicalComposerContext();
  useCollabActive(collabContext, editor);

  const binding = useYjsCollaborationV2__EXPERIMENTAL(
    editor,
    id,
    doc,
    provider,
    yjsDocMap,
    name,
    color,
    {
      __shouldBootstrapUnsafe,
      awarenessData,
      excludedProperties,
      getXmlElement,
      rootName,
      selectionHighlight,
    },
  );

  useYjsHistoryV2(editor, binding);
  useYjsFocusTracking(editor, provider, name, color, awarenessData);
  return useYjsCursors(binding, cursorsContainerRef);
}

const useCollabActive = (
  collabContext: CollaborationContextType,
  editor: LexicalEditor,
) => {
  useEffect(() => {
    // eslint-disable-next-line react-hooks/immutability
    collabContext.isCollabActive = true;

    return () => {
      // Resetting flag only when unmount top level editor collab plugin. Nested
      // editors (e.g. image caption) should unmount without affecting it
      if (editor._parentEditor == null) {
        collabContext.isCollabActive = false;
      }
    };
  }, [collabContext, editor]);
};
