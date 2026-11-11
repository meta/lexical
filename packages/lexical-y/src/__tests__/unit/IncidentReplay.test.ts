/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A 5-writer browser room lost 1,280 characters to one Backspace: a full
// re-read (the remote self-check's) handed the wrappers of nested lists to
// other lists and left the writer's caret after another list's nested list.
// Replayed headlessly from the room's relay update log, which is not part of
// the repository: set SOAKB2_LOG to the log's path to run it. A bound editor
// loads the stored state just before the incident (update 10974), its caret
// where writer C was typing (`but buq|`, deep in list root[2]); F's list
// split (10975) arrives; the binding re-reads the root container; C presses
// Backspace, which must remove one character.

// @vitest-environment node

import {HashtagNode} from '@lexical/hashtag';
import * as Y from '@y/y';
import {
  $createRangeSelection,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import fs from 'node:fs';
import {expect, test} from 'vitest';

import {flush, NODES, Peer} from '../utils/harness';

/**
 * Backspace as RichTextExtension's DELETE_CHARACTER_COMMAND does it: inside
 * a text node, the character before the caret (headless editors have no
 * window for `deleteCharacter`'s DOM-based extension of a text caret);
 * anywhere else, `deleteCharacter(true)`.
 */
function $backspace(): void {
  const s = $getSelection();
  if (!$isRangeSelection(s)) {
    return;
  }
  if (s.isCollapsed() && s.anchor.type === 'text' && s.anchor.offset > 0) {
    s.anchor.set(s.anchor.key, s.anchor.offset - 1, 'text');
    s.removeText();
  } else {
    s.deleteCharacter(true);
  }
}

const LOG = process.env.SOAKB2_LOG || '';
const BASE = 10974;
const SPLIT = 10975;

const TOKEN_RE = /[kp][a-z]\d+z/g;

function caretPath(peer: Peer): string {
  return peer.read(() => {
    const s = $getSelection();
    if (!$isRangeSelection(s)) {
      return String(s);
    }
    const n: LexicalNode = s.anchor.getNode();
    const path: string[] = [];
    for (
      let x: LexicalNode | null = n;
      x !== null && x.getParent() !== null;
      x = x.getParent()
    ) {
      path.unshift(`${x.getType()}[${x.getIndexWithinParent()}]`);
    }
    return `${s.anchor.type}@${s.anchor.offset} ${path.join('/')}${s.isCollapsed() ? '' : ' (range)'}`;
  });
}

test.skipIf(LOG === '' || !fs.existsSync(LOG))(
  "incident: after F splits a list and the root is re-read, C's Backspace deletes one character",
  async () => {
    const lines = fs
      .readFileSync(LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as {u?: string});
    const base = new Y.Doc({gc: false});
    for (let n = 1; n <= BASE; n++) {
      const u = lines[n - 1].u;
      if (u !== undefined) {
        Y.applyUpdate(base, new Uint8Array(Buffer.from(u, 'base64')));
      }
    }
    const net = {
      delivery: 'causal' as const,
      peers: [] as Peer[],
      pumping: false,
      queue: [] as [Peer, Uint8Array][],
    };
    const c = new Peer(424242, net as never, [...NODES, HashtagNode]);
    // The playground's dev build runs the self-check; its remote mismatch
    // is what re-read the root in the browser (simulated below).
    Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(base), 'load');
    c.binding.initialize();
    await flush();
    expect(c.binding.status).toBe('active');
    // C's caret: after `but buq`, which follows `Meeting, now `.
    c.update(() => {
      const texts = $getRoot().getAllTextNodes();
      const i = texts.findIndex(
        (t: TextNode, k: number) =>
          t.getTextContent() === 'but buq' &&
          k > 0 &&
          texts[k - 1].getTextContent().endsWith('Meeting, now '),
      );
      expect(i).toBeGreaterThan(0);
      const sel = $createRangeSelection();
      sel.anchor.set(texts[i].getKey(), 7, 'text');
      sel.focus.set(texts[i].getKey(), 7, 'text');
      $setSelection(sel);
    });
    const caretBefore = caretPath(c);
    // F's split arrives.
    Y.applyUpdate(
      c.doc,
      new Uint8Array(Buffer.from(lines[SPLIT - 1].u!, 'base64')),
      'net',
    );
    await flush();
    const caretAfterRead = caretPath(c);
    // What the remote self-check did on its (DOM-derived) mismatch.
    const b = c.binding as unknown as {
      rereadContainers: (list: unknown[]) => void;
      state: {containers: Map<unknown, unknown>};
      _root: unknown;
    };
    b.rereadContainers([b.state.containers.get(b._root)]);
    await flush();
    const caretAfterReread = caretPath(c);
    const before = c.read(() => $getRoot().getTextContent());
    // C's Backspace (RichTextExtension's DELETE_CHARACTER_COMMAND).
    c.update(() => {
      $backspace();
    });
    await flush();
    const after = c.read(() => $getRoot().getTextContent());
    const tokens = (t: string) => new Set(t.match(TOKEN_RE) || []);
    const lost = [...tokens(before)].filter(t => !tokens(after).has(t));
    // eslint-disable-next-line no-console
    console.log({
      caretAfterRead,
      caretAfterReread,
      caretBefore,
      lostTokens: lost.length,
      removedChars: before.length - after.length,
    });
    expect(caretAfterReread).toBe(caretBefore);
    expect(before.length - after.length).toBe(1);
    expect(lost).toEqual([]);
    void $isTextNode;
  },
  120000,
);
