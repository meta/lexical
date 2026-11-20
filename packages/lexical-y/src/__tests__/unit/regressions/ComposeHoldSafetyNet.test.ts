/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// The safety net under the binding's foresight of the editor's next update
// (YBinding#noteComposed): with the foresight turned off (its check in the
// read and after it, YBinding#predicts), every move of the
// composition at a boundary the hold shows is a missed one. Over a matrix of
// lines (links and inline elements around and beside the composed text, a
// paragraph whose canBeEmpty reads NodeState), carets (each offset of the
// composed text, collapsed or with the focus on the paragraph's end) and
// remote changes (links replaced, removed, extended into the next line,
// formats, a character deleted on either side of the caret, the NodeState
// flipped), after the composer's next update:
//
// - no peer warns a self-check;
// - where that update moved the composition off its node, the hold has
//   ended and the editor shows what is stored (a fresh read of its
//   document, text node boundaries aside: the node composed in is not
//   merged with its neighbours until the composition ends);
// - once the composition ends and every peer is synced, every peer reads
//   the same, and the composer equals a fresh read.
//
// The matrix has to move the composition under a hold at least once, or it
// tests nothing.
//
// The same matrix with the foresight on and an app's plugins on the
// composer (see utils/appPlugins: a selection change handler, an update
// listener and a node transform, each editing the last line in reply): no
// composition moves under a hold, and every edit the plugins commit reaches
// every peer. (Not the mutation listener: an edit it makes in an editor with
// a DOM root is stored more often than the editor shows it, on main too.)
//
// And a move the binding cannot foresee, with the foresight on: an app's
// TextNode whose selectionTransform moves the caret in it to the text before
// it once a remote change shuts its line (NodeState), while a held format
// covers it. A's next update moves the composition under the hold; the hold
// ends, and the editor shows what is stored.

import {$toggleLink} from '@lexical/link';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getDocument,
  $getEditor,
  $getNodeByKey,
  $getRoot,
  $getState,
  $isTextNode,
  $setCompositionKey,
  $setSelection,
  $setState,
  type BaseSelection,
  createState,
  ElementNode,
  type LexicalNode,
  ParagraphNode,
  type RangeSelection,
  TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {registerAppPlugins} from '../../utils/appPlugins';
import {
  $selectIn,
  freshReader,
  NODES,
  type Peer,
  setup,
} from '../../utils/harness';

const shut = createState('safety_shut', {parse: v => v === true});

/** A paragraph whose canBeEmpty reads NodeState. */
class SwitchParagraph extends ParagraphNode {
  $config() {
    return this.config('safety_switch_paragraph', {
      extends: ParagraphNode,
      stateConfigs: [{stateConfig: shut}],
    });
  }
  canBeEmpty(): boolean {
    return !$getState(this, shut);
  }
}

class Box extends ElementNode {
  $config() {
    return this.config('safety_box', {
      children: 'inline',
      extends: ElementNode,
    });
  }
  isInline(): true {
    return true;
  }
  createDOM() {
    return $getDocument().createElement('span');
  }
  updateDOM(): false {
    return false;
  }
}

/**
 * The second line: its content, where the composed text (which starts with
 * "abc") starts in the line's text, and the range linked before it starts.
 */
type Line = {
  $build: () => LexicalNode[];
  at: number;
  link?: [number, number];
};

const LINES: Record<string, Line> = {
  'abc after a bold word': {
    $build: () => [
      $createTextNode('x ').toggleFormat('bold'),
      $createTextNode('abc'),
    ],
    at: 2,
  },
  'abc in a box after a link': {
    $build: () => [
      $createTextNode('x '),
      $create(Box).append($createTextNode('abc')),
    ],
    at: 2,
    link: [0, 2],
  },
  'abc in a box before a link': {
    $build: () => [
      $create(Box).append($createTextNode('abc')),
      $createTextNode(' '),
    ],
    at: 0,
    link: [3, 4],
  },
  'abc in a link': {
    $build: () => [$createTextNode('x abc y')],
    at: 2,
    link: [2, 5],
  },
  'abc in a link at the line end': {
    $build: () => [$createTextNode('x abc')],
    at: 2,
    link: [2, 5],
  },
  'abc in a link at the line start': {
    $build: () => [$createTextNode('abc y')],
    at: 0,
    link: [0, 3],
  },
  'abc in nested boxes between text': {
    $build: () => [
      $createTextNode('x '),
      $create(Box).append($create(Box).append($createTextNode('abc'))),
      $createTextNode(' y'),
    ],
    at: 2,
    link: [5, 7],
  },
  'abc then a word': {$build: () => [$createTextNode('abc def')], at: 0},
};

