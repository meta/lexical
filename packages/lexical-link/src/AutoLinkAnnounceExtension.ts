/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {AriaLiveRegionExtension} from '@lexical/a11y';
import {effect, namedSignals} from '@lexical/extension';
import {defineExtension, safeCast} from 'lexical';

import {AutoLinkNode} from './LexicalLinkNode';

export interface AutoLinkAnnounceExtensionConfig {
  /** Announced when typing turns text into a link. */
  created: string;
  /**
   * Announced when several links appear at once, as pasting a block of text
   * can. `%s` is replaced with how many.
   */
  createdMany: string;
  /** Announced when an automatic link stops being a link. */
  destroyed: string;
  /**
   * Announced when several links go at once, as deleting a selection that
   * spans them does. `%s` is replaced with how many.
   */
  destroyedMany: string;
  /**
   * When `true`, automatic links are not announced. Toggle at runtime via the
   * output signal. Default `false`.
   */
  disabled: boolean;
}

/**
 * Announces automatic links through the {@link AriaLiveRegionExtension} sink.
 *
 * Typing a web address turns it into a link on its own, partway through typing
 * it, with no keystroke to confirm and nothing inserted. A screen reader says
 * nothing, so the user has no way to know a link now exists.
 *
 * A creation paired with a destruction in the same update is not announced.
 * Every keystroke that extends an address rebuilds the link — the old node
 * destroyed and a new one created at once — so announcing every creation would
 * say "Link" at `www.example.c`, again at `o`, and again at `m`. Only a
 * creation on its own is a link that was not there a moment ago.
 */
export const AutoLinkAnnounceExtension = defineExtension({
  build: (_editor, config) => namedSignals(config),
  config: safeCast<AutoLinkAnnounceExtensionConfig>({
    created: 'Link',
    createdMany: '%s links',
    destroyed: 'Link removed',
    destroyedMany: '%s links removed',
    disabled: false,
  }),
  dependencies: [AriaLiveRegionExtension],
  name: '@lexical/link/AutoLinkAnnounce',
  register(editor, _config, state) {
    const {created, createdMany, destroyed, destroyedMany, disabled} =
      state.getOutput();
    const {announce} = state.getDependency(AriaLiveRegionExtension).output;

    // Gate on `disabled` from an effect so a disabled announcer registers no
    // listener at all. Peek the message signals at announce time so editing
    // them does not re-register.
    return effect(() =>
      disabled.value
        ? undefined
        : editor.registerMutationListener(
            AutoLinkNode,
            nodes => {
              let createdCount = 0;
              let destroyedCount = 0;
              for (const [, mutation] of nodes) {
                if (mutation === 'created') {
                  createdCount++;
                } else if (mutation === 'destroyed') {
                  destroyedCount++;
                }
              }
              // Deleting a selection takes every link in it at once, so say
              // how many rather than reporting a dozen as one.
              if (createdCount > 0 && destroyedCount === 0) {
                announce(
                  createdCount === 1
                    ? created.peek()
                    : createdMany.peek().replace('%s', String(createdCount)),
                );
              } else if (destroyedCount > 0 && createdCount === 0) {
                announce(
                  destroyedCount === 1
                    ? destroyed.peek()
                    : destroyedMany
                        .peek()
                        .replace('%s', String(destroyedCount)),
                );
              }
            },
            {skipInitialization: true},
          ),
    );
  },
});
