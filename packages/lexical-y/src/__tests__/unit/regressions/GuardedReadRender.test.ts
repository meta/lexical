/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A read that the editor cannot render (jsdom: the reader's editor is
// attached to a DOM root, so Lexical reconciles what it reads). Lexical
// gives the editor the read's state before it reconciles it, so a throw
// rendering it comes after the editor shows the read's state, and before
// its update listeners run (see YBinding#guardedRead).

import {$create, $getRoot, ElementNode} from 'lexical';
import {describe, expect, test} from 'vitest';

import {$p, flush, NODES, type Peer, setup} from '../../utils/harness';

/** A block whose class throws rendering it, as on a client that cannot. */
class UnrenderableNode extends ElementNode {
  $config() {
    return this.config('test_unrenderable', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    throw new Error('cannot render');
  }
  updateDOM(): boolean {
    return false;
  }
}

function attach(peer: Peer) {
  const element = document.createElement('div');
  element.contentEditable = 'true';
  document.body.appendChild(element);
  peer.editor.setRootElement(element);
}

describe('R-1: a read the editor cannot render', () => {
  test('R-1: a class that throws rendering stored content still fails closed', async () => {
    const t = await setup(() => $getRoot().append($p('hello')), {
      nodes: [...NODES, UnrenderableNode],
    });
    attach(t.b);
    // Showing again what B showed renders through the DOM the failed render
    // left broken, and can throw too: failing closed rethrows that in a
    // microtask (an uncaught error), and still ends read only.
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    try {
      t.a.update(() =>
        $getRoot().append($create(UnrenderableNode).append($p('inside'))),
      );
      await expect(t.sync()).resolves.toBeUndefined();
      await flush();
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    expect(uncaught.length).toBeLessThanOrEqual(1);
    expect(t.b.binding.status).toBe('readonly');
    expect(t.b.warnings).toEqual([
      expect.stringMatching(/^the document cannot be read: /),
    ]);
  });
});
