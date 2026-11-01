/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A paste over part of a line whose nodes a transform makes again with the
// pasted text (a code line's highlighter, a hashtag), while a collaborator
// types next to the pasted range. The characters around the range are not
// pasted over: they are written as they were, so what the collaborator typed
// stays where it was typed. Before the fix, where the old text before the
// range ended with the character the pasted text ends with (`t55z` before,
// `t87z` at the end), the write took that character as one of two equal
// runs and wrote it again, and the collaborator's text landed inside the
// word: `t55 t83zzt84z`.

import {$insertGeneratedNodes} from '@lexical/clipboard';
import {$createCodeNode} from '@lexical/code-core';
import {CodePrismExtension} from '@lexical/code-prism';
import {buildEditorFromExtensions} from '@lexical/extension';
import {HashtagExtension} from '@lexical/hashtag';
import {$generateNodesFromDOM} from '@lexical/html';
import {LinkExtension} from '@lexical/link';
import {ListExtension} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getEditor,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  configExtension,
  defineExtension,
  type LexicalEditor,
  type TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import {createYDoc, YCollabExtension, type YDoc} from '../../..';
import {readYState, seedYState} from '../../../headless';

type Container = 'code' | 'hashtag' | 'plain';

const deps = (container: Container) => [
  RichTextExtension,
  LinkExtension,
  ListExtension,
  ...(container === 'code' ? [CodePrismExtension] : []),
  ...(container === 'hashtag' ? [HashtagExtension] : []),
];
const config = (container: Container) => ({
  extensions: deps(container),
  schemaVersion: 1,
});

const idle = () => new Promise(resolve => setTimeout(resolve, 0));

type Peer = {
  doc: YDoc;
  editor: LexicalEditor & {dispose: () => void};
  out: Uint8Array[];
};

function peer(container: Container, seed: Uint8Array, id: number): Peer {
  const doc = createYDoc(seed);
  doc.clientID = id;
  const out: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') {
      out.push(u);
    }
  });
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        ...deps(container),
        configExtension(YCollabExtension, {doc, schemaVersion: 1}),
      ],
      name: `paste-remade-${id}`,
      onError: (e: Error) => {
        throw e;
      },
    }),
  );
  return {doc, editor, out};
}

function $find(token: string): [TextNode, number] {
  for (const t of $getRoot().getAllTextNodes()) {
    const i = t.getTextContent().indexOf(token);
    if (i >= 0) {
      return [t, i];
    }
  }
  throw new Error(`no ${token}`);
}

// Which character of the pasted text coincides with the text around the
// range: its last with the last character before the range (`z`, the range
// at the end of the line), its first with the first character after the
// range (`t`), or none.
const COINCIDES = {
  first: {after: 't80z', end: 't87q'},
  last: {after: '', end: 't87z'},
  none: {after: '', end: 't87q'},
};

const PASTES = {
  'one line': (end: string) =>
    `<p><b>t84z</b> <a href="https://p.test/1">t85z</a> <i>${end}</i></p>`,
  'one word, then a list': (end: string) =>
    `<p><b>t84z</b></p><ul><li>${end}</li></ul>`,
  'with line breaks': (end: string) =>
    `<p><b>t84z</b> <a href="https://p.test/1">t85z</a> <i>t86z</i></p><ul><li>${end}</li></ul>`,
};

// Where the collaborator types " t83z": right after the word before the
// range, inside the range, right after it.
const TYPING = {
  after: (line: string) => line.indexOf('t57z') + 4,
  before: (line: string) => line.indexOf('t78z'),
  inside: (line: string) => line.indexOf('t57z'),
};

/** The ids of the document's characters, in document order, with its text. */
function chars(doc: YDoc): {ids: string[]; text: string} {
  const ids: string[] = [];
  let text = '';
  type Item = {
    content: unknown;
    countable: boolean;
    deleted: boolean;
    id: {client: number; clock: number};
    right: Item | null;
  };
  const walk = (type: {_start: Item | null}) => {
    for (let it = type._start; it !== null; it = it.right) {
      if (it.deleted || !it.countable) {
        continue;
      }
      if (it.content instanceof Y.ContentString) {
        const str = (it.content as unknown as {str: string}).str;
        for (let k = 0; k < str.length; k++) {
          ids.push(`${it.id.client}:${it.id.clock + k}`);
        }
        text += str;
      } else if (it.content instanceof Y.ContentType) {
        walk((it.content as unknown as {type: {_start: Item | null}}).type);
      }
    }
  };
  walk(doc.get('lexical-y') as unknown as {_start: Item | null});
  return {ids, text};
}

