/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// An app's plugins that edit the document in reply to the editor's own
// events: a SELECTION_CHANGE_COMMAND handler, an update listener, a
// mutation listener and a node transform, each of which appends its mark
// ('!', '?', '#', '*') to the last line's text, at most `limit` times. Every
// edit they commit must reach the shared document, whatever update its
// reply follows (a remote read, a read that ends a composition's hold): a
// peer that does not run them reads them from there.

import {
  $getRoot,
  $isElementNode,
  $isTextNode,
  COMMAND_PRIORITY_LOW,
  type LexicalEditor,
  SELECTION_CHANGE_COMMAND,
  TextNode,
} from 'lexical';

/** The marks the plugins append (none of them a character A types). */
export const APP_MARKS: readonly string[] = ['!', '?', '#', '*'];

const $appendToLastLine = (mark: string): boolean => {
  const last = $getRoot().getLastChild();
  const text = $isElementNode(last) ? last.getLastDescendant() : null;
  if (!$isTextNode(text)) {
    return false;
  }
  text.setTextContent(text.getTextContent() + mark);
  return true;
};

export type AppPlugins = {
  /** How many edits each plugin made. */
  readonly made: Record<string, number>;
  dispose: () => void;
};

export type AppPlugin = 'selection' | 'update' | 'mutation' | 'transform';

export function registerAppPlugins(
  editor: LexicalEditor,
  limit = 4,
  only: readonly AppPlugin[] = ['selection', 'update', 'mutation', 'transform'],
): AppPlugins {
  const made: Record<string, number> = {
    mutation: 0,
    selection: 0,
    transform: 0,
    update: 0,
  };
  const all: Record<AppPlugin, () => () => void> = {
    mutation: () =>
      editor.registerMutationListener(
        TextNode,
        mutations => {
          if (made.mutation < limit && mutations.size > 0) {
            made.mutation++;
            editor.update(() => {
              $appendToLastLine('#');
            });
          }
        },
        {skipInitialization: true},
      ),
    selection: () =>
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          if (made.selection < limit && $appendToLastLine('!')) {
            made.selection++;
          }
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
    transform: () =>
      editor.registerNodeTransform(TextNode, node => {
        const last = $getRoot().getLastChild();
        if (
          made.transform < limit &&
          last !== null &&
          !node.getParents().includes(last as never) &&
          $appendToLastLine('*')
        ) {
          made.transform++;
        }
      }),
    update: () =>
      editor.registerUpdateListener(({dirtyLeaves}) => {
        if (made.update < limit && dirtyLeaves.size > 0) {
          made.update++;
          editor.update(() => {
            $appendToLastLine('?');
          });
        }
      }),
  };
  const disposers = only.map(name => all[name]());
  return {
    dispose: () => disposers.forEach(d => d()),
    made,
  };
}
