/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {registerMarkdownShortcuts} from '@lexical/markdown';
import {defineExtension} from 'lexical';

import {PLAYGROUND_TRANSFORMERS} from '../MarkdownTransformers';

// This is not a published extension because markdown transformers
// should get a refactor to require less manual configuration
export const PlaygroundMarkdownShortcutsExtension = defineExtension({
  name: '@lexical/playground/MarkdownShortcuts',
  register: editor =>
    registerMarkdownShortcuts(editor, PLAYGROUND_TRANSFORMERS),
});
