/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A run merged into a piece by an equal signature, for a text class that
// keeps formats only for text of some lengths (main's pieces:
// a{2}|bcde{1}|fg{0}). Outside the contract: a text class's shown format
// must depend on its class, fields and NodeState only, not on its text
// (DECISIONS D106; #9768 pins the same kind in TextFormatPolicy).
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
import {readLayout3Formats, writeLayout3Formats} from '../../internal/Layout3';
import {flush} from '../utils/harness';

class SizeGated extends TextNode {
  static getType() {
    return 'test_size_gated';
  }
  static clone(n: SizeGated) {
    return new SizeGated(n.__text, n.__key);
  }
  static importJSON(j: SerializedTextNode) {
    return new SizeGated(j.text).updateFromJSON(j);
  }
  constructor(text = '', key?: NodeKey) {
    super(text, key);
  }
  setFormat(f: number | TextFormatType): this {
    const n = this.getTextContent().length;
    return super.setFormat(n === 1 || n === 4 ? f : 0);
  }
  setTextContent(text: string): this {
    super.setTextContent(text);
    return text.length === 1 || text.length === 4 ? this : super.setFormat(0);
  }
}
for (const gc of [false, true])
  test.fails(
    `cached shown attributes follow a same-signature merge gc=${gc}`,
    async () => {
      const doc = createYDoc(null, {gc});
      doc.clientID = 77;
      const e = createEditor({
        nodes: [SizeGated],
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
            $createParagraphNode().append(new SizeGated('abcdefg')),
          ),
        {discrete: true},
      );
      b.initialize();
      await flush();
      const values = readLayout3Formats(b.root);
      // A distinct client owns "de", so "bc" and "de" are separate content items.
      doc.transact(() => {
        b.root.delete(3, 2);
        b.root.insert(3, 'de');
      }, 'raw');
      await flush();
      doc.transact(tr =>
        writeLayout3Formats(
          tr,
          b.root,
          values.map((m, i) =>
            i === 0
              ? new Map([...m, ['f:italic', true]])
              : i >= 1 && i < 5
                ? new Map([...m, ['f:bold', true]])
                : m,
          ),
        ),
      );
      await flush();
      const actual = e.read(() =>
        $getRoot()
          .getAllTextNodes()
          .map(n => [n.getTextContent(), n.getFormat()]),
      );
      expect(actual).toEqual([
        ['a', 2],
        ['bcde', 1],
        ['fg', 0],
      ]);
      b.dispose();
      doc.destroy();
    },
  );
