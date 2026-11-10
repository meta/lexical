/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A composes at the end of a line. B replaces that line with a block of
// another class (or a new block of the same class) holding its text, and adds
// a block after it. The writer matched a line marker to any marker, so the
// common suffix gave the old line's marker to B's new block; every reader
// keys a line by its marker, so on A the composed text node, and the line
// held while composing, moved to the new block. Ending the composition then
// re-tokenized that block with A's code highlighter, dropping its format and
// NodeState, or wrote the text A typed into it. A marker now stays with the
// line that continues the line it ended (DECISIONS.md D118).

import {$createCodeNode, $isCodeNode, CodeHighlightNode} from '@lexical/code';
import {PrismTokenizer, registerCodeHighlighting} from '@lexical/code-prism';
import {autoLinkUrlMatcher, registerAutoLink} from '@lexical/link';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getState,
  $isRangeSelection,
  $isTextNode,
  $setCompositionKey,
  $setSelection,
  $setState,
  createState,
  type ElementNode,
  type LexicalEditor,
  stringValue,
  TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import {
  $createEquation,
  $selectIn,
  expectConverged,
  freshReader,
  NODES,
  setup,
} from '../../utils/harness';

const note = createState('note', {parse: stringValue()});

/** Uppercases the text of a heading or quote (a parent-dependent transform). */
const upper = (editor: LexicalEditor) =>
  editor.registerNodeTransform(TextNode, node => {
    const parent = node.getParent();
    if (parent !== null && parent.getType() === 'quote') {
      const text = node.getTextContent();
      if (text !== text.toUpperCase()) {
        node.setTextContent(text.toUpperCase());
      }
    }
  });

const autoLink = (editor: LexicalEditor) =>
  registerAutoLink(editor, {
    changeHandlers: [],
    excludeParents: [],
    matchers: [autoLinkUrlMatcher],
  });

/**
 * A composes `typed` at the end of the second block, in an editor attached
 * to the DOM as an input method composes; returns the node's key.
 */
function compose(editor: LexicalEditor, typed: string): string {
  const host = document.createElement('div');
  host.contentEditable = 'true';
  document.body.append(host);
  editor.setRootElement(host);
  host.focus();
  onTestFinished(() => {
    editor.setRootElement(null);
    host.remove();
  });
  let key = '';
  editor.update(
    () => {
      const block = $getRoot().getChildAtIndex(1) as ElementNode;
      const text = block.getAllTextNodes().at(-1)!;
      text.select(text.getTextContentSize(), text.getTextContentSize());
      key = text.getKey();
      $setCompositionKey(key);
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        selection.insertText(typed);
      }
    },
    {discrete: true},
  );
  return key;
}

/** The index of the top-level block holding node `key`, -1 if detached. */
const $blockOf = (key: string): number => {
  const node = $getNodeByKey(key);
  return node === null || !node.isAttached()
    ? -1
    : node.getTopLevelElementOrThrow().getIndexWithinParent();
};

const $untouchedBlock = (kind: 'code' | 'paragraph') => {
  const text = $setState(
    $createTextNode('let untouched = 1;').setFormat('underline'),
    note,
    'old',
  );
  return (
    kind === 'code' ? $createCodeNode('javascript') : $createParagraphNode()
  ).append(text);
};

/** The untouched block's text nodes: class, format, note. */
const $untouched = () =>
  ($getRoot().getLastChildOrThrow() as ElementNode)
    .getAllTextNodes()
    .map(n => `${n.getType()}:${n.getFormat()}:${$getState(n, note)}`)
    .join(' ');

