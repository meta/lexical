/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import * as Y from '@y/y';
import {
  $create,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getState,
  $isRangeSelection,
  $isTextNode,
  $setState,
  COLLABORATION_TAG,
  createEditor,
  createState,
  type EditorState,
  ParagraphNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YBinding} from '../..';
import {
  $block,
  $p,
  $selectIn,
  BoxNode,
  describeNode,
  expectConverged,
  flush,
  freshReader,
  NODES,
  setup,
} from '../utils/harness';

// Local updates made without `discrete: true` commit, and are written, in a
// microtask. A remote change a provider applies in the same task, before
// that commit, is integrated into the document first; the local edit is
// then written as made, against the document it was made on, and the
// remote change is read after it.

const LINE = 't1z t2z t3z t4z t5z t6z t7z t8z t9z';
const $doc = () => $getRoot().append($p(LINE), $p('tail line'));

/** Selects `text` in the first paragraph (the first occurrence). */
function $selectWords(text: string) {
  const at = $block([0]).getTextContent().indexOf(text);
  if (at < 0) {
    throw new Error(`not found: ${text}`);
  }
  return $selectIn([0], at, at + text.length);
}

/** The text of the caret's line before the caret. */
function $textBeforeCaret(): string {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return '';
  }
  const anchor = selection.anchor;
  const node = anchor.getNode();
  const line = $isTextNode(node) ? node.getParentOrThrow() : node;
  let text = '';
  for (const child of line.getChildren()) {
    if (child.is(node)) {
      return text + child.getTextContent().slice(0, anchor.offset);
    }
    text += child.getTextContent();
  }
  return text;
}

/** A caret right after `text` in the first paragraph. */
function $selectAfter(text: string) {
  const at = $block([0]).getTextContent().indexOf(text);
  if (at < 0) {
    throw new Error(`not found: ${text}`);
  }
  return $selectIn([0], at + text.length);
}

const REMOTE: [string, () => void, string][] = [
  ['deletes "t1z "', () => void $selectWords('t1z ').removeText(), 't2z'],
  [
    'inserts "t0z "',
    () => void $selectIn([0], 0).insertText('t0z '),
    't0z t1z t2z',
  ],
  [
    'deletes "t8z" after it',
    () => void $selectWords(' t8z').removeText(),
    't7z t9z',
  ],
  ['bolds "t2z"', () => void $selectWords('t2z').formatText('bold'), 't2z'],
];

const LOCAL: [string, () => void][] = [
  ['deletes "t7z"', () => void $selectWords('t7z').removeText()],
  ['types "!" after "t7z"', () => void $selectAfter('t7z').insertText('!')],
  ['bolds "t7z"', () => void $selectWords('t7z').formatText('bold')],
  [
    'splits the line after "t5z"',
    () => void $selectAfter('t5z').insertParagraph(),
  ],
];

describe('a local update waiting for its commit when a remote change arrives in the same task', () => {
  for (const [remoteName, $remote] of REMOTE) {
    for (const [localName, $local] of LOCAL) {
      test(`A ${remoteName}; B ${localName}`, async () => {
        const t = await setup($doc);
        t.offline();
        t.a.update($remote);
        // B's update commits in a microtask.
        t.b.editor.update($local);
        // A's change reaches B in the same task, before B's commit.
        await t.sync();
        await flush();
        await t.sync();
        // Both edits, as each made them; nothing else changes.
        const expected = await setup($doc);
        expected.a.update($remote);
        expected.a.update($local);
        await expectConverged(t.peers, expected.a.describe());
        expect(t.b.warnings).toEqual([]);
        if (localName.startsWith('types')) {
          // B's caret stays after what B typed.
          expect(t.b.read($textBeforeCaret)).toMatch(/t7z!$/);
        }
      });
    }
  }
});

const SEEDS = Number(process.env.LEXICAL_Y_SEEDS || 25);

/** A seeded random number generator (mulberry32). */
function random(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return n => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), s | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return Math.floor((((x ^ (x >>> 14)) >>> 0) / 4294967296) * n);
  };
}

