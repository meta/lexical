/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The development self-check reads a container back into a fresh editor. A
// node class whose constructor builds a nested editor with
// NestedEditorExtension (the playground's ImageNode, for its caption) needs
// that editor to come from LexicalBuilder: with createEditor it threw
// `LexicalBuilder.fromEditor: The given editor was not created with
// LexicalBuilder`, every self-check of a container holding such a node
// warned `container root could not be read`, and on a remote change the
// binding read the whole container again after it (soak S3-1).

import {
  buildEditorFromExtensions,
  NestedEditorExtension,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  configExtension,
  DecoratorNode,
  defineExtension,
  type LexicalEditor,
  type NodeKey,
  type SerializedLexicalNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YCollabExtension, type YDoc} from '../..';

class CaptionedNode extends DecoratorNode<null> {
  __caption: LexicalEditor;
  static getType(): string {
    return 'soak3-captioned';
  }
  static clone(node: CaptionedNode): CaptionedNode {
    return new CaptionedNode(node.__caption, node.__key);
  }
  static importJSON(): CaptionedNode {
    return new CaptionedNode();
  }
  constructor(caption?: LexicalEditor, key?: NodeKey) {
    super(key);
    // As ImageNode does for its caption.
    this.__caption =
      caption ||
      buildEditorFromExtensions({
        dependencies: [NestedEditorExtension],
        name: 'soak3/caption',
      });
  }
  exportJSON(): SerializedLexicalNode {
    return {...super.exportJSON(), type: 'soak3-captioned', version: 1};
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

function build(doc: YDoc, warnings: string[]) {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        RichTextExtension,
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          selfCheck: true,
          synced: true,
        }),
      ],
      name: 'soak3/s3-1',
      nodes: () => [CaptionedNode],
      onWarn: w => {
        warnings.push(String((w as Error).message));
      },
    }),
  );
}

const tick = () => new Promise(r => setTimeout(r, 0));

test('a node that builds a nested editor in its constructor: no self-check warning', async () => {
  const docA = createYDoc();
  const wa: string[] = [];
  const wb: string[] = [];
  const a = build(docA, wa);
  await tick();
  a.update(
    () => {
      const p = $createParagraphNode().append($createTextNode('before'));
      $getRoot().append(p, new CaptionedNode());
    },
    {discrete: true},
  );
  await tick();
  // B opens the document, then both stay connected.
  const docB = createYDoc();
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
  docA.on('update', u => Y.applyUpdate(docB, u));
  docB.on('update', u => Y.applyUpdate(docA, u));
  const b = build(docB, wb);
  await tick();
  // A structural edit next to it: the self-check reads the root back.
  a.update(
    () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('after')),
      );
    },
    {discrete: true},
  );
  await tick();
  expect(b.read(() => $getRoot().getChildrenSize())).toBe(
    a.read(() => $getRoot().getChildrenSize()),
  );
  expect(wa.filter(w => w.includes('self-check'))).toEqual([]);
  expect(wb.filter(w => w.includes('self-check'))).toEqual([]);
  a.dispose();
  b.dispose();
});
