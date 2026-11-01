/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalNode} from 'lexical';

import {
  $createHorizontalRuleNode,
  $isHorizontalRuleNode,
  HorizontalRuleNode,
} from '@lexical/extension';
import {
  type ElementTransformer,
  registerMarkdownShortcuts,
  type Transformer,
  TRANSFORMERS,
} from '@lexical/markdown';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useEffect} from 'react';

const HR: ElementTransformer = {
  dependencies: [HorizontalRuleNode],
  export: (node: LexicalNode) => {
    return $isHorizontalRuleNode(node) ? '***' : null;
  },
  regExp: /^(---|\*\*\*|___)\s?$/,
  replace: (parentNode, _1, _2, isImport) => {
    const line = $createHorizontalRuleNode();

    // TODO: Get rid of isImport flag
    if (isImport || parentNode.getNextSibling() != null) {
      parentNode.replace(line);
    } else {
      parentNode.insertBefore(line);
    }

    line.selectNext();
  },
  triggerOnEnter: true,
  type: 'element',
};
/**
 * The default set of Markdown {@link Transformer}s used by
 * {@link MarkdownShortcutPlugin}: the core `@lexical/markdown` `TRANSFORMERS`
 * plus a transformer that turns `---`, `***`, or `___` into a horizontal rule.
 */

/**
 * A function declared side-effect free (so the build annotates the call)
 * rather than an array spread at module scope, which is a side effect to
 * bundlers and would pin every transformer into every bundle that imports
 * this module.
 *
 * @__NO_SIDE_EFFECTS__
 */
function defaultTransformers(): Transformer[] {
  return [HR, ...TRANSFORMERS];
}

export const DEFAULT_TRANSFORMERS: Transformer[] = defaultTransformers();

/**
 * Registers Markdown shortcuts so that typing Markdown syntax (for example
 * `# ` for a heading or `- ` for a list item) is automatically converted into
 * the corresponding nodes as you type. Pass `transformers` to customize which
 * shortcuts are active; it defaults to {@link DEFAULT_TRANSFORMERS}.
 *
 * @returns `null`, this plugin renders no DOM of its own.
 */
export function MarkdownShortcutPlugin({
  transformers = DEFAULT_TRANSFORMERS,
}: Readonly<{
  transformers?: Transformer[];
}>): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return registerMarkdownShortcuts(editor, transformers);
  }, [editor, transformers]);

  return null;
}