for (const gc of [false, true]) {
  for (const ids of [
    [33, 11, 22],
    [33, 22, 11],
  ]) {
    describe(`gc ${gc}, ids ${ids.join(',')}`, () => {
      test('a line replaced by a quote with a code block added after it: the composition stays on the quote, the code block keeps its format and NodeState', async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode('intro')),
              $createParagraphNode().append($createTextNode('see ')),
            ),
          {gc, ids, nodes: [...NODES, CodeHighlightNode], prepare: upper},
        );
        onTestFinished(() => t.peers.forEach(p => p.stop()));
        const {a, b} = t;
        // Only the composing client highlights code.
        onTestFinished(registerCodeHighlighting(a.editor, PrismTokenizer));
        const key = compose(a.editor, 'word');
        await t.sync();
        b.update(() => {
          const line = $getRoot().getChildAtIndex(1) as ElementNode;
          const quote = $createQuoteNode().append(...line.getChildren());
          line.replace(quote);
          quote.insertAfter($untouchedBlock('code'));
          $setSelection(null);
        });
        await t.sync();
        // The composed text node is not the code block's (B's quote has a new
        // marker, see D118, so the node does not go with the old one).
        expect(a.read(() => $blockOf(key))).not.toBe(2);
        a.update(() => {
          $setCompositionKey(null);
          const n = $getNodeByKey(key);
          if ($isTextNode(n) && n.isAttached()) {
            n.getWritable();
          }
          $setSelection(null);
        });
        await t.sync();
        await t.sync();
        const fresh = await freshReader(a);
        onTestFinished(() => fresh.stop());
        for (const peer of [...t.peers, fresh]) {
          expect(peer.read($untouched)).toBe('text:8:old');
          expect(
            peer.read(() =>
              $getRoot()
                .getChildren()
                .map(n => n.getTextContent()),
            ),
          ).toEqual(['intro', 'SEE WORD', 'let untouched = 1;']);
        }
        await expectConverged(t.peers);
      });

      test('a code block replaced by a code block with a paragraph added after it: text typed as the composition ends stays in the code block', async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode('intro')),
              $createCodeNode('javascript').append($createTextNode('see ')),
            ),
          {gc, ids, nodes: [...NODES, CodeHighlightNode], prepare: autoLink},
        );
        onTestFinished(() => t.peers.forEach(p => p.stop()));
        const {a, b} = t;
        const key = compose(a.editor, 'https://lexical.dev');
        await t.sync();
        b.update(() => {
          const line = $getRoot().getChildAtIndex(1) as ElementNode;
          const code = $createCodeNode('javascript').append(
            ...line.getChildren(),
          );
          line.replace(code);
          code.insertAfter($untouchedBlock('paragraph'));
          $setSelection(null);
        });
        await t.sync();
        expect(a.read(() => $blockOf(key))).not.toBe(2);
        a.update(() => {
          $setCompositionKey(null);
          const n = $getNodeByKey(key);
          if ($isTextNode(n) && n.isAttached()) {
            n.select(n.getTextContentSize(), n.getTextContentSize());
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              selection.insertText(' z');
            }
          }
          $setSelection(null);
        });
        await t.sync();
        await t.sync();
        const fresh = await freshReader(a);
        onTestFinished(() => fresh.stop());
        for (const peer of [...t.peers, fresh]) {
          const blocks = peer.read(() =>
            $getRoot()
              .getChildren()
              .map(n => [$isCodeNode(n), n.getTextContent()]),
          );
          expect(blocks[2]).toEqual([false, 'let untouched = 1;']);
          expect(blocks[1][0]).toBe(true);
          expect(peer.read($untouched)).toBe('text:8:old');
        }
        await expectConverged(t.peers);
      });
    });
  }
}

// A split, a join and a line remade with a line added after it keep the old
// marker where the diff kept it (D118: the tail of a split, the line a join
// ends with), so a collaborator's concurrent change of the line's attributes
// (its alignment, its type) stays with the line that holds its end.
type Change = 'centers' | 'makes it a heading';
const $change = (change: Change, index: number) => {
  const line = $getRoot().getChildAtIndex(index) as ElementNode;
  if (change === 'centers') {
    line.setFormat('center');
  } else {
    line.replace($createHeadingNode('h2').append(...line.getChildren()));
  }
  $setSelection(null);
};
const $shape = () =>
  $getRoot()
    .getChildren()
    .map(
      n =>
        `${n.getType()}${(n as ElementNode).getFormatType()}:${n.getTextContent()}`,
    );

