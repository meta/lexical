/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Contract cells (test process v2) for text made again with other text: for
// every inline shape a line can hold (each TextNode subclass and mode,
// formats, tabs, line breaks, links, autolinks, comments, an inline
// decorator) and for a highlighted code line, an update that makes the
// line's nodes again from their JSON with one word changed, while a
// collaborator types into or deletes from an unchanged word (concurrently,
// or before the writer's editor read it, in both client id orders): every
// client and a fresh reader show the rewrite with the collaborator's edit
// where it was made, and nothing warns. The shapes mirror the inline shapes
// of the test catalog (`__tests__/catalog/nodes.ts`, #9588), to be folded
// into it.

import {$createCodeNode, $isCodeNode} from '@lexical/code-core';
import {CodePrismExtension} from '@lexical/code-prism';
import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$createHashtagNode, HashtagNode} from '@lexical/hashtag';
import {$createAutoLinkNode, $createLinkNode} from '@lexical/link';
import {$createMarkNode} from '@lexical/mark';
import * as Y from '@y/y';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $parseSerializedNode,
  $setSelection,
  configExtension,
  defineExtension,
  type ElementNode,
  type LexicalNode,
  type SerializedLexicalNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../../..';
import {CATALOG_NODES, NODE_SHAPES} from '../../catalog/nodes';
import {
  $createEquation,
  expectConverged,
  flush,
  freshReader,
  NODES,
  type Peer,
  setup,
} from '../../utils/harness';

const $t = (text: string) => $createTextNode(text);

/** The inline shapes, by catalog name. */
const SHAPES: [string, () => LexicalNode[]][] = [
  ['text/normal', () => [$t('plain')]],
  [
    'text/formatted',
    () => [
      $t('bold').setFormat('bold'),
      $t(' styled').setStyle('color: red'),
      $t(' code').setFormat('code'),
    ],
  ],
  ['text/token', () => [$t('token').setMode('token')]],
  ['text/segmented', () => [$t('two segments').setMode('segmented')]],
  ['tab/alone', () => [$createTabNode()]],
  ['tab/between-text', () => [$t('a'), $createTabNode(), $t('b')]],
  [
    'linebreak/between-text',
    () => [$t('line one'), $createLineBreakNode(), $t('line two')],
  ],
  ['hashtag/text', () => [$createHashtagNode('#tag')]],
  [
    'link/text',
    () => [$createLinkNode('https://example.com').append($t('a link'))],
  ],
  [
    'autolink/text',
    () => [
      $createAutoLinkNode('https://example.org').append(
        $t('https://example.org'),
      ),
    ],
  ],
  ['mark/text', () => [$createMarkNode(['comment-1']).append($t('commented'))]],
  [
    'mark/overlapping',
    () => [
      $createMarkNode(['comment-1', 'comment-2']).append($t('two comments')),
      $createMarkNode(['comment-2']).append($t(' one')),
    ],
  ],
  [
    'link/in-mark',
    () => [
      $createMarkNode(['comment-3']).append(
        $createLinkNode('https://example.net').append($t('linked comment')),
      ),
    ],
  ],
  ['equation/inline', () => [$createEquation('x^2')]],
];

const $line = () => $getRoot().getChildAtIndex(1) as ElementNode;
const lineText = (p: Peer) => p.read(() => $line().getTextContent());

/** A node's JSON with its children, as an agent reads a block. */
function $deepJSON(node: LexicalNode): SerializedLexicalNode {
  const json = node.exportJSON() as SerializedLexicalNode & {
    children?: SerializedLexicalNode[];
  };
  if ($isElementNode(node)) {
    json.children = node.getChildren().map($deepJSON);
  }
  return json;
}

/** Makes the line's nodes again from their JSON, `from` replaced by `to`. */
function $rewrite(from: string, to: string) {
  const line = $line();
  const json = line.getChildren().map($deepJSON);
  const last = json[json.length - 1] as SerializedLexicalNode & {
    text?: string;
  };
  last.text = last.text!.replace(from, to);
  for (const child of line.getChildren()) {
    child.remove();
  }
  line.append(...json.map(j => $parseSerializedNode(j)));
  $setSelection(null);
}

/**
 * The peer's edit of an unchanged word: `t2z`, in a node the rewrite makes
 * again with the same text, or `t3z`, in the node whose text it changes.
 */
const EDITS: [string, (leaf: TextNode, at: number) => void, string][] = [
  [
    'types "Q" in',
    (leaf, at) => void leaf.spliceText(at + 2, 0, 'Q', false),
    'Q',
  ],
  [
    'deletes the digit of',
    (leaf, at) => void leaf.spliceText(at + 1, 1, '', false),
    '',
  ],
];
const edited = (word: string, kind: string) =>
  kind === 'Q' ? word.slice(0, 2) + 'Q' + word.slice(2) : 'tz';

