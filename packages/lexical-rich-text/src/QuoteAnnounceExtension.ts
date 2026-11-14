/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {AriaLiveRegionExtension} from '@lexical/a11y';
import {effect, namedSignals} from '@lexical/extension';
import {$findMatchingParent, mergeRegister} from '@lexical/utils';
import {
  $getNodeByKey,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isRootOrShadowRoot,
  defineExtension,
  type EditorState,
  type NodeKey,
  safeCast,
} from 'lexical';

import {HeadingAnnounceExtension} from './HeadingAnnounceExtension';
import {$isHeadingNode, $isQuoteNode, QuoteNode} from './index';

/**
 * One message for a swap. The block the caret landed in comes first, then
 * the block that was removed. The second clause continues the first.
 */
function joinSwap(left: string, right: string): string {
  const continued =
    right.length === 0 ? right : right.charAt(0).toLowerCase() + right.slice(1);
  return `${left}, ${continued}`;
}

export interface QuoteAnnounceExtensionConfig {
  /** Announced when a block becomes a quote. */
  created: string;
  /** Announced when a quote stops being a quote. */
  destroyed: string;
  /** Announced when a quote goes away and the caret lands in another one. */
  destroyedInside: string;
  /** Announced when the caret moves into a quote that already existed. */
  entered: string;
  /** Announced when the caret leaves a quote that is still there. */
  exited: string;
  /**
   * When `true`, quotes are not announced. Toggle at runtime via the output
   * signal. Default `false`.
   */
  disabled: boolean;
}

/**
 * Announces quotes through the {@link AriaLiveRegionExtension} sink: a block
 * becoming a quote, and a quote ceasing to be one.
 *
 * The markdown shortcut consumes both keystrokes (`>` then space) and swaps the
 * block type, which is silent to a screen reader — so without this the user has
 * no way to know the transformation happened.
 *
 * Crossing the edge of a quote is announced only when the block on the far side
 * appears or disappears in the same update — pressing Enter at the end of a
 * quote, or backspacing into one. A screen reader works out the boundary by
 * comparing where the caret was against where it is, so a block that is still
 * being made or unmade when it looks is a block it can miss, and the user
 * carries on typing believing they are still quoting. Moving across the edge
 * with the arrow keys is left alone: both blocks are already there and the
 * screen reader reports the boundary itself.
 *
 * Only one thing is announced per commit, so removing the lower of two quotes
 * reports the removal and where the caret ended up together. Announcing only
 * the removal leaves the user inside the quote above with no way to know it.
 *
 * A quote made or removed somewhere other than the caret stays quiet. The
 * caret has not moved onto that quote, so the screen reader has nothing new
 * to say about where the user is. That covers another person's edit, and a
 * paste or import that happens to contain a quote the caret did not land in.
 *
 * When a heading and a quote trade places, both facts go in the one message,
 * destination first: "Block quote, heading level 2 removed", or "Heading
 * level 2, block quote removed". The live region keeps only the last message
 * in a commit, so this announcer writes that whole line itself.
 */
