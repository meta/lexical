/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A composes in a code block. B joins the block into the line before it (a
// paragraph or a list item holding an underlined word and two words with
// marks of their own), Backspace at the block's start: storage holds that
// line, with the code's text. A's hold shows the block as code, with the
// line's words in it as stored. When A's composition ends, A's code
// highlighter tokenizes the shown code line again; written, its tokens (code
// highlight nodes, which keep no format and join NodeState) would land in the
// line storage holds. The highlighter's re-typing is not written: when the
// hold ends, every peer and a fresh reader show the line with the underlined
// word, each mark on its own word, and no code highlight node outside code.
//
// The edits a user makes there are written as before: typing into the
// composed text, Enter and a second composition after the first ends, a
// format applied to part of a word while a held change restyles the line;
// and so is the highlighter's work where no hold restyles the line.
//
// Only what the transform made of that line is left out of the write: an
// edit of another line in the update that ends the composition (typing, a
// new paragraph) is written, and so is a NodeState value set there on a token
// of the line that the update kept. A write of such an update that fails
// part way, with every recovery of it, keeps what was typed, as on main.
//
// A new text node with an explicit format, made in another line while the
// hold holds the collaborator's join and a format change of the joined text,
// keeps its format (written as a node new in the update, see Writer's
// $insertAtoms), with Prism and Shiki alike; the held line is read as
// stored.
//
// A NodeState value set in the update that ends the composition on text of
// the held line, which the tokenizer carries onto the tokens it makes (an
// app's tokenizer, and the stock ones alike), is written; so is a value set
// there on a code token that the highlighter replaces, the join having
// changed the line's tokens.
//
// Once the hold has ended and A has read the line again, A's transforms run
// again on it as A's own edit, and the writer writes what they change where
// that is only how the line's characters are typed, which keeps each where it
// is stored (see DECISIONS.md D115): a hashtag made again in a line B made a
// heading, A's highlighter's tokens in a line B made a code block, an app's
// transform's bold on the line as it now is. Where they change the line's
// text (an app's transform that upper-cases it), nothing is written: neither
// that nor a hashtag made with it, which main writes.

import {
  $createCodeHighlightNode,
  $createCodeNode,
  $isCodeHighlightNode,
  $isCodeNode,
  CodeHighlightNode,
} from '@lexical/code';
import {
  PrismTokenizer,
  registerCodeHighlighting,
  type Tokenizer as PrismTokenizerType,
} from '@lexical/code-prism';
import {
  loadCodeLanguage,
  loadCodeTheme,
  registerCodeHighlighting as registerShikiHighlighting,
  ShikiTokenizer,
  type Tokenizer as ShikiTokenizerType,
} from '@lexical/code-shiki';
import {HashtagNode, registerLexicalHashtag} from '@lexical/hashtag';
import {autoLinkUrlMatcher, registerAutoLink} from '@lexical/link';
import {$createListItemNode, $createListNode, $insertList} from '@lexical/list';
import {
  $createHeadingNode,
  $createQuoteNode,
  $isHeadingNode,
  HeadingNode,
} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getSlot,
  $getSlotNames,
  $getState,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setCompositionKey,
  $setSelection,
  $setSlot,
  $setState,
  arraySetValue,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  createState,
  DecoratorNode,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  ParagraphNode,
  type StateConfig,
  stringValue,
  TextNode,
} from 'lexical';
import {beforeAll, expect, onTestFinished, test, vi} from 'vitest';

import {isYWarning, UNSUPPORTED_EDIT_WARNING} from '../../..';
import {Reader} from '../../../internal/Read';
import {Writer} from '../../../internal/Write';
import {
  $createBoxNode,
  $selectIn,
  flush,
  freshReader,
  NODES,
  Peer,
  type Setup,
  setup,
} from '../../utils/harness';
import {
  $body,
  $component,
  type ComponentNode,
  SLOT_NODES,
} from '../../utils/slots';

/** Comment marks, a set of ids on the text they cover. */
const marks = createState('marks', {parse: arraySetValue(stringValue())});
/** A note the user or the app sets on text. */
const note = createState('note', {parse: stringValue()});

/** Sets `note` on the text nodes of the selection (an app's command). */
const SET_NOTE_COMMAND = createCommand<string>('SET_NOTE_COMMAND');

const prepare = (editor: LexicalEditor) => {
  registerCodeHighlighting(editor);
  editor.registerCommand(
    SET_NOTE_COMMAND,
    value => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        for (const node of selection.extract()) {
          if ($isTextNode(node)) {
            $setState(node, note, value);
          }
        }
      }
      return true;
    },
    COMMAND_PRIORITY_EDITOR,
  );
};

/** A boolean anchor, as a comment's: `anchor:<ns>:<id>`, true where it is. */
const anchor = createState('anchor:c:c1', {parse: (v: unknown) => v === true});
/** The same, declared flat (a top-level key of the node's JSON). */
const flatAnchor = createState('anchor:f:c1', {
  parse: (v: unknown) => v === true,
});

/** A text node class that reads `flatAnchor` flat. */
class FlatAnchorTextNode extends TextNode {
  $config() {
    return this.config('flat_anchor_text', {
      extends: TextNode,
      stateConfigs: [{flat: true, stateConfig: flatAnchor}],
    });
  }
}

/** A code highlight node class that reads `flatAnchor` flat. */
class FlatAnchorHighlightNode extends CodeHighlightNode {
  $config() {
    return this.config('flat_anchor_highlight', {
      extends: CodeHighlightNode,
      stateConfigs: [{flat: true, stateConfig: flatAnchor}],
    });
  }
}

/** A set-valued NodeState: tags. */
const tags = createState('tags', {parse: arraySetValue(stringValue())});

/** A text node class that reads `tags` flat. */
class FlatTagsTextNode extends TextNode {
  $config() {
    return this.config('flat_tags_text', {
      extends: TextNode,
      stateConfigs: [{flat: true, stateConfig: tags}],
    });
  }
}

/** An object-valued NodeState: meta. */
const meta = createState('meta', {
  isEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  parse: (v: unknown): {v: number} | null =>
    typeof v === 'object' &&
    v !== null &&
    typeof (v as {v?: unknown}).v === 'number'
      ? {v: (v as {v: number}).v}
      : null,
});

/** A scalar NodeState whose key holds U+001F, which set members' names do. */
const flag = createState('flag\u001factive', {
  parse: (v: unknown) => (typeof v === 'boolean' ? v : null),
});

/** A text node class that reads `flag` flat. */
class FlatFlagTextNode extends TextNode {
  $config() {
    return this.config('flat_flag_text', {
      extends: TextNode,
      stateConfigs: [{flat: true, stateConfig: flag}],
    });
  }
}

/** Paragraph classes an app replaces ParagraphNode with. */
class CustomParagraphNode extends ParagraphNode {
  $config() {
    return this.config('custom_paragraph', {extends: ParagraphNode});
  }
}
class InnerParagraphNode extends ParagraphNode {
  $config() {
    return this.config('inner_paragraph', {extends: ParagraphNode});
  }
}
class OuterParagraphNode extends InnerParagraphNode {
  $config() {
    return this.config('outer_paragraph', {extends: InnerParagraphNode});
  }
}

/** A set-valued NodeState, and a scalar named like one of its members. */
const crossSet = createState('cross', {parse: arraySetValue(stringValue())});
const crossFlag = createState('cross\u001fnew', {
  parse: (v: unknown) => (typeof v === 'boolean' ? v : null),
});

/** A text node class that has `crossSet` (not `crossFlag`). */
class CrossSetTextNode extends TextNode {
  $config() {
    return this.config('cross_set_text', {
      extends: TextNode,
      stateConfigs: [crossSet],
    });
  }
}

/** A code highlight node class that has `crossFlag` (not `crossSet`). */
class CrossFlagHighlightNode extends CodeHighlightNode {
  $config() {
    return this.config('cross_flag_highlight', {
      extends: CodeHighlightNode,
      stateConfigs: [crossFlag],
    });
  }
}

/** A scalar NodeState, and another scalar named like a member of its key. */
const overName = createState('over', {
  parse: (v: unknown) => (typeof v === 'string' ? v : ''),
});
const overFlag = createState('over\u001fflag', {
  parse: (v: unknown) => (typeof v === 'boolean' ? v : null),
});

/** A text node class that has `overFlag` (not `overName`). */
class OverFlagTextNode extends TextNode {
  $config() {
    return this.config('over_flag_text', {
      extends: TextNode,
      stateConfigs: [overFlag],
    });
  }
}

/** A code highlight node class that has `overFlag` and `overName`. */
class OverHighlightNode extends CodeHighlightNode {
  $config() {
    return this.config('over_highlight', {
      extends: CodeHighlightNode,
      stateConfigs: [overFlag, overName],
    });
  }
}

/** A text node class an app's transform makes a word into. */
class AppTokenNode extends TextNode {
  $config() {
    return this.config('app_token', {extends: TextNode});
  }
}

/** How a test sets and reads a NodeState value of each shape. */
const VALUE_SHAPES = {
  anchor: {
    $has: (n: TextNode) => $getState(n, anchor),
    $set: (n: TextNode) => $setState(n, anchor, true),
    nodes: undefined,
  },
  'flat anchor': {
    $has: (n: TextNode) => $getState(n, flatAnchor),
    $set: (n: TextNode) => $setState(n, flatAnchor, true),
    nodes: [
      ...NODES,
      FlatAnchorTextNode,
      FlatAnchorHighlightNode,
      {
        replace: TextNode,
        with: (n: TextNode) => new FlatAnchorTextNode(n.__text),
        withKlass: FlatAnchorTextNode,
      },
      {
        replace: CodeHighlightNode,
        with: (n: CodeHighlightNode) =>
          new FlatAnchorHighlightNode(n.__text, n.__highlightType),
        withKlass: FlatAnchorHighlightNode,
      },
    ] as unknown as Klass<LexicalNode>[],
  },
  string: {
    $has: (n: TextNode) => $getState(n, note) === 'saved',
    $set: (n: TextNode) => $setState(n, note, 'saved'),
    nodes: undefined,
  },
};

/** Each top-level block: its type, then each text node, format and marks. */
const show = (p: Peer) =>
  p.read(() =>
    $getRoot()
      .getChildren()
      .map(
        block =>
          `${block.getType()}${$isElementNode(block) && block.getFormatType() ? '/' + block.getFormatType() : ''}[${($isElementNode(
            block,
          )
            ? block.getAllTextNodes()
            : []
          )
            .map(
              n =>
                `${$isCodeHighlightNode(n) ? 'hl:' : ''}${n.getTextContent()}${n.getFormat() ? '/f' + n.getFormat() : ''}${$getState(n, marks).length > 0 ? '/' + $getState(n, marks).join(',') : ''}`,
            )
            .join('|')}]`,
      )
      .join(' '),
  );

/** The words of the line before the code block. */
const $words = () => [
  $createTextNode('aa '),
  $createTextNode('bb').setFormat('underline'),
  $setState($createTextNode(' cc'), marks, ['c5']),
  $setState($createTextNode(' dd'), marks, ['c6']),
];

/** A paragraph or list item holding the words, then a code block. */
async function setupJoin(
  into: 'paragraph' | 'list item',
  gc: boolean,
  ids: number[],
): Promise<Setup> {
  const t = await setup(
    () => {
      $getRoot().append(
        into === 'paragraph'
          ? $createParagraphNode().append(...$words())
          : $createListNode('bullet').append(
              $createListItemNode().append(...$words()),
            ),
        $createCodeNode('javascript').append(
          $createCodeHighlightNode('let x = 1;'),
        ),
      );
    },
    {gc, ids, prepare},
  );
  // A's editor is attached to the DOM, as it is while it composes.
  const host = document.createElement('div');
  host.contentEditable = 'true';
  document.body.append(host);
  t.a.editor.setRootElement(host);
  host.focus();
  onTestFinished(() => {
    t.a.editor.setRootElement(null);
    host.remove();
    t.peers.forEach(p => p.stop());
  });
  return t;
}

/**
 * Paragraphs `other ` and `before bb` (`bb` underlined, or `before ` alone),
 * then a code block, `let x = 1;`.
 */
async function setupRelease(
  gc: boolean,
  ids: number[],
  underlined = true,
  highlighter: 'Prism' | 'Shiki' = 'Prism',
): Promise<Setup> {
  const t = await setup(
    () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('other ')),
        $createParagraphNode().append(
          $createTextNode('before '),
          ...(underlined ? [$createTextNode('bb').setFormat('underline')] : []),
        ),
        $createCodeNode('javascript').append(
          $createCodeHighlightNode('let x = 1;'),
        ),
      );
    },
    {
      gc,
      ids,
      prepare:
        highlighter === 'Prism'
          ? prepare
          : (editor: LexicalEditor) => {
              registerShikiHighlighting(editor);
            },
    },
  );
  const host = document.createElement('div');
  host.contentEditable = 'true';
  document.body.append(host);
  t.a.editor.setRootElement(host);
  host.focus();
  onTestFinished(() => {
    t.a.editor.setRootElement(null);
    host.remove();
    t.peers.forEach(p => p.stop());
  });
  return t;
}

/**
 * A tokenizer that makes one token of each run of the highlight tokens
 * `base` makes, as an app's tokenizer that merges characters of several
 * nodes into one token could (through the public Tokenizer API). Counts its
 * merges in `merges`.
 */
function mergingTokenizer(
  base: PrismTokenizerType,
  merges: {count: number},
): PrismTokenizerType {
  return {
    ...base,
    $tokenize(
      code: Parameters<PrismTokenizerType['$tokenize']>[0],
      language?: string,
    ) {
      const out: LexicalNode[] = [];
      for (const node of base.$tokenize(code, language)) {
        const last = out[out.length - 1];
        if ($isCodeHighlightNode(node) && $isCodeHighlightNode(last)) {
          last.setTextContent(last.getTextContent() + node.getTextContent());
          merges.count++;
        } else {
          out.push(node);
        }
      }
      return out;
    },
  };
}

/** In the active update: insert `TYPED` at the start of the first line. */
function $typeInFirstLine(how: 'insertText' | 'spliceText') {
  const line = $getRoot().getFirstChildOrThrow();
  if (!$isElementNode(line)) {
    return;
  }
  const node = line.getAllTextNodes()[0];
  if (how === 'insertText') {
    node.select(0, 0).insertText('TYPED');
  } else {
    node.spliceText(0, 0, 'TYPED');
  }
  $setSelection(null);
}

