/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Provider} from '.';
import type {CollabDecoratorNode} from './CollabDecoratorNode';
import type {CollabLineBreakNode} from './CollabLineBreakNode';
import type {CollabTextNode} from './CollabTextNode';
import type {Cursor} from './SyncCursors';
import type {Klass, LexicalEditor, LexicalNode, NodeKey} from 'lexical';

import invariant from '@lexical/internal/invariant';
import {type Doc, XmlElement, XmlText} from 'yjs';

import {
  $createCollabElementNode,
  type CollabElementNode,
} from './CollabElementNode';
import {CollabV2Mapping} from './CollabV2Mapping';
import {initializeNodeProperties, ROOT_NODE_NAME} from './Utils';

export type ClientID = number;
export interface BaseBinding {
  clientID: number;
  cursors: Map<ClientID, Cursor>;
  cursorsContainer: null | HTMLElement;
  /**
   * For remote cursors, we lazily create stylesheet that hosts the `::highlight(...)` rules.
   * Editors mounted in different frames each adopt the sheet into their own document.
   */
  cursorHighlightSheet: CSSStyleSheet | null;
  doc: Doc;
  docMap: Map<string, Doc>;
  editor: LexicalEditor;
  id: string;
  nodeProperties: Map<string, {[property: string]: unknown}>; // node type to property to default value
  excludedProperties: ExcludedProperties;
  /**
   * True only while the initial editor state is being written into an empty
   * shared document (the `shouldBootstrap` path). Bootstrapping is not a user
   * edit, so the {@link UndoManager} returned by `createUndoManager` does not
   * capture transactions produced while this is set.
   *
   * @internal Set by the collaboration plugin around the bootstrap update;
   * not part of the supported surface for application code.
   */
  isBootstrapping: boolean;
}

export interface Binding extends BaseBinding {
  collabNodeMap: Map<
    NodeKey,
    | CollabElementNode
    | CollabTextNode
    | CollabDecoratorNode
    | CollabLineBreakNode
  >;
  root: CollabElementNode;
}

export interface BindingV2 extends BaseBinding {
  mapping: CollabV2Mapping;
  root: XmlElement;
}

export type AnyBinding = Binding | BindingV2;

export type ExcludedProperties = Map<Klass<LexicalNode>, Set<string>>;

function createBaseBinding(
  editor: LexicalEditor,
  id: string,
  doc: Doc,
  docMap: Map<string, Doc>,
  excludedProperties?: ExcludedProperties,
): BaseBinding {
  const binding = {
    clientID: doc.clientID,
    cursorHighlightSheet: null,
    cursors: new Map(),
    cursorsContainer: null,
    doc,
    docMap,
    editor,
    excludedProperties: excludedProperties || new Map(),
    id,
    isBootstrapping: false,
    nodeProperties: new Map(),
  };
  initializeNodeProperties(binding);
  return binding;
}

/** Options for {@link createYjsBinding}. */
export interface CreateYjsBindingOptions {
  editor: LexicalEditor;
  /** Identifier for this binding, used as the key in `docMap`. */
  id: string;
  doc: Doc;
  docMap: Map<string, Doc>;
  excludedProperties?: ExcludedProperties;
  /** The key used to look up the root `XmlText` shared type on the Yjs `Doc`. Defaults to `'root'`. */
  rootName?: string;
  /**
   * Resolve the root `XmlText` from the `Doc` yourself, for roots that are not
   * a top-level shared type (e.g. an `XmlText` held in a `Y.Map` or `Y.Array`,
   * as when one `Doc` stores many independently editable documents).
   *
   * Called while the binding is constructed — before any provider has synced —
   * so it must resolve (or create) the root from whatever the `Doc` holds
   * locally at that moment, and it must be idempotent: a caller may build more
   * than one binding over the same root (React StrictMode's double-invoked
   * render, a remount), and creating a shared type twice would replace what the
   * first call created.
   *
   * The returned type is checked to be an `XmlText` integrated into `doc`
   * (reachable from a top-level shared type). It must also not be in use by
   * another live binding, which cannot be checked — a second binding over one
   * root replaces the collab nodes cached on its shared types. A binding cannot
   * be repointed at a different root afterwards. When given, this takes
   * precedence over {@link CreateYjsBindingOptions.rootName}.
   */
  getXmlText?: (doc: Doc) => XmlText;
}

