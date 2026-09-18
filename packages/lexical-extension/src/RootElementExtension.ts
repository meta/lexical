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
 * Exposes the editor's current root element as a reactive
 * `Signal<HTMLElement | null>` that mirrors `editor.getRootElement()` via a
 * root listener.
 *
 * Depend on this extension and read its output `Signal` from a signals
 * `effect`/`computed` to react to the root mounting, unmounting, or remounting
 * (e.g. into a different document such as an iframe) without subscribing
 * through React (or any other framework).
 */
export const RootElementExtension = defineExtension({
  build(editor) {
    return watchedSignal(
      () => editor.getRootElement(),
      rootElementSignal =>
        editor.registerRootListener(rootElement => {
          rootElementSignal.value = rootElement;
        }),
    );
  },
  name: '@lexical/extension/RootElement',
});
