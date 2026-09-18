/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {defineExtension, getActiveElement, safeCast} from 'lexical';

import {namedSignals} from './namedSignals';
import {effect} from './signals';

export type DefaultSelection = 'rootStart' | 'rootEnd';
export interface AutoFocusConfig {
  /**
   * Where to move the selection when the editor is focused and there is no
   * existing selection. Can be "rootStart" or "rootEnd" (the default).
   */
  defaultSelection: DefaultSelection;
  /**
   * The initial state of disabled
   */
  disabled: boolean;
}

/**
 * An Extension to focus the LexicalEditor when the root element is set
 * (typically only when the editor is first created).
 */
export const AutoFocusExtension = defineExtension({
  build: (editor, config, state) => {
    return namedSignals(config);
  },
  config: safeCast<AutoFocusConfig>({
    defaultSelection: 'rootEnd',
    disabled: false,
  }),
  name: '@lexical/extension/AutoFocus',
  register(editor, config, state) {
    const stores = state.getOutput();
    return effect(() =>
      stores.disabled.value
        ? undefined
        : editor.registerRootListener(rootElement => {
            editor.focus(
              () => {
                // If we try and move selection to the same point with setBaseAndExtent, it won't
                // trigger a re-focus on the element. So in the case this occurs, we'll need to correct it.
                // Normally this is fine, Selection API !== Focus API, but fore the intents of the naming
                // of this plugin, which should preserve focus too.
                // getActiveElement rather than document.activeElement, which
                // reports the shadow host when the editor is in a shadow root.
                const activeElement =
                  rootElement !== null ? getActiveElement(rootElement) : null;
                if (
                  rootElement !== null &&
                  (activeElement === null ||
                    !rootElement.contains(activeElement))
                ) {
                  // Note: preventScroll won't work in Webkit.
                  rootElement.focus({preventScroll: true});
                }
              },
              {defaultSelection: stores.defaultSelection.peek()},
            );
          }),
    );
  },
});
