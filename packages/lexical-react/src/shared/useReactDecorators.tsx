/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {ErrorBoundaryType} from './types';
import type {LexicalEditor} from 'lexical';

import {type JSX, Suspense, useMemo, useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';

import {useRootElement} from './useRootElement';

/** @internal */
export function useReactDecorators(
  editor: LexicalEditor,
  ErrorBoundary: ErrorBoundaryType,
): JSX.Element[] {
  const [subscribe, getSnapshot] = useMemo(
    () =>
      [
        (cb: () => void) => editor.registerDecoratorListener(cb),
        () => editor.getDecorators<JSX.Element>(),
      ] as const,
    [editor],
  );
  const decorators = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const rootElement = useRootElement(editor);

  // Return decorators defined as React Portals
  return useMemo(() => {
    // Declare a dependency on rootElement for the lint
    void rootElement;
    const onError = (e: Error) => editor._onError(e);
    const decoratedPortals = [];
    for (const nodeKey in decorators) {
      const element = editor.getElementByKey(nodeKey);

      if (element !== null) {
        const reactDecorator = (
          <ErrorBoundary onError={onError}>
            <Suspense fallback={null}>{decorators[nodeKey]}</Suspense>
          </ErrorBoundary>
        );
        decoratedPortals.push(createPortal(reactDecorator, element, nodeKey));
      }
    }

    return decoratedPortals;
  }, [ErrorBoundary, decorators, editor, rootElement]);
}
