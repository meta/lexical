/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {DOMRenderConfig, DOMRenderExtensionOutput} from './types';

import {
  $getDocument,
  defineExtension,
  type InitialEditorConfig,
  RootNode,
  shallowMergeConfig,
} from 'lexical';

import {compileDOMRenderConfigOverrides} from './compileDOMRenderConfigOverrides';
import {DOMRenderExtensionName} from './constants';
import {
  createEditorContextRecord,
  DOMRenderRuntimeImpl,
  filterEditorInstalled,
} from './DOMRenderRuntime';

/** @internal The result returned from {@link DOMRenderExtension}'s `init`. */
interface DOMRenderInitResult {
  /**
   * The `nodes` and base `dom` captured from the editor config before `dom`
   * is overwritten with the compiled config — the only fields the runtime
   * needs to recompile.
   */
  initialEditorConfig: Pick<InitialEditorConfig, 'nodes' | 'dom'>;
}

/**
 * @experimental
 *
 * An extension that allows overriding the render and export behavior for an
 * editor. This is highly experimental and subject to change from one version
 * to the next.
 **/
export const DOMRenderExtension = defineExtension<
  DOMRenderConfig,
  typeof DOMRenderExtensionName,
  DOMRenderExtensionOutput,
  DOMRenderInitResult
>({
  build(editor, config, state) {
    const {initialEditorConfig} = state.getInitResult();
    const editorContext = createEditorContextRecord(config.contextDefaults);
    const runtime = new DOMRenderRuntimeImpl(
      editor,
      initialEditorConfig,
      config.overrides,
      editorContext,
    );
    return {defaults: editorContext, runtime};
  },
  config: {
    contextDefaults: [],
    overrides: [],
  },
  html: {
    // Define a RootNode export for $generateDOMFromRoot
    export: new Map([
      [
        RootNode,
        () => {
          const element = $getDocument().createElement('div');
          element.role = 'textbox';
          return {element};
        },
      ],
    ]),
  },
  init(editorConfig, config) {
    // Capture the user's base `dom` (before we overwrite it) and `nodes` so the
    // runtime can recompile from scratch when overrides toggle.
    const initialEditorConfig: DOMRenderInitResult['initialEditorConfig'] = {
      dom: editorConfig.dom,
      nodes: editorConfig.nodes,
    };
    const editorContext = createEditorContextRecord(config.contextDefaults);
    const installed = filterEditorInstalled(config.overrides, editorContext);
    editorConfig.dom = compileDOMRenderConfigOverrides(editorConfig, {
      overrides: installed,
    });
    return {initialEditorConfig};
  },
  mergeConfig(config, partial) {
    const merged = shallowMergeConfig(config, partial);
    for (const k of ['overrides', 'contextDefaults'] as const) {
      if (partial[k]) {
        (merged[k] as unknown[]) = [...config[k], ...partial[k]];
      }
    }
    return merged;
  },
  name: DOMRenderExtensionName,
});
