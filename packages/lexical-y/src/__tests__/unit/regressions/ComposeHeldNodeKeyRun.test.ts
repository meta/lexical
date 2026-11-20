/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A composing peer whose own node-type run is deleted by a held remote
// change. A composes "X" at the start of a token node (a TextNode subclass,
// stored with its type `t` and segment `k`), so X is written inside the
// token's run. B, seeing "Xtok", makes X plain text and keeps "tok" a token:
// under paired runs that deletes A's run around X. A receives it while still
// composing (the hold keeps the deleted format items, the editor goes on
// showing them), then makes the same change when its composition ends. A's
// write deletes those items again, so the hold must stop showing them: a
// write and its self-check that still read them stored X as a token
// (`self-check: format t at N`, and `format k at N` at a code
// composition's end).

import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $setCompositionKey,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {expectConverged, freshReader, NODES, setup} from '../../utils/harness';

class TokenNode extends TextNode {
  static getType(): string {
    return 'test_token';
  }
  static clone(node: TokenNode): TokenNode {
    return new TokenNode(node.__text, node.__key);
  }
  static importJSON(json: SerializedTextNode): TokenNode {
    return $createTokenNode(json.text).updateFromJSON(json);
  }
  constructor(text = '', key?: NodeKey) {
    super(text, key);
  }
  createDOM(config: EditorConfig): HTMLElement {
    return super.createDOM(config);
  }
  canInsertTextBefore(): boolean {
    return false;
  }
  canInsertTextAfter(): boolean {
    return false;
  }
  isTextEntity(): true {
    return true;
  }
}
const $createTokenNode = (text: string): TokenNode => new TokenNode(text);
const $isTokenNode = (node: LexicalNode | null): node is TokenNode =>
  node instanceof TokenNode;

/** The token whose text ends with "tok": X out of it, as plain text. */
function $plainX(): void {
  const token = $getRoot()
    .getAllTextNodes()
    .find(n => $isTokenNode(n) && n.getTextContent().endsWith('tok'));
  if (token === undefined || token.getTextContent() === 'tok') {
    return;
  }
  token.setTextContent('tok');
  token.insertBefore($createTextNode('X'));
}

for (const gc of [false, true]) {
  test(`a held change deleting the composer's own token run: its write at the composition's end stores X plain (gc ${gc})`, async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('abc '),
            $createTokenNode('tok'),
            $createTextNode(' end'),
          ),
        ),
      {gc, ids: [1, 2], nodes: [...NODES, TokenNode]},
    );
    const {a, b} = t;
    // A composes X at the start of the token.
    let key = '';
    a.update(() => {
      const token = $getRoot()
        .getAllTextNodes()
        .find($isTokenNode) as TokenNode;
      key = token.getKey();
      token.select(0, 0);
      $setCompositionKey(key);
    });
    a.update(() => {
      const token = $getNodeByKey(key) as TokenNode;
      token.setTextContent('X' + token.getTextContent());
      token.select(1, 1);
    });
    // B sees "Xtok" and makes X plain text.
    await t.sync();
    b.update($plainX);
    // A receives it while composing, then ends the composition with the
    // same change.
    await t.sync();
    a.update(() => {
      $setCompositionKey(null);
      $plainX();
    });
    await t.sync();
    expect(a.warnings.filter(w => /self-check/.test(w))).toEqual([]);
    expect(b.warnings.filter(w => /self-check/.test(w))).toEqual([]);
    await expectConverged(t.peers);
    const fresh = await freshReader(a);
    expect(fresh.describe()).toBe(a.describe());
    expect(a.describe()).toContain('"abc X"');
  });
}
