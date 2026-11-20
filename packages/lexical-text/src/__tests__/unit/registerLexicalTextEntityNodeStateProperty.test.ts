/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createHashtagNode,
  HashtagExtension,
  HashtagNode,
} from '@lexical/hashtag';
import {$createMarkNode, $isMarkNode, MarkNode} from '@lexical/mark';
import {
  $applyNodeReplacement,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getState,
  $isElementNode,
  $isTextNode,
  $setSelection,
  $setState,
  createEditor,
  createState,
  type ElementNode,
  type LexicalEditor,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {type EntityMatch, registerLexicalTextEntity} from '../..';

/**
 * Property: in random layouts of entities and text in several formats, with
 * NodeState on entities and text and some text in MarkNodes, an edit that
 * turns an entity back into text leaves every character of that entity that
 * is still there with the entity's NodeState (or inside another entity that
 * grew over it, which takes characters with its own NodeState), and inside
 * the same MarkNode. Each entity is written with a letter no other text has,
 * which tells its characters apart after the edit.
 */

const note = createState('note', {
  parse: v => (typeof v === 'string' ? v : ''),
});

class MentionNode extends TextNode {
  $config() {
    return this.config('property-mention', {extends: TextNode});
  }
  isTextEntity(): true {
    return true;
  }
}

const getMentionMatch = (text: string): null | EntityMatch => {
  const m = /@[a-z0-9]+/.exec(text);
  return m === null ? null : {end: m.index + m[0].length, start: m.index};
};

type Kind = 'hashtag' | 'mention';
const SEEDS = Number(process.env.TEXT_ENTITY_NODE_STATE_SEEDS ?? 200);
const ENTITY_LETTERS = 'abcdefghijklmnop';
const PLAIN = [' ', ' ', 'x', 'y', '.', '#', '@', 'xy', ' x '];
const TYPED = [' ', 'x', '#', '.', '@', 'z'];
const FORMATS = [0, 0, 1, 2];

/** Mulberry32, so a failure names a seed that reproduces it. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createEntityEditor(kind: Kind): LexicalEditor {
  const editor = createEditor({
    nodes: [HashtagNode, MentionNode, MarkNode],
    onError: e => {
      throw e;
    },
  });
  editor.setRootElement(document.createElement('div'));
  if (kind === 'hashtag') {
    registerLexicalTextEntity(
      editor,
      HashtagExtension.config!.getHashtagMatch,
      HashtagNode,
      node => $createHashtagNode(node.getTextContent()),
    );
  } else {
    registerLexicalTextEntity(editor, getMentionMatch, MentionNode, node =>
      $applyNodeReplacement(new MentionNode(node.getTextContent())).setMode(
        'token',
      ),
    );
  }
  return editor;
}

const $createEntity = (kind: Kind, text: string): TextNode =>
  kind === 'hashtag'
    ? $createHashtagNode(text)
    : $applyNodeReplacement(new MentionNode(text)).setMode('token');

// The text nodes of the editor with their block, in document order
function $textNodes(): TextNode[] {
  return $getRoot().getAllTextNodes();
}

function $blocks(): ElementNode[] {
  return $getRoot()
    .getChildren()
    .filter((n): n is ElementNode => $isElementNode(n));
}

type Info = {entity: boolean; mark: string; note: string; text: string};
const read = (editor: LexicalEditor): Info[] =>
  editor.read(() =>
    $textNodes().map(n => {
      const parent = n.getParent();
      return {
        entity: n.isTextEntity(),
        mark: $isMarkNode(parent) ? parent.getIDs().join(',') : '',
        note: $getState(n, note),
        text: n.getTextContent(),
      };
    }),
  );

function check(
  label: string,
  before: Info[],
  after: Info[],
  failures: string[],
): void {
  // The entities before the edit, by their own letter
  for (const node of before) {
    if (!node.entity || node.note === '') {
      continue;
    }
    const letter = [...node.text].find(c => ENTITY_LETTERS.includes(c));
    if (letter === undefined) {
      continue;
    }
    for (const now of after) {
      if (!now.text.includes(letter)) {
        continue;
      }
      if (now.note === node.note && now.mark === node.mark) {
        continue;
      }
      // Characters that another entity grew over (an entity takes the text
      // its match extends into with its own NodeState, as before): not at
      // the start of an entity, right after its sigil
      const grownOver = now.entity && now.text.indexOf(letter) > 1;
      if (grownOver) {
        continue;
      }
      failures.push(
        `${label}: the characters of ${JSON.stringify(node)} are in ${JSON.stringify(now)}; before ${JSON.stringify(before)} after ${JSON.stringify(after)}`,
      );
      return;
    }
  }
}

describe('registerLexicalTextEntity keeps NodeState (property)', () => {
  for (const kind of ['hashtag', 'mention'] as Kind[]) {
    test(`${kind}: an edit that turns an entity into text keeps its NodeState and marks on its characters`, () => {
      const failures: string[] = [];
      let demoted = 0;
      for (let seed = 0; seed < SEEDS && failures.length < 3; seed++) {
        const random = rng(seed * 11 + (kind === 'hashtag' ? 1 : 2));
        const pick = <V>(values: readonly V[]): V =>
          values[Math.floor(random() * values.length)];
        const editor = createEntityEditor(kind);
        let letter = 0;
        try {
          editor.update(
            () => {
              const blocks = 1 + Math.floor(random() * 3);
              for (let b = 0; b < blocks; b++) {
                const paragraph = $createParagraphNode();
                const runs = 1 + Math.floor(random() * 5);
                for (let r = 0; r < runs; r++) {
                  let node: TextNode;
                  if (random() < 0.45 && letter < ENTITY_LETTERS.length) {
                    const own = ENTITY_LETTERS[letter++];
                    node = $setState(
                      $createEntity(
                        kind,
                        (kind === 'hashtag' ? '#' : '@') +
                          own +
                          (random() < 0.5 ? '1' : ''),
                      ),
                      note,
                      `e${letter}`,
                    );
                  } else {
                    node = $createTextNode(pick(PLAIN) + pick(PLAIN));
                    if (random() < 0.5) {
                      $setState(node, note, `t${Math.floor(random() * 3)}`);
                    }
                  }
                  node.setFormat(pick(FORMATS));
                  paragraph.append(
                    random() < 0.2
                      ? $createMarkNode([
                          `m${Math.floor(random() * 2)}`,
                        ]).append(node)
                      : node,
                  );
                }
                $getRoot().append(paragraph);
              }
            },
            {discrete: true},
          );
          for (let edit = 0; edit < 4; edit++) {
            const before = read(editor);
            const op = random();
            let description = '';
            editor.update(
              () => {
                const nodes = $textNodes();
                if (nodes.length === 0) {
                  return;
                }
                const node = pick(nodes);
                const offset = Math.floor(
                  random() * (node.getTextContentSize() + 1),
                );
                if (op < 0.35) {
                  const typed = pick(TYPED);
                  description = `type ${JSON.stringify(typed)} at ${nodes.indexOf(node)}:${offset}`;
                  node.select(offset, offset).insertText(typed);
                } else if (op < 0.6) {
                  const backward = random() < 0.5;
                  description = `${backward ? 'backspace' : 'delete'} at ${nodes.indexOf(node)}:${offset}`;
                  node.select(offset, offset).deleteCharacter(backward);
                } else if (op < 0.8) {
                  // Join a block onto the one before it (backspace at its
                  // start)
                  const blocks = $blocks();
                  const block = pick(blocks);
                  description = `join block ${blocks.indexOf(block)}`;
                  const first = block.getFirstDescendant();
                  if ($isTextNode(first)) {
                    first.select(0, 0).deleteCharacter(true);
                  }
                } else {
                  // Delete a range across nodes
                  const other = pick(nodes);
                  const [a, b] =
                    nodes.indexOf(node) <= nodes.indexOf(other)
                      ? [node, other]
                      : [other, node];
                  const selection = $createRangeSelection();
                  const from = Math.min(offset, a.getTextContentSize());
                  const to = Math.floor(
                    random() * (b.getTextContentSize() + 1),
                  );
                  selection.anchor.set(a.getKey(), from, 'text');
                  selection.focus.set(
                    b.getKey(),
                    a === b ? Math.max(from, to) : to,
                    'text',
                  );
                  description = `remove ${nodes.indexOf(a)}:${from}-${nodes.indexOf(b)}:${to}`;
                  $setSelection(selection);
                  selection.removeText();
                }
                $setSelection(null);
              },
              {discrete: true},
            );
            const after = read(editor);
            const entitiesBefore = before.filter(n => n.entity).length;
            const entitiesAfter = after.filter(n => n.entity).length;
            if (entitiesAfter < entitiesBefore) {
              demoted++;
            }
            check(
              `seed ${seed} edit ${edit} ${description}`,
              before,
              after,
              failures,
            );
          }
        } catch (e) {
          failures.push(`seed ${seed}: ${String(e)}`);
        }
      }
      expect(failures).toEqual([]);
      // The property was exercised
      expect(demoted).toBeGreaterThan(SEEDS / 10);
    }, 3_600_000);
  }
});