type Change = {
  name: string;
  run: (b: Peer, c: Peer, caret: number) => void;
};

/** Select `start`..`end` (text offsets, clamped to the line) in `line`. */
const $sel = (line: number, start: number, end: number) => {
  const size = $getRoot().getChildAtIndex(line)!.getTextContentSize();
  return $selectIn(
    [line],
    Math.min(start, size),
    Math.min(Math.max(end, start), size),
  );
};

const CHANGES: Change[] = [
  {
    name: 'link over the line, then a character after the caret deleted',
    run: (b, c, caret) => {
      b.update(() => {
        $sel(1, 0, 4);
        $toggleLink('https://s.test/1');
        $setSelection(null);
      });
      c.update(() => {
        $sel(1, caret, caret + 1).removeText();
        $setSelection(null);
      });
    },
  },
  {
    name: 'link reaching into the next line, then a character after the caret deleted',
    run: (b, c, caret) => {
      b.update(() => {
        const selection = $sel(1, 0, 0);
        const next = $getRoot().getChildAtIndex(2) as ElementNode;
        selection.focus.set(next.getFirstDescendant()!.getKey(), 1, 'text');
        $toggleLink('https://s.test/2');
        $setSelection(null);
      });
      c.update(() => {
        $sel(1, caret, caret + 1).removeText();
        $setSelection(null);
      });
    },
  },
  {
    name: 'bold over the composed text, then a character before the caret deleted',
    run: (b, c, caret) => {
      b.update(() => {
        $sel(1, 0, 3).formatText('bold');
        $setSelection(null);
      });
      c.update(() => {
        if (caret > 0) {
          $sel(1, caret - 1, caret).removeText();
        }
        $setSelection(null);
      });
    },
  },
  {
    name: 'link removed, then the NodeState flipped',
    run: (b, c) => {
      b.update(() => {
        $sel(1, 0, 6);
        $toggleLink(null);
        $setSelection(null);
      });
      c.update(() => {
        $setState($getRoot().getChildAtIndex(1)!, shut, true);
        $setSelection(null);
      });
    },
  },
  {
    name: 'link at the caret, then the character before it deleted',
    run: (b, c, caret) => {
      b.update(() => {
        $sel(1, caret, caret + 2);
        $toggleLink('https://s.test/3');
        $setSelection(null);
      });
      c.update(() => {
        if (caret > 0) {
          $sel(1, caret - 1, caret).removeText();
        }
        $setSelection(null);
      });
    },
  },
];

/**
 * What `p` shows, text node boundaries aside (the node being composed is
 * not merged with its neighbours until the composition ends): per line,
 * each character with its format, style and the elements around it.
 */
function shown(p: Peer): string {
  return p.read(() =>
    $getRoot()
      .getChildren()
      .map(line =>
        (line as ElementNode)
          .getAllTextNodes()
          .map(n => {
            const ups: string[] = [];
            for (
              let up = n.getParent();
              up !== null && up !== line;
              up = up.getParent()
            ) {
              ups.push(up.getType());
            }
            const tag = `${n.getFormat()}/${n.getStyle()}/${ups.join('<')}`;
            return [...n.getTextContent()].map(ch => `${ch}{${tag}}`).join('');
          })
          .join(''),
      )
      .join(' | '),
  );
}

/**
 * Run the matrix: with the binding's foresight on or off (`predicts`), and
 * with the app's plugins (see utils/appPlugins) on the composer or not.
 */