/** Runs `fn` on `text` in the first paragraph, if it is still there. */
function $onWords(text: string, fn: (at: number) => void) {
  const at = $block([0]).getTextContent().indexOf(text);
  if (at >= 0) {
    fn(at);
  }
}

describe('the invariant, over random batched edits', () => {
  test('editors show the document and every edit is written', async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = random(seed * 7919);
      const t = await setup($doc, {ids: [1, 2, 3]});
      const log: string[] = [];
      for (let step = 0; step < 12; step++) {
        const peer = t.peers[rnd(3)];
        const words = peer.read(() =>
          $block([0]).getTextContent().match(/t\d+z/g),
        );
        const word = words === null ? null : words[rnd(words.length)];
        const kind = rnd(6);
        log.push(`${peer.doc.clientID}:${kind}:${word}`);
        if (kind === 0 && word !== null) {
          peer.editor.update(() =>
            $onWords(
              word,
              at => void $selectIn([0], at, at + word.length).removeText(),
            ),
          );
        } else if (kind === 1 && word !== null) {
          peer.editor.update(() =>
            $onWords(
              word,
              at =>
                void $selectIn([0], at, at + word.length).formatText('bold'),
            ),
          );
        } else if (kind === 2 && word !== null) {
          peer.editor.update(() =>
            $onWords(
              word,
              at =>
                void $selectIn([0], at + word.length).insertText(
                  ` t${10 + step}z`,
                ),
            ),
          );
        } else if (kind === 3 && process.env.NOUNDO !== '1') {
          peer.undo();
        } else if (kind === 4) {
          peer.online = !peer.online;
        }
        if (rnd(3) === 0) {
          // In the same task: batched updates still waiting for their commit.
          await t.sync();
        } else if (rnd(2) === 0) {
          await flush();
        }
      }
      await t.sync();
      try {
        await expectConverged(t.peers);
        // The next edits are written.
        for (const peer of t.peers) {
          peer.update(() =>
            $selectIn([1], 0).insertText(`${peer.doc.clientID}>`),
          );
        }
        await t.sync();
        await expectConverged(t.peers);
        // Each peer's, once.
        const fresh = await freshReader(t.a);
        const tail = fresh.describe().match(/paragraph\("(.*)tail line"\)$/);
        expect(tail && tail[1].match(/\d>/g)?.sort()).toEqual([
          '1>',
          '2>',
          '3>',
        ]);
      } catch (error) {
        failures.push(
          `seed ${seed}: ${log.join(' ')}\n${error}\n` +
            t.peers
              .map(p => `${p.describe()} ${p.errors} ${p.warnings}`)
              .join('\n'),
        );
      }
    }
    expect(
      `${failures.length} of ${SEEDS} seeds\n${failures.slice(0, 3).join('\n\n')}`,
    ).toBe(`0 of ${SEEDS} seeds\n`);
  }, 600_000);
});

