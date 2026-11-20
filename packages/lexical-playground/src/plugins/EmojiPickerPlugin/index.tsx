/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import {
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  type TextNode,
} from 'lexical';
import {useCallback, useEffect, useMemo, useState} from 'react';

class EmojiOption extends MenuOption {
  title: string;
  emoji: string;
  keywords: string[];

  constructor(
    title: string,
    emoji: string,
    options: {
      ariaLabel?: string;
      keywords?: string[];
    },
  ) {
    super(title);
    this.title = title;
    this.emoji = emoji;
    this.ariaLabel = options.ariaLabel;
    this.keywords = options.keywords || [];
  }
}

type Emoji = {
  emoji: string;
  description: string;
  category: string;
  aliases: string[];
  tags: string[];
  unicode_version: string;
  ios_version: string;
  skin_tones?: boolean;
};

const MAX_EMOJI_SUGGESTION_COUNT = 10;

export default function EmojiPickerPlugin() {
  const [editor] = useLexicalComposerContext();
  const [queryString, setQueryString] = useState<string | null>(null);
  const [emojis, setEmojis] = useState<Emoji[]>([]);

  useEffect(() => {
    import('../../utils/emoji-list').then(file => setEmojis(file.default));
  }, []);

  const emojiOptions = useMemo(
    () =>
      emojis != null
        ? emojis.map(
            ({emoji, aliases, tags}) =>
              new EmojiOption(`${emoji} ${aliases[0]}`, emoji, {
                // Announce the shortcode, not the glyph and not the
                // dataset description.
                //
                // The glyph is announced from the screen reader's own
                // dictionary, so leaving it in the name says the same emoji
                // twice. The description reads well ("face savoring food") but
                // is NOT searchable - only aliases and tags are matched - so a
                // screen-reader user would hear a name they cannot type. The
                // shortcode is what you search by, so it is what should be
                // read; underscores become spaces so it is intelligible.
                ariaLabel: aliases[0].replace(/_/g, ' '),
                keywords: [...aliases, ...tags],
              }),
          )
        : [],
    [emojis],
  );

  const checkForTriggerMatch = useBasicTypeaheadTriggerMatch(':', {
    // Bare ":" must not open the menu: typeahead Enter runs before rich-text and
    // would steal paragraph breaks (flaky under collab).
    minLength: 1,
    punctuation: '\\.,\\+\\*\\?\\$\\@\\|#{}\\(\\)\\^\\[\\]\\\\/!%\'"~=<>:;', // allow _ and -
  });

  const options: EmojiOption[] = useMemo(() => {
    return emojiOptions
      .filter((option: EmojiOption) => {
        return queryString != null
          ? new RegExp(queryString, 'gi').exec(option.title) ||
            option.keywords != null
            ? option.keywords.some((keyword: string) =>
                new RegExp(queryString, 'gi').exec(keyword),
              )
            : false
          : emojiOptions;
      })
      .slice(0, MAX_EMOJI_SUGGESTION_COUNT);
  }, [emojiOptions, queryString]);

  const onSelectOption = useCallback(
    (
      selectedOption: EmojiOption,
      nodeToRemove: TextNode | null,
      closeMenu: () => void,
    ) => {
      editor.update(() => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection) || selectedOption == null) {
          return;
        }

        if (nodeToRemove) {
          nodeToRemove.remove();
        }

        selection.insertNodes([$createTextNode(selectedOption.emoji)]);

        closeMenu();
      });
    },
    [editor],
  );

  return (
    <LexicalTypeaheadMenuPlugin
      menuAriaLabel="Emojis"
      onQueryChange={setQueryString}
      onSelectOption={onSelectOption}
      triggerFn={checkForTriggerMatch}
      options={options}
    />
  );
}