// Shiki loads grammars and themes asynchronously; loaded, it highlights in
// the update that changes the block.
beforeAll(async () => {
  await loadCodeLanguage('javascript');
  await loadCodeTheme('one-light');
});

/** A starts composing in the first text node of its last block. */
function startComposing(a: Peer, offset = 1): string {
  let composed = '';
  a.update(() => {
    const block = $getRoot().getLastChildOrThrow();
    const node = (
      $isElementNode(block) ? block.getAllTextNodes()[0] : null
    ) as TextNode;
    node.select(offset, offset);
    composed = node.getKey();
    $setCompositionKey(composed);
  });
  return composed;
}

/** A's composition of `composed` ends. */
function endComposing(a: Peer, composed: string) {
  a.update(() => {
    $setCompositionKey(null);
    const n = $getNodeByKey(composed);
    if ($isTextNode(n) && n.isAttached()) {
      n.getWritable();
    }
  });
}

/** B joins the code block into the line before it (Backspace at its start). */
function joinCode(b: Peer) {
  b.update(() => {
    const code = $getRoot().getLastChildOrThrow();
    if (!$isCodeNode(code)) {
      return;
    }
    code.selectStart().deleteCharacter(true);
    $setSelection(null);
  });
}

/** Every peer and a fresh reader show the same; that view. */
async function converged(t: Setup): Promise<string> {
  await t.sync();
  await t.sync();
  const fresh = await freshReader(t.a);
  onTestFinished(() => fresh.stop());
  const views = [...t.peers, fresh].map(show);
  for (const view of views) {
    expect(view).toBe(views[0]);
  }
  for (const peer of t.peers) {
    expect(peer.errors).toEqual([]);
  }
  return views[0];
}

/** An inline decorator whose text content is not one character. */
class InlineEquationNode extends DecoratorNode<null> {
  $config() {
    return this.config('inline_equation', {extends: DecoratorNode});
  }
  isInline(): boolean {
    return true;
  }
  createDOM(): HTMLElement {
    return document.createElement('span');
  }
  updateDOM(): boolean {
    return false;
  }
  decorate(): null {
    return null;
  }
  getTextContent(): string {
    return 'x^2';
  }
}

/** A starts composing `#tag` at the end of the first text node. */
function composeHashtag(a: Peer): string {
  let composed = '';
  a.update(() => {
    const node = $getRoot().getAllTextNodes()[0];
    node.selectEnd();
    composed = node.getKey();
    $setCompositionKey(composed);
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      selection.insertText('#tag');
    }
  });
  return composed;
}

/** B makes the first block a heading. */
function makeHeading(b: Peer) {
  b.update(() => {
    const line = $getRoot().getFirstChildOrThrow();
    if ($isElementNode(line)) {
      line.replace($createHeadingNode('h2').append(...line.getChildren()));
    }
    $setSelection(null);
  });
}

/** Each block's text nodes, with their type, format and note. */
const blocks = (p: Peer): string =>
  p.read(() =>
    $getRoot()
      .getChildren()
      .map(
        block =>
          `${block.getType()}[${
            $isElementNode(block)
              ? block
                  .getAllTextNodes()
                  .map(
                    n =>
                      `${n.getType()}:${n.getTextContent()}/${n.getFormat()}/${$getState(n, note)}`,
                  )
                  .join('|')
              : ''
          }]`,
      )
      .join(' '),
  );

const ORDERS = [
  [1, 2],
  [2, 1],
];

