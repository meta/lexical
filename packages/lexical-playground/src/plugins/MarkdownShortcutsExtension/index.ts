/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {effect, namedSignals} from '@lexical/extension';
import {registerMarkdownShortcuts} from '@lexical/markdown';
import {defineExtension, safeCast} from 'lexical';

import {PLAYGROUND_TRANSFORMERS} from '../MarkdownTransformers';

export interface PlaygroundMarkdownShortcutsConfig {
  /**
   * When true, the extension registers no markdown shortcuts, so
   * typing markdown (for example `## ` or `- `) leaves the text as
   * typed. Defaults to `false`.
   */
  disabled: boolean;
}

// This is not a published extension because markdown transformers
// should get a refactor to require less manual configuration
export const PlaygroundMarkdownShortcutsExtension = defineExtension({
  build: (_editor, config) => namedSignals(config),
  config: safeCast<PlaygroundMarkdownShortcutsConfig>({
    disabled: false,
  }),
  name: '@lexical/playground/MarkdownShortcuts',
  register(editor, _config, state) {
    const {disabled} = state.getOutput();
    // Gate on `disabled` from an effect so a disabled markdown
    // extension registers no shortcuts at all.
    return effect(() =>
      disabled.value
        ? undefined
        : registerMarkdownShortcuts(editor, PLAYGROUND_TRANSFORMERS),
    );
  },
});
