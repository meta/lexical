/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {registerTouchIndentation} from '@lexical/extension';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useEffect} from 'react';

export {registerTouchIndentation};

/**
 * This plugin adds the ability to indent/outdent content by swiping
 * left or right on touch devices. It dispatches the existing
 * INDENT_CONTENT_COMMAND and OUTDENT_CONTENT_COMMAND commands.
 */
export function TouchIndentationPlugin({
  swipeThreshold,
}: {
  swipeThreshold?: number;
}): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return registerTouchIndentation(editor, swipeThreshold);
  }, [editor, swipeThreshold]);

  return null;
}
