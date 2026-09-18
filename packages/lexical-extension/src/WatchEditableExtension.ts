/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {defineExtension} from 'lexical';

import {watchedSignal} from './watchedSignal';

/**
 * Exposes the editor's editable state as a reactive `Signal<boolean>` that
 * mirrors `editor.isEditable()` via an editable listener.
 *
 * Depend on this extension and read its output `Signal` from a signals
 * `effect`/`computed` to react to editability changes without subscribing
 * through React (or any other framework).
 */
export const WatchEditableExtension = defineExtension({
  build(editor) {
    return watchedSignal(
      () => editor.isEditable(),
      signal =>
        editor.registerEditableListener(editable => {
          signal.value = editable;
        }),
    );
  },
  name: '@lexical/extension/WatchEditable',
});
