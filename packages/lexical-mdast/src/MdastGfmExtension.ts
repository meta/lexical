/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {defineExtension} from 'lexical';

import {
  MdastAutolinkLiteralExtension,
  MdastStrikethroughExtension,
  MdastTaskListExtension,
} from './MdastImportExtension';
import {MdastTableExtension} from './MdastTableExtension';

/**
 * Convenience bundle of every GFM extension — strikethrough, task lists,
 * literal autolinks, and tables — mirroring the scope of
 * `micromark-extension-gfm`. Combine with `MdastCommonMarkExtension` for
 * GitHub-flavored Markdown:
 * ```ts
 * dependencies: [MdastCommonMarkExtension, MdastGfmExtension]
 * ```
 * Each member is also usable individually when you only want some of GFM
 * (e.g. task lists without tables).
 * @experimental
 */
export const MdastGfmExtension = defineExtension({
  dependencies: [
    MdastStrikethroughExtension,
    MdastTaskListExtension,
    MdastAutolinkLiteralExtension,
    MdastTableExtension,
  ],
  name: '@lexical/mdast/Gfm',
});