for (const gc of [false, true]) {
  for (const ids of ORDERS) {
    const variant = `gc ${gc ? 'on' : 'off'}, ids ${ids}`;

    for (const into of ['paragraph', 'list item'] as const) {
      test(`a held code block joined into a ${into} keeps that line's formats and marks when the composition ends (${variant})`, async () => {
        const t = await setupJoin(into, gc, ids);
        const composed = startComposing(t.a);
        await t.sync();
        joinCode(t.b);
        await t.sync();
        endComposing(t.a, composed);
        const view = await converged(t);
        expect(view).not.toContain('hl:');
        expect(view).toContain('aa |bb/f8| cc/c5| dd/c6|let x = 1;');
      });
    }

    test(`text typed into the composed text of a held code block joined into a paragraph is written (${variant})`, async () => {
      const t = await setupJoin('paragraph', gc, ids);
      const composed = startComposing(t.a);
      await t.sync();
      joinCode(t.b);
      await t.sync();
      t.a.update(() => {
        const n = $getNodeByKey(composed);
        if ($isTextNode(n)) {
          n.spliceText(1, 0, 'zz', true);
        }
      });
      await t.sync();
      endComposing(t.a, composed);
      expect(await converged(t)).toBe(
        'paragraph[aa |bb/f8| cc/c5| dd/c6|lzzet x = 1;]',
      );
    });

    test(`Enter and a second composition after the first ends are written (${variant})`, async () => {
      const t = await setupJoin('paragraph', gc, ids);
      const composed = startComposing(t.a);
      await t.sync();
      joinCode(t.b);
      await t.sync();
      endComposing(t.a, composed);
      await t.sync();
      // A second composition, in the line the code block was joined into.
      const again = startComposing(t.a, 2);
      t.a.update(() => {
        const n = $getNodeByKey(again);
        if ($isTextNode(n)) {
          n.spliceText(2, 0, 'qq', true);
        }
      });
      await t.sync();
      endComposing(t.a, again);
      await t.sync();
      // Enter after `aaqq `.
      t.a.update(() => {
        const block = $getRoot().getLastChildOrThrow();
        if ($isElementNode(block)) {
          block.getAllTextNodes()[0].select(5, 5);
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertParagraph();
          }
        }
      });
      expect(await converged(t)).toBe(
        'paragraph[aaqq ] paragraph[bb/f8| cc/c5| dd/c6|let x = 1;]',
      );
    });

    for (const change of ['heading', 'alignment'] as const) {
      test(`a format applied to part of a word while a ${change} change of the line composed in is held is written (${variant})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append(
                $createTextNode('aa '),
                $createTextNode('bb').setFormat('underline'),
                $createTextNode(' cc'),
              ),
            );
          },
          {gc, ids, prepare},
        );
        onTestFinished(() => t.peers.forEach(p => p.stop()));
        let composed = '';
        t.a.update(() => {
          const line = $getRoot().getFirstChildOrThrow();
          const node = (
            $isElementNode(line) ? line.getAllTextNodes()[2] : null
          ) as TextNode;
          node.select(1, 1);
          composed = node.getKey();
          $setCompositionKey(composed);
        });
        await t.sync();
        t.b.update(() => {
          const line = $getRoot().getFirstChildOrThrow();
          if (!$isElementNode(line)) {
            return;
          }
          if (change === 'heading') {
            line.selectStart();
            $setBlocksType($getSelection()!, () => $createHeadingNode('h2'));
          } else {
            line.setFormat('center');
          }
          $setSelection(null);
        });
        await t.sync();
        // A bolds the first `a`, splitting its text node.
        t.a.update(() => {
          const line = $getRoot().getFirstChildOrThrow();
          if ($isElementNode(line)) {
            line.getAllTextNodes()[0].select(0, 1);
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              selection.formatText('bold');
            }
          }
        });
        await t.sync();
        endComposing(t.a, composed);
        expect(await converged(t)).toBe(
          change === 'heading'
            ? 'heading[a/f1|a |bb/f8| cc]'
            : 'paragraph/center[a/f1|a |bb/f8| cc]',
        );
      });
    }

    for (const how of [
      'typed',
      'spliced',
      'appended',
      'batched',
      'separate',
    ] as const) {
      test(`an edit of another line in the update that ends the composition is written, the held line read as stored (${how}, ${variant})`, async () => {
        const t = await setupRelease(gc, ids);
        const composed = startComposing(t.a);
        await t.sync();
        joinCode(t.b);
        await t.sync();
        const $end = () => {
          $setCompositionKey(null);
          const n = $getNodeByKey(composed);
          if ($isTextNode(n) && n.isAttached()) {
            n.getWritable();
          }
        };
        if (how === 'typed' || how === 'spliced') {
          t.a.update(() => {
            $end();
            $typeInFirstLine(how === 'typed' ? 'insertText' : 'spliceText');
          });
        } else if (how === 'appended') {
          t.a.update(() => {
            $end();
            $getRoot().append(
              $createParagraphNode().append($createTextNode('TYPED')),
            );
            $setSelection(null);
          });
        } else if (how === 'batched') {
          // Two updates Lexical commits as one.
          t.a.editor.update($end);
          t.a.editor.update(() => $typeInFirstLine('spliceText'));
        } else {
          t.a.update($end);
          await t.sync();
          t.a.update(() => $typeInFirstLine('insertText'));
        }
        const view = await converged(t);
        expect(view).not.toContain('hl:');
        expect(view).toBe(
          how === 'appended'
            ? 'paragraph[other ] paragraph[before |bb/f8|let x = 1;] paragraph[TYPED]'
            : 'paragraph[TYPEDother ] paragraph[before |bb/f8|let x = 1;]',
        );
      });
    }

    for (const how of ['listener', 'same task'] as const) {
      test(`an app's edit queued as the composition ends runs after the line is read as stored, and is written (${how}, ${variant})`, async () => {
        const t = await setupRelease(gc, ids);
        const composed = startComposing(t.a);
        await t.sync();
        joinCode(t.b);
        await t.sync();
        let armed = false;
        const off = t.a.editor.registerUpdateListener(() => {
          if (armed && how === 'listener') {
            armed = false;
            // Queued in the listener phase of the update that ends the
            // composition.
            t.a.editor.update(() => {
              $getRoot().append(
                $createParagraphNode().append($createTextNode('APP')),
              );
              $setSelection(null);
            });
          }
        });
        onTestFinished(off);
        armed = true;
        t.a.update(() => {
          $setCompositionKey(null);
          const n = $getNodeByKey(composed);
          if ($isTextNode(n) && n.isAttached()) {
            n.getWritable();
          }
        });
        if (how === 'same task') {
          t.a.editor.update(() => $typeInFirstLine('spliceText'));
        }
        const view = await converged(t);
        expect(view).not.toContain('hl:');
        expect(view).toBe(
          how === 'listener'
            ? 'paragraph[other ] paragraph[before |bb/f8|let x = 1;] paragraph[APP]'
            : 'paragraph[TYPEDother ] paragraph[before |bb/f8|let x = 1;]',
        );
      });
    }

    test(`text the binding cannot store, typed into a line of another container in the update that ends the composition, is read again with the held line (${variant})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createBoxNode().append(
              $createParagraphNode().append($createTextNode('other ')),
            ),
            $createParagraphNode().append(
              $createTextNode('before '),
              $createTextNode('bb').setFormat('underline'),
            ),
            $createCodeNode('javascript').append(
              $createCodeHighlightNode('let x = 1;'),
            ),
          );
        },
        {gc, ids, prepare},
      );
      // (Headless: the box has no DOM.)
      onTestFinished(() => t.peers.forEach(p => p.stop()));
      const composed = startComposing(t.a);
      await t.sync();
      joinCode(t.b);
      await t.sync();
      // A lone surrogate, stored as U+FFFD: the box's line is read again too.
      t.a.update(() => {
        $setCompositionKey(null);
        const n = $getNodeByKey(composed);
        if ($isTextNode(n) && n.isAttached()) {
          n.getWritable();
        }
        const box = $getRoot().getFirstChildOrThrow();
        if ($isElementNode(box)) {
          box.getAllTextNodes()[0].spliceText(0, 0, 'X\uD800');
        }
        $setSelection(null);
      });
      const view = await converged(t);
      expect(view).not.toContain('hl:');
      expect(t.a.read(() => $getRoot().getTextContent())).toBe(
        'X\uFFFDother \n\nbefore bblet x = 1;',
      );
      expect(view).toContain('paragraph[before |bb/f8|let x = 1;]');
    });

    test(`a code block in a named slot, joined by a collaborator while A composes in it, is read as stored with the slot's host when the composition ends (${variant})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $component({
              body: $body(
                $createParagraphNode().append(
                  $createTextNode('before '),
                  $createTextNode('bb').setFormat('underline'),
                ),
                $createCodeNode('javascript').append(
                  $createCodeHighlightNode('let x = 1;'),
                ),
              ),
            }),
          );
        },
        {gc, ids, nodes: SLOT_NODES, prepare},
      );
      // (Headless: the slot's host has no DOM.)
      onTestFinished(() => t.peers.forEach(p => p.stop()));
      const $code = () => {
        const body = $getSlot(
          $getRoot().getFirstChildOrThrow() as ComponentNode,
          'body',
        );
        const code = $isElementNode(body) ? body.getLastChild() : null;
        return $isCodeNode(code) ? code : null;
      };
      let composed = '';
      t.a.update(() => {
        const text = $code()!.getAllTextNodes()[0];
        text.select(1, 1);
        composed = text.getKey();
        $setCompositionKey(composed);
      });
      await t.sync();
      t.b.update(() => {
        $code()!.selectStart().deleteCharacter(true);
        $setSelection(null);
      });
      await t.sync();
      t.a.update(() => {
        $setCompositionKey(null);
        const n = $getNodeByKey(composed);
        if ($isTextNode(n) && n.isAttached()) {
          n.getWritable();
        }
      });
      await converged(t);
      const body = (peer: Peer) =>
        peer.read(() => {
          const slot = $getSlot(
            $getRoot().getFirstChildOrThrow() as ComponentNode,
            'body',
          );
          return $isElementNode(slot)
            ? slot
                .getChildren()
                .map(
                  block =>
                    `${block.getType()}[${
                      $isElementNode(block)
                        ? block
                            .getAllTextNodes()
                            .map(
                              n =>
                                `${n.getType() === 'text' ? '' : 'hl:'}${n.getTextContent()}/${n.getFormat()}`,
                            )
                            .join('|')
                        : ''
                    }]`,
                )
                .join(' ')
            : '';
        });
      for (const peer of t.peers) {
        expect(body(peer)).toBe('paragraph[before /0|bb/8|let x = 1;/0]');
      }
    });

    for (const where of ['read', 'apply'] as const) {
      test(`a read that fails as the composition ends is recovered, and an app's edit queued behind it is written (${where}, ${variant})`, async () => {
        const t = await setupRelease(gc, ids);
        const composed = startComposing(t.a);
        await t.sync();
        joinCode(t.b);
        await t.sync();
        // One read of A's fails, once: the read of the line, or the read of
        // what the hold held.
        const proto = Reader.prototype;
        const {$apply, $readFull} = proto;
        let armed = false;
        let fired = false;
        const fail = () => {
          if (armed && !fired) {
            fired = true;
            throw new Error('reader failure');
          }
        };
        if (where === 'read') {
          proto.$readFull = function (...args) {
            fail();
            return $readFull.apply(this, args);
          };
        } else {
          proto.$apply = function (...args) {
            const result = $apply.apply(this, args);
            fail();
            return result;
          };
        }
        onTestFinished(() => {
          proto.$apply = $apply;
          proto.$readFull = $readFull;
        });
        let queue = true;
        const off = t.a.editor.registerUpdateListener(() => {
          if (queue && armed) {
            queue = false;
            t.a.editor.update(() => {
              $getRoot().append(
                $createParagraphNode().append($createTextNode('APP')),
              );
              $setSelection(null);
            });
          }
        });
        onTestFinished(off);
        armed = true;
        t.a.update(() => {
          $setCompositionKey(null);
          const n = $getNodeByKey(composed);
          if ($isTextNode(n) && n.isAttached()) {
            n.getWritable();
          }
        });
        const view = await converged(t);
        armed = false;
        expect(fired).toBe(true);
        expect(view).not.toContain('hl:');
        expect(view).toBe(
          'paragraph[other ] paragraph[before |bb/f8|let x = 1;] paragraph[APP]',
        );
      });
    }

    test(`slots swapped in the update that ends a composition held in one of them are refused, and keep the text of both (${variant})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $component({
              aside: $body(
                $createParagraphNode().append($createTextNode('aside ')),
              ),
              body: $body(
                $createParagraphNode().append(
                  $createTextNode('before '),
                  $createTextNode('bb').setFormat('underline'),
                ),
                $createCodeNode('javascript').append(
                  $createCodeHighlightNode('let x = 1;'),
                ),
              ),
            }),
          );
        },
        {gc, ids, nodes: SLOT_NODES, prepare},
      );
      // (Headless: the slot's host has no DOM.)
      onTestFinished(() => t.peers.forEach(p => p.stop()));
      const $host = () => $getRoot().getFirstChildOrThrow() as ComponentNode;
      const $code = () => {
        const body = $getSlot($host(), 'body');
        const code = $isElementNode(body) ? body.getLastChild() : null;
        return $isCodeNode(code) ? code : null;
      };
      let composed = '';
      t.a.update(() => {
        const text = $code()!.getAllTextNodes()[0];
        text.select(1, 1);
        composed = text.getKey();
        $setCompositionKey(composed);
      });
      await t.sync();
      t.b.update(() => {
        $code()!.selectStart().deleteCharacter(true);
        $setSelection(null);
      });
      await t.sync();
      t.a.update(() => {
        $setCompositionKey(null);
        const n = $getNodeByKey(composed);
        if ($isTextNode(n) && n.isAttached()) {
          n.getWritable();
        }
        const host = $host();
        const body = $getSlot(host, 'body')!;
        const aside = $getSlot(host, 'aside')!;
        $setSlot(host, 'body', aside);
        $setSlot(host, 'aside', body);
        $setSelection(null);
      });
      await converged(t);
      const fresh = await freshReader(t.a);
      onTestFinished(() => fresh.stop());
      for (const peer of [...t.peers, fresh]) {
        const text = peer.read(() => {
          const host = $host();
          return $getSlotNames(host)
            .map(name => $getSlot(host, name)!.getTextContent())
            .join('|');
        });
        expect(text).toContain('aside ');
        expect(text).toContain('before bblet x = 1;');
      }
    });

    for (const how of ['note', 'marks', 'command', 'separate'] as const) {
      test(`a NodeState value set on a token of the held line that the update ending the composition kept is written (${how}, ${variant})`, async () => {
        // The joined line is `before let x = 1;`: the highlighter keeps the
        // `let` token, which A shows as the code token it was.
        const t = await setupRelease(gc, ids, false);
        const composed = startComposing(t.a);
        await t.sync();
        joinCode(t.b);
        await t.sync();
        const $set = () => {
          const line = $getRoot().getChildrenSize() - 1;
          const selection = $selectIn([line], 7, 10);
          expect(selection.getTextContent()).toBe('let');
          if (how === 'command') {
            t.a.editor.dispatchCommand(SET_NOTE_COMMAND, 'saved');
          } else {
            for (const node of selection.extract()) {
              if ($isTextNode(node)) {
                if (how === 'marks') {
                  $setState(node, marks, ['c7']);
                } else {
                  $setState(node, note, 'saved');
                }
              }
            }
          }
          $setSelection(null);
        };
        if (how === 'separate') {
          endComposing(t.a, composed);
          await t.sync();
          t.a.update($set);
        } else {
          t.a.update(() => {
            $setCompositionKey(null);
            $set();
          });
        }
        await converged(t);
        const notes = (p: Peer) =>
          p.read(() =>
            $getRoot()
              .getAllTextNodes()
              .flatMap(n =>
                [...n.getTextContent()].map(
                  ch =>
                    ch +
                    ($getState(n, note) === ''
                      ? ''
                      : '=' + $getState(n, note)) +
                    ($getState(n, marks).length === 0
                      ? ''
                      : '+' + $getState(n, marks).join(',')),
                ),
              )
              .join(' '),
          );
        const value = how === 'marks' ? '+c7' : '=saved';
        expect(notes(t.a)).toBe(
          `o t h e r   b e f o r e   l${value} e${value} t${value}   x   =   1 ;`,
        );
        expect(show(t.a)).not.toContain('hl:');
      });
    }

    test(`a write of the update that ends the composition and types in another line, failing after that line is written and in every recovery, keeps the typing (${variant})`, async () => {
      const t = await setupRelease(gc, ids);
      const composed = startComposing(t.a);
      await t.sync();
      joinCode(t.b);
      await t.sync();
      const otherKey = t.a.read(() =>
        $getRoot().getFirstChildOrThrow().getKey(),
      );
      const proto = Writer.prototype as unknown as {
        $run: (this: Writer) => void;
        $writeLineAlone: (this: Writer, u: unknown, d: {key?: string}) => void;
      };
      const run = proto.$run;
      const writeLine = proto.$writeLineAlone;
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
      let failed = false;
      proto.$writeLineAlone = function (u, d) {
        writeLine.call(this, u, d);
        if (!failed && this.tr.doc === t.a.doc && d.key === otherKey) {
          failed = true;
          throw new Error('fault after the typed line was written');
        }
      };
      proto.$run = function () {
        if (failed && this.tr.doc === t.a.doc) {
          throw new Error('fault where a recovery starts');
        }
        run.call(this);
      };
      try {
        t.a.update(() => {
          $setCompositionKey(null);
          const n = $getNodeByKey(composed);
          if ($isTextNode(n) && n.isAttached()) {
            n.getWritable();
          }
          $typeInFirstLine('insertText');
        });
      } catch (_e) {
        // Main's recovery reports the last fault (the editor's onError).
      } finally {
        proto.$run = run;
        proto.$writeLineAlone = writeLine;
        quiet.mockRestore();
      }
      expect(failed).toBe(true);
      await t.sync();
      await t.sync();
      const fresh = await freshReader(t.a);
      onTestFinished(() => fresh.stop());
      const texts = [...t.peers, fresh].map(p =>
        p.read(() => $getRoot().getTextContent()),
      );
      for (const text of texts) {
        expect(text).toBe(texts[0]);
        expect(text).toContain('TYPEDother ');
      }
    });

    for (const highlighter of ['Prism', 'Shiki'] as const) {
      for (const when of ['release', 'held'] as const) {
        test(`a new text node with an explicit format, made in another line ${when === 'release' ? 'in the update that ends the composition' : 'during the hold'}, keeps it; the held line, joined and its format changed, is read as stored (${highlighter}, ${variant})`, async () => {
          const t = await setupRelease(gc, ids, true, highlighter);
          const composed = startComposing(t.a);
          await t.sync();
          joinCode(t.b);
          // B also takes the underline off `bb` in the joined line: held at
          // A too, which goes on showing `bb` underlined in the code line.
          t.b.update(() => {
            const line = $getRoot().getChildren()[1];
            if ($isElementNode(line)) {
              const bb = line
                .getAllTextNodes()
                .find(n => n.getTextContent() === 'bb');
              if (bb !== undefined) {
                bb.setFormat(0);
              }
            }
            $setSelection(null);
          });
          await t.sync();
          const $newNode = () => {
            const other = $getRoot().getFirstChildOrThrow();
            if ($isElementNode(other)) {
              other.append($createTextNode('NEW').setFormat('underline'));
            }
            $setSelection(null);
          };
          if (when === 'held') {
            t.a.update($newNode);
            await t.sync();
            endComposing(t.a, composed);
          } else {
            t.a.update(() => {
              $setCompositionKey(null);
              const n = $getNodeByKey(composed);
              if ($isTextNode(n) && n.isAttached()) {
                n.getWritable();
              }
              $newNode();
            });
          }
          expect(await converged(t)).toBe(
            'paragraph[other |NEW/f8] paragraph[before bblet x = 1;]',
          );
        });
      }
    }

    for (const highlighter of ['Prism', 'Shiki'] as const) {
      for (const shape of ['string', 'anchor', 'flat anchor'] as const) {
        for (const carries of [true, false]) {
          test(`a NodeState value (${shape}) set on the held line in the update that ends the composition is written where ${carries ? "an app's tokenizer" : 'the stock tokenizer'} carries it onto the tokens it makes (${highlighter}, ${variant})`, async () => {
            const value = VALUE_SHAPES[shape];
            const base: PrismTokenizerType =
              highlighter === 'Prism'
                ? PrismTokenizer
                : (ShikiTokenizer as unknown as PrismTokenizerType);
            // A tokenizer that gives the token starting with a text node's
            // text that node's value (an app's tokenizer, through the public
            // Tokenizer API).
            const carrying = {
              ...base,
              $tokenize(
                code: Parameters<PrismTokenizerType['$tokenize']>[0],
                language?: string,
              ) {
                const source = code.getAllTextNodes().find(value.$has);
                const next = base.$tokenize(code, language);
                if (source === undefined) {
                  return next;
                }
                return next.flatMap(n => {
                  if (
                    !$isCodeHighlightNode(n) ||
                    !n.getTextContent().startsWith(source.getTextContent())
                  ) {
                    return [n];
                  }
                  const parts = n.splitText(source.getTextContentSize());
                  value.$set(parts[0]);
                  return parts;
                });
              },
            };
            const tokenizer = carries ? carrying : base;
            const t = await setup(
              () => {
                $getRoot().append(
                  $createParagraphNode().append($createTextNode('before ')),
                  $createCodeNode('javascript').append(
                    $createCodeHighlightNode('let x = 1;'),
                  ),
                );
              },
              {
                gc,
                ids,
                nodes: value.nodes,
                prepare: (editor: LexicalEditor) => {
                  if (highlighter === 'Prism') {
                    registerCodeHighlighting(
                      editor,
                      tokenizer as PrismTokenizerType,
                    );
                  } else {
                    registerShikiHighlighting(
                      editor,
                      tokenizer as unknown as ShikiTokenizerType,
                    );
                  }
                },
              },
            );
            const host = document.createElement('div');
            host.contentEditable = 'true';
            document.body.append(host);
            t.a.editor.setRootElement(host);
            host.focus();
            onTestFinished(() => {
              t.a.editor.setRootElement(null);
              host.remove();
              t.peers.forEach(p => p.stop());
            });
            startComposing(t.a);
            await t.sync();
            joinCode(t.b);
            await t.sync();
            // `before` in the joined line, which A shows as the code line.
            t.a.update(() => {
              $setCompositionKey(null);
              const line = $getRoot().getChildrenSize() - 1;
              for (const n of $selectIn([line], 0, 6).extract()) {
                if ($isTextNode(n)) {
                  value.$set(n);
                }
              }
              $setSelection(null);
            });
            await converged(t);
            const values = t.a.read(() =>
              $getRoot()
                .getAllTextNodes()
                .flatMap(n =>
                  [...n.getTextContent()].map(() =>
                    value.$has(n) ? 's' : '-',
                  ),
                )
                .join(''),
            );
            expect(show(t.a)).not.toContain('hl:');
            expect(values).toBe(
              'ssssss' + '-'.repeat('before let x = 1;'.length - 6),
            );
          });
        }
      }
    }

    for (const highlighter of ['Prism', 'Shiki'] as const) {
      for (const shape of [
        'skipped',
        'plain end',
        'typing',
        'not restyled',
        'format split',
      ] as const) {
        test(`the re-typing left out of the write is reported once, only where it is (${shape}, ${highlighter}, ${variant})`, async () => {
          let t: Setup;
          let composed = '';
          if (shape === 'format split') {
            // The line composed in is a paragraph a held heading change
            // restyles; A bolds part of a word, splitting its node.
            t = await setup(
              () => {
                $getRoot().append(
                  $createParagraphNode().append(
                    $createTextNode('aa '),
                    $createTextNode('bb').setFormat('underline'),
                    $createTextNode(' cc'),
                  ),
                );
              },
              {
                gc,
                ids,
                prepare: (editor: LexicalEditor) => {
                  if (highlighter === 'Prism') {
                    registerCodeHighlighting(editor);
                  } else {
                    registerShikiHighlighting(editor);
                  }
                },
              },
            );
            onTestFinished(() => t.peers.forEach(p => p.stop()));
            t.a.update(() => {
              const line = $getRoot().getFirstChildOrThrow();
              const node = (
                $isElementNode(line) ? line.getAllTextNodes()[2] : null
              ) as TextNode;
              node.select(1, 1);
              composed = node.getKey();
              $setCompositionKey(composed);
            });
            await t.sync();
            t.b.update(() => {
              $getRoot().getFirstChildOrThrow().selectStart();
              $setBlocksType($getSelection()!, () => $createHeadingNode('h2'));
              $setSelection(null);
            });
            await t.sync();
            t.a.update(() => {
              const line = $getRoot().getFirstChildOrThrow();
              if ($isElementNode(line)) {
                line.getAllTextNodes()[0].select(0, 1);
                const selection = $getSelection();
                if ($isRangeSelection(selection)) {
                  selection.formatText('bold');
                }
              }
            });
            await t.sync();
          } else {
            t = await setupRelease(gc, ids, true, highlighter);
            composed = startComposing(t.a);
            await t.sync();
            if (shape === 'not restyled') {
              // B types in the code line A composes in.
              t.b.update(() => {
                const code = $getRoot().getLastChildOrThrow();
                if ($isElementNode(code)) {
                  code.selectEnd();
                  const selection = $getSelection();
                  if ($isRangeSelection(selection)) {
                    selection.insertText(' y');
                  }
                }
                $setSelection(null);
              });
            } else if (shape !== 'plain end') {
              joinCode(t.b);
            }
            await t.sync();
          }
          t.a.update(() => {
            $setCompositionKey(null);
            const n = $getNodeByKey(composed);
            if ($isTextNode(n) && n.isAttached()) {
              if (shape === 'typing') {
                // The update that ends the composition changes the line's
                // text.
                n.spliceText(1, 0, 'zz', true);
              } else {
                n.getWritable();
              }
            }
            $setSelection(null);
          });
          await converged(t);
          const reported = (peer: Peer) =>
            peer.warningEvents.filter(
              w =>
                isYWarning(w, UNSUPPORTED_EDIT_WARNING) &&
                w.data.reason === 'other' &&
                w.data.detailCode === 'held-line-retokenize',
            ).length;
          expect(reported(t.a)).toBe(shape === 'skipped' ? 1 : 0);
          expect(reported(t.b)).toBe(0);
        });
      }
    }

    for (const highlighter of ['Prism', 'Shiki'] as const) {
      test(`a NodeState value named as an ordinary field (style), set on the held line in the update that ends the composition, keeps that field (${highlighter}, ${variant})`, async () => {
        const styleNote = createState('style', {parse: stringValue()});
        const base: PrismTokenizerType =
          highlighter === 'Prism'
            ? PrismTokenizer
            : (ShikiTokenizer as unknown as PrismTokenizerType);
        // An app's tokenizer that carries the first word's value and style
        // onto the token it makes for it.
        const carrying = {
          ...base,
          $tokenize(
            code: Parameters<PrismTokenizerType['$tokenize']>[0],
            language?: string,
          ) {
            const source = code.getAllTextNodes()[0];
            const next = base.$tokenize(code, language);
            if (
              source === undefined ||
              !code.getTextContent().startsWith('before ')
            ) {
              return next;
            }
            return next.flatMap(n => {
              if (
                !$isCodeHighlightNode(n) ||
                !n.getTextContent().startsWith('before')
              ) {
                return [n];
              }
              const parts = n.splitText(6);
              $setState(parts[0], styleNote, $getState(source, styleNote));
              parts[0].setStyle(source.getStyle());
              return parts;
            });
          },
        };
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append(
                $createTextNode('before').setStyle('color: red'),
                $createTextNode(' '),
              ),
              $createCodeNode('javascript').append(
                $createCodeHighlightNode('let x = 1;'),
              ),
            );
          },
          {
            gc,
            ids,
            prepare: (editor: LexicalEditor) => {
              if (highlighter === 'Prism') {
                registerCodeHighlighting(
                  editor,
                  carrying as PrismTokenizerType,
                );
              } else {
                registerShikiHighlighting(
                  editor,
                  carrying as unknown as ShikiTokenizerType,
                );
              }
            },
          },
        );
        const host = document.createElement('div');
        host.contentEditable = 'true';
        document.body.append(host);
        t.a.editor.setRootElement(host);
        host.focus();
        onTestFinished(() => {
          t.a.editor.setRootElement(null);
          host.remove();
          t.peers.forEach(p => p.stop());
        });
        startComposing(t.a);
        await t.sync();
        joinCode(t.b);
        await t.sync();
        t.a.update(() => {
          $setCompositionKey(null);
          for (const n of $selectIn([0], 0, 6).extract()) {
            if ($isTextNode(n)) {
              $setState(n, styleNote, 'SAVED');
            }
          }
          $setSelection(null);
        });
        await converged(t);
        const word = (peer: Peer) =>
          peer.read(() =>
            $getRoot()
              .getAllTextNodes()
              .flatMap(n =>
                [...n.getTextContent()].map(
                  () => `${$getState(n, styleNote)}/${n.getStyle()}`,
                ),
              )
              .slice(0, 6),
          );
        for (const peer of t.peers) {
          expect(word(peer)).toEqual(Array(6).fill('SAVED/color: red'));
        }
      });
    }

    test(`the re-typing left out of the write is reported once in a composition that goes on through a second hold (${variant})`, async () => {
      let retype = false;
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('before ').setFormat('bold'),
            ),
            $createCodeNode('javascript').append(
              $createCodeHighlightNode('let x = 1;'),
            ),
          );
        },
        {
          gc,
          ids,
          nodes: [...NODES, AppTokenNode],
          prepare: (editor: LexicalEditor) => {
            prepare(editor);
            // An app's transform that makes a word a node of its own type.
            editor.registerNodeTransform(TextNode, n => {
              if (
                retype &&
                n.getType() === 'text' &&
                n.getTextContent().startsWith('before')
              ) {
                retype = false;
                n.replace(
                  $create(AppTokenNode)
                    .setTextContent(n.getTextContent())
                    .setFormat(n.getFormat()),
                );
              }
            });
          },
        },
      );
      onTestFinished(() => t.peers.forEach(p => p.stop()));
      startComposing(t.a);
      await t.sync();
      joinCode(t.b);
      await t.sync();
      // A, still composing, re-types the joined line: left out, reported.
      t.a.update(() => {
        const code = $getRoot().getLastChildOrThrow();
        if ($isCodeNode(code)) {
          code.getWritable();
        }
      });
      await t.sync();
      expect(t.a.editor._compositionKey).not.toBe(null);
      // B makes the line code again; A's app re-types it while composing.
      t.b.update(() => {
        $getRoot().getFirstChildOrThrow().selectStart();
        $setBlocksType($getSelection()!, () => $createCodeNode('javascript'));
        $setSelection(null);
      });
      await t.sync();
      retype = true;
      t.a.update(() => {
        const line = $getRoot().getFirstChildOrThrow();
        if ($isElementNode(line)) {
          line.getAllTextNodes()[0].getWritable();
        }
      });
      await t.sync();
      t.a.update(() => {
        $setCompositionKey(null);
        $setSelection(null);
      });
      await converged(t);
      const reported = (peer: Peer) =>
        peer.warningEvents.filter(
          w =>
            isYWarning(w, UNSUPPORTED_EDIT_WARNING) &&
            w.data.reason === 'other' &&
            w.data.detailCode === 'held-line-retokenize',
        ).length;
      expect(reported(t.a)).toBe(1);
      expect(reported(t.b)).toBe(0);
    });

    for (const highlighter of ['Prism', 'Shiki'] as const) {
      for (const [change, state, klass, initial, value, expected] of [
        // A set-valued or an object value is not written onto a token the
        // highlighter made: the stored value stays.
        [
          'a set-valued value its class reads flat, with a member added,',
          tags,
          FlatTagsTextNode,
          ['old'],
          ['new', 'old'],
          ['old'],
        ],
        [
          'a set-valued value its class reads flat, with its member replaced,',
          tags,
          FlatTagsTextNode,
          ['old'],
          ['new'],
          ['old'],
        ],
        [
          'a set-valued value its class reads flat, with a member removed,',
          tags,
          FlatTagsTextNode,
          ['a', 'b'],
          ['b'],
          ['a', 'b'],
        ],
        ['an object value', meta, TextNode, {v: 1}, {v: 2}, {v: 1}],
        // A scalar value is written, under a key holding U+001F too (not a
        // set's member).
        [
          'a scalar value its class reads flat, its key holding U+001F,',
          flag,
          FlatFlagTextNode,
          false,
          true,
          true,
        ],
      ] as const) {
        test(`${change} set in the update that ends the composition and carried by the tokenizer onto a token the highlighter makes, which reads it nested, ${JSON.stringify(expected) === JSON.stringify(value) ? 'is written' : 'is not written there: the stored value stays'} (${highlighter}, ${variant})`, async () => {
          const base: PrismTokenizerType =
            highlighter === 'Prism'
              ? PrismTokenizer
              : (ShikiTokenizer as unknown as PrismTokenizerType);
          const config = state as StateConfig<string, unknown>;
          // An app's tokenizer that carries the first word's value onto the
          // token it makes for it (a code highlight node, which reads it
          // nested).
          const carrying = {
            ...base,
            $tokenize(
              code: Parameters<PrismTokenizerType['$tokenize']>[0],
              language?: string,
            ) {
              const source = code.getAllTextNodes()[0];
              const next = base.$tokenize(code, language);
              if (
                source === undefined ||
                !code.getTextContent().startsWith('before ')
              ) {
                return next;
              }
              return next.flatMap(n => {
                if (
                  !$isCodeHighlightNode(n) ||
                  !n.getTextContent().startsWith('before')
                ) {
                  return [n];
                }
                const parts = n.splitText(6);
                $setState(parts[0], config, $getState(source, config));
                return parts;
              });
            },
          };
          const t = await setup(
            () => {
              $getRoot().append(
                $createParagraphNode().append(
                  $setState(
                    $create(klass as typeof TextNode).setTextContent('before'),
                    config,
                    initial,
                  ),
                  $createTextNode(' '),
                ),
                $createCodeNode('javascript').append(
                  $createCodeHighlightNode('let x = 1;'),
                ),
              );
            },
            {
              gc,
              ids,
              nodes: [...NODES, FlatTagsTextNode, FlatFlagTextNode],
              prepare: (editor: LexicalEditor) => {
                if (highlighter === 'Prism') {
                  registerCodeHighlighting(
                    editor,
                    carrying as PrismTokenizerType,
                  );
                } else {
                  registerShikiHighlighting(
                    editor,
                    carrying as unknown as ShikiTokenizerType,
                  );
                }
              },
            },
          );
          const host = document.createElement('div');
          host.contentEditable = 'true';
          document.body.append(host);
          t.a.editor.setRootElement(host);
          host.focus();
          onTestFinished(() => {
            t.a.editor.setRootElement(null);
            host.remove();
            t.peers.forEach(p => p.stop());
          });
          startComposing(t.a);
          await t.sync();
          joinCode(t.b);
          await t.sync();
          t.a.update(() => {
            $setCompositionKey(null);
            for (const n of $selectIn([0], 0, 6).extract()) {
              if ($isTextNode(n)) {
                $setState(n, config, value);
              }
            }
            $setSelection(null);
          });
          await converged(t);
          const fresh = await freshReader(t.a);
          onTestFinished(() => fresh.stop());
          for (const peer of [...t.peers, fresh]) {
            const word = peer.read(() =>
              $getRoot()
                .getAllTextNodes()
                .flatMap(n =>
                  [...n.getTextContent()].map(() =>
                    JSON.stringify($getState(n, config)),
                  ),
                )
                .slice(0, 6),
            );
            expect(word).toEqual(Array(6).fill(JSON.stringify(expected)));
          }
        });
      }
    }

    for (const highlighter of ['Prism', 'Shiki'] as const) {
      test(`a scalar value a token the highlighter makes carries under a name that the stored class reads as a member of its set-valued state stays as stored, and so does the set (${highlighter}, ${variant})`, async () => {
        const base: PrismTokenizerType =
          highlighter === 'Prism'
            ? PrismTokenizer
            : (ShikiTokenizer as unknown as PrismTokenizerType);
        let finishing = false;
        // An app's tokenizer that makes the first word's token one of its
        // own class, which has `cross\u001fnew` as a scalar, set at the end
        // of the composition.
        const marking = {
          ...base,
          $tokenize(
            code: Parameters<PrismTokenizerType['$tokenize']>[0],
            language?: string,
          ) {
            const next = base.$tokenize(code, language);
            if (!code.getTextContent().startsWith('before ')) {
              return next;
            }
            return next.flatMap(n => {
              if (
                !$isCodeHighlightNode(n) ||
                !n.getTextContent().startsWith('before')
              ) {
                return [n];
              }
              const type = n.getHighlightType();
              const parts = n.splitText(6);
              const first = $create(CrossFlagHighlightNode)
                .setTextContent(parts[0].getTextContent())
                .setHighlightType(type);
              if (finishing) {
                $setState(first, crossFlag, true);
              }
              return [first, ...parts.slice(1)];
            });
          },
        };
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append(
                $setState(
                  $create(CrossSetTextNode).setTextContent('before'),
                  crossSet,
                  ['old'],
                ),
                $createTextNode(' '),
              ),
              $createCodeNode('javascript').append(
                $createCodeHighlightNode('let x = 1;'),
              ),
            );
          },
          {
            gc,
            ids,
            nodes: [...NODES, CrossSetTextNode, CrossFlagHighlightNode],
            prepare: (editor: LexicalEditor) => {
              if (highlighter === 'Prism') {
                registerCodeHighlighting(editor, marking as PrismTokenizerType);
              } else {
                registerShikiHighlighting(
                  editor,
                  marking as unknown as ShikiTokenizerType,
                );
              }
            },
          },
        );
        const host = document.createElement('div');
        host.contentEditable = 'true';
        document.body.append(host);
        t.a.editor.setRootElement(host);
        host.focus();
        onTestFinished(() => {
          t.a.editor.setRootElement(null);
          host.remove();
          t.peers.forEach(p => p.stop());
        });
        startComposing(t.a);
        await t.sync();
        joinCode(t.b);
        await t.sync();
        finishing = true;
        t.a.update(() => {
          $setCompositionKey(null);
          $setSelection(null);
        });
        await converged(t);
        const fresh = await freshReader(t.a);
        onTestFinished(() => fresh.stop());
        for (const peer of [...t.peers, fresh]) {
          const word = peer.read(() =>
            $getRoot()
              .getAllTextNodes()
              .flatMap(n =>
                [...n.getTextContent()].map(() =>
                  n instanceof CrossSetTextNode
                    ? $getState(n, crossSet).join()
                    : n.getType(),
                ),
              )
              .slice(0, 6),
          );
          expect(word).toEqual(Array(6).fill('old'));
          expect(
            peer.read(() =>
              JSON.stringify(
                $getRoot().getAllTextNodes()[0].exportJSON().$ ?? null,
              ),
            ),
          ).toBe(JSON.stringify({cross: ['old']}));
        }
      });
    }

    for (const highlighter of ['Prism', 'Shiki'] as const) {
      test(`a scalar value a token the highlighter makes carries is written where the stored class has a scalar named like a member of its key, which it does not read as one (${highlighter}, ${variant})`, async () => {
        const base: PrismTokenizerType =
          highlighter === 'Prism'
            ? PrismTokenizer
            : (ShikiTokenizer as unknown as PrismTokenizerType);
        let finishing = false;
        // An app's tokenizer that makes the first word's token one of its
        // own class, carrying `overFlag` and setting `overName` at the end of
        // the composition.
        const naming = {
          ...base,
          $tokenize(
            code: Parameters<PrismTokenizerType['$tokenize']>[0],
            language?: string,
          ) {
            const source = code.getAllTextNodes()[0];
            const next = base.$tokenize(code, language);
            if (
              source === undefined ||
              !code.getTextContent().startsWith('before ')
            ) {
              return next;
            }
            return next.flatMap(n => {
              if (
                !$isCodeHighlightNode(n) ||
                !n.getTextContent().startsWith('before')
              ) {
                return [n];
              }
              const type = n.getHighlightType();
              const parts = n.splitText(6);
              const first = $create(OverHighlightNode)
                .setTextContent(parts[0].getTextContent())
                .setHighlightType(type);
              $setState(first, overFlag, $getState(source, overFlag));
              if (finishing) {
                $setState(first, overName, 'NOVEL');
              }
              return [first, ...parts.slice(1)];
            });
          },
        };
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append(
                $setState(
                  $create(OverFlagTextNode).setTextContent('before'),
                  overFlag,
                  true,
                ),
                $createTextNode(' '),
              ),
              $createCodeNode('javascript').append(
                $createCodeHighlightNode('let x = 1;'),
              ),
            );
          },
          {
            gc,
            ids,
            nodes: [...NODES, OverFlagTextNode, OverHighlightNode],
            prepare: (editor: LexicalEditor) => {
              if (highlighter === 'Prism') {
                registerCodeHighlighting(editor, naming as PrismTokenizerType);
              } else {
                registerShikiHighlighting(
                  editor,
                  naming as unknown as ShikiTokenizerType,
                );
              }
            },
          },
        );
        const host = document.createElement('div');
        host.contentEditable = 'true';
        document.body.append(host);
        t.a.editor.setRootElement(host);
        host.focus();
        onTestFinished(() => {
          t.a.editor.setRootElement(null);
          host.remove();
          t.peers.forEach(p => p.stop());
        });
        startComposing(t.a);
        await t.sync();
        joinCode(t.b);
        await t.sync();
        finishing = true;
        t.a.update(() => {
          $setCompositionKey(null);
          $setSelection(null);
        });
        await converged(t);
        const fresh = await freshReader(t.a);
        onTestFinished(() => fresh.stop());
        for (const peer of [...t.peers, fresh]) {
          const word = peer.read(() =>
            $getRoot()
              .getAllTextNodes()
              .flatMap(n =>
                [...n.getTextContent()].map(() =>
                  JSON.stringify([
                    $getState(n, overName),
                    $getState(n, overFlag),
                  ]),
                ),
              )
              .slice(0, 6),
          );
          expect(word).toEqual(Array(6).fill(JSON.stringify(['NOVEL', true])));
        }
      });
    }

    test(`the re-typing left out of the write is reported again in a composition that ends and starts again in one update (${variant})`, async () => {
      let retype = false;
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('before ').setFormat('bold'),
            ),
            $createCodeNode('javascript').append(
              $createCodeHighlightNode('let x = 1;'),
            ),
          );
        },
        {
          gc,
          ids,
          nodes: [...NODES, AppTokenNode],
          prepare: (editor: LexicalEditor) => {
            prepare(editor);
            editor.registerNodeTransform(TextNode, n => {
              if (
                retype &&
                n.getType() === 'text' &&
                n.getTextContent().startsWith('before')
              ) {
                retype = false;
                n.replace(
                  $create(AppTokenNode)
                    .setTextContent(n.getTextContent())
                    .setFormat(n.getFormat()),
                );
              }
            });
          },
        },
      );
      const host = document.createElement('div');
      host.contentEditable = 'true';
      document.body.append(host);
      t.a.editor.setRootElement(host);
      host.focus();
      onTestFinished(() => {
        t.a.editor.setRootElement(null);
        host.remove();
        t.peers.forEach(p => p.stop());
      });
      startComposing(t.a);
      await t.sync();
      joinCode(t.b);
      await t.sync();
      t.a.update(() => {
        const code = $getRoot().getLastChildOrThrow();
        if ($isCodeNode(code)) {
          code.getWritable();
        }
      });
      await t.sync();
      // The browser ends the composition and starts another, in one update.
      t.a.update(() => {
        const n = $getNodeByKey(t.a.editor._compositionKey!);
        if ($isTextNode(n)) {
          n.select(1, 1);
        }
        host.dispatchEvent(
          new CompositionEvent('compositionend', {bubbles: true, data: ''}),
        );
        host.dispatchEvent(
          new CompositionEvent('compositionstart', {bubbles: true, data: ''}),
        );
      });
      await t.sync();
      t.b.update(() => {
        $getRoot().getFirstChildOrThrow().selectStart();
        $setBlocksType($getSelection()!, () => $createCodeNode('javascript'));
        $setSelection(null);
      });
      await t.sync();
      retype = true;
      t.a.update(() => {
        const line = $getRoot().getFirstChildOrThrow();
        if ($isElementNode(line)) {
          line.getAllTextNodes()[0].getWritable();
        }
      });
      await t.sync();
      t.a.update(() => {
        $setCompositionKey(null);
        $setSelection(null);
      });
      await converged(t);
      const reported = (peer: Peer) =>
        peer.warningEvents.filter(
          w =>
            isYWarning(w, UNSUPPORTED_EDIT_WARNING) &&
            w.data.reason === 'other' &&
            w.data.detailCode === 'held-line-retokenize',
        ).length;
      expect(reported(t.a)).toBe(2);
      expect(reported(t.b)).toBe(0);
    });

    test(`a container moved in the update that ends a composition held in it is decided as without the re-typing rule: written as on main, with no warning and no error (${variant})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('OUTSIDE ')),
            $createBoxNode().append(
              $createParagraphNode().append($createTextNode('LEADING ')),
              $createParagraphNode().append($createTextNode('BEFORE ')),
              $createCodeNode('javascript').append(
                $createCodeHighlightNode('let x = 1;'),
              ),
              $createParagraphNode().append($createTextNode('TAIL ')),
            ),
          );
        },
        {gc, ids, prepare},
      );
      // (Headless: the box has no DOM.)
      onTestFinished(() => t.peers.forEach(p => p.stop()));
      const errors = vi.spyOn(console, 'error');
      onTestFinished(() => errors.mockRestore());
      const $code = () => {
        const box = $getRoot()
          .getChildren()
          .find(n => n.getType() === 'test_box');
        const code = $isElementNode(box)
          ? box.getChildren().find($isCodeNode)
          : null;
        return $isCodeNode(code) ? code : null;
      };
      let composed = '';
      t.a.update(() => {
        const text = $code()!.getAllTextNodes()[0];
        text.select(1, 1);
        composed = text.getKey();
        $setCompositionKey(composed);
      });
      await t.sync();
      t.b.update(() => {
        $code()!.selectStart().deleteCharacter(true);
        $setSelection(null);
      });
      await t.sync();
      // A ends the composition and moves the box before the other paragraph.
      t.a.update(() => {
        const box = $getRoot().getLastChildOrThrow();
        $setCompositionKey(null);
        const n = $getNodeByKey(composed);
        if ($isTextNode(n) && n.isAttached()) {
          n.getWritable();
        }
        $getRoot().getFirstChildOrThrow().insertBefore(box);
        $setSelection(null);
      });
      // As on main: the moved container's line is written with the
      // highlighter's tokens (the update moves structure, see
      // HoldGuard#$reshapesRestyledLine).
      expect(await converged(t)).toBe(
        'test_box[LEADING |hl:BEFORE|hl: |hl:let|hl: x |hl:=|hl: |hl:1|hl:;|TAIL ] paragraph[OUTSIDE ]',
      );
      // No re-typing reported (nothing was left out) and no self-check
      // warning; main's other warnings are as on main.
      for (const peer of t.peers) {
        expect(
          peer.warningEvents.filter(w =>
            isYWarning(w, UNSUPPORTED_EDIT_WARNING),
          ),
        ).toEqual([]);
        expect(peer.warnings.filter(w => w.includes('self-check'))).toEqual([]);
      }
      // Nor the hold's report of a write its check did not foresee.
      expect(
        errors.mock.calls.filter(call =>
          String(call[0]).includes('@lexical/y'),
        ),
      ).toEqual([]);
    });

    for (const change of ['alignment', 'indent', 'direction'] as const) {
      test(`a hashtag typed with an input method while a collaborator changes the ${change} of its line is stored as a hashtag when the composition ends, as on main (${variant})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('see ')),
            );
          },
          {
            gc,
            ids,
            nodes: [...NODES, HashtagNode],
            prepare: (editor: LexicalEditor) => {
              registerLexicalHashtag(editor);
            },
          },
        );
        onTestFinished(() => t.peers.forEach(p => p.stop()));
        // A composes `#tag` at the end of the line: no transform runs on
        // the text being composed.
        let composed = '';
        t.a.update(() => {
          const line = $getRoot().getFirstChildOrThrow();
          const node = $isElementNode(line) ? line.getFirstChild() : null;
          if (!$isTextNode(node)) {
            return;
          }
          node.select(4, 4);
          composed = node.getKey();
          $setCompositionKey(composed);
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText('#tag');
          }
        });
        await t.sync();
        t.b.update(() => {
          const line = $getRoot().getFirstChildOrThrow();
          if ($isElementNode(line)) {
            if (change === 'alignment') {
              line.setFormat('center');
            } else if (change === 'indent') {
              line.setIndent(1);
            } else {
              line.setDirection('rtl');
            }
          }
          $setSelection(null);
        });
        await t.sync();
        // The composition ends: the hashtag transform makes `#tag` a
        // hashtag node, in the line whose held change is no change of its
        // type.
        endComposing(t.a, composed);
        await converged(t);
        const fresh = await freshReader(t.a);
        onTestFinished(() => fresh.stop());
        for (const peer of [...t.peers, fresh]) {
          expect(
            peer.read(() =>
              $getRoot()
                .getAllTextNodes()
                .map(n => `${n.getType()}:${n.getTextContent()}`),
            ),
          ).toEqual(['text:see ', 'hashtag:#tag']);
        }
        for (const peer of t.peers) {
          expect(
            peer.warningEvents.filter(w =>
              isYWarning(w, UNSUPPORTED_EDIT_WARNING),
            ),
          ).toEqual([]);
        }
      });
    }

    for (const shape of ['a cleared note', 'a set', 'an object'] as const) {
      test(`${shape} set on the line in the update that ends a composition while a collaborator centres that line, which the hashtag transform carries onto the token it makes, is written as on main (${variant})`, async () => {
        const t = await setup(
          () => {
            const text = $createTextNode('see ');
            $setState(text, note, 'old');
            $setState(text, marks, ['m1']);
            $setState(text, meta, {v: 1});
            $getRoot().append($createParagraphNode().append(text));
          },
          {
            gc,
            ids,
            nodes: [...NODES, HashtagNode],
            prepare: (editor: LexicalEditor) => {
              registerLexicalHashtag(editor);
            },
          },
        );
        onTestFinished(() => t.peers.forEach(p => p.stop()));
        let composed = '';
        t.a.update(() => {
          const node = $getRoot().getAllTextNodes()[0];
          node.select(4, 4);
          composed = node.getKey();
          $setCompositionKey(composed);
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText('#tag');
          }
        });
        await t.sync();
        t.b.update(() => {
          const line = $getRoot().getFirstChildOrThrow();
          if ($isElementNode(line)) {
            line.setFormat('center');
          }
          $setSelection(null);
        });
        await t.sync();
        // The update that ends the composition changes the value on the
        // line; the hashtag transform makes a token of `#tag` that carries
        // it.
        t.a.update(() => {
          $setCompositionKey(null);
          for (const n of $getRoot().getAllTextNodes()) {
            if (shape === 'a cleared note') {
              $setState(n, note, '');
            } else if (shape === 'a set') {
              $setState(n, marks, ['m2']);
            } else {
              $setState(n, meta, {v: 2});
            }
          }
          $setSelection(null);
        });
        await converged(t);
        const fresh = await freshReader(t.a);
        onTestFinished(() => fresh.stop());
        const $value = (n: TextNode): string =>
          shape === 'a cleared note'
            ? $getState(n, note)
            : shape === 'a set'
              ? $getState(n, marks).join('+')
              : JSON.stringify($getState(n, meta));
        const want =
          shape === 'a cleared note'
            ? ''
            : shape === 'a set'
              ? 'm2'
              : '{"v":2}';
        for (const peer of [...t.peers, fresh]) {
          expect(
            peer.read(() =>
              $getRoot()
                .getAllTextNodes()
                .map(n => `${n.getType()}:${n.getTextContent()}=${$value(n)}`),
            ),
          ).toEqual([`text:see =${want}`, `hashtag:#tag=${want}`]);
        }
        for (const peer of t.peers) {
          expect(
            peer.warningEvents.filter(w =>
              isYWarning(w, UNSUPPORTED_EDIT_WARNING),
            ),
          ).toEqual([]);
        }
      });
    }

    for (const convert of ['heading', 'quote', 'list item'] as const) {
      for (const entity of ['hashtag', 'autolink'] as const) {
        for (const who of ['every client', 'the composing client'] as const) {
          test(`a ${entity} typed with an input method while a collaborator makes its line a ${convert} is stored as a ${entity} when the composition ends, as on main (transform on ${who}, ${variant})`, async () => {
            const typed = entity === 'hashtag' ? '#tag' : 'https://lexical.dev';
            const register = (editor: LexicalEditor): (() => void) =>
              entity === 'hashtag'
                ? registerLexicalHashtag(editor)
                : registerAutoLink(editor, {
                    changeHandlers: [],
                    excludeParents: [],
                    matchers: [autoLinkUrlMatcher],
                  });
            const t = await setup(
              () => {
                $getRoot().append(
                  $createParagraphNode().append($createTextNode('see ')),
                );
              },
              {
                gc,
                ids,
                nodes: [...NODES, HashtagNode],
                prepare: (editor: LexicalEditor) => {
                  if (who === 'every client') {
                    register(editor);
                  }
                },
              },
            );
            onTestFinished(() => t.peers.forEach(p => p.stop()));
            if (who === 'the composing client') {
              // Only A runs the transform, so B's conversion does not make
              // the entity itself.
              onTestFinished(register(t.a.editor));
            }
            let composed = '';
            t.a.update(() => {
              const line = $getRoot().getFirstChildOrThrow();
              const node = $isElementNode(line) ? line.getFirstChild() : null;
              if (!$isTextNode(node)) {
                return;
              }
              node.select(4, 4);
              composed = node.getKey();
              $setCompositionKey(composed);
              const selection = $getSelection();
              if ($isRangeSelection(selection)) {
                selection.insertText(typed);
              }
            });
            await t.sync();
            t.b.update(() => {
              $getRoot().getFirstChildOrThrow().selectStart();
              if (convert === 'heading') {
                $setBlocksType($getSelection()!, () =>
                  $createHeadingNode('h2'),
                );
              } else if (convert === 'quote') {
                $setBlocksType($getSelection()!, () => $createQuoteNode());
              } else {
                $insertList('bullet');
              }
              $setSelection(null);
            });
            await t.sync();
            endComposing(t.a, composed);
            await converged(t);
            const fresh = await freshReader(t.a);
            onTestFinished(() => fresh.stop());
            const block =
              convert === 'heading'
                ? 'heading'
                : convert === 'quote'
                  ? 'quote'
                  : 'listitem';
            for (const peer of [...t.peers, fresh]) {
              expect(
                peer.read(() => {
                  const line = $getRoot()
                    .getAllTextNodes()[0]
                    .getParentOrThrow();
                  const shape = (n: LexicalNode): string =>
                    $isElementNode(n)
                      ? `${n.getType()}[${n.getChildren().map(shape).join('|')}]`
                      : `${n.getType()}:${n.getTextContent()}`;
                  return shape(
                    $isElementNode(line) && line.getType() === 'autolink'
                      ? line.getParentOrThrow()
                      : line,
                  );
                }),
              ).toBe(
                entity === 'hashtag'
                  ? `${block}[text:see |hashtag:#tag]`
                  : `${block}[text:see |autolink[text:https://lexical.dev]]`,
              );
            }
          });
        }
      }
    }

    for (const from of ['heading', 'paragraph'] as const) {
      test(`bold applied to the line in the update that ends a composition, where a collaborator made the ${from} a ${from === 'heading' ? 'paragraph' : 'heading'} and the hashtag transform made a token of the composed text, is written on all of it (${variant})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              (from === 'heading'
                ? $createHeadingNode('h2')
                : $createParagraphNode()
              ).append($createTextNode('see ')),
            );
          },
          {gc, ids, nodes: [...NODES, HashtagNode]},
        );
        onTestFinished(() => t.peers.forEach(p => p.stop()));
        // Only A runs the transform.
        onTestFinished(registerLexicalHashtag(t.a.editor));
        let composed = '';
        t.a.update(() => {
          const line = $getRoot().getFirstChildOrThrow();
          const node = $isElementNode(line) ? line.getFirstChild() : null;
          if (!$isTextNode(node)) {
            return;
          }
          node.select(4, 4);
          composed = node.getKey();
          $setCompositionKey(composed);
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText('#tag');
          }
        });
        await t.sync();
        t.b.update(() => {
          $getRoot().getFirstChildOrThrow().selectStart();
          $setBlocksType($getSelection()!, () =>
            from === 'heading'
              ? $createParagraphNode()
              : $createHeadingNode('h2'),
          );
          $setSelection(null);
        });
        await t.sync();
        t.a.update(() => {
          $setCompositionKey(null);
          const line = $getRoot().getFirstChildOrThrow();
          if ($isElementNode(line)) {
            line.select(0, line.getChildrenSize());
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              selection.formatText('bold');
            }
          }
          $setSelection(null);
        });
        await converged(t);
        const fresh = await freshReader(t.a);
        onTestFinished(() => fresh.stop());
        for (const peer of [...t.peers, fresh]) {
          expect(
            peer.read(() =>
              $getRoot()
                .getAllTextNodes()
                .map(
                  n =>
                    `${n.getType()}:${n.getTextContent()}${n.hasFormat('bold') ? '/b' : ''}`,
                )
                .join('|'),
            ),
          ).toBe('text:see /b|hashtag:#tag/b');
        }
      });
    }

    for (const [highlighter, every] of [
      ['Prism', false],
      ['Shiki', false],
      ['Prism', true],
      ['Shiki', true],
    ] as const) {
      test(`a hashtag typed with an input method in a line a collaborator makes a code block, with bold and a NodeState value set on the line in the update that ends the composition, is stored as the highlighter's tokens, which keep the NodeState value and whose formats follow the highlighter, ${every ? 'where every client highlights' : 'where only the composing client highlights: its transforms run again on the line read as stored'} (${highlighter}, ${variant})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('see ')),
            );
          },
          {gc, ids, nodes: [...NODES, HashtagNode]},
        );
        onTestFinished(() => t.peers.forEach(p => p.stop()));
        // The hashtag's transform and the highlighter, on A only or on
        // every client (B's then tokenizes the line it makes a code block).
        for (const peer of every ? t.peers : [t.a]) {
          onTestFinished(registerLexicalHashtag(peer.editor));
          onTestFinished(
            highlighter === 'Prism'
              ? registerCodeHighlighting(peer.editor)
              : registerShikiHighlighting(peer.editor),
          );
        }
        let composed = '';
        t.a.update(() => {
          const node = $getRoot().getAllTextNodes()[0];
          node.select(4, 4);
          composed = node.getKey();
          $setCompositionKey(composed);
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText('#tag');
          }
        });
        await t.sync();
        t.b.update(() => {
          $getRoot().getFirstChildOrThrow().selectStart();
          $setBlocksType($getSelection()!, () => $createCodeNode('javascript'));
          $setSelection(null);
        });
        await t.sync();
        // The update that ends the composition bolds the line and sets a
        // note on it; the hashtag transform makes a token of `#tag`.
        t.a.update(() => {
          $setCompositionKey(null);
          for (const n of $getRoot().getAllTextNodes()) {
            n.setFormat('bold');
            $setState(n, note, 'saved');
          }
          $setSelection(null);
        });
        await converged(t);
        const fresh = await freshReader(t.a);
        onTestFinished(() => fresh.stop());
        for (const peer of [...t.peers, fresh]) {
          // The highlighter's tokens (B's, or A's once its transforms run
          // again on the line read as stored), which keep the note that the
          // update that ends the composition set (code highlight nodes keep
          // no format).
          expect(
            peer.read(() =>
              $getRoot()
                .getAllTextNodes()
                .flatMap(n =>
                  [...n.getTextContent()].map(
                    () =>
                      `${n.getType()}${n.hasFormat('bold') ? '/b' : ''}:${$getState(n, note)}`,
                  ),
                )
                .join(','),
            ),
          ).toBe(Array(8).fill('code-highlight:saved').join(','));
        }
      });
    }

    for (const replacement of ['factory', 'chain'] as const) {
      test(`a hashtag typed with an input method in a paragraph the composing editor shows through a node replacement (${replacement}), which a collaborator makes an ordinary paragraph and centres, is stored as a hashtag when the composition ends, as on main (${variant})`, async () => {
        const registered: Klass<LexicalNode>[] = [
          ...NODES,
          HashtagNode,
          CustomParagraphNode,
          InnerParagraphNode,
          OuterParagraphNode,
        ];
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('see ')),
            );
          },
          {gc, ids, nodes: registered},
        );
        onTestFinished(() => t.peers.forEach(p => p.stop()));
        // The composing client replaces ParagraphNode: with a factory that
        // declares no class, or with a chain of two replacements. Only it
        // runs the hashtag transform.
        const composer = new Peer(
          33,
          {
            delivery: 'causal',
            peers: [],
            pumping: false,
            queue: [],
          } as unknown as Peer['net'],
          [
            ...registered,
            ...(replacement === 'factory'
              ? [
                  {
                    replace: ParagraphNode,
                    with: () => new CustomParagraphNode(),
                  },
                ]
              : [
                  {
                    replace: ParagraphNode,
                    with: () => $create(InnerParagraphNode),
                    withKlass: InnerParagraphNode,
                  },
                  {
                    replace: InnerParagraphNode,
                    with: () => $create(OuterParagraphNode),
                    withKlass: OuterParagraphNode,
                  },
                ]),
          ] as unknown as Peer['nodes'],
          editor => {
            registerLexicalHashtag(editor);
          },
          false,
          gc,
        );
        onTestFinished(() => composer.stop());
        const toComposer = () =>
          Y.applyUpdate(composer.doc, Y.encodeStateAsUpdate(t.a.doc), 'peer');
        const fromComposer = () =>
          Y.applyUpdate(t.a.doc, Y.encodeStateAsUpdate(composer.doc), 'peer');
        toComposer();
        composer.binding.initialize();
        await flush();
        let composed = '';
        composer.update(() => {
          const node = $getRoot().getAllTextNodes()[0];
          node.select(4, 4);
          composed = node.getKey();
          $setCompositionKey(composed);
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText('#tag');
          }
        });
        fromComposer();
        await t.sync();
        // B makes an ordinary paragraph of the line, keeping its children,
        // and centres it.
        t.b.update(() => {
          const old = $getRoot().getFirstChildOrThrow();
          if ($isElementNode(old)) {
            const next = $createParagraphNode().append(...old.getChildren());
            next.setFormat('center');
            old.replace(next);
          }
          $setSelection(null);
        });
        await t.sync();
        toComposer();
        await flush();
        composer.update(() => {
          $setCompositionKey(null);
          const n = $getNodeByKey(composed);
          if ($isTextNode(n) && n.isAttached()) {
            n.getWritable();
          }
          $setSelection(null);
        });
        await flush();
        fromComposer();
        await t.sync();
        await t.sync();
        toComposer();
        await flush();
        const fresh = await freshReader(t.a);
        onTestFinished(() => fresh.stop());
        for (const peer of [t.a, t.b, composer, fresh]) {
          expect(
            peer.read(() =>
              $getRoot()
                .getAllTextNodes()
                .map(n => `${n.getType()}:${n.getTextContent()}`)
                .join('|'),
            ),
          ).toBe('text:see |hashtag:#tag');
        }
      });
    }

    test(`a line held in a composition, which a collaborator makes a heading and deletes as the composition ends, leaves the block after it as stored (${variant})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('see ')),
          );
        },
        {gc, ids, nodes: [...NODES, HashtagNode]},
      );
      onTestFinished(() => t.peers.forEach(p => p.stop()));
      // Only A runs the transforms: the hashtag's and the highlighter's.
      onTestFinished(registerLexicalHashtag(t.a.editor));
      onTestFinished(registerCodeHighlighting(t.a.editor));
      const composed = composeHashtag(t.a);
      await t.sync();
      // B makes the line a heading and appends a code block with an
      // underlined word and a note, which A reads as it is.
      makeHeading(t.b);
      t.b.update(() => {
        $getRoot().append(
          $createCodeNode('javascript').append(
            $setState(
              $createTextNode('let untouched = 1;').setFormat('underline'),
              note,
              'old',
            ),
          ),
        );
        $setSelection(null);
      });
      await t.sync();
      // B deletes the heading; A reads it right after its write of the
      // update that ends the composition, before the hold is released.
      t.offline();
      t.b.update(() => {
        $getRoot().getFirstChildOrThrow().remove();
        $setSelection(null);
      });
      const expected = blocks(t.b);
      const remote = Y.encodeStateAsUpdate(
        t.b.doc,
        Y.encodeStateVector(t.a.doc),
      );
      let delivered = false;
      const deliver = (tr: Y.Transaction) => {
        if (!delivered && tr.origin === t.a.binding) {
          delivered = true;
          Y.applyUpdate(t.a.doc, remote, 'provider');
        }
      };
      t.a.doc.on('afterTransactionCleanup', deliver);
      onTestFinished(() => t.a.doc.off('afterTransactionCleanup', deliver));
      endComposing(t.a, composed);
      await converged(t);
      expect(delivered).toBe(true);
      const fresh = await freshReader(t.a);
      onTestFinished(() => fresh.stop());
      for (const peer of [...t.peers, fresh]) {
        expect(blocks(peer)).toBe(expected);
      }
      expect(expected).toBe('code[text:let untouched = 1;/8/old]');
    });

    test(`a line held in a composition, which a collaborator joins into the line before it and follows with a code block, gets the hashtag the composition made, and the code block stays as stored (${variant})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('see ')),
          );
        },
        {gc, ids, nodes: [...NODES, HashtagNode]},
      );
      onTestFinished(() => t.peers.forEach(p => p.stop()));
      t.a.update(() => {
        $getRoot()
          .getFirstChildOrThrow()
          .insertBefore(
            $createParagraphNode().append($createTextNode('intro ')),
          );
        $setSelection(null);
      });
      await t.sync();
      onTestFinished(registerLexicalHashtag(t.a.editor));
      onTestFinished(registerCodeHighlighting(t.a.editor));
      let composed = '';
      t.a.update(() => {
        const node = $getRoot().getAllTextNodes()[1];
        node.selectEnd();
        composed = node.getKey();
        $setCompositionKey(composed);
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText('#tag');
        }
      });
      await t.sync();
      // B joins the line into the one before it (Backspace at its start)
      // and appends a code block with an underlined word and a note.
      t.b.update(() => {
        const line = $getRoot().getChildAtIndex(1);
        if ($isElementNode(line)) {
          line.selectStart().deleteCharacter(true);
        }
        $getRoot().append(
          $createCodeNode('javascript').append(
            $setState(
              $createTextNode('let untouched = 1;').setFormat('underline'),
              note,
              'old',
            ),
          ),
        );
        $setSelection(null);
      });
      await t.sync();
      endComposing(t.a, composed);
      await converged(t);
      const fresh = await freshReader(t.a);
      onTestFinished(() => fresh.stop());
      for (const peer of [...t.peers, fresh]) {
        expect(blocks(peer)).toBe(
          'paragraph[text:intro see /0/|hashtag:#tag/0/] code[text:let untouched = 1;/8/old]',
        );
      }
    });

    for (const edit of ['bold', 'a note'] as const) {
      test(`${edit} set on a line that starts with an inline decorator, in the update that ends a composition held while a collaborator makes the line a heading, is written on the hashtag the transform makes, as on main (${variant})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append(
                $create(InlineEquationNode),
                $createTextNode('see '),
              ),
            );
          },
          {
            gc,
            ids,
            nodes: [...NODES, HashtagNode, InlineEquationNode],
            prepare: (editor: LexicalEditor) => {
              registerLexicalHashtag(editor);
            },
          },
        );
        onTestFinished(() => t.peers.forEach(p => p.stop()));
        composeHashtag(t.a);
        await t.sync();
        makeHeading(t.b);
        await t.sync();
        t.a.update(() => {
          $setCompositionKey(null);
          for (const n of $getRoot().getAllTextNodes()) {
            if (edit === 'bold') {
              n.setFormat('bold');
            } else {
              $setState(n, note, 'new');
            }
          }
          $setSelection(null);
        });
        await converged(t);
        const fresh = await freshReader(t.a);
        onTestFinished(() => fresh.stop());
        for (const peer of [...t.peers, fresh]) {
          expect(blocks(peer)).toBe(
            edit === 'bold'
              ? 'heading[text:see /1/|hashtag:#tag/1/]'
              : 'heading[text:see /0/new|hashtag:#tag/0/new]',
          );
          expect(peer.read(() => $getRoot().getTextContent())).toBe(
            'x^2see #tag',
          );
        }
      });
    }

    for (const transform of ['bold', 'capitals'] as const) {
      test(`an app's transform that sets ${transform} on text in a heading ${transform === 'bold' ? 'applies to the line a collaborator made a heading, as the transforms run again on the line read as stored once the composition held there ends' : 'changes the text of the line a collaborator made a heading, as the transforms run again on it, which is not written, nor the hashtag made with it (main writes the hashtag)'} (${variant})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('before ')),
            );
          },
          {gc, ids, nodes: [...NODES, HashtagNode]},
        );
        onTestFinished(() => t.peers.forEach(p => p.stop()));
        // Only A runs the transforms.
        onTestFinished(registerLexicalHashtag(t.a.editor));
        onTestFinished(
          t.a.editor.registerNodeTransform(TextNode, node => {
            if (!$isHeadingNode(node.getParent())) {
              return;
            }
            if (transform === 'bold') {
              if (!node.hasFormat('bold')) {
                node.toggleFormat('bold');
              }
            } else if (
              node.getTextContent() !== node.getTextContent().toUpperCase()
            ) {
              node.setTextContent(node.getTextContent().toUpperCase());
            }
          }),
        );
        const composed = composeHashtag(t.a);
        await t.sync();
        makeHeading(t.b);
        await t.sync();
        endComposing(t.a, composed);
        await converged(t);
        const fresh = await freshReader(t.a);
        onTestFinished(() => fresh.stop());
        // The hashtag, and the bold the app's transform sets on the text in
        // the heading; capitals change the text, so nothing is written and
        // the line stays as stored.
        for (const peer of [...t.peers, fresh]) {
          expect(blocks(peer)).toBe(
            transform === 'bold'
              ? 'heading[text:before /1/|hashtag:#tag/0/]'
              : 'heading[text:before #tag/0/]',
          );
        }
      });
    }

    test(`one undo takes back the update that ends a composition together with the transforms run again on the line read as stored, as main takes back that update (${variant})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('see ')),
          );
        },
        {gc, ids, nodes: [...NODES, HashtagNode]},
      );
      onTestFinished(() => t.peers.forEach(p => p.stop()));
      // Only A runs the transform.
      onTestFinished(registerLexicalHashtag(t.a.editor));
      let composed = '';
      t.a.update(() => {
        const line = $getRoot().getFirstChildOrThrow();
        const node = $isElementNode(line) ? line.getFirstChild() : null;
        if (!$isTextNode(node)) {
          return;
        }
        node.select(4, 4);
        composed = node.getKey();
        $setCompositionKey(composed);
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText('#tag');
        }
      });
      await t.sync();
      t.b.update(() => {
        $getRoot().getFirstChildOrThrow().selectStart();
        $setBlocksType($getSelection()!, () => $createHeadingNode('h2'));
        $setSelection(null);
      });
      await t.sync();
      // The update that ends the composition also bolds the line.
      t.a.update(() => {
        $setCompositionKey(null);
        const line = $getRoot().getFirstChildOrThrow();
        if ($isElementNode(line)) {
          line.select(0, line.getChildrenSize());
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.formatText('bold');
          }
        }
        $setSelection(null);
      });
      await t.sync();
      const tokens = (peer: Peer) =>
        peer.read(() =>
          $getRoot()
            .getAllTextNodes()
            .map(
              n =>
                `${n.getType()}:${n.getTextContent()}${n.hasFormat('bold') ? '/b' : ''}`,
            )
            .join('|'),
        );
      expect(tokens(t.a)).toBe('text:see /b|hashtag:#tag/b');
      t.a.undo();
      await converged(t);
      for (const peer of t.peers) {
        expect(tokens(peer)).toBe('text:see #tag');
      }
    });

    for (const timeout of [0, 10000] as const) {
      for (const between of [
        'nothing',
        "a collaborator's edit",
        "an app's edit",
      ] as const) {
        test(`with captureTimeout ${timeout} and ${between} between the update that ends a composition and the transforms run again on the line read as stored, ${between === "an app's edit" && timeout === 0 ? 'that app edit leaves those transforms an undo step of their own' : 'one undo takes back that update together with them'} (${variant})`, async () => {
          const t = await setup(
            () => {
              $getRoot().append(
                $createParagraphNode().append($createTextNode('see ')),
                $createParagraphNode().append($createTextNode('other')),
              );
            },
            {gc, ids, nodes: [...NODES, HashtagNode]},
          );
          onTestFinished(() => t.peers.forEach(p => p.stop()));
          // Only A runs the transform.
          onTestFinished(registerLexicalHashtag(t.a.editor));
          const um = t.a.binding.undoManager!;
          um.captureTimeout = timeout;
          composeHashtag(t.a);
          await t.sync();
          makeHeading(t.b);
          await t.sync();
          let deliver: ((tr: Y.Transaction) => void) | null = null;
          if (between === "a collaborator's edit") {
            // B types in the other line; A reads it right after its write of
            // the update that ends the composition.
            t.offline();
            t.b.update(() => {
              $getRoot().getLastChildOrThrow().selectEnd().insertText(' B');
              $setSelection(null);
            });
            const remote = Y.encodeStateAsUpdate(
              t.b.doc,
              Y.encodeStateVector(t.a.doc),
            );
            const handler = (tr: Y.Transaction) => {
              if (tr.origin === t.a.binding) {
                t.a.doc.off('afterTransactionCleanup', handler);
                Y.applyUpdate(t.a.doc, remote, 'provider');
              }
            };
            deliver = handler;
            t.a.doc.on('afterTransactionCleanup', handler);
          }
          let armed = between === "an app's edit";
          // An app's edit queued as the composition ends: written before
          // the transforms run again on the line read as stored.
          onTestFinished(
            t.a.editor.registerUpdateListener(() => {
              if (armed) {
                armed = false;
                t.a.editor.update(() => {
                  $getRoot()
                    .getLastChildOrThrow()
                    .selectEnd()
                    .insertText(' APP');
                  $setSelection(null);
                });
              }
            }),
          );
          // The update that ends the composition starts an undo step and
          // bolds the line.
          um.stopCapturing();
          const steps = um.undoStack.length;
          t.a.update(() => {
            $setCompositionKey(null);
            const line = $getRoot().getFirstChildOrThrow();
            if ($isElementNode(line)) {
              line.select(0, line.getChildrenSize());
              const selection = $getSelection();
              if ($isRangeSelection(selection)) {
                selection.formatText('bold');
              }
            }
            $setSelection(null);
          });
          await converged(t);
          if (deliver !== null) {
            t.a.doc.off('afterTransactionCleanup', deliver);
          }
          const edited =
            between === 'nothing'
              ? 'other'
              : between === "an app's edit"
                ? 'other APP'
                : 'other B';
          expect(blocks(t.a)).toBe(
            `heading[text:see /1/|hashtag:#tag/1/] paragraph[text:${edited}/0/]`,
          );
          const undo = async () => {
            t.a.undo();
            await converged(t);
          };
          if (between === "an app's edit" && timeout === 0) {
            // The update that ends the composition, the app's edit, and the
            // transforms run again, each an undo step.
            expect(um.undoStack.length - steps).toBe(3);
            await undo();
            expect(blocks(t.a)).toBe(
              'heading[text:see #tag/1/] paragraph[text:other APP/0/]',
            );
            await undo();
            expect(blocks(t.a)).toBe(
              'heading[text:see #tag/1/] paragraph[text:other/0/]',
            );
            await undo();
          } else {
            expect(um.undoStack.length - steps).toBe(1);
            await undo();
          }
          const fresh = await freshReader(t.a);
          onTestFinished(() => fresh.stop());
          for (const peer of [...t.peers, fresh]) {
            expect(blocks(peer)).toBe(
              `heading[text:see #tag/0/] paragraph[text:${between === "a collaborator's edit" ? 'other B' : 'other'}/0/]`,
            );
          }
        });
      }
    }

    for (const into of ['quote', 'code block'] as const) {
      test(`an app's transform that makes the heading a collaborator made of a held line a ${into}, as the transforms run again on the line read as stored, leaves the line as stored (${variant})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('before ')),
            );
          },
          {gc, ids, nodes: [...NODES, HashtagNode]},
        );
        onTestFinished(() => t.peers.forEach(p => p.stop()));
        // Only A runs the transforms.
        onTestFinished(registerLexicalHashtag(t.a.editor));
        if (into === 'code block') {
          onTestFinished(registerCodeHighlighting(t.a.editor));
        }
        onTestFinished(
          t.a.editor.registerNodeTransform(HeadingNode, node => {
            node.replace(
              into === 'quote' ? $createQuoteNode() : $createCodeNode(),
              true,
            );
          }),
        );
        const composed = composeHashtag(t.a);
        await t.sync();
        makeHeading(t.b);
        await t.sync();
        endComposing(t.a, composed);
        await converged(t);
        const fresh = await freshReader(t.a);
        onTestFinished(() => fresh.stop());
        // The block stays as stored (what else the transforms changed is
        // read again).
        for (const peer of [...t.peers, fresh]) {
          expect(blocks(peer)).toBe('heading[text:before #tag/0/]');
        }
      });
    }

    for (const how of [
      'split over two quotes',
      'its first part moved into the next paragraph',
    ] as const) {
      test(`an app's transform that replaces the heading a collaborator made of a held line, ${how}, as the transforms run again on the line read as stored, leaves the line as stored (${variant})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('before ')),
              $createParagraphNode().append($createTextNode('other')),
            );
          },
          {gc, ids, nodes: [...NODES, HashtagNode]},
        );
        onTestFinished(() => t.peers.forEach(p => p.stop()));
        // Only A runs the transforms: the second puts `before ` and the
        // rest of the heading in two quotes, or `before ` in the paragraph
        // after it and the rest in a quote.
        onTestFinished(registerLexicalHashtag(t.a.editor));
        onTestFinished(
          t.a.editor.registerNodeTransform(HeadingNode, node => {
            const text = node.getAllTextNodes()[0];
            if (text === undefined || node.getTextContent() !== 'before #tag') {
              return;
            }
            const lead =
              text.getTextContentSize() > 7 ? text.splitText(7)[0] : text;
            const rest = node.getChildren().filter(child => !child.is(lead));
            const quote = $createQuoteNode();
            if (how === 'split over two quotes') {
              quote.append(lead);
              const second = $createQuoteNode().append(...rest);
              node.replace(quote);
              quote.insertAfter(second);
            } else {
              const next = $getRoot().getLastChildOrThrow();
              if ($isElementNode(next)) {
                next.append(lead);
              }
              quote.append(...rest);
              node.replace(quote);
            }
          }),
        );
        const composed = composeHashtag(t.a);
        await t.sync();
        makeHeading(t.b);
        await t.sync();
        endComposing(t.a, composed);
        await converged(t);
        const fresh = await freshReader(t.a);
        onTestFinished(() => fresh.stop());
        for (const peer of [...t.peers, fresh]) {
          expect(blocks(peer)).toBe(
            'heading[text:before #tag/0/] paragraph[text:other/0/]',
          );
        }
      });
    }

    for (const shape of [
      'split over two quotes, the same text in a paragraph after them',
      'wrapped in a quote after a token with the same text',
      'wrapped in brackets in a quote, after a long word',
    ] as const) {
      test(`an app's transform that restructures the heading a collaborator made of a held line, ${shape}, as the transforms run again on the line read as stored, leaves the line as stored (${variant})`, async () => {
        const word = shape.startsWith('wrapped in brackets')
          ? 'a'.repeat(1000) + ' '
          : 'before ';
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode(word)),
            );
            if (shape.startsWith('split')) {
              $getRoot().append(
                $createParagraphNode().append(
                  $createTextNode('before #tag').setMode('token'),
                ),
              );
            }
          },
          {gc, ids, nodes: [...NODES, HashtagNode]},
        );
        onTestFinished(() => t.peers.forEach(p => p.stop()));
        // Only A runs the transforms.
        onTestFinished(registerLexicalHashtag(t.a.editor));
        onTestFinished(
          t.a.editor.registerNodeTransform(HeadingNode, node => {
            if (node.getTextContent() !== word + '#tag') {
              return;
            }
            const quote = $createQuoteNode();
            if (shape.startsWith('split')) {
              const first = node.getAllTextNodes()[0];
              const lead =
                first.getTextContentSize() > 7 ? first.splitText(7)[0] : first;
              const rest = node.getChildren().filter(c => !c.is(lead));
              quote.append(lead);
              const second = $createQuoteNode().append(...rest);
              node.replace(quote);
              quote.insertAfter(second);
            } else if (shape.startsWith('wrapped in a quote')) {
              quote.append(
                $createTextNode('before #tag').setMode('token'),
                $createTextNode('|'),
                ...node.getChildren(),
              );
              node.replace(quote);
            } else {
              quote.append(
                $createTextNode('['),
                ...node.getChildren(),
                $createTextNode(']'),
              );
              node.replace(quote);
            }
          }),
        );
        const composed = composeHashtag(t.a);
        await t.sync();
        makeHeading(t.b);
        await t.sync();
        endComposing(t.a, composed);
        await converged(t);
        const fresh = await freshReader(t.a);
        onTestFinished(() => fresh.stop());
        for (const peer of [...t.peers, fresh]) {
          expect(blocks(peer)).toBe(
            `heading[text:${word}#tag/0/]` +
              (shape.startsWith('split')
                ? ' paragraph[text:before #tag/0/]'
                : ''),
          );
        }
      });
    }

    test(`a hashtag that is the whole line, held while a collaborator makes it a heading, is written when the composition ends, though the transform replaces the line's only text node, as on main (${variant})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('#')),
          );
        },
        {gc, ids, nodes: [...NODES, HashtagNode]},
      );
      onTestFinished(() => t.peers.forEach(p => p.stop()));
      onTestFinished(registerLexicalHashtag(t.a.editor));
      let composed = '';
      t.a.update(() => {
        const node = $getRoot().getAllTextNodes()[0];
        node.selectEnd();
        composed = node.getKey();
        $setCompositionKey(composed);
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText('tag');
        }
      });
      await t.sync();
      makeHeading(t.b);
      await t.sync();
      endComposing(t.a, composed);
      await converged(t);
      const fresh = await freshReader(t.a);
      onTestFinished(() => fresh.stop());
      for (const peer of [...t.peers, fresh]) {
        expect(blocks(peer)).toBe('heading[hashtag:#tag/0/]');
      }
    });

    for (const after of ['', ' after'] as const) {
      test(`an app's transform that upper-cases text in a heading, as the transforms run again on the line a collaborator made a heading, changes its text, so nothing is written: ${after === '' ? 'nor the hashtag at the end of the line (main writes the hashtag)' : 'the line stays as stored, as on main'} (${variant})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('before ' + after)),
            );
          },
          {gc, ids, nodes: [...NODES, HashtagNode]},
        );
        onTestFinished(() => t.peers.forEach(p => p.stop()));
        // Only A runs the transforms.
        onTestFinished(registerLexicalHashtag(t.a.editor));
        onTestFinished(
          t.a.editor.registerNodeTransform(TextNode, node => {
            if (
              $isHeadingNode(node.getParent()) &&
              node.getTextContent() !== node.getTextContent().toUpperCase()
            ) {
              node.setTextContent(node.getTextContent().toUpperCase());
            }
          }),
        );
        let composed = '';
        t.a.update(() => {
          const node = $getRoot().getAllTextNodes()[0];
          node.select(7, 7);
          composed = node.getKey();
          $setCompositionKey(composed);
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText('#tag');
          }
        });
        await t.sync();
        makeHeading(t.b);
        await t.sync();
        endComposing(t.a, composed);
        await converged(t);
        const fresh = await freshReader(t.a);
        onTestFinished(() => fresh.stop());
        for (const peer of [...t.peers, fresh]) {
          expect(blocks(peer)).toBe(
            after === ''
              ? 'heading[text:before #tag/0/]'
              : 'heading[text:before #tag after/0/]',
          );
        }
      });
    }

    for (const value of ['bold', 'a note'] as const) {
      test(`${value} that a collaborator's own transforms set on the text of the heading it made of a held line, also made a code block, gives way to the composing client's highlighter's tokens${value === 'a note' ? ', which keep the note,' : ''} when the composition ends, as the transforms run again on the line read as stored (${variant})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('see  after')),
            );
          },
          {
            gc,
            ids,
            nodes: [...NODES, HashtagNode],
            prepare: (editor: LexicalEditor) => {
              // Every client's transforms: text in a heading gets the
              // value, and a heading becomes a code block.
              editor.registerNodeTransform(TextNode, node => {
                if (!$isHeadingNode(node.getParent())) {
                  return;
                }
                if (value === 'bold') {
                  if (!node.hasFormat('bold')) {
                    node.toggleFormat('bold');
                  }
                } else if ($getState(node, note) !== 'N') {
                  $setState(node, note, 'N');
                }
              });
              editor.registerNodeTransform(HeadingNode, node => {
                node.replace($createCodeNode('javascript'), true);
              });
            },
          },
        );
        onTestFinished(() => t.peers.forEach(p => p.stop()));
        // A also runs the hashtag transform and the highlighter.
        onTestFinished(registerLexicalHashtag(t.a.editor));
        onTestFinished(registerCodeHighlighting(t.a.editor));
        let composed = '';
        t.a.update(() => {
          const node = $getRoot().getAllTextNodes()[0];
          node.select(4, 4);
          composed = node.getKey();
          $setCompositionKey(composed);
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText('#tag');
          }
        });
        await t.sync();
        makeHeading(t.b);
        await t.sync();
        endComposing(t.a, composed);
        await converged(t);
        const fresh = await freshReader(t.a);
        onTestFinished(() => fresh.stop());
        // A's highlighter tokenizes the code block it reads (code highlight
        // nodes keep no format; they keep B's note).
        for (const peer of [...t.peers, fresh]) {
          expect(blocks(peer)).toBe(
            value === 'bold'
              ? 'code[code-highlight:see #tag after/0/]'
              : 'code[code-highlight:see /0/N|code-highlight:#tag/0/N|code-highlight: after/0/N]',
          );
        }
      });
    }

    test(`a style set on the line in the update that ends a composition, where a collaborator's held change made the line a heading and set another style, is cleared with the collaborator's by the app's transform that clears the style of text in a heading, as the transforms run again on the line read as stored (${variant})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('before ')),
          );
        },
        {gc, ids, nodes: [...NODES, HashtagNode]},
      );
      onTestFinished(() => t.peers.forEach(p => p.stop()));
      // Only A runs the transforms: the hashtag's, and one that clears the
      // style of text in a heading.
      onTestFinished(registerLexicalHashtag(t.a.editor));
      const clear = (node: TextNode) => {
        if ($isHeadingNode(node.getParent()) && node.getStyle() !== '') {
          node.setStyle('');
        }
      };
      onTestFinished(t.a.editor.registerNodeTransform(TextNode, clear));
      onTestFinished(t.a.editor.registerNodeTransform(HashtagNode, clear));
      composeHashtag(t.a);
      await t.sync();
      t.b.update(() => {
        const line = $getRoot().getFirstChildOrThrow();
        if ($isElementNode(line)) {
          line.replace($createHeadingNode('h2').append(...line.getChildren()));
        }
        for (const text of $getRoot().getAllTextNodes()) {
          text.setStyle('color:blue');
        }
        $setSelection(null);
      });
      await t.sync();
      t.a.update(() => {
        $setCompositionKey(null);
        for (const n of $getRoot().getAllTextNodes()) {
          n.setStyle('color:green');
        }
        $setSelection(null);
      });
      await converged(t);
      const fresh = await freshReader(t.a);
      onTestFinished(() => fresh.stop());
      for (const peer of [...t.peers, fresh]) {
        expect(
          peer.read(() =>
            $getRoot()
              .getAllTextNodes()
              .map(n => `${n.getType()}:${n.getTextContent()}=${n.getStyle()}`),
          ),
        ).toEqual(['text:before =', 'hashtag:#tag=']);
      }
    });

    test(`a composition that ends in the update inserting its text, as Firefox's input and WebKit's insertFromComposition end one, is written with the highlighter's tokens, each keeping the NodeState of the text it covers (${variant})`, async () => {
      const t = await setupJoin('paragraph', gc, ids);
      const composed = startComposing(t.a);
      await t.sync();
      joinCode(t.b);
      await t.sync();
      // One update inserts the composed text and ends the composition: the
      // line's text changes, so its re-typing is written as main writes it
      // (an accepted limit, see DECISIONS.md D115); the highlighter's tokens
      // keep each word's comment mark.
      t.a.update(() => {
        const n = $getNodeByKey(composed);
        if ($isTextNode(n) && n.isAttached()) {
          n.select(1, 1);
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText('zz');
          }
        }
        $setCompositionKey(null);
        $setSelection(null);
      });
      expect(await converged(t)).toBe(
        'paragraph[hl:aa bb|hl: cc/c5|hl: dd/c6|l|hl:zz|et x = 1;]',
      );
    });

    for (const highlighter of ['Prism', 'Shiki'] as const) {
      for (const shape of ['string', 'anchor', 'flat anchor'] as const) {
        test(`a NodeState value (${shape}) set in the update that ends the composition on a code token that the highlighter replaces, the join having changed the line's tokens, is kept (${highlighter}, ${variant})`, async () => {
          const value = VALUE_SHAPES[shape];
          // `before` and `let` join into one word, `beforelet`: the
          // highlighter's token for it replaces the `let` keyword token.
          const t = await setup(
            () => {
              $getRoot().append(
                $createParagraphNode().append($createTextNode('before')),
                $createCodeNode('javascript').append(
                  $createCodeHighlightNode('let x = 1;'),
                ),
              );
            },
            {
              gc,
              ids,
              nodes: value.nodes,
              prepare: (editor: LexicalEditor) => {
                if (highlighter === 'Prism') {
                  registerCodeHighlighting(editor);
                } else {
                  registerShikiHighlighting(editor);
                }
              },
            },
          );
          const host = document.createElement('div');
          host.contentEditable = 'true';
          document.body.append(host);
          t.a.editor.setRootElement(host);
          host.focus();
          onTestFinished(() => {
            t.a.editor.setRootElement(null);
            host.remove();
            t.peers.forEach(p => p.stop());
          });
          startComposing(t.a);
          await t.sync();
          joinCode(t.b);
          await t.sync();
          let token = '';
          t.a.update(() => {
            $setCompositionKey(null);
            const line = $getRoot().getChildrenSize() - 1;
            for (const n of $selectIn([line], 6, 9).extract()) {
              if ($isTextNode(n)) {
                token = n.getKey();
                value.$set(n);
              }
            }
            $setSelection(null);
          });
          // The highlighter replaced the token the value was set on.
          expect(t.a.read(() => $getNodeByKey(token))).toBe(null);
          await converged(t);
          const values = t.a.read(() =>
            $getRoot()
              .getAllTextNodes()
              .flatMap(n =>
                [...n.getTextContent()].map(() => (value.$has(n) ? 's' : '-')),
              )
              .join(''),
          );
          expect(show(t.a)).not.toContain('hl:');
          expect(t.a.read(() => $getRoot().getTextContent())).toBe(
            'beforelet x = 1;',
          );
          expect(values).toBe('------sss' + '-'.repeat(7));
        });
      }
    }

    for (const highlighter of ['Prism', 'Shiki'] as const) {
      for (const merging of [false, true]) {
        test(`a NodeState value extended in the update that ends the composition onto characters next to others that had it is written (${highlighter}${merging ? ', with a tokenizer that makes one token of each run of tokens' : ''}, ${variant})`, async () => {
          // A merged token is split again at the boundaries of each node with
          // NodeState, after whatever tokenizer the stock highlighters run.
          const merges = {count: 0};
          const base: PrismTokenizerType =
            highlighter === 'Prism'
              ? PrismTokenizer
              : (ShikiTokenizer as unknown as PrismTokenizerType);
          const tokenizer = merging ? mergingTokenizer(base, merges) : base;
          const t = await setup(
            () => {
              const bef = $createTextNode('bef');
              $setState(bef, note, 'saved');
              $getRoot().append(
                $createParagraphNode().append(
                  bef,
                  $createTextNode('ore'),
                  $createTextNode(' '),
                ),
                $createCodeNode('javascript').append(
                  $createCodeHighlightNode('let x = 1;'),
                ),
              );
            },
            {
              gc,
              ids,
              prepare: (editor: LexicalEditor) => {
                if (highlighter === 'Prism') {
                  registerCodeHighlighting(editor, tokenizer);
                } else {
                  registerShikiHighlighting(
                    editor,
                    tokenizer as unknown as ShikiTokenizerType,
                  );
                }
              },
            },
          );
          const host = document.createElement('div');
          host.contentEditable = 'true';
          document.body.append(host);
          t.a.editor.setRootElement(host);
          host.focus();
          onTestFinished(() => {
            t.a.editor.setRootElement(null);
            host.remove();
            t.peers.forEach(p => p.stop());
          });
          startComposing(t.a);
          await t.sync();
          joinCode(t.b);
          await t.sync();
          t.a.update(() => {
            $setCompositionKey(null);
            const line = $getRoot().getChildrenSize() - 1;
            for (const n of $selectIn([line], 3, 6).extract()) {
              if ($isTextNode(n)) {
                $setState(n, note, 'saved');
              }
            }
            $setSelection(null);
          });
          await converged(t);
          const values = t.a.read(() =>
            $getRoot()
              .getAllTextNodes()
              .flatMap(n =>
                [...n.getTextContent()].map(() =>
                  $getState(n, note) === 'saved' ? 's' : '-',
                ),
              )
              .join(''),
          );
          expect(show(t.a)).not.toContain('hl:');
          expect(values).toBe(
            'ssssss' + '-'.repeat('before let x = 1;'.length - 6),
          );
          expect(merges.count > 0).toBe(merging);
        });
      }
    }

    test(`without a hold, a code block joined into a paragraph keeps the paragraph's words (${variant})`, async () => {
      const t = await setupJoin('paragraph', gc, ids);
      joinCode(t.b);
      expect(await converged(t)).toBe(
        'paragraph[aa |bb/f8| cc/c5| dd/c6|let x = 1;]',
      );
    });

    test(`a code line composed in, which a held change does not restyle, is tokenized again and written when the composition ends (${variant})`, async () => {
      const t = await setupJoin('paragraph', gc, ids);
      const composed = startComposing(t.a);
      await t.sync();
      t.b.update(() => {
        const code = $getRoot().getLastChildOrThrow();
        if ($isElementNode(code)) {
          code.selectEnd();
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText(' y');
          }
        }
        $setSelection(null);
      });
      await t.sync();
      endComposing(t.a, composed);
      expect(await converged(t)).toBe(
        'paragraph[aa |bb/f8| cc/c5| dd/c6] code[hl:let|hl: x |hl:=|hl: |hl:1|hl:;|hl: y]',
      );
    });
  }
}
