/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {ClientIDRange} from '../../internal/ClientID';
import type {YDoc} from '../../internal/YDoc';
import type {Node as YNode} from '@y/y';
import type {LexicalEditor} from 'lexical';

import {YBinding} from '../../internal/Binding';

/**
 * A test helper, the one-off writer: write an editor's current document
 * into the empty layout root of `doc`, without a live binding (also next to
 * an older layout's root, for converters). Throws when the layout root is
 * not empty; warnings go to the editor's `onWarn`.
 */
export function writeEditorToYDoc(
  editor: LexicalEditor,
  doc: YDoc,
  options: {root?: YNode; clientIDRange?: ClientIDRange} = {},
): void {
  const binding = new YBinding(editor, doc, {
    captureTimeout: null,
    clientIDRange: options.clientIDRange,
    convert: true,
    root: options.root,
    schemaVersion: 1,
  });
  const stop = binding.start();
  try {
    if (binding.status !== 'pending') {
      throw new Error('@lexical/y: the shared root is not empty');
    }
    binding.initialize();
  } finally {
    stop();
  }
}
