/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$distributeInlineWrapper, defineImportRule, sel} from '@lexical/html';

import {$createLinkNode} from './LexicalLinkNode';

const AnchorRule = defineImportRule({
  $import: (ctx, el) => {
    if (!el.textContent && el.children.length === 0) {
      return [];
    }
    // Use no schema here: when the `<a>` contains block descendants
    // (e.g. `<a><h1>x</h1><div>y</div></a>`), we want them lifted so each
    // block becomes a sibling at the link's level, with the link wrapping
    // its inline content. $distributeInlineWrapper handles both the
    // common all-inline case (single LinkNode wrapping the run) and the
    // mixed-block case (per-block recursion).
    const href = el.getAttribute('href') || '';
    const attrs = {
      rel: el.getAttribute('rel'),
      target: el.getAttribute('target'),
      title: el.getAttribute('title'),
    };
    return $distributeInlineWrapper(ctx.$importChildren(el), () =>
      $createLinkNode(href, attrs),
    );
  },
  match: sel.tag('a'),
  name: '@lexical/link/a',
});

/**
 * Import rules for {@link LinkNode}.
 *
 * Registered by {@link LinkExtension} itself (together with
 * `CoreImportExtension`), so any editor that uses the link extension can
 * import `<a>` through the `DOMImportExtension` pipeline without further
 * configuration.
 *
 * @experimental
 */
export const LinkImportRules = [AnchorRule];
