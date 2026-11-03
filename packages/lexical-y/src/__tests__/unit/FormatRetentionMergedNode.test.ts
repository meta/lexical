/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A text class that keeps a format bit only for long text. Main reads a
// bit over part of its text, which neither part shows, as two plain parts;
// the reader merges parts whose nodes show the same and the merged node
// keeps the bit. Outside the contract: a text class's shown format must
// depend on its class, fields and NodeState only, not on its text content
// or length (DECISIONS D106; #9768 pins the same case in TextFormatPolicy).
import {
  $createParagraphNode,
  $getRoot,
  createEditor,
  type NodeKey,
  type SerializedTextNode,
  type TextFormatType,
  TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YBinding} from '../..';
import {flush} from '../utils/harness';

class LengthGated extends TextNode {
  static getType() {
    return 'test_length_gated';
  }
  static clone(n: LengthGated) {
    return new LengthGated(n.__text, n.__key);
  }
  static importJSON(j: SerializedTextNode) {
    return new LengthGated(j.text).updateFromJSON(j);
  }
  constructor(text = '', key?: NodeKey) {
    super(text, key);
  }
  setFormat(f: number | TextFormatType): this {
    return super.setFormat(this.getTextContent().length >= 8 ? f : 0);
  }
  setTextContent(text: string): this {
    super.setTextContent(text);
    return text.length < 8 ? super.setFormat(0) : this;
  }
}
for (const gc of [false, true])
  test.fails(
    `merging equal shown parts must preserve the merged format gc=${gc}`,
    async () => {
      const doc = createYDoc(null, {gc});
      const e = createEditor({
        nodes: [LengthGated],
        onError: x => {
          throw x;
        },
        onWarn: () => {},
      });
      const b = new YBinding(e, doc, {schemaVersion: 1, selfCheck: true});
      b.start();
      e.update(
        () =>
          $getRoot().append(
            $createParagraphNode().append(new LengthGated('alpha beta')),
          ),
        {discrete: true},
      );
      b.initialize();
      await flush();
      doc.transact(() => b.root.format(0, 3, {'f:bold': true}));
      await flush();
      const actual = e.read(() =>
        $getRoot()
          .getAllTextNodes()
          .map(n => [n.getTextContent(), n.getFormat()]),
      );
      expect(actual.every(([, format]) => format === 0)).toBe(true);
      b.dispose();
      doc.destroy();
    },
  );