export const QuoteAnnounceExtension = defineExtension({
  build: (_editor, config) => namedSignals(config),
  config: safeCast<QuoteAnnounceExtensionConfig>({
    created: 'Block quote',
    destroyed: 'Block quote removed',
    destroyedInside: 'Block quote removed, in block quote',
    disabled: false,
    entered: 'Block quote',
    exited: 'Exiting block quote',
  }),
  dependencies: [AriaLiveRegionExtension, HeadingAnnounceExtension],
  name: '@lexical/rich-text/QuoteAnnounce',
  register(editor, _config, state) {
    const {created, destroyed, destroyedInside, disabled, entered, exited} =
      state.getOutput();
    const {announce} = state.getDependency(AriaLiveRegionExtension).output;
    const {
      created: headingCreated,
      destroyed: headingDestroyed,
      disabled: headingDisabled,
    } = state.getDependency(HeadingAnnounceExtension).output;

    const $headingLevel = (
      editorState: EditorState,
      blockKey: NodeKey,
    ): string | null =>
      editorState.read(() => {
        const block = $getNodeByKey(blockKey);
        return $isHeadingNode(block) ? block.getTag().slice(1) : null;
      });

    const $caretAt = (
      editorState: EditorState,
    ): {block: NodeKey; quote: NodeKey | null} | null =>
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return null;
        }
        const node = selection.anchor.getNode();
        // getTopLevelElement() throws for a text node whose parent is the
        // root or a shadow root, a state this listener has to survive.
        let block = node;
        for (
          let parent = node.getParent();
          parent !== null && !$isRootOrShadowRoot(parent);
          parent = parent.getParent()
        ) {
          block = parent;
        }
        const quote = $findMatchingParent(node, $isQuoteNode);
        return {
          block: block.getKey(),
          quote: quote === null ? null : quote.getKey(),
        };
      });

    const isMissingFrom = (editorState: EditorState, key: NodeKey): boolean =>
      editorState.read(() => $getNodeByKey(key) === null);

    /**
     * True when the caret now sits in a block that this commit created and
     * that is not a plain paragraph — the shape of converting one block type
     * to another, as `$setBlocksType` does.
     *
     * A heading that replaces the quote is named first, then the removal,
     * because the live region keeps only the last write in a commit.
     * Any other block type is left to speak for itself.
     *
     * Converting to a plain paragraph is excluded because nothing announces a
     * paragraph, so "Block quote removed" is the only report the user gets.
     */
    const $replacedByAnotherBlockType = (
      editorState: EditorState,
      prevEditorState: EditorState,
      blockKey: NodeKey,
    ): boolean =>
      editorState.read(() => {
        const block = $getNodeByKey(blockKey);
        return (
          block !== null &&
          !$isParagraphNode(block) &&
          isMissingFrom(prevEditorState, blockKey)
        );
      });

    // Recorded by the mutation listener, read by the update listener that runs
    // after it. The sets say which quotes changed, so the update can tell
    // whether the caret was in one of them.
    let quotesChanged: 'created' | 'destroyed' | null = null;
    let createdKeys = new Set<NodeKey>();
    let destroyedKeys = new Set<NodeKey>();

    // Gate on `disabled` from an effect so a disabled announcer registers no
    // listener at all. Peek the message signals at announce time so editing
    // them does not re-register.
    return effect(() =>
      disabled.value
        ? undefined
        : mergeRegister(
            editor.registerMutationListener(
              QuoteNode,
              nodes => {
                // Converting one block type to another destroys and creates in
                // the same update. Prefer the creation, so a paragraph becoming
                // a quote is not reported as a quote being removed.
                for (const [key, mutation] of nodes) {
                  if (mutation === 'created') {
                    createdKeys.add(key);
                    quotesChanged = 'created';
                  } else if (mutation === 'destroyed') {
                    destroyedKeys.add(key);
                    if (quotesChanged !== 'created') {
                      quotesChanged = 'destroyed';
                    }
                  }
                }
              },
              {skipInitialization: true},
            ),
            editor.registerUpdateListener(
              ({dirtyElements, dirtyLeaves, editorState, prevEditorState}) => {
                const changed = quotesChanged;
                const createdNow = createdKeys;
                const destroyedNow = destroyedKeys;
                quotesChanged = null;
                createdKeys = new Set();
                destroyedKeys = new Set();
                // Nothing was made or unmade, so nothing can have appeared or
                // disappeared beside the caret.
                if (dirtyElements.size === 0 && dirtyLeaves.size === 0) {
                  return;
                }

                const before = $caretAt(prevEditorState);
                const after = $caretAt(editorState);

                if (changed === 'created') {
                  // Speak only when the caret is inside the quote this commit
                  // made. A quote added somewhere else is not where the user is.
                  if (
                    after !== null &&
                    after.quote !== null &&
                    createdNow.has(after.quote)
                  ) {
                    const level =
                      before !== null &&
                      isMissingFrom(editorState, before.block)
                        ? $headingLevel(prevEditorState, before.block)
                        : null;
                    // Where the caret landed, then the heading it replaced.
                    if (level !== null && !headingDisabled.peek()) {
                      announce(
                        joinSwap(
                          created.peek(),
                          headingDestroyed.peek().replace('%s', level),
                        ),
                      );
                    } else {
                      announce(created.peek());
                    }
                  }
                  return;
                }

                if (changed === 'destroyed') {
                  // Speak only when the caret was in the quote that went away.
                  if (
                    before === null ||
                    before.quote === null ||
                    !destroyedNow.has(before.quote)
                  ) {
                    return;
                  }
                  if (
                    after !== null &&
                    after.quote === null &&
                    $replacedByAnotherBlockType(
                      editorState,
                      prevEditorState,
                      after.block,
                    )
                  ) {
                    const level = $headingLevel(editorState, after.block);
                    // Where the caret landed, then the quote it replaced. When
                    // nothing else speaks for the new block, the removal does.
                    if (level !== null && !headingDisabled.peek()) {
                      announce(
                        joinSwap(
                          headingCreated.peek().replace('%s', level),
                          destroyed.peek(),
                        ),
                      );
                      return;
                    }
                  }
                  // Removing the lower of two quotes leaves the caret inside
                  // the one above, which is worth saying as well.
                  announce(
                    after !== null && after.quote !== null
                      ? destroyedInside.peek()
                      : destroyed.peek(),
                  );
                  return;
                }

                if (
                  before === null ||
                  after === null ||
                  before.quote === after.quote
                ) {
                  return;
                }

                if (
                  after.quote !== null &&
                  !isMissingFrom(prevEditorState, after.quote) &&
                  isMissingFrom(editorState, before.block)
                ) {
                  announce(entered.peek());
                } else if (
                  after.quote === null &&
                  before.quote !== null &&
                  !isMissingFrom(editorState, before.quote) &&
                  isMissingFrom(prevEditorState, after.block)
                ) {
                  announce(exited.peek());
                }
              },
            ),
          ),
    );
  },
});
