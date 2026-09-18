/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {AriaLiveRegionExtension} from '@lexical/a11y';
import {effect, namedSignals} from '@lexical/extension';
import {$getNodeByKey, defineExtension, type NodeKey, safeCast} from 'lexical';

import {$isHeadingNode, HeadingNode, type HeadingTagType} from './index';

export interface HeadingAnnounceExtensionConfig {
  /**
   * Announced when a block becomes a heading. `%s` is replaced with the
   * level (1-6).
   */
  created: string;
  /**
   * Announced when a heading stops being a heading. `%s` is replaced with the
   * level it was.
   */
  destroyed: string;
  /**
   * When `true`, headings are not announced. Toggle at runtime via the output
   * signal. Default `false`.
   */
  disabled: boolean;
}

function $readHeadingTag(key: NodeKey): HeadingTagType | null {
  const node = $getNodeByKey(key);
  return $isHeadingNode(node) ? node.getTag() : null;
}

/**
 * Announces headings through the {@link AriaLiveRegionExtension} sink: a block
 * becoming a heading, and a heading ceasing to be one.
 *
 * The markdown shortcut consumes both keystrokes (`#` then space) and swaps the
 * block type, which is silent to a screen reader — so without this the user has
 * no way to know the transformation happened, or to confirm the level without
 * navigating out of the block and back in.
 *
 * Only those two transitions announce. Typing inside a heading, moving the
 * caret through it, and deleting text while the heading survives are all
 * silent; announcing on every keystroke would make a heading impossible to type
 * into.
 *
 * A destroyed node is gone from the current editor state, so its level is read
 * from the previous state `registerMutationListener` provides.
 */
export const HeadingAnnounceExtension = defineExtension({
  build: (_editor, config) => namedSignals(config),
  config: safeCast<HeadingAnnounceExtensionConfig>({
    created: 'Heading level %s',
    destroyed: 'Heading level %s removed',
    disabled: false,
  }),
  dependencies: [AriaLiveRegionExtension],
  name: '@lexical/rich-text/HeadingAnnounce',
  register(editor, _config, state) {
    const {created, destroyed, disabled} = state.getOutput();
    const {announce} = state.getDependency(AriaLiveRegionExtension).output;

    // Gate on `disabled` from an effect so a disabled announcer registers no
    // listener at all. Peek the message signals at announce time so editing
    // them does not re-register.
    return effect(() =>
      disabled.value
        ? undefined
        : editor.registerMutationListener(
            HeadingNode,
            (nodes, {prevEditorState}) => {
              // A level change fires both a removal and a creation. In the
              // first block the removal reaches the live region, announcing the
              // old level instead of the new one. Prefer the creation; only
              // announce removal when nothing replaced it.
              let createdTag: HeadingTagType | null = null;
              let destroyedTag: HeadingTagType | null = null;
              for (const [key, mutation] of nodes) {
                if (mutation === 'created' && createdTag === null) {
                  createdTag = editor.read('latest', () =>
                    $readHeadingTag(key),
                  );
                } else if (mutation === 'destroyed' && destroyedTag === null) {
                  destroyedTag = prevEditorState.read(() =>
                    $readHeadingTag(key),
                  );
                }
              }
              if (createdTag !== null) {
                announce(created.peek().replace('%s', createdTag.slice(1)));
              } else if (destroyedTag !== null) {
                announce(destroyed.peek().replace('%s', destroyedTag.slice(1)));
              }
            },
            {skipInitialization: true},
          ),
    );
  },
});
