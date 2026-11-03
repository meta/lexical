/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// GPT layout 3 review round 12's cells (P8 dormant runs; the text format
// rule of main's #9768).
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type TextFormatType,
  TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YBinding} from '../..';
import {flush} from '../utils/harness';

class ConstructorEnabled extends TextNode {
  __allowsFormat = true;
  $config() {
    return this.config('review_constructor_enabled', {extends: TextNode});
  }
  canHaveFormat() {
    return !!this.__allowsFormat;
  }
  setFormat(f: number | TextFormatType): this {
    return this.__allowsFormat ? super.setFormat(f) : this;
  }
}
function editor() {
  return createEditor({
    nodes: [
      ConstructorEnabled,
      {
        replace: TextNode,
        with: (n: TextNode) => new ConstructorEnabled(n.getTextContent()),
        withKlass: ConstructorEnabled,
      },
    ],
    onError: e => {
      throw e;
    },
    onWarn: () => {},
  });
}
for (const gc of [false, true])
  test(`R12 constructor-enabled formats are retained gc=${gc}`, async () => {
    const doc = createYDoc(null, {gc});
    const e = editor();
    const b = new YBinding(e, doc, {schemaVersion: 1, selfCheck: true});
    b.start();
    e.update(
      () =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode('alpha beta')),
        ),
      {discrete: true},
    );
    b.initialize();
    await flush();
    e.update(
      () => {
        const node = $getRoot().getAllTextNodes()[0];
        node.select(6, 10).formatText('bold');
      },
      {discrete: true},
    );
    await flush();
    const actual = e.read(() =>
      $getRoot()
        .getAllTextNodes()
        .map(n => [n.getTextContent(), n.getFormat(), n.canHaveFormat()]),
    );
    const copy = createYDoc(Y.encodeStateAsUpdate(doc), {gc});
    const e2 = editor();
    const b2 = new YBinding(e2, copy, {schemaVersion: 1, selfCheck: true});
    b2.start();
    b2.initialize();
    await flush();
    const fresh = e2.read(() =>
      $getRoot()
        .getAllTextNodes()
        .map(n => [n.getTextContent(), n.getFormat(), n.canHaveFormat()]),
    );
    expect(actual).toEqual([
      ['alpha ', 0, true],
      ['beta', 1, true],
    ]);
    expect(fresh).toEqual(actual);
    b.dispose();
    b2.dispose();
    doc.destroy();
    copy.destroy();
  });