/** The ids of the characters of `token` (once in the text). */
function idsOf(doc: YDoc, token: string): string[] {
  const {ids, text} = chars(doc);
  const i = text.indexOf(token);
  expect(i).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(token, i + 1)).toBe(-1);
  return ids.slice(i, i + token.length);
}

/**
 * A types " t83z" at `typeAt` of `line` while B pastes `html` over
 * "t78z t57z"; then each gets the other's update. Returns the text every
 * client reads, after checking that both editors show it.
 */
async function scenario(
  container: Container,
  line: string,
  html: string,
  typeAt: number,
  kept: string,
): Promise<string> {
  const seed = seedYState(config(container), () => {
    $getRoot().append(
      $createParagraphNode().append($createTextNode('t1z')),
      container === 'code'
        ? $createCodeNode('javascript').append($createTextNode(line))
        : $createParagraphNode().append($createTextNode(line)),
    );
  });
  const a = peer(container, seed, 101);
  const b = peer(container, seed, 202);
  onTestFinished(() => {
    a.editor.dispose();
    b.editor.dispose();
  });
  await idle();
  a.out.length = 0;
  b.out.length = 0;
  const before = idsOf(a.doc, kept);
  a.editor.update(
    () => {
      let acc = 0;
      for (const t of $getRoot().getAllTextNodes()) {
        const text = t.getTextContent();
        if (t.getParentOrThrow().getTextContent().includes('t54z')) {
          if (typeAt <= acc + text.length) {
            t.select(typeAt - acc, typeAt - acc).insertText(' t83z');
            return;
          }
          acc += text.length;
        }
      }
    },
    {discrete: true},
  );
  b.editor.update(
    () => {
      const [from, i] = $find('t78z');
      const [to, j] = $find('t57z');
      const s = $createRangeSelection();
      s.anchor.set(from.getKey(), i, 'text');
      s.focus.set(to.getKey(), j + 4, 'text');
      $setSelection(s);
      const dom = new DOMParser().parseFromString(html, 'text/html');
      $insertGeneratedNodes(
        $getEditor(),
        $generateNodesFromDOM($getEditor(), dom),
        s,
      );
    },
    {discrete: true},
  );
  await idle();
  for (const u of a.out.splice(0)) {
    Y.applyUpdate(b.doc, u, 'remote');
  }
  for (const u of b.out.splice(0)) {
    Y.applyUpdate(a.doc, u, 'remote');
  }
  await idle();
  const text = (p: Peer) => p.editor.read(() => $getRoot().getTextContent());
  const stored = readYState(
    Y.encodeStateAsUpdate(a.doc),
    config(container),
    () => $getRoot().getTextContent(),
  );
  expect(text(a)).toBe(stored);
  expect(text(b)).toBe(stored);
  // The word before the range is not written again: its characters are the
  // same items.
  expect(idsOf(a.doc, kept)).toEqual(before);
  return stored;
}

