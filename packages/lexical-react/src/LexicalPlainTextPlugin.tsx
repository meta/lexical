/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {ErrorBoundaryType} from './shared/types';
import type {JSX} from 'react';

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useLexicalEditable} from '@lexical/react/useLexicalEditable';

import {LegacyDecorators} from './shared/LegacyDecorators';
import {useCanShowPlaceholder} from './shared/useCanShowPlaceholder';
import {usePlainTextSetup} from './shared/usePlainTextSetup';

/**
 * Sets up plain text editing by wiring up the core plain text commands and
 * rendering the provided `contentEditable`, an optional `placeholder`, and any
 * decorator nodes (wrapped in the given `ErrorBoundary`). Use this instead of
 * {@link RichTextPlugin} when the editor should not support block-level rich
 * text formatting.
 *
 * This is a legacy plugin. When building an editor with the extension API,
 * configure {@link PlainTextExtension} instead.
 *
 * @returns The element tree to render inside your LexicalComposer.
 */
export function PlainTextPlugin({
  contentEditable,
  // TODO Remove. This property is now part of ContentEditable
  placeholder = null,
  ErrorBoundary,
}: {
  contentEditable: JSX.Element;
  placeholder?:
    | ((isEditable: boolean) => null | JSX.Element)
    | null
    | JSX.Element;
  ErrorBoundary: ErrorBoundaryType;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  usePlainTextSetup(editor);

  return (
    <>
      {contentEditable}
      <Placeholder content={placeholder} />
      <LegacyDecorators editor={editor} ErrorBoundary={ErrorBoundary} />
    </>
  );
}

// TODO Remove
function Placeholder({
  content,
}: {
  content: ((isEditable: boolean) => null | JSX.Element) | null | JSX.Element;
}): null | JSX.Element {
  const [editor] = useLexicalComposerContext();
  const showPlaceholder = useCanShowPlaceholder(editor);
  const editable = useLexicalEditable();

  if (!showPlaceholder) {
    return null;
  }

  if (typeof content === 'function') {
    return content(editable);
  } else {
    return content;
  }
}