describe('another binding writing meanwhile', () => {
  test('on a replica of the document, sees its document as it is', async () => {
    const t = await setup(() => $getRoot().append($p('abcdef')), {
      ids: [1, 2, 3],
    });
    t.offline();
    const vector = Y.encodeStateVector(t.c.doc);
    t.c.update(() => void $selectIn([0], 0, 1).removeText());
    const change = Y.encodeStateAsUpdate(t.c.doc, vector);
    Y.applyUpdate(t.b.doc, change);
    expect(t.b.describe()).toBe('paragraph("bcdef")');
    let calls = 0;
    t.a.doc.on('beforeTransaction', (tr: Y.Transaction) => {
      if (tr.origin === t.a.binding && calls++ === 0) {
        // While A writes on the document as it was before C's change.
        t.b.update(() => void $selectIn([0], 1, 2).removeText());
      }
    });
    t.a.editor.update(() => void $selectIn([0], 6).insertText('!'));
    Y.applyUpdate(t.a.doc, change);
    expect(calls).toBe(1);
    expect(t.b.describe()).toBe('paragraph("bdef")');
    expect((await freshReader(t.b)).describe()).toBe('paragraph("bdef")');
    await t.sync();
    await expectConverged(t.peers, 'paragraph("bdef!")');
  });

  test('on another root of the same document, sees it as it is', async () => {
    const doc = createYDoc(null, {gc: false});
    doc.clientID = 1;
    const warnings: string[] = [];
    const bind = (name: string) => {
      const editor = createEditor({
        namespace: name,
        nodes: NODES,
        onError: e => {
          throw e;
        },
        onWarn: e => void warnings.push(String(e)),
      });
      const binding = new YBinding(editor, doc, {
        root: doc.get(name),
        schemaVersion: 1,
        selfCheck: true,
      });
      binding.start();
      return {binding, editor};
    };
    const b = bind('B');
    let cursorAfterRead: unknown = null;
    doc.on('afterTransaction', (tr: Y.Transaction) => {
      if (tr.origin === 'remote') {
        // B (bound first) has read the change; A has not.
        cursorAfterRead = b.binding.getCursor();
      }
    });
    const a = bind('A');
    for (const {binding, editor} of [b, a]) {
      editor.update(() => void $getRoot().append($p('abcdef')), {
        discrete: true,
      });
      binding.initialize();
    }
    await flush();
    b.editor.update(() => void $selectIn([0], 2), {discrete: true});
    const remote = new Y.Doc({gc: false});
    remote.clientID = 2;
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    remote.transact(() => {
      remote.get('A').delete(0, 1);
      remote.get('B').delete(0, 1);
    });
    let cursorDuringWrite: unknown = null;
    doc.on('beforeTransaction', (tr: Y.Transaction) => {
      if (tr.origin === a.binding && cursorDuringWrite === null) {
        cursorDuringWrite = b.binding.getCursor();
      }
    });
    a.editor.update(() => void $block([0]).selectEnd().insertText('!'));
    Y.applyUpdate(
      doc,
      Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)),
      'remote',
    );
    await flush();
    expect(cursorAfterRead).not.toBe(null);
    expect(cursorDuringWrite).toEqual(cursorAfterRead);
    const show = (editor: typeof a.editor) =>
      editor
        .getEditorState()
        .read(() => $getRoot().getChildren().map(describeNode).join(' / '));
    expect(show(b.editor)).toBe('paragraph("bcdef")');
    expect(show(a.editor)).toBe('paragraph("bcdef!")');
    expect(warnings).toEqual([]);
  });
});

test('another editor on the same root keeps its selection', async () => {
  for (const [gc, bFirst] of [
    [false, true],
    [true, true],
    [false, false],
    [true, false],
  ]) {
    const doc = createYDoc(null, {gc});
    doc.clientID = 1;
    const root = doc.get('root');
    const bind = (namespace: string) => {
      const warnings: string[] = [];
      const editor = createEditor({
        namespace,
        nodes: NODES,
        onError: e => {
          throw e;
        },
        onWarn: e => void warnings.push(String(e)),
      });
      const binding = new YBinding(editor, doc, {
        root,
        schemaVersion: 1,
        selfCheck: true,
      });
      binding.start();
      return {binding, editor, warnings};
    };
    // A writes an update waiting for its commit on the document as it was
    // before a remote change, before or after B reads the change.
    const first = bind(bFirst ? 'B' : 'A');
    const second = bind(bFirst ? 'A' : 'B');
    const [a, b] = bFirst ? [second, first] : [first, second];
    b.editor.update(() => void $getRoot().append($p('abcdef'), $p('tail')), {
      discrete: true,
    });
    b.binding.initialize();
    await flush();
    b.editor.update(() => void $selectIn([0], 2), {discrete: true});
    const remote = new Y.Doc({gc});
    remote.clientID = 2;
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    remote.get('root').delete(0, 1);
    a.editor.update(() => void $block([1]).selectEnd().insertText('!'));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)));
    await flush();
    const result = b.editor.getEditorState().read(() => {
      const selection = $getSelection();
      return {
        caret: $isRangeSelection(selection) ? selection.anchor.offset : null,
        text: $getRoot()
          .getChildren()
          .map(n => n.getTextContent()),
      };
    });
    expect(result).toEqual({caret: 1, text: ['bcdef', 'tail!']});
    expect(b.warnings).toEqual([]);
    a.binding.dispose();
    b.binding.dispose();
  }
});

