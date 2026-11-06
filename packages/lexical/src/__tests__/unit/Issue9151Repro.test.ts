/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$insertDataTransferForRichText} from '@lexical/clipboard';
import {$createCodeNode, $isCodeNode} from '@lexical/code';
import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
} from 'lexical';
import {initializeUnitTest, invariant} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

const DISJOINT_PRE_HTML =
  '<pre>Some text here</pre> </br><pre>Some more text there</pre>';
const PASTED_TEXT = 'Some text here\n\nSome more text there';

describe('Regression #9151', () => {
  initializeUnitTest(testEnv => {
    test.each([
      ['adjacent pre blocks', '<pre>a</pre><pre>b</pre>', 'a\nb'],
      ['one separator', '<pre>a</pre><br><pre>b</pre>', 'a\n\nb'],
      ['two separators', '<pre>a</pre><br><br><pre>b</pre>', 'a\n\n\nb'],
      [
        'three separators',
        '<pre>a</pre><br><br><br><pre>b</pre>',
        'a\n\n\n\nb',
      ],
      ['one trailing break', '<pre>a</pre><br>', 'a'],
      ['two trailing breaks', '<pre>a</pre><br><br>', 'a\n'],
      ['three trailing breaks', '<pre>a</pre><br><br><br>', 'a\n\n'],
      ['pre whitespace', '<pre>a\n</pre><pre>\n\nb</pre>', 'a\n\n\nb'],
      ['empty pre block', '<pre>a</pre><pre></pre><pre>b</pre>', 'a\n\nb'],
      ['empty paragraph', '<pre>a</pre><p></p><pre>b</pre>', 'a\n\nb'],
      ['trailing pre whitespace', '<pre>a\n</pre>', 'a\n'],
      [
        'mixed list',
        '<pre>a</pre><ul><li>one</li><li>two</li></ul>',
        'a\none\n\ntwo',
      ],
      ['inline run', '<pre>a</pre>x<br>y<pre>b</pre>', 'a\nx\ny\nb'],
      [
        'non-pre first block',
        '<p>x</p><pre>a</pre><pre>b</pre>',
        'x\n\na\n\nb',
      ],
    ])('preserves spacing for %s', async (_name, html, expected) => {
      const {editor} = testEnv;
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/html', html);

      await editor.update(
        () => {
          const code = $createCodeNode();
          $getRoot().append(code);
          code.select();
          const selection = $getSelection();
          invariant($isRangeSelection(selection), 'Expected a range selection');
          $insertDataTransferForRichText(dataTransfer, selection, editor);
        },
        {discrete: true},
      );

      editor.read(() => {
        const code = $getRoot().getFirstChild();
        invariant($isCodeNode(code), 'Expected the existing CodeNode');
        expect(code.getTextContent()).toBe(expected);
      });
    });

    test('preserves every pre block pasted into an empty code block', async () => {
      const {editor} = testEnv;
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/html', DISJOINT_PRE_HTML);

      await editor.update(
        () => {
          const code = $createCodeNode();
          $getRoot().append(code);
          code.select();

          const selection = $getSelection();
          invariant($isRangeSelection(selection), 'Expected a range selection');
          $insertDataTransferForRichText(dataTransfer, selection, editor);
        },
        {discrete: true},
      );

      editor.read(() => {
        const root = $getRoot();
        expect(root.getChildrenSize()).toBe(1);
        const code = root.getFirstChild();
        invariant($isCodeNode(code), 'Expected the existing CodeNode');
        expect(code.getTextContent()).toBe(PASTED_TEXT);
      });
    });

    test('keeps surrounding code and places the caret after all pasted blocks', async () => {
      const {editor} = testEnv;
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/html', DISJOINT_PRE_HTML);

      await editor.update(
        () => {
          const text = $createTextNode('beforeafter');
          $getRoot().append($createCodeNode().append(text));
          text.select('before'.length, 'before'.length);

          const selection = $getSelection();
          invariant($isRangeSelection(selection), 'Expected a range selection');
          $insertDataTransferForRichText(dataTransfer, selection, editor);
        },
        {discrete: true},
      );

      editor.read(() => {
        const code = $getRoot().getFirstChild();
        invariant($isCodeNode(code), 'Expected the existing CodeNode');
        expect(code.getTextContent()).toBe(`before${PASTED_TEXT}after`);

        const selection = $getSelection();
        invariant($isRangeSelection(selection), 'Expected a range selection');
        expect(selection.isCollapsed()).toBe(true);
        expect(selection.anchor.getNode().getTextContent()).toBe(
          `before${PASTED_TEXT}after`,
        );
        expect(selection.anchor.offset).toBe(
          'before'.length + PASTED_TEXT.length,
        );
      });
    });
  });
});