for (const gc of [false, true]) {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    for (const change of ['centers', 'makes it a heading'] as const) {
      describe(`gc ${gc}, ids ${ids.join(',')}, a collaborator ${change} the line`, () => {
        const run = async (
          init: () => void,
          $edit: () => void,
          index: number,
          want: string[],
        ) => {
          const t = await setup(init, {gc, ids});
          onTestFinished(() => t.peers.forEach(p => p.stop()));
          t.offline();
          t.a.update($edit);
          t.b.update(() => $change(change, index));
          await t.sync();
          const fresh = await freshReader(t.a);
          onTestFinished(() => fresh.stop());
          for (const peer of [...t.peers, fresh]) {
            expect(peer.read($shape)).toEqual(want);
          }
          await expectConverged(t.peers);
        };
        const changed = (type: string, text: string) =>
          change === 'centers' ? `${type}center:${text}` : `heading:${text}`;

        test('Enter in a line that ends with an inline node: the tail keeps the change', () =>
          run(
            () =>
              $getRoot().append(
                $createParagraphNode().append(
                  $createTextNode('hello world'),
                  $createEquation('x^2'),
                ),
              ),
            () => {
              $selectIn([0], 6).insertParagraph();
              $setSelection(null);
            },
            0,
            ['paragraph:hello ', changed('paragraph', 'world')],
          ));

        test("app code that splits a line (the head's text set, a line added holding the tail): the tail keeps the change", () =>
          run(
            () =>
              $getRoot().append(
                $createParagraphNode().append($createTextNode('hello world')),
              ),
            () => {
              const line = $getRoot().getFirstChildOrThrow() as ElementNode;
              (line.getFirstChildOrThrow() as TextNode).setTextContent(
                'hello ',
              );
              line.insertAfter(
                $createParagraphNode().append($createTextNode('world')),
              );
              $setSelection(null);
            },
            0,
            ['paragraph:hello ', changed('paragraph', 'world')],
          ));

        test("app code that sets a line's text to its start and adds a line holding its end before it: the line keeps the change", () =>
          run(
            () =>
              $getRoot().append(
                $createParagraphNode().append($createTextNode('hello world')),
              ),
            () => {
              const line = $getRoot().getFirstChildOrThrow() as ElementNode;
              (line.getFirstChildOrThrow() as TextNode).setTextContent(
                'hello ',
              );
              line.insertBefore(
                $createParagraphNode().append($createTextNode('world')),
              );
              $setSelection(null);
            },
            0,
            ['paragraph:world', changed('paragraph', 'hello ')],
          ));

        // An accepted limit (D118): the remade line gets a new marker, so the
        // change is dropped (before, it was applied to the added line).
        test.fails(
          'a line remade with the same text, with a line added after it: the remade line keeps the change',
          () =>
            run(
              () =>
                $getRoot().append(
                  $createParagraphNode().append($createTextNode('abc')),
                ),
              () => {
                const line = $getRoot().getFirstChildOrThrow();
                const remade = $createParagraphNode().append(
                  $createTextNode('abc'),
                );
                line.replace(remade);
                remade.insertAfter(
                  $createParagraphNode().append($createTextNode('xyz')),
                );
                $setSelection(null);
              },
              0,
              [changed('paragraph', 'abc'), 'paragraph:xyz'],
            ),
        );

        test('Backspace at the start of a line, with a line added after it: the joined line keeps the change', () =>
          run(
            () =>
              $getRoot().append(
                $createParagraphNode().append($createTextNode('one')),
                $createParagraphNode().append($createTextNode('two')),
              ),
            () => {
              $selectIn([1], 0).deleteCharacter(true);
              $getRoot().append(
                $createParagraphNode().append($createTextNode('added')),
              );
              $setSelection(null);
            },
            1,
            [changed('paragraph', 'onetwo'), 'paragraph:added'],
          ));
      });
    }
  }
}