test('a change another binding writes while the remote change is applied is not in the view either', async () => {
  const doc = createYDoc(null, {gc: false});
  doc.clientID = 1;
  const warnings: string[] = [];
  const bind = (namespace: string) => {
    const editor = createEditor({
      namespace,
      nodes: NODES,
      onError: e => {
        throw e;
      },
      onWarn: e => void warnings.push(String(e)),
    });
    const binding = new YBinding(editor, doc, {
      root: doc.get('root'),
      schemaVersion: 1,
      selfCheck: true,
    });
    binding.start();
    return {binding, editor};
  };
  const b = bind('B');
  const a = bind('A');
  b.editor.update(() => void $getRoot().append($p('abcdef'), $p('tail')), {
    discrete: true,
  });
  b.binding.initialize();
  await flush();
  const remote = new Y.Doc({gc: false});
  remote.clientID = 2;
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
  remote.get('root').delete(0, 1);
  // B reads the remote change first, and its listener writes at once,
  // before A writes its update that waits for its commit.
  let armed = true;
  b.editor.registerUpdateListener(({tags}) => {
    if (armed && tags.has(COLLABORATION_TAG)) {
      armed = false;
      b.editor.update(() => void $selectIn([0], 0).insertText('!'), {
        discrete: true,
      });
    }
  });
  a.editor.update(() => void $selectIn([0], 2, 3).removeText());
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)));
  await flush();
  const text = (editor: typeof a.editor) =>
    editor.getEditorState().read(() => $getRoot().getTextContent());
  expect(armed).toBe(false);
  expect(text(a.editor)).toBe('!bdef\n\ntail');
  expect(text(b.editor)).toBe('!bdef\n\ntail');
  expect(warnings).toEqual([]);
  a.binding.dispose();
  b.binding.dispose();
});

// Open (#9579): a binding's read of a change shows what the changes applied
// since did to the lines it reads, but the binding goes on seeing those
// changes as unread until it reads them in turn. A selection taken of its
// editor in between (another binding's listener asking for it) is taken
// on a document without them, one character off here.
test.fails(
  "a selection taken between reads of two changes is the editor's (#9579)",
  async () => {
    const doc = createYDoc(null, {gc: false});
    doc.clientID = 1;
    const bind = (namespace: string) => {
      const editor = createEditor({
        namespace,
        nodes: NODES,
        onError: e => {
          throw e;
        },
      });
      const binding = new YBinding(editor, doc, {
        root: doc.get('root'),
        schemaVersion: 1,
        selfCheck: true,
      });
      binding.start();
      return {binding, editor};
    };
    const b = bind('B');
    const a = bind('A');
    const c = bind('C');
    b.editor.update(() => void $getRoot().append($p('abcdef'), $p('tail')), {
      discrete: true,
    });
    b.binding.initialize();
    await flush();
    const remote = new Y.Doc({gc: false});
    remote.clientID = 2;
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    remote.get('root').delete(0, 1);
    // B reads the remote change and writes from its listener; A reads the
    // remote change (which shows B's write); C asks for A's selection
    // before A reads B's write.
    const textOf = (editorState: EditorState) =>
      editorState.read(() => $getRoot().getTextContent());
    let prefixed = false;
    b.editor.registerUpdateListener(({tags, editorState}) => {
      if (
        !prefixed &&
        tags.has(COLLABORATION_TAG) &&
        textOf(editorState).startsWith('b')
      ) {
        prefixed = true;
        b.editor.update(() => void $selectIn([0], 0).insertText('!'), {
          discrete: true,
        });
      }
    });
    let taken: unknown = null;
    c.editor.registerUpdateListener(({tags, editorState}) => {
      if (
        taken === null &&
        tags.has(COLLABORATION_TAG) &&
        textOf(editorState).startsWith('!b')
      ) {
        taken = a.binding.getCursor();
      }
    });
    a.editor.update(() => void $selectIn([0], 2, 3).removeText(), {
      discrete: true,
    });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)));
    await flush();
    expect(taken).not.toBe(null);
    expect(taken).toEqual(a.binding.getCursor());
  },
);

