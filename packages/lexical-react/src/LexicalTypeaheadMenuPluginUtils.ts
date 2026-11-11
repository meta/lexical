/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {MenuOption, TriggerFn} from './shared/LexicalMenu';

import {getScrollParent as getScrollParent_} from '@lexical/utils';
import {createCommand, type LexicalCommand} from 'lexical';
import {useCallback} from 'react';

/**
 * The default set of punctuation characters (as a character-class fragment)
 * that terminate a typeahead query. Used as the default `punctuation` option of
 * {@link useBasicTypeaheadTriggerMatch}.
 */
export const PUNCTUATION =
  '\\.,\\+\\*\\?\\$\\@\\|#{}\\(\\)\\^\\-\\[\\]\\\\/!%\'"~=<>_:;';

/**
 * Command dispatched while the typeahead menu is open to scroll the option at
 * the given `index` into view. The built-in menu hook registers a default
 * handler; custom implementations can register their own handler at a higher
 * priority to override the scrolling behavior.
 */
export const SCROLL_TYPEAHEAD_OPTION_INTO_VIEW_COMMAND: LexicalCommand<{
  index: number;
  option: MenuOption;
}> = createCommand('SCROLL_TYPEAHEAD_OPTION_INTO_VIEW_COMMAND');

/** @deprecated Moved to `@lexical/utils`. Import `getScrollParent` from there. */
export const getScrollParent = getScrollParent_;

/**
 * Builds a {@link TriggerFn} for the common case of a single-character
 * `trigger` (such as `@` or `#`) followed by a query. The returned function
 * matches when the trigger is preceded by whitespace, an open parenthesis,
 * or the start of the line
 * and is followed by between `minLength` and `maxLength` non-`punctuation`
 * characters (optionally allowing whitespace).
 *
 * @returns A memoized trigger function for {@link LexicalTypeaheadMenuPlugin}.
 */
export function useBasicTypeaheadTriggerMatch(
  trigger: string,
  {
    minLength = 1,
    maxLength = 75,
    punctuation = PUNCTUATION,
    allowWhitespace = false,
  }: {
    minLength?: number;
    maxLength?: number;
    punctuation?: string;
    allowWhitespace?: boolean;
  },
): TriggerFn {
  return useCallback(
    (text: string) => {
      const validCharsSuffix = allowWhitespace ? '' : '\\s';
      const validChars = '[^' + trigger + punctuation + validCharsSuffix + ']';
      const TypeaheadTriggerRegex = new RegExp(
        '(^|\\s|\\()(' +
          '[' +
          trigger +
          ']' +
          '((?:' +
          validChars +
          '){0,' +
          maxLength +
          '})' +
          ')$',
      );
      const match = TypeaheadTriggerRegex.exec(text);
      if (match !== null) {
        const maybeLeadingWhitespace = match[1];
        const matchingString = match[3];
        if (matchingString.length >= minLength) {
          return {
            leadOffset: match.index + maybeLeadingWhitespace.length,
            matchingString,
            replaceableString: match[2],
          };
        }
      }
      return null;
    },
    [allowWhitespace, trigger, punctuation, maxLength, minLength],
  );
}
