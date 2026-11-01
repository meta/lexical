/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {EditorThemeClasses, LexicalEditor} from 'lexical';

import invariant from '@lexical/internal/invariant';
import {createContext as createReactContext, useContext} from 'react';

/**
 * The context value provided alongside a {@link LexicalEditor} by a
 * {@link LexicalComposer}. It exposes a `getTheme()` function that resolves the
 * active {@link EditorThemeClasses}, falling back to any parent composer's
 * theme.
 */
export type LexicalComposerContextType = {
  getTheme: () => EditorThemeClasses | null | undefined;
};

/**
 * A tuple of the {@link LexicalEditor} and its
 * {@link LexicalComposerContextType}, as stored in {@link LexicalComposerContext}
 * and returned by {@link useLexicalComposerContext}.
 */
export type LexicalComposerContextWithEditor = [
  LexicalEditor,
  LexicalComposerContextType,
];

/**
 * The React context used to share the {@link LexicalEditor} and its
 * {@link LexicalComposerContextType} with descendant plugins and components.
 * Most code should read it through {@link useLexicalComposerContext} rather than
 * consuming the context directly.
 */
export const LexicalComposerContext: React.Context<
  LexicalComposerContextWithEditor | null | undefined
> =
  // Annotated by hand: React's createContext is not a Lexical factory, so the
  // build does not annotate it, and an unannotated module-scope call pins the
  // module into every bundle.
  /* @__PURE__ */ createReactContext<
    LexicalComposerContextWithEditor | null | undefined
  >(null);

/**
 * Creates a {@link LexicalComposerContextType} for a composer. Theme resolution
 * falls back to the optional `parent` context, so nested composers inherit the
 * parent's theme unless they provide their own.
 *
 * @param parent - The parent composer context to inherit from, if any.
 * @param theme - The theme classes for this composer, or `null`/`undefined` to
 * inherit from `parent`.
 * @returns The new composer context value.
 */
export function createLexicalComposerContext(
  parent: LexicalComposerContextWithEditor | null | undefined,
  theme: EditorThemeClasses | null | undefined,
): LexicalComposerContextType {
  let parentContext: LexicalComposerContextType | null = null;

  if (parent != null) {
    parentContext = parent[1];
  }

  function getTheme() {
    if (theme != null) {
      return theme;
    }

    return parentContext != null ? parentContext.getTheme() : null;
  }

  return {
    getTheme,
  };
}

/**
 * Returns the {@link LexicalEditor} and its {@link LexicalComposerContextType}
 * from the nearest {@link LexicalComposer} (or nested composer). This is the
 * primary way plugins and components access the editor instance.
 *
 * @returns The `[editor, context]` tuple for the current composer.
 * @throws If called outside of a LexicalComposer.
 */
export function useLexicalComposerContext(): LexicalComposerContextWithEditor {
  const composerContext = useContext(LexicalComposerContext);

  if (composerContext == null) {
    invariant(
      false,
      'LexicalComposerContext.useLexicalComposerContext: cannot find a LexicalComposerContext',
    );
  }

  return composerContext;
}
