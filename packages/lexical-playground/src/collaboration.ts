/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Provider} from '@lexical/yjs';

import {WebsocketProvider} from 'y-websocket';
import {Doc} from 'yjs';

const url = new URL(window.location.href);
const params = new URLSearchParams(url.search);
const WEBSOCKET_ENDPOINT =
  params.get('collabEndpoint') || 'ws://localhost:1234';
const WEBSOCKET_SLUG = 'playground';
const WEBSOCKET_ID = params.get('collabId') || '0';

/**
 * True in the `right` frame of the `/split/` two-client view, which exists to
 * simulate a second user joining a document the `left` frame already created.
 *
 * `CollaborationPlugin`'s client-side `shouldBootstrap` seeds an empty Yjs
 * document with a single empty paragraph once the provider reports `sync`. That
 * write is an ordinary Yjs insert, not a compare-and-set, so two clients that
 * both find the document empty each insert a paragraph and Yjs keeps both. Only
 * one client may bootstrap a given document.
 *
 * For the main document only the `left` frame creates content, but a nested
 * editor's document (an image caption, a sticky note) is reached by both
 * clients the moment the node itself syncs -- `syncPropertiesToYjs` gives the
 * nested editor a sub-`Doc` and uses that doc's `guid` as the editor key, so
 * both frames resolve the same collab room at the same time. Nested editors
 * therefore have to make the same choice the main document does.
 */
export const skipCollaborationInit =
  // @ts-expect-error -- `frames.right` is the named `/split/` iframe
  window.parent != null && window.parent.frames.right === window;

// parent dom -> child doc
export function createWebsocketProvider(
  id: string,
  yjsDocMap: Map<string, Doc>,
): Provider {
  let doc = yjsDocMap.get(id);

  if (doc === undefined) {
    doc = new Doc();
    yjsDocMap.set(id, doc);
  } else {
    doc.load();
  }

  return createWebsocketProviderWithDoc(id, doc);
}

export function createWebsocketProviderWithDoc(id: string, doc: Doc): Provider {
  // @ts-expect-error
  return new WebsocketProvider(
    WEBSOCKET_ENDPOINT,
    WEBSOCKET_SLUG + '/' + WEBSOCKET_ID + '/' + id,
    doc,
    {
      connect: false,
    },
  );
}
