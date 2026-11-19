/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {BaseSelection, ElementNode} from 'lexical';
import type {Root} from 'mdast';

import {$getExtensionOutput} from '@lexical/extension';

import {MdastExtension} from './MdastExtension';

/**
 * Shorthand for
 * `$getExtensionOutput(MdastExtension).$convertToMarkdownString`.
 * Must be called inside an `editor.read()` or `editor.update()`. Throws if
 * the editor was not built with {@link MdastExtension}.
 * @experimental
 */
export function $convertToMarkdownString(node?: ElementNode): string {
  return $getExtensionOutput(MdastExtension).$convertToMarkdownString(node);
}

/**
 * Shorthand for `$getExtensionOutput(MdastExtension).$convertToMdast`.
 * Must be called inside an `editor.read()` or `editor.update()`. Throws if
 * the editor was not built with {@link MdastExtension}.
 * @experimental
 */
export function $convertToMdast(node?: ElementNode): Root {
  return $getExtensionOutput(MdastExtension).$convertToMdast(node);
}

/**
 * Shorthand for
 * `$getExtensionOutput(MdastExtension).$convertSelectionToMarkdownString`.
 * Serializes only the selected content (defaulting to the current selection)
 * to a Markdown string; returns `''` for a null or collapsed selection.
 * Must be called inside an `editor.read()` or `editor.update()`. Throws if
 * the editor was not built with {@link MdastExtension}.
 * @experimental
 */
export function $convertSelectionToMarkdownString(
  selection?: BaseSelection | null,
): string {
  return $getExtensionOutput(MdastExtension).$convertSelectionToMarkdownString(
    selection,
  );
}