// A removes the lines after a line while composing in one of them, and B
// typed into it at the same time (held on A): no line continues the removed
// lines' markers, so the line before keeps one by position, as before, and
// B's character joins its end rather than the next line's text or a line of
// its own (D118).
for (const gc of [false, true]) {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`lines removed after a line while a collaborator typed in one of them (gc ${gc}, ids ${ids.join(',')}): the typed character joins the line before, as before`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('zero')),
            $createParagraphNode().append($createTextNode('one')),
            $createParagraphNode().append($createTextNode('two')),
          ),
        {gc, ids},
      );
      onTestFinished(() => t.peers.forEach(p => p.stop()));
      const {a, b} = t;
      a.update(() => {
        const text = (
          $getRoot().getChildAtIndex(2) as ElementNode
        ).getFirstChildOrThrow() as TextNode;
        text.select(1, 1);
        $setCompositionKey(text.getKey());
      });
      b.update(() => {
        $selectIn([2], 1).insertText('R');
        $setSelection(null);
      });
      await t.sync();
      a.update(() => {
        $getRoot().getChildAtIndex(2)!.remove();
        $getRoot().getChildAtIndex(1)!.remove();
        // The caret ends at the end of the line before.
        $getRoot().getFirstChildOrThrow().selectEnd();
      });
      await t.sync();
      a.update(() => $setCompositionKey(null));
      await t.sync();
      const fresh = await freshReader(a);
      onTestFinished(() => fresh.stop());
      for (const peer of [...t.peers, fresh]) {
        expect(
          peer.read(() =>
            $getRoot()
              .getChildren()
              .map(n => n.getTextContent()),
          ),
        ).toEqual(['zeroR']);
      }
      await expectConverged(t.peers);
    });
  }
}

// Two collaborators delete across the same lines at once, and one of them
// also replaces the line that is left and adds a line next to it: that line
// gets a new marker, as before. Kept, its old marker (which the other
// client's join deletes) left it without a boundary, joined to the added
// line (D118).
for (const gc of [false, true]) {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    for (const added of ['after', 'before'] as const) {
      test(`concurrent deletes across lines, one replacing the line left and adding a line ${added} it (gc ${gc}, ids ${ids.join(',')}): every line keeps its boundary`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              ...['AB', 'CDEF', 'G'].map(text =>
                $createParagraphNode().append($createTextNode(text)),
              ),
            ),
          {gc, ids},
        );
        onTestFinished(() => t.peers.forEach(p => p.stop()));
        t.offline();
        t.a.update(() => {
          const texts = $getRoot().getAllTextNodes();
          const selection = texts[0].select(2, 2);
          selection.focus.set(texts[1].getKey(), 2, 'text');
          selection.removeText();
          $setSelection(null);
        });
        t.b.update(() => {
          const texts = $getRoot().getAllTextNodes();
          const selection = texts[0].select(1, 1);
          selection.focus.set(texts[1].getKey(), 4, 'text');
          selection.removeText();
          const line = $getRoot().getFirstChildOrThrow() as ElementNode;
          const next = $createParagraphNode().append(...line.getChildren());
          line.replace(next);
          const extra = $createParagraphNode().append($createTextNode('ADDED'));
          if (added === 'after') {
            next.insertAfter(extra);
          } else {
            next.insertBefore(extra);
          }
          $setSelection(null);
        });
        await t.sync();
        await t.sync();
        const fresh = await freshReader(t.a);
        onTestFinished(() => fresh.stop());
        const want =
          added === 'after' ? ['A', 'ADDED', 'G'] : ['ADDED', 'A', 'G'];
        for (const peer of [...t.peers, fresh]) {
          expect(
            peer.read(() =>
              $getRoot()
                .getChildren()
                .map(n => n.getTextContent()),
            ),
          ).toEqual(want);
        }
        await expectConverged(t.peers);
      });
    }
  }
}
