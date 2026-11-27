/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// ProdE3ReplacedLineCaret (prod-emily3, A6-1): a peer replaces the line
// holding this client's caret, deleting what it showed and inserting the new
// line at the same place in one transaction (an agent's block write racing
// a person typing). The caret went to offset 0 of the replacing line, so the
// next keys landed at the line's start and split the person's word. It now
// keeps its offset in the line that replaced it, clamped to that line's end,
// as `@lexical/yjs` does; where characters of the line are kept it is mapped
// by identity as before, and a line removed with none put at its place
// leaves it where it went before (see LostCaret).

import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $parseSerializedNode,
  $setSelection,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $createBoxNode,
  $createEquation,
  expectConverged,
  flush,
  type Peer,
  setup,
} from '../../utils/harness';

const LINE = 'Weekly active users grew.';

function $doc(next: string) {
  $getRoot().append(
    $createParagraphNode().append($createTextNode('Q3 review')),
    $createParagraphNode().append($createTextNode(LINE)),
    next === 'paragraph'
      ? $createParagraphNode().append($createTextNode('after'))
      : next === 'box'
        ? $createBoxNode().append(
            $createParagraphNode().append($createTextNode('in box')),
          )
        : $createEquation('x^2'),
    $createParagraphNode().append($createTextNode('end')),
  );
}

/** Put `p`'s caret `at` characters into the second line. */
function caretAt(p: Peer, at: number) {
  p.update(() => {
    const t = (
      $getRoot().getChildAtIndex(1) as ElementNode
    ).getFirstChild() as TextNode;
    const s = $createRangeSelection();
    s.anchor.set(t.getKey(), at, 'text');
    s.focus.set(t.getKey(), at, 'text');
    $setSelection(s);
  });
}

function type(p: Peer, text: string) {
  p.update(() => {
    const s = $getSelection();
    if ($isRangeSelection(s)) {
      s.insertText(text);
    }
  });
}

function lines(p: Peer): string[] {
  return p.read(() =>
    $getRoot()
      .getChildren()
      .map(c => c.getTextContent()),
  );
}

/** `text` with `typed` inserted `offset` characters in, clamped. */
function typedAt(text: string, offset: number, typed: string): string {
  const at = Math.min(offset, text.length);
  return text.slice(0, at) + typed + text.slice(at);
}

