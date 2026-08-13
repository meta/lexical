/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {ErrorBoundaryType} from './types';
import type {LexicalEditor} from 'lexical';
import type {JSX} from 'react';

import {LexicalBuilder} from '@lexical/extension';
import invariant from '@lexical/internal/invariant';
import {ReactProviderExtension} from '@lexical/react/ReactProviderExtension';

import {useReactDecorators} from './useReactDecorators';

function isUsingReactExtension(editor: LexicalEditor): boolean {
  const builder = LexicalBuilder.maybeFromEditor(editor);
  if (builder && builder.hasExtensionByName(ReactProviderExtension.name)) {
    for (const name of ['@lexical/plain-text', '@lexical/rich-text']) {
      invariant(
        !builder.hasExtensionByName(name),
        'LexicalBuilder: @lexical/react legacy text plugins conflict with the %s extension. Remove the legacy <RichTextPlugin/> or <PlainTextPlugin/> component.',
        name,
      );
    }
    return true;
  }
  return false;
}

function Decorators({
  editor,
  ErrorBoundary,
}: {
  editor: LexicalEditor;
  ErrorBoundary: ErrorBoundaryType;
}) {
  return useReactDecorators(editor, ErrorBoundary);
}

/**
 * @internal
 *
 * When using @lexical/extension, the ReactProvider is expected to handle
 * rendering decorators. This component allows RichTextPlugin and
 * PlainTextPlugin to be used in extension projects that have not yet
 * migrated to use RichTextExtension or PlainTextExtension.
 **/
export function LegacyDecorators({
  editor,
  ErrorBoundary,
}: {
  editor: LexicalEditor;
  ErrorBoundary: ErrorBoundaryType;
}): JSX.Element | null {
  return isUsingReactExtension(editor) ? null : (
    <Decorators editor={editor} ErrorBoundary={ErrorBoundary} />
  );
}