async function runMatrix(opts: {predicts: boolean; plugins: boolean}) {
  let cases = 0;
  let moved = 0;
  let made = 0;
  const failures: string[] = [];
  for (const [lineName, line] of Object.entries(LINES)) {
    for (const change of CHANGES) {
      for (const caret of [0, 1, 2, 3]) {
        for (const focusOnEnd of [false, true]) {
          for (const gc of [false, true]) {
            const where = `${lineName} / ${change.name} / caret ${caret}${focusOnEnd ? ' / focus on the line end' : ''} / gc ${gc}`;
            const t = await setup(
              () =>
                $getRoot().append(
                  $createParagraphNode().append($createTextNode('zero')),
                  $create(SwitchParagraph).append(...line.$build()),
                  $createParagraphNode().append($createTextNode('two')),
                ),
              {gc, ids: [1, 2, 3], nodes: [...NODES, Box, SwitchParagraph]},
            );
            const {a, b, c} = t;
            (a.binding as unknown as {predicts: boolean}).predicts =
              opts.predicts;
            const plugins = opts.plugins
              ? registerAppPlugins(a.editor, 4, [
                  'selection',
                  'update',
                  'transform',
                ])
              : null;
            const host = document.createElement('div');
            host.contentEditable = 'true';
            document.body.append(host);
            a.editor.setRootElement(host);
            try {
              // The link the changes replace or remove.
              const linked = line.link;
              if (linked !== undefined) {
                b.update(() => {
                  $sel(1, linked[0], linked[1]);
                  $toggleLink('https://s.test/0');
                  $setSelection(null);
                });
                await t.sync();
              }
              let key = '';
              a.update(() => {
                const text = $getRoot()
                  .getAllTextNodes()
                  .find(n => n.getTextContent().startsWith('abc'))!;
                key = text.getKey();
                const selection = $createRangeSelection();
                selection.anchor.set(key, caret, 'text');
                if (focusOnEnd) {
                  const second = $getRoot().getChildAtIndex(1) as ElementNode;
                  selection.focus.set(
                    second.getKey(),
                    second.getChildrenSize(),
                    'element',
                  );
                } else {
                  selection.focus.set(key, caret, 'text');
                }
                $setSelection(selection);
                $setCompositionKey(key);
              });
              a.update(() => {});
              if (a.editor._compositionKey !== key) {
                continue;
              }
              cases++;
              change.run(b, c, caret + line.at);
              await t.sync();
              // The composition as the remote reads left it (a read without a
              // hold moves it as main does).
              const read = a.editor._compositionKey;
              const binding = a.binding as unknown as {
                state: {hidden: unknown};
              };
              const held = binding.state.hidden !== null;
              // The composer's next update.
              a.update(() => {});
              await Promise.resolve();
              const now = a.editor._compositionKey;
              // (An app's edits made in listeners of the composer's updates
              // can warn a passing self-check, on main too: not asserted
              // with the plugins; convergence below is.)
              for (const p of opts.plugins ? [] : t.peers) {
                const checks = p.warnings.filter(w => w.includes('self-check'));
                if (checks.length > 0) {
                  failures.push(`${where}: ${checks[0]}`);
                }
              }
              if (now !== read) {
                if (held) {
                  moved++;
                }
                if (binding.state.hidden !== null) {
                  failures.push(
                    `${where}: the composition moved and the hold stayed`,
                  );
                } else {
                  const stored = await freshReader(a);
                  if (shown(stored) !== shown(a)) {
                    failures.push(
                      `${where}: shows ${a.describe()}, stored ${stored.describe()}`,
                    );
                  }
                }
              }
              a.update(() => $setCompositionKey(null));
              await t.sync();
              // Edits the plugins made in reply to the last updates (each
              // reply can bring another), until none comes.
              for (let round = 0; round < 20; round++) {
                const was = a.describe();
                await new Promise(resolve => setTimeout(resolve, 0));
                await t.sync();
                if (a.describe() === was) {
                  break;
                }
              }
              const fresh = (await freshReader(a)).describe();
              if (
                fresh !== a.describe() ||
                b.describe() !== a.describe() ||
                c.describe() !== a.describe()
              ) {
                failures.push(
                  `${where}: did not converge: A ${a.describe()}, stored ${fresh}, B ${b.describe()}`,
                );
              }
              if (plugins !== null) {
                made += Object.values(plugins.made).reduce((x, y) => x + y, 0);
              }
            } finally {
              plugins?.dispose();
              a.editor.setRootElement(null);
              host.remove();
              t.peers.forEach(p => p.stop());
            }
          }
        }
      }
    }
  }
  return {cases, failures, made, moved};
}

test('a move of the composition the binding did not foresee ends the hold, and the editor shows what is stored', async () => {
  const {cases, failures, moved} = await runMatrix({
    plugins: false,
    predicts: false,
  });
  expect(failures.join('\n')).toBe('');
  expect(cases).toBeGreaterThan(100);
  expect(moved).toBeGreaterThan(0);
}, 600_000);

test("an app's plugins that edit in reply to the editor's own updates have every edit stored, holds and foresight active", async () => {
  const {cases, failures, made, moved} = await runMatrix({
    plugins: true,
    predicts: true,
  });
  expect(failures.join('\n')).toBe('');
  expect(cases).toBeGreaterThan(100);
  expect(made).toBeGreaterThan(cases);
  expect(moved).toBe(0);
}, 600_000);