const $edit =
  (word: string, fn: (leaf: TextNode, at: number) => void) => () => {
    for (const leaf of $line().getAllTextNodes()) {
      const at = leaf.getTextContent().indexOf(word);
      if (at >= 0) {
        fn(leaf, at);
        break;
      }
    }
    $setSelection(null);
  };

describe('C9: a line made again from its JSON with one word changed keeps a collaborator edit of an unchanged word', () => {
  for (const [name, $shape] of SHAPES) {
    for (const [editName, edit, kind] of EDITS) {
      for (const word of ['t2z', 't3z']) {
        for (const timing of ['concurrent', 'unread'] as const) {
          for (const ids of [
            [1, 2],
            [2, 1],
          ]) {
            test(`${name}: the peer ${editName} "${word}", ${timing} (ids ${ids})`, async () => {
              const t = await setup(
                () => {
                  $getRoot().append(
                    $createParagraphNode().append($t('Title')),
                    $createParagraphNode().append(
                      $t('t1z t2z '),
                      ...$shape(),
                      $t(' t3z t4z'),
                    ),
                  );
                },
                {ids, nodes: [...NODES, HashtagNode]},
              );
              const before = lineText(t.a);
              t.offline();
              if (timing === 'unread') {
                t.b.update($edit(word, edit));
                t.a.editor.update(() => $rewrite('t4z', 't9z'));
                await t.sync();
                await flush();
                await t.sync();
              } else {
                t.a.update(() => $rewrite('t4z', 't9z'));
                t.b.update($edit(word, edit));
                await t.sync();
              }
              const expected = before
                .replace(word, edited(word, kind))
                .replace('t4z', 't9z');
              const fresh = await freshReader(t.a, [...NODES, HashtagNode]);
              expect([...t.peers, fresh].map(lineText)).toEqual(
                [...t.peers, fresh].map(() => expected),
              );
              await expectConverged(t.peers);
              expect(t.peers.flatMap(p => p.warnings)).toEqual([]);
            });
          }
        }
      }
    }
  }
});

// A highlighted code line an agent makes again as one text node with one
// token changed: the highlighter makes its tokens again from that text, and
// a collaborator's concurrent edit of another token stays in that token.
describe('C9: a highlighted code line made again with one token changed', () => {
  function codePeer(id: number) {
    const doc = createYDoc();
    doc.clientID = id;
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        dependencies: [
          CodePrismExtension,
          configExtension(YCollabExtension, {doc, schemaVersion: 1}),
        ],
        name: `c9-code/${id}`,
        onError: (e: Error) => {
          throw e;
        },
      }),
    );
    const {binding} = getExtensionDependencyFromEditor(
      editor,
      YCollabExtension,
    ).output;
    return {binding, doc, editor};
  }
  type CodePeer = ReturnType<typeof codePeer>;
  const exchange = (a: CodePeer, b: CodePeer) => {
    Y.applyUpdate(
      b.doc,
      Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)),
    );
    Y.applyUpdate(
      a.doc,
      Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)),
    );
    a.editor.read(() => 0);
    b.editor.read(() => 0);
  };
  const codeText = (p: CodePeer) =>
    p.editor.getEditorState().read(() => {
      const code = $getRoot().getChildren().find($isCodeNode);
      return code ? code.getTextContent() : '';
    });
  const LINE = 'const a = fetch(t45z); // t46z note';
  for (const [editName, edit, kind] of EDITS) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      test(`the peer ${editName} "t2z" while "t46z" is made again as "t47z" (ids ${ids})`, () => {
        const a = codePeer(ids[0]);
        const b = codePeer(ids[1]);
        a.editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createCodeNode('javascript').append(
                  $t(LINE.replace('t45z', 't2z')),
                ),
              );
          },
          {discrete: true},
        );
        a.binding.initialize();
        exchange(a, b);
        b.binding.initialize();
        const before = codeText(a);
        expect(codeText(b)).toBe(before);
        a.editor.update(
          () => {
            const code = $getRoot().getFirstChildOrThrow() as ElementNode;
            const text = code.getTextContent().replace('t46z', 't47z');
            for (const child of code.getChildren()) {
              child.remove();
            }
            code.append($t(text));
            $setSelection(null);
          },
          {discrete: true},
        );
        b.editor.update(
          () => {
            const code = $getRoot().getFirstChildOrThrow() as ElementNode;
            for (const leaf of code.getAllTextNodes()) {
              const at = leaf.getTextContent().indexOf('t2z');
              if (at >= 0 && $isTextNode(leaf)) {
                edit(leaf, at);
                break;
              }
            }
            $setSelection(null);
          },
          {discrete: true},
        );
        exchange(a, b);
        exchange(a, b);
        const expected = before
          .replace('t2z', edited('t2z', kind))
          .replace('t46z', 't47z');
        expect([codeText(a), codeText(b)]).toEqual([expected, expected]);
      });
    }
  }
});