/**
 * Create a V1 Yjs {@link Binding} that connects a {@link LexicalEditor} to a
 * Yjs `Doc` for real-time collaboration.
 *
 * For the legacy positional-argument API, see {@link createBinding}.
 */
export function createYjsBinding({
  editor,
  id,
  doc,
  docMap,
  excludedProperties,
  rootName = 'root',
  getXmlText,
}: CreateYjsBindingOptions): Binding {
  const rootXmlText = getXmlText
    ? getXmlText(doc)
    : (doc.get(rootName, XmlText) as XmlText);
  invariant(
    rootXmlText instanceof XmlText && rootXmlText.doc === doc,
    'createYjsBinding: getXmlText must return an XmlText that is already integrated into the given doc',
  );
  const root: CollabElementNode = $createCollabElementNode(
    rootXmlText,
    null,
    'root',
  );
  root._key = 'root';
  return {
    ...createBaseBinding(editor, id, doc, docMap, excludedProperties),
    collabNodeMap: new Map(),
    root,
  };
}

export function createBinding(
  editor: LexicalEditor,
  provider: Provider,
  id: string,
  doc: Doc | null | undefined,
  docMap: Map<string, Doc>,
  excludedProperties?: ExcludedProperties,
): Binding {
  invariant(
    doc !== undefined && doc !== null,
    'createBinding: doc is null or undefined',
  );
  return createYjsBinding({doc, docMap, editor, excludedProperties, id});
}

/** Options for {@link createBindingV2__EXPERIMENTAL}. */
export interface CreateBindingV2Options__EXPERIMENTAL {
  excludedProperties?: ExcludedProperties;
  /** The key used to look up the root `XmlElement` shared type on the Yjs `Doc`. Defaults to `'root-v2'`. */
  rootName?: string;
  /**
   * Resolve the root `XmlElement` from the `Doc` yourself, for roots that are
   * not a top-level shared type (e.g. an `XmlElement` held in a `Y.Map` or
   * `Y.Array`, as when one `Doc` stores many independently editable
   * documents). The V2 equivalent of
   * {@link CreateYjsBindingOptions.getXmlText}, with the same before-any-sync
   * timing and the same idempotency requirement.
   *
   * The returned type is checked to be an `XmlElement` integrated into `doc`
   * (reachable from a top-level shared type) that was created as
   * `new XmlElement()` without a `nodeName` — the root is identified by its
   * default `'UNDEFINED'` node name, which is also what
   * `doc.get(rootName, XmlElement)` produces — and fails with an invariant
   * rather than corrupting the document. As in V1, that it is not in use by
   * another live binding cannot be checked and is the caller's to guarantee.
   * When given, it takes precedence over
   * {@link CreateBindingV2Options__EXPERIMENTAL.rootName}.
   */
  getXmlElement?: (doc: Doc) => XmlElement;
}

export function createBindingV2__EXPERIMENTAL(
  editor: LexicalEditor,
  id: string,
  doc: Doc | null | undefined,
  docMap: Map<string, Doc>,
  options: CreateBindingV2Options__EXPERIMENTAL = {},
): BindingV2 {
  invariant(
    doc !== undefined && doc !== null,
    'createBinding: doc is null or undefined',
  );
  const {excludedProperties, rootName = 'root-v2', getXmlElement} = options;
  const root = getXmlElement
    ? getXmlElement(doc)
    : (doc.get(rootName, XmlElement) as XmlElement);
  invariant(
    root instanceof XmlElement && root.doc === doc,
    'createBindingV2: getXmlElement must return an XmlElement that is already integrated into the given doc',
  );
  invariant(
    root.nodeName === ROOT_NODE_NAME,
    'createBindingV2: the root XmlElement must be created without a nodeName (its nodeName is %s, expected %s)',
    root.nodeName,
    ROOT_NODE_NAME,
  );
  return {
    ...createBaseBinding(editor, id, doc, docMap, excludedProperties),
    mapping: new CollabV2Mapping(),
    root,
  };
}

export function isBindingV1(binding: BaseBinding): binding is Binding {
  return Object.prototype.hasOwnProperty.call(binding, 'collabNodeMap');
}

export function isBindingV2(binding: BaseBinding): binding is BindingV2 {
  return Object.prototype.hasOwnProperty.call(binding, 'mapping');
}