/**
 * An app's TextNode whose selectionTransform moves a caret in it to the end
 * of the text before it, once its line is shut (SwitchParagraph's NodeState)
 * in the state committed before too: a move of the composition Lexical's
 * own normalization does not make, which the binding cannot foresee (it
 * runs no app code that writes).
 */
class Leaning extends TextNode {
  $config() {
    return this.config('safety_leaning', {extends: TextNode});
  }
  selectionTransform(_prev: BaseSelection | null, next: RangeSelection): void {
    const previous = this.getPreviousSibling();
    const line = this.getTopLevelElement();
    const key = line === null ? null : line.getKey();
    const shutBefore =
      key !== null &&
      $getEditor()
        .getEditorState()
        .read(() => {
          const was = $getNodeByKey(key);
          return was !== null && $getState(was, shut);
        });
    if (
      line !== null &&
      $getState(line, shut) &&
      shutBefore &&
      next.isCollapsed() &&
      next.anchor.key === this.getKey() &&
      $isTextNode(previous)
    ) {
      const size = previous.getTextContentSize();
      next.anchor.set(previous.getKey(), size, 'text');
      next.focus.set(previous.getKey(), size, 'text');
    }
  }
}

test("an app's selection transform that moves the composition under a hold ends the hold, and the editor shows what is stored", async () => {
  let cases = 0;
  let moved = 0;
  const failures: string[] = [];
  const HELD: [string, (b: Peer) => void][] = [
    [
      'bold',
      b =>
        b.update(() => {
          $sel(1, 2, 5).formatText('bold');
          $setSelection(null);
        }),
    ],
    [
      'link',
      b =>
        b.update(() => {
          $sel(1, 2, 5);
          $toggleLink('https://s.test/4');
          $setSelection(null);
        }),
    ],
  ];
  for (const [heldName, held] of HELD) {
    for (const caret of [1, 2, 3]) {
      for (const gc of [false, true]) {
        const where = `${heldName} / caret ${caret} / gc ${gc}`;
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode('zero')),
              $create(SwitchParagraph).append(
                $create(Box).append(
                  $createTextNode('x '),
                  $create(Leaning).setTextContent('abc'),
                ),
              ),
              $createParagraphNode().append($createTextNode('two')),
            ),
          {
            gc,
            ids: [1, 2, 3],
            nodes: [...NODES, Box, SwitchParagraph, Leaning],
          },
        );
        const {a, b, c} = t;
        const host = document.createElement('div');
        host.contentEditable = 'true';
        document.body.append(host);
        a.editor.setRootElement(host);
        host.focus();
        try {
          let key = '';
          a.update(() => {
            const text = $getRoot()
              .getAllTextNodes()
              .find(n => n.getTextContent() === 'abc')!;
            key = text.getKey();
            text.select(caret, caret);
            $setCompositionKey(key);
          });
          a.update(() => {});
          if (a.editor._compositionKey !== key) {
            continue;
          }
          cases++;
          held(b);
          await t.sync();
          // The line shut: A's next update moves the caret.
          c.update(() => {
            $setState($getRoot().getChildAtIndex(1)!, shut, true);
            $setSelection(null);
          });
          await t.sync();
          const binding = a.binding as unknown as {state: {hidden: unknown}};
          const read = a.editor._compositionKey;
          const wasHeld = binding.state.hidden !== null;
          a.update(() => {});
          await Promise.resolve();
          if (a.editor._compositionKey !== read && wasHeld) {
            moved++;
            if (binding.state.hidden !== null) {
              failures.push(
                `${where}: the composition moved and the hold stayed`,
              );
            } else {
              const stored = await freshReader(a);
              if (shown(stored) !== shown(a)) {
                failures.push(
                  `${where}: shows ${a.describe()}, stored ${stored.describe()}`,
                );
              }
            }
          }
          for (const p of t.peers) {
            const checks = p.warnings.filter(w => w.includes('self-check'));
            if (checks.length > 0) {
              failures.push(`${where}: ${checks[0]}`);
            }
          }
          a.update(() => $setCompositionKey(null));
          await t.sync();
          const fresh = (await freshReader(a)).describe();
          if (fresh !== a.describe() || b.describe() !== a.describe()) {
            failures.push(`${where}: did not converge`);
          }
        } finally {
          a.editor.setRootElement(null);
          host.remove();
          t.peers.forEach(p => p.stop());
        }
      }
    }
  }
  expect(failures.join('\n')).toBe('');
  expect(cases).toBeGreaterThan(6);
  expect(moved).toBeGreaterThan(0);
}, 600_000);