for (const ids of [
  [1, 2],
  [2, 1],
]) {
  describe(`client ids ${ids.join(' and ')}`, () => {
    for (const typedFirst of [false, true]) {
      for (const how of ['a new node', 'its own JSON (keeps NodeState)']) {
        for (const next of ['paragraph', 'block decorator', 'box']) {
          for (const where of ['end', 'middle']) {
            test(`a peer replaces the caret's line with ${how} (followed by a ${next}, caret at the ${where}${
              typedFirst ? ', after typing there' : ''
            }): the caret keeps its offset in the new line`, async () => {
              const {a, b, sync} = await setup(() => $doc(next), {ids});
              caretAt(b, where === 'end' ? LINE.length : 6);
              let offset = where === 'end' ? LINE.length : 6;
              if (typedFirst) {
                type(b, ' mine');
                offset += ' mine'.length;
                await sync();
              }
              const old = lines(a)[1];
              const replacement = old.replace('grew', 'grew AGENT');
              a.update(() => {
                const line = $getRoot().getChildAtIndex(1) as ElementNode;
                if (how === 'a new node') {
                  line.replace(
                    $createParagraphNode().append($createTextNode(replacement)),
                  );
                } else {
                  const json = line.exportJSON() as unknown as {
                    children: unknown[];
                  };
                  json.children = [
                    {
                      ...(line.getFirstChild() as TextNode).exportJSON(),
                      text: replacement,
                    },
                  ];
                  line.replace($parseSerializedNode(json as never));
                }
              });
              await sync();
              await flush();
              type(b, 'Z');
              await sync();
              await expectConverged([a, b]);
              expect(lines(a)[0]).toBe('Q3 review');
              expect(lines(a)[1]).toBe(typedAt(replacement, offset, 'Z'));
            });
          }
        }
      }
    }

    test('a replacing line shorter than the caret offset: the caret goes to its end', async () => {
      const {a, b, sync} = await setup(() => $doc('paragraph'), {ids});
      caretAt(b, LINE.length);
      a.update(() => {
        ($getRoot().getChildAtIndex(1) as ElementNode).replace(
          $createParagraphNode().append($createTextNode('Short')),
        );
      });
      await sync();
      await flush();
      type(b, 'Z');
      await sync();
      await expectConverged([a, b]);
      expect(lines(a).slice(0, 3)).toEqual(['Q3 review', 'ShortZ', 'after']);
    });

    test('a line replaced by two: the caret keeps its offset in the first', async () => {
      const {a, b, sync} = await setup(() => $doc('paragraph'), {ids});
      caretAt(b, 6);
      a.update(() => {
        const line = $getRoot().getChildAtIndex(1) as ElementNode;
        line.insertAfter(
          $createParagraphNode().append($createTextNode('Second new')),
        );
        line.replace(
          $createParagraphNode().append($createTextNode('First new')),
        );
      });
      await sync();
      await flush();
      type(b, 'Z');
      await sync();
      await expectConverged([a, b]);
      expect(lines(a).slice(0, 4)).toEqual([
        'Q3 review',
        'First Znew',
        'Second new',
        'after',
      ]);
    });

    // A caret in an empty line was after no text there: it stays at the
    // line's start, offset 0, as for a replaced line (#9517).
    test('control: an empty line that keeps its marker filled by a peer: the caret stays at its start', async () => {
      const {a, b, sync} = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('Q3 review')),
            $createParagraphNode(),
            $createParagraphNode().append($createTextNode('after')),
          );
        },
        {ids},
      );
      b.update(() => {
        ($getRoot().getChildAtIndex(1) as ElementNode).select(0, 0);
      });
      a.update(() => {
        ($getRoot().getChildAtIndex(1) as ElementNode).replace(
          $createParagraphNode().append($createTextNode('Filled')),
        );
      });
      await sync();
      await flush();
      type(b, 'Z');
      await sync();
      await expectConverged([a, b]);
      expect(lines(a)).toEqual(['Q3 review', 'ZFilled', 'after']);
    });

    test('control: a peer edits the line keeping its characters: the caret stays after the same text', async () => {
      const {a, b, sync} = await setup(() => $doc('paragraph'), {ids});
      caretAt(b, LINE.length);
      a.update(() => {
        const t = (
          $getRoot().getChildAtIndex(1) as ElementNode
        ).getFirstChild() as TextNode;
        t.spliceText(LINE.indexOf('grew') + 4, 0, ' AGENT');
      });
      await sync();
      await flush();
      type(b, 'Z');
      await sync();
      await expectConverged([a, b]);
      expect(lines(a)[1]).toBe('Weekly active users grew AGENT.Z');
    });

    test('control: a peer removes the line with nothing put at its place: the caret leaves it as before', async () => {
      const {a, b, sync} = await setup(() => $doc('paragraph'), {ids});
      caretAt(b, 6);
      a.update(() => {
        ($getRoot().getChildAtIndex(1) as ElementNode).remove();
      });
      await sync();
      await flush();
      type(b, 'Z');
      await sync();
      await expectConverged([a, b]);
      expect(lines(a).slice(0, 2)).toEqual(['Q3 review', 'Zafter']);
    });

    test('control: a peer replaces the line with a block node: the caret leaves it as for a removed line', async () => {
      const {a, b, sync} = await setup(() => $doc('paragraph'), {ids});
      caretAt(b, 6);
      a.update(() => {
        ($getRoot().getChildAtIndex(1) as ElementNode).replace(
          $createBoxNode().append(
            $createParagraphNode().append($createTextNode('boxed')),
          ),
        );
      });
      await sync();
      await flush();
      type(b, 'Z');
      await sync();
      await expectConverged([a, b]);
      expect(lines(a)).toEqual(['Q3 review', 'boxed', 'Zafter', 'end']);
    });
  });
}

// A styled line replaced: the delete of its text leaves the format items that
// bounded its runs live (see Cursor#delete), and those show nothing. The
// caret took them for what the line still showed and went to the start of
// the new line.
for (const ids of [
  [1, 2],
  [2, 1],
]) {
  for (const style of ['bold', 'a color'] as const) {
    test(`a line with ${style} on a word replaced by a peer: the caret keeps its offset (client ids ${ids.join(' and ')})`, async () => {
      const {a, b, sync} = await setup(
        () => {
          const word = $createTextNode('active');
          if (style === 'bold') {
            word.toggleFormat('bold');
          } else {
            word.setStyle('color: red;');
          }
          $getRoot().append(
            $createParagraphNode().append($createTextNode('Q3 review')),
            $createParagraphNode().append(
              $createTextNode('Weekly '),
              word,
              $createTextNode(' users grew.'),
            ),
            $createParagraphNode().append($createTextNode('after')),
          );
        },
        {ids},
      );
      const offset = 'Weekly active users'.length;
      b.update(() => {
        const texts = (
          $getRoot().getChildAtIndex(1) as ElementNode
        ).getAllTextNodes();
        const last = texts[texts.length - 1];
        const s = $createRangeSelection();
        s.anchor.set(last.getKey(), ' users'.length, 'text');
        s.focus.set(last.getKey(), ' users'.length, 'text');
        $setSelection(s);
      });
      const replacement = LINE.replace('grew', 'grew AGENT');
      a.update(() => {
        ($getRoot().getChildAtIndex(1) as ElementNode).replace(
          $createParagraphNode().append($createTextNode(replacement)),
        );
      });
      await sync();
      await flush();
      type(b, 'Z');
      await sync();
      await expectConverged([a, b]);
      expect(lines(a).slice(0, 3)).toEqual([
        'Q3 review',
        typedAt(replacement, offset, 'Z'),
        'after',
      ]);
    });
  }
}
