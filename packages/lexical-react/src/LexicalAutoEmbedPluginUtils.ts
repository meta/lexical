/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {MenuOption} from '@lexical/react/LexicalMenuOption';
import {
  createCommand,
  type LexicalCommand,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';

/**
 * The result of matching a URL for an embed: the matched `url`, an `id`
 * identifying the embedded resource, and optional provider-specific `data`.
 */
export type EmbedMatchResult<TEmbedMatchResult = unknown> = {
  url: string;
  id: string;
  data?: TEmbedMatchResult;
};

/**
 * Describes a kind of embed (for example YouTube, a tweet, or Google Maps) that
 * {@link LexicalAutoEmbedPlugin} can detect and insert. Each config has a `type`
 * identifier, a `parseUrl` function that decides whether a URL matches and
 * extracts its data, and an `insertNode` function that inserts the corresponding
 * Lexical node.
 */
export interface EmbedConfig<
  TEmbedMatchResultData = unknown,
  TEmbedMatchResult = EmbedMatchResult<TEmbedMatchResultData>,
> {
  type: string;
  // Determine if a given URL is a match and return url data.
  parseUrl: (
    text: string,
  ) => Promise<TEmbedMatchResult | null> | TEmbedMatchResult | null;
  // Create the Lexical embed node from the url data.
  insertNode: (editor: LexicalEditor, result: TEmbedMatchResult) => void;
}

/**
 * A general-purpose regular expression for detecting URLs, provided as a
 * convenience for implementing an {@link EmbedConfig}'s `parseUrl`.
 */
export const URL_MATCHER =
  /((https?:\/\/(www\.)?)|(www\.))[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/;

/**
 * Command dispatched to start inserting an embed. Its payload is the `type` of
 * the {@link EmbedConfig} to use; {@link LexicalAutoEmbedPlugin} listens for it
 * and runs that config's URL detection flow.
 */
export const INSERT_EMBED_COMMAND: LexicalCommand<EmbedConfig['type']> =
  createCommand('INSERT_EMBED_COMMAND');

/**
 * A {@link MenuOption} for the auto-embed menu, pairing a display `title` with
 * an `onSelect` callback invoked when the user chooses to embed the detected
 * URL.
 */
export class AutoEmbedOption extends MenuOption {
  title: string;
  onSelect: (targetNode: LexicalNode | null) => void;
  constructor(
    title: string,
    options: {
      onSelect: (targetNode: LexicalNode | null) => void;
    },
  ) {
    super(title);
    this.title = title;
    this.onSelect = options.onSelect.bind(this);
  }
}