const value = createState('value', {
  parse: (v: unknown) => (typeof v === 'string' ? v : ''),
});
class ValueParagraph extends ParagraphNode {
  $config() {
    return this.config('test_value_paragraph', {
      extends: ParagraphNode,
      stateConfigs: [value],
    });
  }
}
const $valueDoc = () => {
  const node = $create(ValueParagraph).append($createTextNode('body'));
  $setState(node, value, 'old');
  $getRoot().append(node, $p('tail'));
};
const $setValue = (v: string) => void $setState($block([0]), value, v);
const valueOf = (peer: {read: <T>(fn: () => T) => T}) =>
  peer.read(() => $getState($block([0]), value));

describe('an attribute the remote change set or deleted', () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`deleted, then reset and restored by local updates (ids ${ids})`, async () => {
      const t = await setup($valueDoc, {
        ids,
        nodes: [...NODES, ValueParagraph],
      });
      t.offline();
      t.a.update(() => $setValue(''));
      let restored = false;
      t.b.editor.registerUpdateListener(({tags}) => {
        if (tags.has('reset') && !restored) {
          restored = true;
          t.b.editor.update(() => $setValue('old'));
        }
      });
      t.b.editor.update(() => $setValue(''), {tag: 'reset'});
      await t.sync();
      await flush();
      await t.sync();
      expect(restored).toBe(true);
      await expectConverged(t.peers);
      expect(valueOf(t.a)).toBe('old');
      expect(valueOf(await freshReader(t.b))).toBe('old');
    });

    for (const local of ['', 'LOCAL']) {
      test(`set, then ${local === '' ? 'deleted' : 'set'} by a waiting local update as by a concurrent one (ids ${ids})`, async () => {
        const run = async (waiting: boolean) => {
          const t = await setup($valueDoc, {
            ids,
            nodes: [...NODES, ValueParagraph],
          });
          t.offline();
          t.a.update(() => $setValue('REMOTE'));
          if (waiting) {
            t.b.editor.update(() => $setValue(local));
          } else {
            t.b.update(() => $setValue(local));
          }
          await t.sync();
          await expectConverged(t.peers);
          return valueOf(await freshReader(t.b));
        };
        const concurrent = await run(false);
        if (local === '') {
          expect(concurrent).toBe('REMOTE');
        }
        expect(await run(true)).toBe(concurrent);
      });
    }
  }
});

class OtherBoxNode extends BoxNode {
  $config() {
    return this.config('test_other_box', {extends: BoxNode});
  }
}

test('a node the remote change replaced in place keeps what it inserted', async () => {
  const run = async (waiting: boolean) => {
    const t = await setup(
      () =>
        $getRoot().append($create(BoxNode).append($p('ORIGINAL')), $p('tail')),
      {nodes: [...NODES, OtherBoxNode]},
    );
    t.offline();
    // A stored node replaced in place by a node of another type (its type
    // attribute), and text inserted into it, in one remote change.
    let box: Y.Node | null = null;
    for (let it = t.a.binding.root._start; it !== null; it = it.right) {
      if (it.content instanceof Y.ContentType && !it.deleted) {
        const type = it.content.type as Y.Node;
        if (String(type.name) === 'b:test_box') {
          box = type;
        }
      }
    }
    expect(box).not.toBe(null);
    t.a.doc.transact(() => {
      t.a.binding.root.setAttr('k:test_other_box', 'nested');
      box!.setAttr('t', 'test_other_box');
      box!.insert(0, 'REMOTE-');
    });
    const $local = () => void $getRoot().append($p('LOCAL'));
    if (waiting) {
      t.b.editor.update($local);
    } else {
      t.b.update($local);
    }
    await t.sync();
    await t.sync();
    await expectConverged(t.peers);
    return (await freshReader(t.a)).describe();
  };
  const concurrent = await run(false);
  expect(concurrent).toContain('REMOTE-ORIGINAL');
  expect(await run(true)).toBe(concurrent);
});
