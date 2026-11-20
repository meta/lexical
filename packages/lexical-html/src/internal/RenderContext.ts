/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {DOMRenderExtension} from './DOMRenderExtension';
import type {
  AnyRenderStateConfigPairOrUpdater,
  ContextRecord,
  RenderStateConfig,
} from './types';

import {getPeerDependencyFromEditor} from '@lexical/extension';
import {
  $getEditor,
  $getEditorDOMRenderConfig,
  type EditorDOMRenderConfig,
  type LexicalEditor,
} from 'lexical';

import {DOMRenderContextSymbol, DOMRenderExtensionName} from './constants';
import {
  $withContext,
  createContextState,
  getContextRecord,
  getContextValue,
} from './ContextRecord';

/**
 * Create a context state to be used during render.
 *
 * Note that to support the ValueOrUpdater pattern you can not use a
 * function for V (but you may wrap it in an array or object).
 *
 * @experimental
 * @__NO_SIDE_EFFECTS__
 */
export function createRenderState<V>(
  name: string,
  getDefaultValue: () => V,
  isEqual?: (a: V, b: V) => boolean,
): RenderStateConfig<V> {
  return createContextState(
    DOMRenderContextSymbol,
    name,
    getDefaultValue,
    isEqual,
  );
}

/**
 * Render context state that is true if the export was initiated from the root of the document.
 * @experimental
 */
export const RenderContextRoot = createRenderState('root', Boolean);

/**
 * Render context state that is true if this is an export operation ($generateHtmlFromNodes).
 * @experimental
 */
export const RenderContextExport = createRenderState('isExport', Boolean);

function getDefaultRenderContext(
  editor: LexicalEditor,
): undefined | ContextRecord<typeof DOMRenderContextSymbol> {
  const dep = getPeerDependencyFromEditor<typeof DOMRenderExtension>(
    editor,
    DOMRenderExtensionName,
  );
  return dep ? dep.output.defaults : undefined;
}

function getRenderContext(
  editor: LexicalEditor,
): undefined | ContextRecord<typeof DOMRenderContextSymbol> {
  return (
    getContextRecord(DOMRenderContextSymbol, editor) ||
    getDefaultRenderContext(editor)
  );
}

/**
 * Get a render context value during a DOM render or export operation.
 * @experimental
 */
export function $getRenderContextValue<V>(
  cfg: RenderStateConfig<V>,
  editor: LexicalEditor = $getEditor(),
): V {
  return getContextValue(getRenderContext(editor), cfg);
}

function getRuntime(editor: LexicalEditor) {
  const dep = getPeerDependencyFromEditor<typeof DOMRenderExtension>(
    editor,
    DOMRenderExtensionName,
  );
  return dep ? dep.output.runtime : undefined;
}

/**
 * Imperatively set a value in the persistent editor render context.
 *
 * Unlike {@link $withRenderContext} (which scopes values to a callback), this
 * persists on the editor. If the change flips any override's
 * `disabledForEditor` result, the resident render config is recompiled and the
 * affected nodes are re-rendered. No-op if {@link DOMRenderExtension} is not
 * installed.
 *
 * @experimental
 */
export function $setRenderContextValue<V>(
  cfg: RenderStateConfig<V>,
  value: V,
  editor: LexicalEditor = $getEditor(),
): void {
  const runtime = getRuntime(editor);
  if (runtime) {
    runtime.setContextValue(cfg, value);
  }
}

/**
 * Imperatively update a value in the persistent editor render context with an
 * updater function. See {@link $setRenderContextValue}.
 *
 * @experimental
 */
export function $updateRenderContextValue<V>(
  cfg: RenderStateConfig<V>,
  updater: (prev: V) => V,
  editor: LexicalEditor = $getEditor(),
): void {
  const runtime = getRuntime(editor);
  if (runtime) {
    runtime.setContextValue(
      cfg,
      updater(getContextValue(runtime.editorContext, cfg)),
    );
  }
}

/**
 * Resolve the {@link EditorDOMRenderConfig} to use for the current
 * export/generate session, applying any `disabledForSession` overrides against
 * the active session context. Falls back to the editor's resident config when
 * {@link DOMRenderExtension} is not installed.
 *
 * @experimental
 */
export function $getSessionDOMRenderConfig(
  editor: LexicalEditor = $getEditor(),
): EditorDOMRenderConfig {
  const runtime = getRuntime(editor);
  return runtime
    ? runtime.getSessionConfig()
    : $getEditorDOMRenderConfig(editor);
}

/**
 * Execute a callback within a render context with the given config pairs.
 * @experimental
 */
export const $withRenderContext: (
  cfg: readonly AnyRenderStateConfigPairOrUpdater[],
  editor?: LexicalEditor,
) => <T>(f: () => T) => T = $withContext(
  DOMRenderContextSymbol,
  getDefaultRenderContext,
);