/** Every text in a JSON tree, with `changes` made in it. */
function changed(
  json: SerializedLexicalNode,
  changes: readonly [string, string][],
): SerializedLexicalNode {
  const node = {...json} as SerializedLexicalNode & {
    children?: SerializedLexicalNode[];
    text?: string;
  };
  if (typeof node.text === 'string') {
    for (const [from, to] of changes) {
      node.text = node.text.replace(from, to);
    }
  }
  if (node.children) {
    node.children = node.children.map(c => changed(c, changes));
  }
  return node;
}

/** Makes the line's nodes again from their JSON, with `changes`. */
function $rewriteAll(changes: readonly [string, string][]) {
  const line = $line();
  const json = line.getChildren().map(c => changed($deepJSON(c), changes));
  for (const child of line.getChildren()) {
    child.remove();
  }
  line.append(...json.map(j => $parseSerializedNode(j)));
  $setSelection(null);
}

// #9621: with a word changed on each side (in the first and the last text
// node), the words between the changes keep their characters too: the
// peer's edit of `t2z` or `t3z` stays where it was made, and a delete it
// undoes leaves the word once.
describe('C9: a line made again from its JSON with a word changed on each side keeps a collaborator edit between them', () => {
  const CHANGES: [string, string][] = [
    ['t1z', 't8z'],
    ['t4z', 't9z'],
  ];
  for (const [name, $shape] of SHAPES) {
    for (const [editName, edit, kind] of [
      ...EDITS,
      [
        'deletes and undoes the digit of',
        (leaf: TextNode, at: number) =>
          void leaf.spliceText(at + 1, 1, '', false),
        'undo',
      ] as const,
    ]) {
      for (const word of ['t2z', 't3z']) {
        for (const timing of ['concurrent', 'unread'] as const) {
          for (const ids of [
            [1, 2],
            [2, 1],
          ]) {
            test(`${name}: the peer ${editName} "${word}", ${timing} (ids ${ids})`, async () => {
              const t = await setup(
                () => {
                  $getRoot().append(
                    $createParagraphNode().append($t('Title')),
                    $createParagraphNode().append(
                      $t('t1z t2z '),
                      ...$shape(),
                      $t(' t3z t4z'),
                    ),
                  );
                },
                {ids, nodes: [...NODES, HashtagNode]},
              );
              const before = lineText(t.a);
              t.offline();
              if (timing === 'unread') {
                t.b.update($edit(word, edit));
                t.a.editor.update(() => $rewriteAll(CHANGES));
                await t.sync();
                await flush();
                await t.sync();
              } else {
                t.a.update(() => $rewriteAll(CHANGES));
                t.b.update($edit(word, edit));
                await t.sync();
              }
              if (kind === 'undo') {
                t.b.undo();
                await t.sync();
              }
              let expected =
                kind === 'undo'
                  ? before
                  : before.replace(word, edited(word, kind));
              for (const [from, to] of CHANGES) {
                expected = expected.replace(from, to);
              }
              const fresh = await freshReader(t.a, [...NODES, HashtagNode]);
              expect([...t.peers, fresh].map(lineText)).toEqual(
                [...t.peers, fresh].map(() => expected),
              );
              await expectConverged(t.peers);
              expect(t.peers.flatMap(p => p.warnings)).toEqual([]);
            });
          }
        }
      }
    }
  }
});

// Every inline shape of the catalog (`catalog/nodes.ts`), its nodes made
// again from their JSON with the words around it changed: the shape comes
// back as it was, the same on every client. Reading the old line's layout
// asked a removed node whether it is inline in the new state, which a class
// that reads its latest version there (the playground's EquationNode)
// refused with a throw.
describe('C9: a line made again from its JSON around each catalog inline shape keeps the shape', () => {
  const $json = (n: LexicalNode): SerializedLexicalNode => $deepJSON(n);
  const CHANGES: [string, string][] = [
    ['t1z', 't8z'],
    ['t4z', 't9z'],
  ];
  for (const shape of NODE_SHAPES.filter(s => s.$inline !== undefined)) {
    test(shape.name, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append($t('Title')),
            $createParagraphNode().append(
              $t('t1z t2z '),
              ...shape.$inline!(),
              $t(' t3z t4z'),
            ),
          );
        },
        {nodes: [...CATALOG_NODES]},
      );
      const json = (p: Peer) => p.read(() => $line().getChildren().map($json));
      const expected = json(t.a).map(j => changed(j, CHANGES));
      t.a.update(() => $rewriteAll(CHANGES));
      await t.sync();
      expect(json(t.a)).toEqual(expected);
      expect(json(t.b)).toEqual(expected);
      await expectConverged(t.peers);
      expect(t.peers.flatMap(p => p.warnings)).toEqual([]);
    });
  }
});
