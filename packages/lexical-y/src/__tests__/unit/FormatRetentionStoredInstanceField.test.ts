/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Canonical stored formats on a text class whose instances declare in
// their constructor that they keep formats: the stored bold reads back.
import {
  $create,
  $createParagraphNode,
  $getRoot,
  createEditor,
  type TextFormatType,
  TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YBinding} from '../..';
import {readLayout3Formats, writeLayout3Formats} from '../../internal/Layout3';
import {flush} from '../utils/harness';

class Enabled extends TextNode {
  __allowsFormat = true;
  $config() {
    return this.config('test_format_enabled', {extends: TextNode});
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
    nodes: [Enabled],
    onError: e => {
      throw e;
    },
    onWarn: () => {},
  });
}
for (const gc of [false, true])
  test(`canonical stored formats survive a constructor-dependent declaration gc=${gc}`, async () => {
    const doc = createYDoc(null, {gc});
    const e = editor();
    const b = new YBinding(e, doc, {schemaVersion: 1, selfCheck: true});
    b.start();
    e.update(
      () =>
        $getRoot().append(
          $createParagraphNode().append(
            $create(Enabled).setTextContent('alpha beta'),
          ),
        ),
      {discrete: true},
    );
    b.initialize();
    await flush();
    const root = b.root;
    const values = readLayout3Formats(root);
    doc.transact(tr =>
      writeLayout3Formats(
        tr,
        root,
        values.map((v, i) =>
          i >= 6 && i < 10 ? new Map([...v, ['f:bold', true]]) : v,
        ),
      ),
    );
    await flush();
    const actual = e.read(() =>
      $getRoot()
        .getAllTextNodes()
        .map(n => [n.getTextContent(), n.getFormat(), n.canHaveFormat()]),
    );
    expect(actual).toEqual([
      ['alpha ', 0, true],
      ['beta', 1, true],
    ]);
    b.dispose();
    doc.destroy();
  });
