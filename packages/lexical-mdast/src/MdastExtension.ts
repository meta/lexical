/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {defineExtension} from 'lexical';

import {MdastExportExtension} from './MdastExportExtension';
import {MdastImportExtension} from './MdastImportExtension';

/**
 * Convenience bundle of {@link MdastImportExtension} and
 * {@link MdastExportExtension}: Markdown parsing *and* serialization.
 *
 * Depend on this when you want both directions without thinking about it:
 * ```ts
 * dependencies: [MdastCommonMarkExtension, MdastExtension]
 * ```
 * Editors that never serialize back to Markdown can skip it (feature
 * extensions already pull in {@link MdastImportExtension}) and avoid
 * bundling the serializer (`mdast-util-to-markdown`).
 * @experimental
 */
export const MdastExtension = defineExtension({
  dependencies: [MdastImportExtension, MdastExportExtension],
  name: '@lexical/mdast/Mdast',
});
