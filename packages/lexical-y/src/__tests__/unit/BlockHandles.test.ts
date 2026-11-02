/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The "Handles and collaboration" example of the Block IDs documentation page
// (packages/lexical-website/docs/extensions/block-ids.md): an agent that
// addresses blocks by handle on a server resolves each handle against the
// stored state with the handles it was shown, checks that the block is still
// where and what it read (the whole block), then applies the edit in place to
// the stored state, by id, with the server page's `applyChecked` (from
// `../utils/agentEditSketch`, as written there). Keep the two in sync.

import {
  $getBlockById,
  $getBlockHandle,
  $getBlockHandles,
  $getBlockId,
  $resolveBlockHandle,
  BlockIdExtension,
  blockIdState,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSlotNames,
  $isElementNode,
  $isTextNode,
  $setState,
  type ElementNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

import {
  createYWriter,
  editYState,
  readYState,
  seedYState,
} from '../../headless';
import {$blockAt, applyChecked, type DocStore} from '../utils/agentEditSketch';

// As on the Block IDs page.
// Changes a block's text in place: only the characters that differ, in the
// block's own text nodes. block.replace(newBlock) would re-create the block,
// and what a collaborator types in it meanwhile would not stay where they
// typed it. Returns false, changing nothing, unless the block holds only
// simple text (no tabs, hashtags or other special text nodes), directly or
// in inline elements such as links: no line breaks, nested blocks, named
// slots or decorators, even ones without text. Text added at the edge of an
// inline element that takes no text there (a link) goes beside it, as typing
// does.
function $setBlockText(block: LexicalNode, text: string): boolean {
  if (!$isElementNode(block) || !$holdsOnlyText(block)) {
    return false;
  }
  const nodes = block.getAllTextNodes();
  const old = nodes.map(node => node.getTextContent()).join('');
  let start = 0;
  while (start < old.length && old[start] === text[start]) {
    start++;
  }
  let end = 0;
  while (
    end < old.length - start &&
    end < text.length - start &&
    old[old.length - 1 - end] === text[text.length - 1 - end]
  ) {
    end++;
  }
  const inserted = text.slice(start, text.length - end);
  const deleteEnd = old.length - end;
  let offset = 0;
  let done = false;
  for (const node of nodes) {
    const size = node.getTextContentSize();
    const from = Math.max(start - offset, 0);
    const to = Math.min(deleteEnd - offset, size);
    if (
      !done &&
      (start - offset < size ||
        (start - offset === size && start === deleteEnd))
    ) {
      // The node where the change starts (for an insert at a node boundary,
      // the node before it): delete and insert there.
      if (start === deleteEnd) {
        $insertText(node, from, inserted);
      } else {
        node.spliceText(from, to - from, inserted);
      }
      done = true;
    } else if (to > from) {
      node.spliceText(from, to - from, '');
    }
    offset += size;
  }
  if (!done && inserted !== '') {
    block.append($createTextNode(inserted));
  }
  return true;
}

function $holdsOnlyText(element: ElementNode): boolean {
  // Named slots hold blocks of their own (and count in getTextContent).
  return (
    $getSlotNames(element).length === 0 &&
    element
      .getChildren()
      .every(
        child =>
          ($isTextNode(child) && child.isSimpleText()) ||
          ($isElementNode(child) && child.isInline() && $holdsOnlyText(child)),
      )
  );
}

// Inserts text at `at` in `node`, or, at an edge of inline elements that
// take no text there (canInsertTextAfter or canInsertTextBefore is false, as
// for a link or a mark), beside the outermost of them.
function $insertText(node: TextNode, at: number, text: string): void {
  if (text === '') {
    return;
  }
  const atEnd = at === node.getTextContentSize();
  let outermost: ElementNode | null = null;
  for (
    let inner: LexicalNode = node, parent = node.getParent();
    $isElementNode(parent) && parent.isInline();
    inner = parent, parent = parent.getParent()
  ) {
    if (
      atEnd
        ? inner.getNextSibling() !== null
        : at !== 0 || inner.getPreviousSibling() !== null
    ) {
      break;
    }
    if (atEnd ? !parent.canInsertTextAfter() : !parent.canInsertTextBefore()) {
      outermost = parent;
    }
  }
  if (outermost === null) {
    node.spliceText(at, 0, text);
    return;
  }
  const beside = atEnd
    ? outermost.getNextSibling()
    : outermost.getPreviousSibling();
  if ($isTextNode(beside) && beside.isSimpleText()) {
    beside.spliceText(atEnd ? 0 : beside.getTextContentSize(), 0, text);
  } else if (atEnd) {
    outermost.insertAfter($createTextNode(text));
  } else {
    outermost.insertBefore($createTextNode(text));
  }
}

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Every string one substitution, deletion or insertion away from `s`. */
function oneCharTypos(s: string): string[] {
  const result = new Set<string>();
  for (let i = 0; i < s.length; i++) {
    result.add(s.slice(0, i) + s.slice(i + 1));
    for (const c of ALPHABET) {
      result.add(s.slice(0, i) + c + s.slice(i + 1));
    }
  }
  for (let i = 0; i <= s.length; i++) {
    for (const c of ALPHABET) {
      result.add(s.slice(0, i) + c + s.slice(i));
    }
  }
  result.delete(s);
  return Array.from(result);
}

describe('block handles with @lexical/y', () => {
  test('resolving and checking against the stored state, applying to it in place', async () => {
    const config = {
      extensions: [RichTextExtension, BlockIdExtension],
      onWarn: () => {},
      schemaVersion: 1,
    };
    const agent = createYWriter('Writing assistant');
    const person = createYWriter('Person');
    const seed = seedYState(config, () => {
      for (const [id, text] of [
        // Ids picked for their hashes: p13e and p20d, p18f and p2cs, p1i4
        // and p2pq each start with the same 4 characters.
        ['p13e', 'Q3 plan'],
        ['wxyz2222', 'Revenue grew 4%.'],
        ['p18f', 'Hiring is on track.'],
        ['p1i4', 'Shares its hash start'],
        ['p2pq', 'with this one'],
      ]) {
        const node = $createParagraphNode().append($createTextNode(text));
        $setState(node, blockIdState, id);
        $getRoot().append(node);
      }
    });
    const handlesOf = (state: Uint8Array) =>
      readYState(state, config, () =>
        $getRoot()
          .getChildren()
          .map(node => [$getBlockHandle(node), node.getTextContent()]),
      );
    const merge = (...updates: Uint8Array[]) =>
      Y.mergeUpdates(updates as Uint8Array<ArrayBuffer>[]);

    // At the read: `seen` is the state the model reads; keep the handles it
    // is shown with it, and each block it read as a whole.
    const seen = seed;
    const shown = readYState(seen, config, () => $getBlockHandles());
    const read = new Map(
      readYState(seen, config, () =>
        $getRoot()
          .getChildren()
          .map(node => {
            const id = $getBlockId(node)!;
            return [id, $blockAt(id)];
          }),
      ),
    );

    // The documented steps, for one op, on a store that holds `stored`.
    const applyByHandle = async (
      stored: Uint8Array,
      op: {block: string; text: string},
    ): Promise<{stored: Uint8Array; told: string | null}> => {
      let state = stored;
      const store: DocStore = {
        load: async () => ({state, version: 0}),
        send: () => {},
        storeIf: async (_version, next) => {
          state = next;
          return true;
        },
      };
      let id = '';
      const refused = await applyChecked(
        store,
        config,
        () => {
          const result = $resolveBlockHandle(op.block, {read: shown});
          if (result.status !== 'found') {
            return [result.status];
          }
          id = $getBlockId(result.node)!;
          if ($blockAt(id) !== read.get(id)) {
            return ['changed' as const];
          }
          return $isElementNode(result.node) && $holdsOnlyText(result.node)
            ? []
            : ['not just text' as const];
        },
        () =>
          $setBlockText($getBlockById(id)!, op.text)
            ? []
            : ['not just text' as const],
      );
      return {stored: state, told: refused?.failures[0] ?? null};
    };

    // What the model reads.
    expect(handlesOf(seen)).toEqual([
      ['0ydd', 'Q3 plan'],
      ['GAZ0', 'Revenue grew 4%.'],
      ['NnGk', 'Hiring is on track.'],
      ['KwuaJ', 'Shares its hash start'],
      ['KwuaB', 'with this one'],
    ]);

    // Meanwhile, a person types in the block the model rewrites, deletes the
    // third and fourth blocks, and adds one whose hash starts like the
    // first's.
    const typed = editYState(
      seed,
      config,
      () => {
        const [, revenue, hiring] = $getRoot().getChildren();
        assert($isElementNode(revenue));
        const text = revenue.getFirstDescendant();
        assert($isTextNode(text));
        // "Revenue grew |4%." → "Revenue grew about 4%."
        text.spliceText(13, 0, 'about ');
        hiring.remove();
        $getBlockById('p1i4')!.remove();
        const node = $createParagraphNode().append($createTextNode('Q4 plan'));
        $setState(node, blockIdState, 'p20d');
        $getRoot().append(node);
      },
      {writer: person},
    );
    let stored = typed.state;

    // The model's answers, made from what it read.
    const told: (string | null)[] = [];
    for (const op of [
      {block: 'GAZ0', text: 'Revenue grew 6%.'},
      // Deleted since the read.
      {block: 'NnGk', text: 'Hiring is ahead.'},
      // Deleted since the read, though p2pq's hash shares its start.
      {block: 'KwuaJ', text: 'Edited'},
      // A block added since shares the prefix: still the block read.
      {block: '0ydd', text: 'Q3 goals'},
    ]) {
      const result = await applyByHandle(stored, op);
      stored = result.stored;
      told.push(result.told);
    }
    // The person typed in the block the model rewrites: sent back to read
    // again, instead of merging the two.
    expect(told).toEqual(['changed', 'not-found', 'not-found', null]);
    expect(
      readYState(stored, config, () => $resolveBlockHandle('Kwua').status),
    ).toBe('found');
    // The edit landed in place, and the block the person typed in keeps
    // their text.
    expect(readYState(stored, config, () => $getRoot().getTextContent())).toBe(
      'Q3 goals\n\nRevenue grew about 4%.\n\nwith this one\n\nQ4 plan',
    );

    // A prefix freed by a deletion and taken by a block added since: without
    // the read it names the new block, with it the block read is gone.
    const reused = editYState(
      seed,
      config,
      () => {
        $getBlockById('p18f')!.remove();
        const node = $createParagraphNode().append($createTextNode('New'));
        $setState(node, blockIdState, 'p2cs');
        $getRoot().append(node);
      },
      {writer: person},
    ).state;
    expect(
      readYState(reused, config, () => $resolveBlockHandle('NnGk').status),
    ).toBe('found');
    expect(
      (await applyByHandle(reused, {block: 'NnGk', text: 'Hiring is ahead.'}))
        .told,
    ).toBe('not-found');

    // Resolved inside the edit of the read instead, the deleted block is
    // always found.
    expect(
      readYState(seen, config, () => $resolveBlockHandle('NnGk').status),
    ).toBe('found');

    // Why in place: replacing the block re-creates it, and the person's
    // concurrent typing no longer stays where they typed it.
    const {update: replaced} = editYState(
      seen,
      config,
      () => {
        $getBlockById('wxyz2222')!.replace(
          $createParagraphNode().append($createTextNode('Revenue grew 6%.')),
        );
      },
      {writer: agent},
    );
    expect(
      readYState(merge(typed.state, replaced!), config, () =>
        $getRoot().getTextContent(),
      ),
    ).toBe('Q3 plan\n\nabout Revenue grew 6%.\n\nwith this one\n\nQ4 plan');
  });
});

describe('block handles of derived ids', () => {
  test('lines written without BlockIdExtension, read with it: derived ids get short, typo-safe handles', () => {
    const plain = {
      extensions: [RichTextExtension],
      onWarn: () => {},
      schemaVersion: 1,
    };
    const withIds = {
      ...plain,
      extensions: [RichTextExtension, BlockIdExtension],
    };
    // A document written by clients without BlockIdExtension: a seed, then
    // lines appended by two writers.
    let state = seedYState(plain, () => {
      for (let i = 0; i < 100; i++) {
        $getRoot().append(
          $createParagraphNode().append($createTextNode(`Seeded line ${i}`)),
        );
      }
    });
    for (const writer of [createYWriter('First'), createYWriter('Second')]) {
      for (let round = 0; round < 3; round++) {
        state = editYState(
          state,
          plain,
          () => {
            for (let i = 0; i < 50; i++) {
              $getRoot().append(
                $createParagraphNode().append(
                  $createTextNode(`${writer.author} line ${round}.${i}`),
                ),
              );
            }
          },
          {writer},
        ).state;
      }
    }
    const result = readYState(state, withIds, () => {
      const blocks = $getRoot().getChildren();
      const handles = $getBlockHandles();
      let tried = 0;
      let hits = 0;
      for (const [id, handle] of handles) {
        for (const typo of oneCharTypos(handle)) {
          tried++;
          const found = $resolveBlockHandle(typo);
          if (found.status === 'found' && $getBlockId(found.node) !== id) {
            hits++;
            // Only by being that block's handle (or a longer prefix of its
            // hash, never shorter).
            expect(
              typo.startsWith(handles.get($getBlockId(found.node)!)!),
            ).toBe(true);
          }
        }
      }
      return {
        hits,
        ids: blocks.map(block => $getBlockId(block)),
        lengths: Array.from(handles.values(), handle => handle.length),
        resolved: blocks.every(block => {
          const found = $resolveBlockHandle(handles.get($getBlockId(block)!)!);
          return found.status === 'found' && found.node.is(block);
        }),
        tried,
      };
    });
    expect(result.ids).toHaveLength(400);
    // Every line shows an id derived from its Yjs identity.
    for (const id of result.ids) {
      expect(id).toMatch(/^y[0-9a-z]+_[0-9a-z]+/);
    }
    expect(new Set(result.ids).size).toBe(400);
    // Ids of one client share their first characters, and their clocks are
    // close: handles still take 4 or 5 characters.
    expect(Math.min(...result.lengths)).toBe(4);
    expect(Math.max(...result.lengths)).toBeLessThanOrEqual(5);
    expect(result.resolved).toBe(true);
    expect(result.hits / result.tried).toBeLessThan(1e-3);
  });
});