describe('a paste over part of a line its transform makes again', () => {
  for (const container of ['code', 'hashtag', 'plain'] as const) {
    for (const [coincide, {after, end}] of Object.entries(COINCIDES)) {
      for (const [pasteName, paste] of Object.entries(PASTES)) {
        for (const [typing, at] of Object.entries(TYPING)) {
          test(`${container}, ${coincide} character coincides, ${pasteName}, typing ${typing} the range`, async () => {
            // In a code line, the range is in a comment: the highlighter makes
            // the comment again as one node, old text and pasted text.
            const head =
              container === 'code' ? 'const t44z = f(); // ' : 'see ';
            const word = container === 'hashtag' ? '#t55z' : 't55z';
            const line = `${head}t54z ${word}t78z t57z${after}`;
            const stored = await scenario(
              container,
              line,
              paste(end),
              at(line),
              `t54z ${word}`,
            );
            // The words around the range stay whole, and the typed text
            // stays where it was typed, in one piece.
            expect(stored).toContain(`t54z ${word}`);
            if (after !== '') {
              expect(stored).toContain(after);
            }
            expect(stored.split(' t83z').length - 1).toBe(1);
            // (Typed right after the range, it is at the place the pasted
            // text is inserted: the two inserts are ordered by client id.)
            if (typing === 'before') {
              expect(stored).toContain(`${word} t83z`);
            }
            for (const token of ['t84z', end]) {
              expect(stored.split(token).length - 1).toBe(1);
            }
          });
        }
      }
    }
  }

  test('code, a one-word first pasted line that ends like the word after the range', async () => {
    const line = 'const t44z = f(); // t54z t55zt78z t57zt80z';
    const stored = await scenario(
      'code',
      line,
      '<p><b>t84z</b></p><ul><li>t80z</li></ul>',
      TYPING.before(line),
      't54z t55z',
    );
    expect(stored).toContain('// t54z t55z t83zt84z');
  });

  test('code, a paste and typing after it in one update, while a collaborator deletes the character before the range', async () => {
    const line = 'const x = 1; // t55 zzz t 5tz5';
    const seed = seedYState(config('code'), () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('t1z')),
        $createCodeNode('javascript').append($createTextNode(line)),
      );
    });
    const a = peer('code', seed, 101);
    const b = peer('code', seed, 202);
    onTestFinished(() => {
      a.editor.dispose();
      b.editor.dispose();
    });
    await idle();
    a.out.length = 0;
    b.out.length = 0;
    // A deletes the last "z" of "zzz", right before the range.
    a.editor.update(
      () => {
        const [t, i] = $find('zzz');
        const s = $createRangeSelection();
        s.anchor.set(t.getKey(), i + 2, 'text');
        s.focus.set(t.getKey(), i + 3, 'text');
        $setSelection(s);
        s.removeText();
      },
      {discrete: true},
    );
    // In one update, B pastes over " t 5tz5" and types "x" after the paste.
    b.editor.update(
      () => {
        const [t, i] = $find('zzz');
        const s = $createRangeSelection();
        s.anchor.set(t.getKey(), i + 3, 'text');
        const [end, j] = $find('5tz5');
        s.focus.set(end.getKey(), j + 4, 'text');
        $setSelection(s);
        const dom = new DOMParser().parseFromString(
          '<p><b>z55z</b></p><ul><li>ttz</li></ul>',
          'text/html',
        );
        $insertGeneratedNodes(
          $getEditor(),
          $generateNodesFromDOM($getEditor(), dom),
          s,
        );
        const after = $getSelection();
        if ($isRangeSelection(after)) {
          after.insertText('x');
        }
      },
      {discrete: true},
    );
    await idle();
    for (const u of a.out.splice(0)) {
      Y.applyUpdate(b.doc, u, 'remote');
    }
    for (const u of b.out.splice(0)) {
      Y.applyUpdate(a.doc, u, 'remote');
    }
    await idle();
    const text = (p: Peer) => p.editor.read(() => $getRoot().getTextContent());
    const stored = readYState(
      Y.encodeStateAsUpdate(a.doc),
      config('code'),
      () => $getRoot().getTextContent(),
    );
    expect(text(a)).toBe(stored);
    expect(text(b)).toBe(stored);
    // A's delete stays: two of the three "z" are left before the paste.
    expect(stored).toContain('// t55 zzz55z');
  });

  // Open (#9587): the mirror case. Where the pasted text starts like the word
  // right after the range (`t84z` before `t80z`), that word's first character
  // is written again, and what a collaborator types right after it lands
  // before the whole paste instead.
  test.fails(
    'code, typing inside the word after the range, when the paste starts like it (open)',
    async () => {
      const line = 'const t44z = f(); // t54z t55zt78z t57zt80z';
      const stored = await scenario(
        'code',
        line,
        PASTES['with line breaks']('t87q'),
        line.indexOf('t80z') + 1,
        't54z t55z',
      );
      expect(stored).toContain('t t83z80z');
    },
  );
});
