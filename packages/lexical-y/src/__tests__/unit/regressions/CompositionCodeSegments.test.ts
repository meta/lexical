/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// #9577: a code token that NodeState splits into several highlight nodes
// shares one segment. While the editor composes in the last of them, a read
// of the line reused the composed node, by that segment, for the text before
// it, and then again for the composed text: the text before was lost, and
// the composing client wrote the line without it when the composition ended.
// The document and the two remote updates were captured from a randomized
// soak (seed 8109294 of the L2 harness).

import {CodePrismExtension} from '@lexical/code-prism';
import {
  BlockIdExtension,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
  NodeStructureExtension,
} from '@lexical/extension';
import {LinkExtension} from '@lexical/link';
import {ListExtension} from '@lexical/list';
import {MarkStateExtension} from '@lexical/mark';
import {RichTextExtension} from '@lexical/rich-text';
import {TableExtension} from '@lexical/table';
import * as Y from '@y/y';
import {
  $getNodeByKey,
  $getRoot,
  $isTextNode,
  $setCompositionKey,
  configExtension,
  defineExtension,
  type LexicalEditor,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YCollabExtension, type YDoc} from '../../..';

// A document whose code block line is
// `const t44z = fetch(t45z); // t46z note t47zt48z t49z t50z t51z`, its
// comment token stored as three highlight nodes, `// t46z note t47z`,
// `t48z t49z` (commented `c3`) and ` t50z t51z`.
const DOC =
  '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';

// Two changes another client made to that line's comment ids, as they reached
// the composing client. Neither removes text.
const REMOTE = [
  'AQ3s0NeCAwLG0NDXggMVof2LjMeS4QGRAQxzOm1hcmtJZHMfYzMEdHJ1Zcbs0NeCAwKh/YuMx5LhAZEBAWsKImRldDZqdy4yIsah/YuMx5LhAaMB0NDXggMWAWsEbnVsbMbs0NeCAwTQ0NeCAxYMczptYXJrSWRzH2MzBG51bGzG5qn1nqryjgcMof2LjMeS4QGmAQFrCiJkZXQ2ancuMiLG5qn1nqryjgcNof2LjMeS4QGvAQFrCiJkZXQ2ajQubCLG0NDXggMc0NDXggMdAWsEbnVsbMbs0NeCAweh/YuMx5LhAa8BDHM6bWFya0lkcx9jMwR0cnVlxuzQ14IDCaH9i4zHkuEBrwEBawoiZGV0Nmp3LjIixtDQ14IDKNDQ14IDKQFrBG51bGzG7NDXggML0NDXggMpDHM6bWFya0lkcx9jMwRudWxsxuXQ14IDBKH9i4zHkuEBvAEMczpzdWdnZXN0H3M0BHRydWXGof2LjMeS4QG/AaH9i4zHkuEBwAEMczpzdWdnZXN0H3M0BG51bGwDof2LjMeS4QECkAEBpAEB7NDXggMBCAHQ0NeCAwUWARwBHwEjASYB',
  'AQfX0NeCAy3G0NDXggMVof2LjMeS4QGRAQFrCyJkZXQ2amIuMTkixqH9i4zHkuEBowHQ0NeCAxYBawRudWxsxuap9Z6q8o4HDKH9i4zHkuEBpgEBawsiZGV0NmpiLjE5IsbmqfWeqvKOBw2h/YuMx5LhAa8BAWsKImRldDZqNC5sIsbQ0NeCAxzQ0NeCAx0BawRudWxsxtfQ14IDMKH9i4zHkuEBrwEBawsiZGV0NmpiLjE5IsbQ0NeCAyjQ0NeCAykBawRudWxsCZmH3oiPq/sPAQkFkrTwz5DXpQ4BAAnwptTd6JjKDQEICJyq1fjQ78kLAQgE5qn1nqryjgcCAAgKA6H9i4zHkuEBDJABAaQBAfgBBbgCCcoCB9YCAtkCBOECDe8CBK0DArQDEckDHN7Q14IDAQEB19DXggMCCiMxAdDQ14IDBwAJDQgWARwBHwEjASYB',
];

const LINE = 'const t44z = fetch(t45z); // t46z note t47zt48z t49z t50z t51z';

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

const idle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

function client(doc: YDoc): LexicalEditor {
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        BlockIdExtension,
        NodeStructureExtension,
        RichTextExtension,
        ListExtension,
        LinkExtension,
        TableExtension,
        CodePrismExtension,
        MarkStateExtension,
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          selfCheck: true,
        }),
      ],
      name: 'composition-code-segments',
      onError: (e: Error) => {
        throw e;
      },
    }),
  );
  getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output.binding.initialize();
  return editor;
}

const codeLine = (editor: LexicalEditor) =>
  editor.getEditorState().read(() =>
    $getRoot()
      .getTextContent()
      .split('\n')
      .find(l => l.includes('t45z')),
  );

describe('#9577: composing in a code token split by NodeState', () => {
  test.each([[true], [false]])(
    'remote comment id changes to the line keep its text (composing: %s)',
    async composing => {
      const doc = createYDoc();
      doc.clientID = 777;
      Y.applyUpdate(doc, b64(DOC), 'load');
      const editor = client(doc);
      await idle();
      expect(codeLine(editor)).toBe(LINE);
      // compositionstart, then " t" right after "t50z".
      let key = '';
      let at = 0;
      if (composing) {
        editor.update(
          () => {
            for (const n of $getRoot().getAllTextNodes()) {
              const i = n.getTextContent().indexOf('t50z');
              if (i >= 0) {
                key = n.getKey();
                at = i + 4;
                n.select(at, at);
                $setCompositionKey(key);
                return;
              }
            }
          },
          {discrete: true},
        );
        editor.update(
          () => {
            const n = $getNodeByKey(key) as TextNode;
            const t = n.getTextContent();
            n.setTextContent(t.slice(0, at) + ' t' + t.slice(at));
            n.select(at + 2, at + 2);
          },
          {discrete: true},
        );
        await idle();
      }
      const expected = composing ? LINE.replace('t50z', 't50z t') : LINE;
      for (const u of REMOTE) {
        Y.applyUpdate(doc, b64(u), 'remote');
        await idle();
        expect(codeLine(editor)).toBe(expected);
        // The composition stays in its node (in a browser, the DOM text node
        // the IME composes in).
        expect(
          editor
            .getEditorState()
            .read(() => $getNodeByKey(key)?.isAttached() ?? false),
        ).toBe(composing);
      }
      if (composing) {
        // compositionend
        editor.update(
          () => {
            $setCompositionKey(null);
            const n = $getNodeByKey(key);
            if ($isTextNode(n) && n.isAttached()) {
              n.getWritable();
            }
          },
          {discrete: true},
        );
        await idle();
      }
      expect(codeLine(editor)).toBe(expected);
      // What every client reads from the document now.
      const stored = createYDoc();
      Y.applyUpdate(stored, Y.encodeStateAsUpdate(doc));
      const reader = client(stored);
      await idle();
      expect(codeLine(reader)).toBe(expected);
    },
  );
});
