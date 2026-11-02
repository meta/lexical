/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// D57 over every node shape: a surrogate half without its pair typed into
// each text node of a shape (a link's text, a list item, a table cell, a code
// line, a heading, a quote, a collapsible's title, token and segmented text,
// the text around an inline decorator, ...) is written as U+FFFD, never
// throws, and the author, the other client and a fresh read of each client's
// document show the same content: what an editor without collaboration shows
// when the app writes U+FFFD itself (per text node), with the same formats.

import {
  $getRoot,
  $isTabNode,
  $isTextNode,
  $setSelection,
  createEditor,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {CATALOG_NODES, NODE_SHAPES} from '../../catalog/nodes';
import {expectConverged, freshReader, setup} from '../../utils/harness';

/** Whether `s` holds a surrogate code unit that is not half of a pair. */
function hasLone(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) {
        return true;
      }
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** `s` with every surrogate half that has no pair in it as U+FFFD. */
function wellFormed(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const d = s.charCodeAt(i + 1);
    if (c >= 0xd800 && c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
      out += s.slice(i, i + 2);
      i++;
    } else if (c >= 0xd800 && c <= 0xdfff) {
      out += '\ufffd';
    } else {
      out += s[i];
    }
  }
  return out;
}

/** Every text node of the document with text (any mode), but tabs. */
function $texts(): TextNode[] {
  const out: TextNode[] = [];
  const walk = (node: LexicalNode) => {
    if ($isTextNode(node)) {
      if (!$isTabNode(node) && node.getTextContentSize() > 0) {
        out.push(node);
      }
    } else if ('getChildren' in node) {
      for (const child of (
        node as {getChildren(): LexicalNode[]}
      ).getChildren()) {
        walk(child);
      }
    }
  };
  walk($getRoot());
  return out;
}

/** The document's text and, per UTF-16 unit, the format and style there. */
function $content(): string {
  const parts: string[] = [$getRoot().getTextContent()];
  for (const node of $texts()) {
    const sig = `${node.getFormat()}/${node.getStyle()}`;
    parts.push(node.getTextContent().replace(/[\s\S]/g, () => sig + ' '));
  }
  return parts.join('\n');
}

// Every shape whose block holds text of a line (inline shapes come with text
// around them). Not block decorators (their text, if any, is in a nested
// editor or a field), nor named-slot hosts and nested editors, which this
// harness's editors (not built with LexicalBuilder) cannot hold: their
// shapes' own matrices cover them.
const shapes = NODE_SHAPES.filter(
  s =>
    s.kind !== 'block-decorator' &&
    s.kind !== 'slot-host' &&
    // An inline shape's block has text around it, whatever it holds.
    (s.$inline !== undefined || !s.tags.includes('zero-text')) &&
    !s.tags.includes('slots') &&
    !s.tags.includes('nested-editor'),
);

/**
 * A lone high half and a lone low half inside every text node of the
 * document, and a low half at the end of the last one, each text node's new text passed through
 * `write` (the lone halves as they are, or as U+FFFD).
 */
function $typeHalves(write: (text: string) => string): number {
  const texts = $texts();
  texts.forEach((node, i) => {
    const text = node.getTextContent();
    // After the node's first character, between ordinary characters, so
    // that neither half pairs with the other or with the node's own text.
    const first = Array.from(text)[0];
    let now = first + 'x\ud83dy\ude00z' + text.slice(first.length);
    if (i === texts.length - 1) {
      now += '\ude00';
    }
    node.setTextContent(write(now));
  });
  return texts.length;
}

describe.each([false, true])('lone halves in every node shape (gc %s)', gc => {
  for (const shape of shapes) {
    test(shape.name, async () => {
      const t = await setup(() => $getRoot().append(shape.$block()), {
        gc,
        nodes: [...CATALOG_NODES],
      });
      // The same edit made with U+FFFD written by the app itself, on an
      // editor without collaboration: what every client must show (computed
      // without the binding, so that no binding bug can change it).
      const plain = createEditor({
        namespace: 'expected',
        nodes: [...CATALOG_NODES],
        onError: e => {
          throw e;
        },
      });
      plain.update(() => $getRoot().append(shape.$block()), {discrete: true});
      plain.update(
        () => {
          $typeHalves(wellFormed);
          $setSelection(null);
        },
        {discrete: true},
      );
      const expected = plain.getEditorState().read($content);
      expect(hasLone(expected)).toBe(false);
      const before = t.b.warnings.length;
      let typed = 0;
      t.b.update(() => {
        typed = $typeHalves(text => text);
        $setSelection(null);
      });
      await t.sync();
      expect(typed).toBeGreaterThan(0);
      for (const peer of t.peers) {
        expect(peer.read($content)).toBe(expected);
        const fresh = await freshReader(peer);
        expect(fresh.describe()).toBe(peer.describe());
        expect(fresh.read($content)).toBe(expected);
      }
      expect(t.b.warnings.slice(before)).toEqual([]);
      await expectConverged(t.peers);
    });
  }
});
