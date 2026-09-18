/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {CodeExtension} from '@lexical/code-core';
import {LinkExtension} from '@lexical/link';
import {ListExtension} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {defineExtension} from 'lexical';

/**
 * The nodes the default `TRANSFORMERS` need, as extensions, so that tests
 * build their editor the same way an application does.
 *
 * Deliberately nodes only: a test that needs the shortcut listener registers
 * it from an extension of its own, so that anything whose transforms have to
 * run ahead of it (a text entity, an autolinker) can be a dependency of that
 * extension. Extensions are registered in topological order, so a dependency
 * edge is what orders them; position in the array passed to
 * `buildEditorFromExtensions` is not an ordering at all. Registering the
 * listener here would leave a test no edge to declare.
 */
export const MarkdownTestExtension = defineExtension({
  dependencies: [
    RichTextExtension,
    ListExtension,
    LinkExtension,
    CodeExtension,
  ],
  name: '@lexical/markdown/test',
});
