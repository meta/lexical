/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  type CanIndentPredicate,
  registerTabIndentation,
} from '@lexical/extension';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useEffect, useRef} from 'react';

import useLayoutEffect from './shared/useLayoutEffect';

export {registerTabIndentation};

/**
 * This plugin adds the ability to indent content using the tab key. Generally, we don't
 * recommend using this plugin as it could negatively affect accessibility for keyboard
 * users, causing focus to become trapped within the editor.
 *
 * This is a legacy plugin. When building an editor with the extension API,
 * configure {@link TabIndentationExtension} instead.
 */
export function TabIndentationPlugin({
  maxIndent,
  $canIndent,
}: {
  maxIndent?: number;
  /**
   * By default, indents are set on all elements for which the {@link ElementNode.canIndent} returns true.
   * This option allows you to set indents for specific nodes without overriding the method for others.
   */
  $canIndent?: CanIndentPredicate;
}): null {
  const [editor] = useLexicalComposerContext();
  // Registering re-checks the whole document against maxIndent, so keep the
  // latest $canIndent in a ref instead of re-registering when it changes.
  const $canIndentRef = useRef($canIndent);
  useLayoutEffect(() => {
    $canIndentRef.current = $canIndent;
  });
  useEffect(() => {
    return registerTabIndentation(editor, maxIndent, node => {
      const $currentCanIndent = $canIndentRef.current;
      return $currentCanIndent ? $currentCanIndent(node) : node.canIndent();
    });
  }, [editor, maxIndent]);

  return null;
}
