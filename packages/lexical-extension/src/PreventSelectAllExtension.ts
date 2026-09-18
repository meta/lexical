/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  CONTROL_OR_META,
  defineExtension,
  isExactShortcutMatch,
  isHTMLElement,
  registerEventListener,
  safeCast,
  stopLexicalPropagation,
} from 'lexical';

import {namedSignals} from './namedSignals';
import {effect} from './signals';

function captureKeydown(e: KeyboardEvent) {
  const target = e.target;
  if (
    isExactShortcutMatch(e, 'a', CONTROL_OR_META) &&
    isHTMLElement(target) &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
  ) {
    // prevents the event bubbling before it reaches the lexical scope
    target.addEventListener('keydown', stopLexicalPropagation, {once: true});
  }
}

export interface PreventSelectAllConfig {
  disabled: boolean;
}

/**
 * By default, lexical intercepts most events and dispatches the appropriate commands.
 * This extension prevents the keydown event propagating from input/textarea elements,
 * which are typically part of a decorator node, in order to stop dispatching the SELECT_ALL_COMMAND.
 *
 * When used as a dependency of SelectBlockExtension, its disabled state is
 * kept in sync with that extension.
 */
export const PreventSelectAllExtension = defineExtension({
  build: (editor, config, state) => namedSignals(config),
  config: safeCast<PreventSelectAllConfig>({
    disabled: false,
  }),
  name: '@lexical/extension/PreventSelectAll',
  register: (editor, config, state) => {
    const stores = state.getOutput();
    return effect(() => {
      if (!stores.disabled.value) {
        return editor.registerRootListener(rootElement => {
          if (rootElement) {
            return registerEventListener(
              rootElement,
              'keydown',
              captureKeydown,
              true,
            );
          }
        });
      }
    });
  },
});
