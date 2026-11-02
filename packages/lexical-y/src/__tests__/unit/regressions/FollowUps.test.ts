/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Regression cases for follow-up findings of the #9400 reviews whose
// original repros were not committed. Each case is named after its finding.
// jsdom: the reconciler runs, so elements derive their text fields from the
// text they render.

import {
  BlockIdExtension,
  blockIdState,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$createQuoteNode} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $setSelection,
  $setState,
  configExtension,
  defineExtension,
  type ElementNode,
} from 'lexical';
import {describe, expect, test, vi} from 'vitest';

import {createYDoc, YCollabExtension, type YDoc} from '../../..';
import {
  $block,
  $createEquation,
  expectConverged,
  freshReader,
  setup,
} from '../../utils/harness';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function client(doc: YDoc, attached: boolean) {
  const warnings: string[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        configExtension(YCollabExtension, {doc, schemaVersion: 1}),
        BlockIdExtension,
      ],
      name: 'regressions-follow-ups',
      onError: e => {
        throw e;
      },
      onWarn: e => {
        warnings.push(String(e && (e as Error).message));
      },
    }),
  );
  if (attached) {
    const element = document.createElement('div');
    element.contentEditable = 'true';
    document.body.appendChild(element);
    editor.setRootElement(element);
  }
  const {binding} = getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output;
  return {binding, editor, warnings};
}

// R16A-2: a headless writer stores a paragraph whose first text is bold with
// textFormat 0 (no reconciler there); a DOM-attached reader derives 1. A
// naming follow-up (`block-id-repair`) that only renames that paragraph is
// taken by the follow-up check for a change of the derived field: refused,
// and its container (the whole root) read again. Not a divergence (the
// re-read gives the same document); a needless whole-container re-read.
// Open (#9568, and listed under Known open issues in #9400).
describe('R16A-2: a naming follow-up on a paragraph whose derived textFormat differs from the stored one', () => {
  test.fails(
    'R16A-2 a DOM-attached reader renames the paragraph: the follow-up is neither refused nor read again',
    async () => {
      const docA = createYDoc();
      const writer = client(docA, false);
      writer.editor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append($createTextNode('Title')),
              $createParagraphNode().append(
                $createTextNode('bold start').toggleFormat('bold'),
                $createTextNode(' plain'),
              ),
            );
        },
        {discrete: true},
      );
      writer.binding.initialize();
      await flush();
      const docB = createYDoc();
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
      const reader = client(docB, true);
      reader.binding.initialize();
      await flush();
      // The binding reports a refused follow-up as a development warning.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      reader.editor.update(
        () => {
          $setState($getRoot().getChildAtIndex(1)!, blockIdState, 'renamed-1');
        },
        {discrete: true, tag: 'block-id-repair'},
      );
      await flush();
      await flush();
      const refused = [
        ...warn.mock.calls.map(call => String(call[0])),
        ...reader.warnings,
      ].filter(w => w.includes('follow-up'));
      warn.mockRestore();
      const read = () =>
        reader.editor
          .getEditorState()
          .read(() => [
            $getState($getRoot().getChildAtIndex(1)!, blockIdState),
            ($getRoot().getChildAtIndex(1) as ElementNode).getTextContent(),
          ]);
      expect(read()).toEqual(['renamed-1', 'bold start plain']);
      expect(refused).toEqual([]);
    },
  );
});

// R15B-F2: A moves a paragraph into a shadow-root quote while B adds a line
// break or an inline node at its end, so the quote holds a raw run with no
// text, which a read shows in a paragraph of its own. B's follow-up then sets
// that paragraph's textFormat or textStyle, which nothing stores: the
// follow-up is refused and read again, and the re-read kept the field the
// read-made paragraph had, so B differed from the peer and a fresh reader
// for good.
describe('R15B-F2: a refused follow-up on the paragraph a read makes around a raw run in a quote', () => {
  for (const inline of ['a line break', 'an equation'] as const) {
    for (const field of ['textFormat', 'textStyle'] as const) {
      test(`R15B-F2 a run holding only ${inline}; the follow-up sets ${field}: the author ends as a fresh reader`, async () => {
        const t = await setup(() =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('Title')),
            $createParagraphNode().append($createTextNode('one')),
            $createParagraphNode().append($createTextNode('end')),
          ),
        );
        t.offline();
        t.a.update(() => {
          const paragraph = $block([1]);
          const quote = $createQuoteNode({shadowRoot: true});
          paragraph.insertBefore(quote);
          quote.append(paragraph);
          $setSelection(null);
        });
        t.b.update(() => {
          const selection = $block([1]).selectEnd();
          if (inline === 'a line break') {
            selection.insertLineBreak();
          } else {
            selection.insertNodes([$createEquation('e')]);
          }
        });
        await t.sync();
        t.b.update(() => {
          const paragraph = $block([1]).getLastChild() as ElementNode;
          if (field === 'textFormat') {
            paragraph.setTextFormat(8);
          } else {
            paragraph.setTextStyle('color: red');
          }
          $setSelection(null);
        }, 'block-id-repair');
        const fresh = await freshReader(t.b);
        await t.sync();
        expect(t.b.json()).toEqual(fresh.json());
        expect(t.b.json()).toEqual(t.a.json());
        await expectConverged(t.peers);
      });
    }
  }
});
