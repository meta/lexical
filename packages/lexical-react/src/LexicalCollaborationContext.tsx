/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  CollaborationContext,
  newContext,
} from '@lexical/react/LexicalCollaborationContextUtils';
import {useMemo} from 'react';

export {
  CollaborationContext,
  type CollaborationContextType,
  useCollaborationContext,
} from '@lexical/react/LexicalCollaborationContextUtils';

/**
 * A provider component that creates a fresh {@link CollaborationContextType}
 * and makes it available to descendant editors via {@link CollaborationContext}.
 * Wrap a group of editors that should share collaboration state in this
 * component.
 *
 * @returns A context provider wrapping `children`.
 */
export function LexicalCollaboration({children}: {children: React.ReactNode}) {
  const collabContext = useMemo(() => newContext(), []);

  return (
    <CollaborationContext.Provider value={collabContext}>
      {children}
    </CollaborationContext.Provider>
  );
}
