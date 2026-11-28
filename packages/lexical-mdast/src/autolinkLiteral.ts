/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Link, Nodes, Parent, RootContent, Text} from 'mdast';
import type {Extension} from 'mdast-util-from-markdown';

import {gfmAutolinkLiteralFromMarkdown} from 'mdast-util-gfm-autolink-literal';

// Where the URL pattern of the library's transform starts a literal, also
// right after a letter or digit, where it starts none.
const URL_START = /https?:\/\/|www(?=\.)/gi;

// Puts back `value`, the characters of a text that the transforms read as
// `masked`, into the texts and links that replaced it in `children` from
// `start`, and returns the index after them. Returns -1 when those children
// are not consecutive texts and links whose texts make up `masked`, each
// link with a url that ends with its text.
function restorePieces(
  children: RootContent[],
  start: number,
  value: string,
  masked: string,
): number {
  const pieces: [text: Text, link: Link | null][] = [];
  let offset = 0;
  let j = start;
  while (offset < value.length && j < children.length) {
    const next = children[j++];
    if (next.type === 'text') {
      pieces.push([next, null]);
    } else if (
      next.type === 'link' &&
      next.children.length === 1 &&
      next.children[0].type === 'text' &&
      next.url.endsWith(next.children[0].value)
    ) {
      pieces.push([next.children[0], next]);
    } else {
      return -1;
    }
    offset += pieces[pieces.length - 1][0].value.length;
  }
  if (offset !== value.length) {
    return -1;
  }
  offset = 0;
  for (const [text, link] of pieces) {
    const {length} = text.value;
    if (text.value !== masked.slice(offset, offset + length)) {
      return -1;
    }
    text.value = value.slice(offset, offset + length);
    if (link !== null) {
      link.url = link.url.slice(0, link.url.length - length) + text.value;
    }
    offset += length;
  }
  return j;
}

/**
 * `gfmAutolinkLiteralFromMarkdown()`, reading literals as GitHub shows them
 * in comments: a `www.` or `http(s)://` literal links only where micromark
 * finds it in the source, and an email, `mailto:` or `xmpp:` literal also
 * where the library's transform finds it in the decoded text. So a URL that
 * an escape or a character reference writes (`https\://x.com`,
 * `&#x77;ww.x.com`), and a `www.` URL right after `.`, `!`, `"` or a code
 * span, stays text, while `a\@b.co` links. Text that another transform added
 * before this one is not searched for URLs. `base` is the extension whose
 * transforms find the literals; tests pass one of their own.
 *
 * @internal
 * @__NO_SIDE_EFFECTS__
 */
export function gfmAutolinkLiteralFromSource(
  base: Extension = gfmAutolinkLiteralFromMarkdown(),
): Extension {
  return {
    ...base,
    transforms: [
      tree => {
        // Each text outside a link gets `q` in place of the first letter of
        // each `www.` or `http(s)://` in it, where the library's transforms
        // would find a URL but also right after a letter or digit, where they
        // find none, and is kept with its original value, as are the children
        // of its parent.
        // `q` starts neither `www` nor `http`, so no URL starts there, but
        // it is a letter like the one it replaces for the email patterns and
        // for the check of the character before a URL. So a `q` where the
        // transforms find no URL changes nothing, and neither does one for
        // a later URL, so one pass masks them all.
        const originals = new Map<RootContent, string>();
        const snapshots = new Map<Parent, RootContent[]>();
        const mask = (node: Nodes) => {
          if (
            node.type === 'link' ||
            node.type === 'linkReference' ||
            !('children' in node)
          ) {
            return;
          }
          let masked = false;
          for (const child of node.children) {
            if (child.type === 'text') {
              const value = child.value.replace(
                URL_START,
                match => 'q' + match.slice(1),
              );
              if (value !== child.value) {
                originals.set(child, child.value);
                child.value = value;
                masked = true;
              }
            } else {
              mask(child);
            }
          }
          if (masked) {
            snapshots.set(node, [...node.children]);
          }
        };
        mask(tree);
        for (const transform of base.transforms || []) {
          tree = transform(tree) || tree;
        }
        // The transforms replace a text with consecutive texts and links
        // whose text adds up to it, and leave every other child as it was.
        // Where a parent's children are not so, its children go back to
        // what they were, with no link from the transforms, rather than
        // keep a `q`.
        for (const [parent, old] of snapshots) {
          let j = 0;
          for (let i = 0; i < old.length && j !== -1; i++) {
            const child = old[i];
            const original = originals.get(child);
            if (parent.children[j] === child) {
              j++;
            } else if (child.type === 'text') {
              j = restorePieces(
                parent.children,
                j,
                original === undefined ? child.value : original,
                child.value,
              );
            } else {
              j = -1;
            }
          }
          if (j !== parent.children.length) {
            parent.children = old;
          }
          for (const child of old) {
            const original = originals.get(child);
            if (original !== undefined && child.type === 'text') {
              child.value = original;
            }
          }
        }
        return tree;
      },
    ],
  };
}
