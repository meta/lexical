/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Doc} from 'yjs';

import devInvariant from '@lexical/internal/devInvariant';
import {createContext, useContext} from 'react';

/**
 * The value stored in the {@link CollaborationContext}: the local user's
 * display `name` and cursor `color`, whether collaboration is currently active,
 * and the map of Yjs documents shared by the editors under this provider.
 */
export type CollaborationContextType = {
  color: string;
  isCollabActive: boolean;
  name: string;
  yjsDocMap: Map<string, Doc>;
};

const entries = [
  ['Cat', 'rgb(125, 50, 0)'],
  ['Dog', 'rgb(100, 0, 0)'],
  ['Rabbit', 'rgb(150, 0, 0)'],
  ['Frog', 'rgb(200, 0, 0)'],
  ['Fox', 'rgb(200, 75, 0)'],
  ['Hedgehog', 'rgb(0, 75, 0)'],
  ['Pigeon', 'rgb(0, 125, 0)'],
  ['Squirrel', 'rgb(75, 100, 0)'],
  ['Bear', 'rgb(125, 100, 0)'],
  ['Tiger', 'rgb(0, 0, 150)'],
  ['Leopard', 'rgb(0, 0, 200)'],
  ['Zebra', 'rgb(0, 0, 250)'],
  ['Wolf', 'rgb(0, 100, 150)'],
  ['Owl', 'rgb(0, 100, 100)'],
  ['Gull', 'rgb(100, 0, 100)'],
  ['Squid', 'rgb(150, 0, 150)'],
];

const randomEntry = entries[Math.floor(Math.random() * entries.length)];

/**
 * The React context that holds the shared {@link CollaborationContextType} for
 * collaborative editors. Provide it with {@link LexicalCollaboration} and read
 * it with {@link useCollaborationContext}.
 */
export const CollaborationContext =
  createContext<CollaborationContextType | null>(null);

/** @internal */
export function newContext(): CollaborationContextType {
  return {
    color: randomEntry[1],
    isCollabActive: false,
    name: randomEntry[0],
    yjsDocMap: new Map(),
  };
}

// This is here to help the transition post-#7818, however should be removed in a future release as
// a shared context across editors is likely to lead to bugs.
const UNSAFE_GLOBAL_CONTEXT = newContext();

/**
 * Reads the current {@link CollaborationContextType} from the nearest
 * {@link LexicalCollaboration} provider. Optionally pass `username` and `color`
 * to set the local user's display name and cursor color.
 *
 * @returns The active collaboration context.
 */
export function useCollaborationContext(
  username?: string,
  color?: string,
): CollaborationContextType {
  let collabContext = useContext(CollaborationContext);
  devInvariant(
    collabContext != null,
    'useCollaborationContext: no context provider found',
  );

  collabContext = collabContext ?? UNSAFE_GLOBAL_CONTEXT;

  if (username != null) {
    // eslint-disable-next-line react-hooks/immutability
    collabContext.name = username;
  }

  if (color != null) {
    // eslint-disable-next-line react-hooks/immutability
    collabContext.color = color;
  }

  return collabContext;
}
