/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  type JSX,
  type ReactNode,
  type RefCallback,
  useCallback,
  useState,
} from 'react';
import {createPortal} from 'react-dom';

/**
 * Renders its children inside an open DOM ShadowRoot using a React portal.
 *
 * The host `<div>` is created in the light DOM; a shadow root is attached to it
 * with the platform `Element.attachShadow` API, and the children (including the
 * Lexical contentEditable) are portaled into that shadow tree. React context
 * still flows across the portal, so the editor is built exactly as it would be
 * in the light DOM — only its DOM lives behind a shadow boundary.
 *
 * Because shadow trees encapsulate styles, an optional `styleSheet` string is
 * injected as a `<style>` element inside the shadow root so the editor's CSS
 * travels with it.
 */
export default function ShadowRoot({
  children,
  styleSheet,
}: {
  children: ReactNode;
  styleSheet?: string;
}): JSX.Element {
  const [shadowRoot, setShadowRoot] = useState<ShadowRoot | null>(null);
  const hostRef = useCallback<RefCallback<HTMLElement>>(
    host =>
      setShadowRoot(
        host ? (host.shadowRoot ?? host.attachShadow({mode: 'open'})) : null,
      ),
    [],
  );

  return (
    <div ref={hostRef} className="shadow-host">
      {shadowRoot !== null
        ? createPortal(
            <>
              {styleSheet !== undefined ? <style>{styleSheet}</style> : null}
              {children}
            </>,
            shadowRoot,
          )
        : null}
    </div>
  );
}
