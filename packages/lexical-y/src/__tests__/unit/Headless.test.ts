/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  BlockIdExtension,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$createListItemNode, $createListNode, $isListNode} from '@lexical/list';
import {$createHeadingNode} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
  $getSelection,
  $getState,
  $isRangeSelection,
  $isTextNode,
  $parseSerializedNode,
  $setState,
  COLLABORATION_TAG,
  configExtension,
  createState,
  defineExtension,
  HISTORY_MERGE_TAG,
  type LexicalEditor,
  LexicalWarning,
  SKIP_COLLAB_TAG,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {setFlagsFromString} from 'node:v8';
import {runInNewContext} from 'node:vm';
import {afterEach, describe, expect, test, vi} from 'vitest';

import {
  LAYOUT_VERSION,
  UNSUPPORTED_LAYOUT_WARNING,
  YBinding,
  YCollabExtension,
} from '../..';
import {
  createYDoc,
  createYWriter,
  editYState,
  readYState,
  seedYState,
  YHeadlessError,
} from '../../headless';
import {
  createHeadlessYEditor,
  MAX_FOLLOW_UPS,
  openHeadlessYEditor,
} from '../../internal/HeadlessEditor';
import {
  $block,
  $p,
  $selectIn,
  describeNode,
  expectConverged,
  NODES,
  type Peer,
  setup,
} from '../utils/harness';

// The tests turn the binding's self-check on (it is off by default): a
// mismatch is a warning, so the tests that expect none catch it.
const config = {nodes: NODES, schemaVersion: 1, selfCheck: true};

/** Run microtasks collected by a spy; the messages of those that throw. */
function rethrown(tasks: (() => void)[]): string[] {
  const out: string[] = [];
  for (const task of tasks.splice(0)) {
    try {
      task();
    } catch (e) {
      out.push((e as Error).message);
    }
  }
  return out;
}

// Like a block id extension: every top-level block gets a random id, given
// in an update scheduled by an update listener (so on open, too).
const bidState = createState('bid', {
  parse: v => (typeof v === 'string' ? v : ''),
});
let nextBid = 0;
const BidExtension = defineExtension({
  name: 'test-bid',
  nodes: NODES,
  register: editor =>
    editor.registerUpdateListener(({editorState}) => {
      const missing = editorState.read(() =>
        $getRoot()
          .getChildren()
          .some(node => $getState(node, bidState) === ''),
      );
      if (missing) {
        editor.update(() => {
          for (const node of $getRoot().getChildren()) {
            if ($getState(node, bidState) === '') {
              $setState(node, bidState, `b${nextBid++}`);
            }
          }
        });
      }
    }),
});
const bidConfig = {
  extensions: [BidExtension],
  schemaVersion: 1,
  selfCheck: true,
};
const $bids = () =>
  $getRoot()
    .getChildren()
    .map(node => $getState(node, bidState))
    .join(',');

const $describe = () => $getRoot().getChildren().map(describeNode).join(' / ');

function seed(...lines: string[]): Uint8Array {
  return seedYState(config, () => {
    for (const line of lines) {
      $getRoot().append($p(line));
    }
  });
}

function caught(fn: () => unknown): YHeadlessError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(YHeadlessError);
    return error as YHeadlessError;
  }
  throw new Error('expected a YHeadlessError');
}

/** The format items of the layout root's top level that are not deleted. */
function aliveFormats(state: Uint8Array): string[] {
  const doc = new Y.Doc({gc: false});
  doc.cleanupFormatting = false;
  Y.applyUpdate(doc, state);
  const out: string[] = [];
  for (let item = doc.get('lexical-y')._start; item !== null; ) {
    const content = item.content as unknown as {key?: string; value?: unknown};
    if (!item.deleted && item.content instanceof Y.ContentFormat) {
      out.push(`${content.key}=${JSON.stringify(content.value)}`);
    }
    item = item.right;
  }
  doc.destroy();
  return out;
}

/** Client ids of every struct an update carries. */
function clientsOf(update: Uint8Array): number[] {
  const {structs} = Y.decodeUpdate(update);
  return [...new Set(structs.map(s => s.id.client))];
}

function applyTo(peers: Peer[], update: Uint8Array) {
  for (const peer of peers) {
    Y.applyUpdate(peer.doc, update, 'server');
  }
}

describe('@lexical/y/headless', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('seed, edit and read round trip', () => {
    const state = seed('Hello');
    expect(readYState(state, config, $describe)).toBe('paragraph("Hello")');
    const {update, state: next} = editYState(
      state,
      config,
      () => {
        (
          $block([0]).getFirstChild() as ReturnType<typeof $createTextNode>
        ).spliceText(5, 0, ', world');
        $getRoot().append($p('Second'));
      },
      {writer: null},
    );
    expect(update).not.toBeNull();
    expect(readYState(next, config, $describe)).toBe(
      'paragraph("Hello, world") / paragraph("Second")',
    );
    // The state is the stored state with the update merged in.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    Y.applyUpdate(doc, update!);
    expect(
      readYState(Y.encodeStateAsUpdate(doc), config, () =>
        $getEditor().getEditorState().toJSON(),
      ),
    ).toEqual(
      readYState(next, config, () => $getEditor().getEditorState().toJSON()),
    );
  });

  test('the stored state is garbage collected; the update is not', () => {
    const removed = 'text the agent rewrites away';
    const state = seed(removed);
    const {update, state: next} = editYState(
      state,
      config,
      () => {
        $block([0]).clear().append($createTextNode('new wording'));
      },
      {writer: null},
    );
    const has = (bytes: Uint8Array, text: string) =>
      new TextDecoder().decode(bytes).includes(text);
    expect(readYState(next, config, $describe)).toBe(
      'paragraph("new wording")',
    );
    // Merged without garbage collection, the deleted text would stay.
    expect(
      has(
        Y.mergeUpdates([state, update!] as Uint8Array<ArrayBuffer>[]),
        removed,
      ),
    ).toBe(true);
    expect(has(next, removed)).toBe(false);
    // Already compact: a garbage-collected document encodes it unchanged.
    for (const s of [state, next]) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, s);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(s);
    }
  });

  test('identical seeds give the same bytes and merge into one copy', () => {
    expect(seed('a', 'b')).toEqual(seed('a', 'b'));
    expect(seed('a', 'b')).not.toEqual(seed('a', 'c'));
    const merged = Y.mergeUpdates([
      seed('a', 'b') as Uint8Array<ArrayBuffer>,
      seed('a', 'b') as Uint8Array<ArrayBuffer>,
    ]);
    expect(readYState(merged, config, $describe)).toBe(
      'paragraph("a") / paragraph("b")',
    );
  });

  test("a seed is normalized, and merges with a client's seed of the same content into one copy", async () => {
    // A list item holding text beside its nested list: the binding's
    // normalization puts the nested list in an item of its own.
    const $build = () => {
      $getRoot().append(
        $p('title'),
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('one')),
          $createListItemNode().append(
            $createTextNode('two'),
            $createListNode('bullet').append(
              $createListItemNode().append($createTextNode('nested')),
            ),
          ),
        ),
      );
    };
    const normalized =
      'paragraph("title") / list[bullet](listitem("one") listitem("two") listitem(list[bullet](listitem("nested"))))';
    const state = seedYState(config, $build);
    expect(readYState(state, config, $describe)).toBe(normalized);
    // A client seeding the same content in a new document.
    const doc = createYDoc();
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        dependencies: [
          configExtension(YCollabExtension, {doc, schemaVersion: 1}),
        ],
        name: 'client',
        nodes: NODES,
      }),
    );
    const {binding} = getExtensionDependencyFromEditor(
      editor,
      YCollabExtension,
    ).output;
    editor.update($build);
    binding.initialize();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(editor.read($describe)).toBe(normalized);
    const merged = Y.mergeUpdates([
      state as Uint8Array<ArrayBuffer>,
      Y.encodeStateAsUpdate(doc),
    ]);
    expect(readYState(merged, config, $describe)).toBe(normalized);
    editor.dispose();
  });

  test('an edit with no change returns no update', () => {
    const state = seed('same');
    const result = editYState(state, config, () => {}, {writer: null});
    expect(result.update).toBeNull();
    // Already compact.
    expect(result.state).toEqual(state);
  });

  test('the state an edit with no change returns is compacted too', () => {
    // Stored uncompacted: a seed and a rewrite merged as updates.
    const state = seed('text the agent rewrites away');
    const {update} = editYState(
      state,
      config,
      () => {
        $block([0]).clear().append($createTextNode('new wording'));
      },
      {writer: null},
    );
    const merged = Y.mergeUpdates([
      state,
      update!,
    ] as Uint8Array<ArrayBuffer>[]);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, merged);
    const compacted = Y.encodeStateAsUpdate(doc);
    expect(compacted.length).toBeLessThan(merged.length);
    const result = editYState(merged, config, () => {}, {writer: null});
    expect(result.update).toBeNull();
    expect(result.state).toEqual(compacted);
    expect(readYState(result.state, config, $describe)).toBe(
      'paragraph("new wording")',
    );
  });

  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`the returned state keeps the format items the clients keep (${ids})`, async () => {
      const t = await setup(() => $getRoot().append($p('AB'), $p('second')), {
        ids,
      });
      // a bolds "A" while b deletes it: the bold's format items stay around
      // the deleted text, at the start of the document. Yjs's format cleanup
      // would delete them; the clients' binding opts out of it.
      t.offline();
      t.a.update(() => $selectIn([0], 0, 1).formatText('bold'));
      t.b.update(() => $selectIn([0], 0, 1).removeText());
      await t.sync();
      const state = Y.encodeStateAsUpdate(t.a.doc);
      expect(aliveFormats(state)).toEqual(['f:bold=true', 'f:bold=null']);
      // The server edits elsewhere and stores the returned state.
      const result = editYState(
        state,
        config,
        () => {
          $block([1]).selectEnd();
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText('!');
          }
        },
        {writer: null},
      );
      // It is `state` with `update` applied, no more.
      expect(aliveFormats(result.state)).toEqual(
        aliveFormats(
          Y.mergeUpdates([state, result.update!] as Uint8Array<ArrayBuffer>[]),
        ),
      );
      applyTo(t.peers, result.update!);
      await t.sync();
      // b types bold text where those items are.
      const before = Y.encodeStateVector(t.b.doc);
      t.b.update(() => {
        $selectIn([0], 0);
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.formatText('bold');
          selection.insertText('Y');
        }
      });
      const typed = Y.encodeStateAsUpdate(t.b.doc, before);
      await t.sync();
      const stored = Y.mergeUpdates([
        result.state,
        typed,
      ] as Uint8Array<ArrayBuffer>[]);
      await expectConverged(t.peers, t.a.describe());
      expect(readYState(stored, config, $describe)).toBe(t.a.describe());
    });
  }

  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`createYDoc gives a relay the format items the clients keep (${ids})`, async () => {
      const t = await setup(() => $getRoot().append($p('AB'), $p('second')), {
        ids,
      });
      const relay = createYDoc(Y.encodeStateAsUpdate(t.a.doc));
      const plain = new Y.Doc();
      Y.applyUpdate(plain, Y.encodeStateAsUpdate(t.a.doc));
      expect(relay.cleanupFormatting).toBe(false);
      // a bolds "A" while b deletes it; the relay receives each one's
      // update, in both orders across the two ids.
      t.offline();
      const vectors = t.peers.map(peer => Y.encodeStateVector(peer.doc));
      t.a.update(() => $selectIn([0], 0, 1).formatText('bold'));
      t.b.update(() => $selectIn([0], 0, 1).removeText());
      const updates = t.peers.map((peer, i) =>
        Y.encodeStateAsUpdate(peer.doc, vectors[i]),
      );
      for (const doc of [relay, plain]) {
        for (const update of updates) {
          Y.applyUpdate(doc, update);
        }
      }
      await t.sync();
      const clients = aliveFormats(Y.encodeStateAsUpdate(t.a.doc));
      expect(clients).toEqual(['f:bold=true', 'f:bold=null']);
      expect(aliveFormats(Y.encodeStateAsUpdate(relay))).toEqual(clients);
      // A plain Y.Doc runs Yjs's format cleanup and stores less.
      expect(aliveFormats(Y.encodeStateAsUpdate(plain))).not.toEqual(clients);
      // What the relay stores reads as the clients do, also once someone
      // types bold text where those items are.
      const before = Y.encodeStateVector(t.b.doc);
      t.b.update(() => {
        $selectIn([0], 0);
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.formatText('bold');
          selection.insertText('Y');
        }
      });
      Y.applyUpdate(relay, Y.encodeStateAsUpdate(t.b.doc, before));
      await expectConverged(t.peers, t.a.describe());
      expect(readYState(Y.encodeStateAsUpdate(relay), config, $describe)).toBe(
        t.a.describe(),
      );
      relay.destroy();
      plain.destroy();
    });
  }

  test('createYDoc without a state is an empty document; a state that does not load throws', () => {
    const doc = createYDoc();
    expect(doc.cleanupFormatting).toBe(false);
    expect(doc.gc).toBe(true);
    expect(Y.encodeStateVector(doc)).toEqual(Y.encodeStateVector(new Y.Doc()));
    doc.destroy();
    expect(createYDoc(null).cleanupFormatting).toBe(false);
    const seeded = createYDoc(seed('stored'));
    expect(readYState(Y.encodeStateAsUpdate(seeded), config, $describe)).toBe(
      readYState(seed('stored'), config, $describe),
    );
    seeded.destroy();
    expect(() => createYDoc(new Uint8Array([255, 255, 255]))).toThrow();
  });

  test('an edit tagged as remote or skipped is refused', () => {
    const state = seed('a');
    for (const tag of [
      COLLABORATION_TAG,
      SKIP_COLLAB_TAG,
      [HISTORY_MERGE_TAG, COLLABORATION_TAG],
    ]) {
      const ran = vi.fn();
      const error = caught(() =>
        editYState(
          state,
          config,
          () => {
            ran();
            $getRoot().append($p('lost'));
          },
          {tag, writer: null},
        ),
      );
      expect(error.code).toBe('ignored-tag');
      // The message says what to do.
      expect(error.message).toMatch(/; remove it from options\.tag /);
      expect(ran).not.toHaveBeenCalled();
    }
    // Other tags are the edit's own.
    const {update, state: next} = editYState(
      state,
      config,
      () => $getRoot().append($p('b')),
      {tag: HISTORY_MERGE_TAG, writer: null},
    );
    expect(update).not.toBeNull();
    expect(readYState(next, config, $describe)).toBe(
      'paragraph("a") / paragraph("b")',
    );
  });

  test('block ids are configured as on the clients', () => {
    const AppNodes = defineExtension({name: 'test-app-nodes', nodes: NODES});
    const repairTransforms = (editor: LexicalEditor) =>
      getExtensionDependencyFromEditor(editor, BlockIdExtension).config
        .repairTransforms;
    const client = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          AppNodes,
          configExtension(YCollabExtension, {
            doc: createYDoc(),
            schemaVersion: 1,
          }),
          BlockIdExtension,
        ],
        name: 'test-client',
      }),
    );
    const handle = createHeadlessYEditor({
      extensions: [AppNodes, BlockIdExtension],
      schemaVersion: 1,
    });
    try {
      expect(repairTransforms(client)).toBe(false);
      expect(repairTransforms(handle.editor)).toBe(false);
      // So the binding writes (no '@lexical/y/unsupported-config').
      const warnings: LexicalWarning[] = [];
      const idConfig = {
        extensions: [AppNodes, BlockIdExtension],
        onWarn: (warning: LexicalWarning) => warnings.push(warning),
        schemaVersion: 1,
      };
      const state = seedYState(idConfig, () =>
        $getRoot().append($createParagraphNode().append($createTextNode('a'))),
      );
      const result = editYState(
        state,
        idConfig,
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('b')),
          ),
        {writer: null},
      );
      expect(result.update).not.toBeNull();
      expect(warnings).toEqual([]);
    } finally {
      handle.dispose();
      client.dispose();
    }
  });

  test('a synchronous loop of calls holds no document it opened', () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const heap = () => {
      gc();
      gc();
      return process.memoryUsage().heapUsed;
    };
    const big = seedYState({nodes: NODES, schemaVersion: 1}, () => {
      for (let i = 0; i < 1000; i++) {
        $getRoot().append($p(`paragraph ${i} with some text in it`));
      }
    });
    // A writer keeps client ids and clocks, never a document.
    const writer = createYWriter('agent');
    let written = big;
    const start = heap();
    // No await: nothing Lexical scheduled in a microtask has run.
    for (let i = 0; i < 20; i++) {
      readYState(big, {nodes: NODES, schemaVersion: 1}, () =>
        $getRoot().getTextContentSize(),
      );
      editYState(
        big,
        {nodes: NODES, schemaVersion: 1},
        () => $getRoot().append($p('x')),
        {
          writer: null,
        },
      );
      written = editYState(
        written,
        {nodes: NODES, schemaVersion: 1},
        () => $getRoot().append($p('y')),
        {writer},
      ).state;
    }
    // Each call held about 1.8 MB (the editor, the document and the
    // binding) until the loop yielded: over 100 MB here.
    expect(heap() - start).toBeLessThan(10e6);
    expect(
      readYState(written, {nodes: NODES, schemaVersion: 1}, () =>
        $getRoot().getChildrenSize(),
      ),
    ).toBe(1020);
    // 60 calls on a 1,000-line document: about 2 s alone, over vitest's
    // default 5 s limit when the whole suite runs.
  }, 30_000);

  test('an error thrown by the edit is rethrown and nothing is returned', () => {
    const state = seed('keep');
    expect(() =>
      editYState(
        state,
        config,
        () => {
          $getRoot().clear();
          throw new Error('refused');
        },
        {writer: null},
      ),
    ).toThrow('refused');
    expect(readYState(state, config, $describe)).toBe('paragraph("keep")');
  });

  test('anything the edit throws is rethrown, and nothing is written', () => {
    const state = seed('keep');
    // Lexical reports only its own realm's Errors to onError: a string, a
    // plain object or an Error from another realm must not read as an edit
    // that changed nothing.
    const foreign = runInNewContext('new Error("from another realm")');
    expect(foreign instanceof Error).toBe(false);
    const thrownValues: unknown[] = [
      'a string',
      {reason: 'an object'},
      foreign,
      new Error('an error'),
    ];
    for (const value of thrownValues) {
      let transacted = false;
      let caughtValue: unknown = null;
      try {
        editYState(
          state,
          config,
          () => {
            $getRoot().clear().append($p('lost'));
            throw value;
          },
          {
            allowedRoots: ['lexical-y', 'activity'],
            transact: doc => {
              transacted = true;
              doc.get('activity').setAttr('last', 'agent');
            },
            writer: null,
          },
        );
      } catch (error) {
        caughtValue = error;
      }
      expect(caughtValue).toBe(value);
      expect(transacted).toBe(false);
    }
    expect(readYState(state, config, $describe)).toBe('paragraph("keep")');
    // The same in a document whose opening writes (block ids): the edit
    // fails, so nothing is returned either.
    const bare = seed('a');
    expect(() =>
      editYState(
        bare,
        bidConfig,
        () => {
          // eslint-disable-next-line no-throw-literal -- a value that is not an Error
          throw 'refused';
        },
        {writer: null},
      ),
    ).toThrow('refused');
  });

  test('a state that fails to open releases what opening registered', () => {
    let registered = 0;
    let released = 0;
    const Tracked = defineExtension({
      name: 'test-tracked',
      nodes: NODES,
      register: editor => {
        registered++;
        const off = editor.registerUpdateListener(() => {});
        return () => {
          released++;
          off();
        };
      },
    });
    const tracked = {extensions: [Tracked], schemaVersion: 1, selfCheck: true};
    const destroyed: Y.Doc[] = [];
    const destroy = Y.Doc.prototype.destroy;
    vi.spyOn(Y.Doc.prototype, 'destroy').mockImplementation(function (
      this: Y.Doc,
    ) {
      destroyed.push(this);
      destroy.call(this);
    });
    // Bytes that are not a Yjs update.
    const garbage = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255]);
    expect(() => Y.applyUpdate(new Y.Doc(), garbage)).toThrow();
    for (const fn of [
      () => editYState(garbage, tracked, () => {}, {writer: null}),
      () => readYState(garbage, tracked, $describe),
      () => createHeadlessYEditor({...tracked, state: garbage}),
    ]) {
      expect(fn).toThrow();
    }
    expect(registered).toBe(3);
    expect(released).toBe(3);
    // The document each one loaded the state into is destroyed.
    expect(destroyed.length).toBe(3);
  });

  for (const order of ['server first', 'peers first'] as const) {
    test(`a server edit merges with concurrent peer edits (${order})`, async () => {
      const t = await setup(() => {
        $getRoot().append($p('one'), $p('two'));
      });
      const state = Y.encodeStateAsUpdate(t.a.doc);
      t.offline();
      t.a.update(() => $selectIn([0], 3).insertText(' A'));
      t.b.update(() => $selectIn([1], 0).insertText('B '));
      const {update} = editYState(
        state,
        config,
        () => {
          $getRoot().append($p('three'));
          (
            $block([0]).getFirstChild() as ReturnType<typeof $createTextNode>
          ).spliceText(0, 0, 'S ');
        },
        {writer: null},
      );
      if (order === 'server first') {
        applyTo(t.peers, update!);
        await t.sync();
      } else {
        await t.sync();
        applyTo(t.peers, update!);
        await t.sync();
      }
      await expectConverged(
        t.peers,
        'paragraph("S one A") / paragraph("B two") / paragraph("three")',
      );
      // The server's own copy (stored state, the peers' updates, its update)
      // reads the same.
      const stored = Y.mergeUpdates([
        Y.encodeStateAsUpdate(t.a.doc),
        Y.encodeStateAsUpdate(t.b.doc),
        update as Uint8Array<ArrayBuffer>,
      ]);
      expect(readYState(stored, config, $describe)).toBe(t.a.describe());
    });
  }

  test('an edit to a block a peer is typing in keeps their text', async () => {
    const t = await setup(() => $getRoot().append($p('hello world')));
    const state = Y.encodeStateAsUpdate(t.a.doc);
    t.offline();
    // The peer types in the middle of the line, character by character.
    for (const ch of [' ', 'b', 'i', 'g']) {
      const at = t.b.read(() => $getRoot().getTextContent().indexOf(' world'));
      t.b.update(() => $selectIn([0], at).insertText(ch));
    }
    // The server replaces the last word and turns the line into a heading.
    const {update} = editYState(
      state,
      config,
      () => {
        const text = $block([0]).getFirstChild();
        if (!$isTextNode(text)) {
          throw new Error('expected text');
        }
        text.spliceText(6, 5, 'there');
        $block([0]).replace($createHeadingNode('h2'), true);
      },
      {writer: null},
    );
    applyTo([t.a], update!);
    await t.sync();
    await expectConverged(t.peers, 'heading[h2]("hello big there")');
  });

  test('an update to a root that is not allowed is refused', () => {
    const state = seed('x');
    const error = caught(() =>
      editYState(state, config, () => {}, {
        transact: doc => doc.get('elsewhere').setAttr('k', 1),
        writer: null,
      }),
    );
    expect(error.code).toBe('foreign-roots');
    expect(error.message).toBe(
      "@lexical/y: the update writes outside the allowed roots (elsewhere); list every root the edit may write to in options.allowedRoots, which replaces the default, so name the layout root ('lexical-y') there too.",
    );
    // Allowed explicitly, it goes through with the edit in one update.
    const {update, state: next} = editYState(
      state,
      config,
      () => $getRoot().append($p('y')),
      {
        allowedRoots: ['lexical-y', 'activity'],
        transact: doc => doc.get('activity').setAttr('last', 'agent'),
        writer: null,
      },
    );
    const doc = new Y.Doc();
    Y.applyUpdate(doc, next);
    expect(doc.get('activity').getAttr('last')).toBe('agent');
    expect(readYState(next, config, $describe)).toBe(
      'paragraph("x") / paragraph("y")',
    );
    expect(update).not.toBeNull();
  });

  test("clientIDRange 'uint32' keeps every client id in 32 bits", () => {
    const state = seedYState({...config, clientIDRange: 'uint32'}, () =>
      $getRoot().append($p('a')),
    );
    expect(clientsOf(state).every(id => id <= 0xffffffff)).toBe(true);
    for (let i = 0; i < 20; i++) {
      const {update} = editYState(
        state,
        {...config, clientIDRange: 'uint32'},
        () => $getRoot().append($p(`edit ${i}`)),
        {writer: null},
      );
      expect(clientsOf(update!).every(id => id <= 0xffffffff)).toBe(true);
    }
    // Yjs 14's default ids are 53-bit.
    const {update} = editYState(
      state,
      config,
      () => $getRoot().append($p('wide')),
      {writer: null},
    );
    expect(clientsOf(update!).some(id => id > 0xffffffff)).toBe(true);
  });

  test('a document with a newer layout is read only and refused', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, seed('future'));
    doc.get('lexical-y').setAttr(`lexical-y:${LAYOUT_VERSION + 1}`, true);
    const state = Y.encodeStateAsUpdate(doc);
    for (const fn of [
      () =>
        editYState(state, config, () => $getRoot().append($p('x')), {
          writer: null,
        }),
      () => readYState(state, config, $describe),
      () => createHeadlessYEditor({...config, state}),
    ]) {
      const error = caught(fn);
      expect(error.code).toBe('read-only');
      // The message names the reasons (the warnings' messages, which say
      // what to do); programs read them as data: the binding's typed warnings.
      expect(error.message).toBe(
        `@lexical/y: the document is read only here: ${error.warnings
          .map(warning => warning.message)
          .join('; ')}`,
      );
      expect(
        error.warnings.map(warning => [warning.code, warning.data]),
      ).toEqual([
        [
          UNSUPPORTED_LAYOUT_WARNING,
          {
            found: LAYOUT_VERSION + 1,
            reason: 'newer',
            supported: LAYOUT_VERSION,
          },
        ],
      ]);
      // Narrowing on `code`, then on `data.reason`, types the fields.
      const [warning] = error.warnings;
      expect(
        warning.code === UNSUPPORTED_LAYOUT_WARNING &&
          warning.data.reason === 'newer'
          ? `${warning.data.found} > ${warning.data.supported}`
          : null,
      ).toBe(`${LAYOUT_VERSION + 1} > ${LAYOUT_VERSION}`);
    }
  });

  test('an empty state is not initialized', () => {
    const empty = Y.encodeStateAsUpdate(new Y.Doc());
    const refused = caught(() =>
      editYState(empty, config, () => {}, {writer: null}),
    );
    expect(refused.code).toBe('not-initialized');
    expect(refused.message).toContain('with seedYState(config, $build)');
    expect(caught(() => readYState(empty, config, $describe)).code).toBe(
      'not-initialized',
    );
    // A pending handle can be seeded by hand.
    using handle = createHeadlessYEditor(config);
    expect(handle.binding.status).toBe('pending');
    handle.editor.update(() => $getRoot().clear().append($p('by hand')), {
      discrete: true,
    });
    handle.binding.initialize();
    expect(
      readYState(Y.encodeStateAsUpdate(handle.doc), config, $describe),
    ).toBe('paragraph("by hand")');
  });

  test('dispose leaves no listeners on the editor or the document', () => {
    // What the binding and the helpers registered: compared with a bare
    // document and a bare editor of the same config (Yjs and Lexical keep
    // some registrations of their own).
    const docListeners = (doc: Y.Doc): string[] => {
      const observers = (
        doc as unknown as {_observers: Map<string, Set<unknown>>}
      )._observers;
      return [...observers]
        .filter(([, set]) => set.size > 0)
        .map(([name, set]) => `${name}:${set.size}`)
        .sort();
    };
    const editorListeners = (editor: LexicalEditor): string[] => [
      ...Object.entries(editor._listeners)
        .filter(([, set]) => set.size > 0)
        .map(([name, set]) => `${name}:${set.size}`),
      ...[...editor._commands].map(
        ([, byPriority]) =>
          `command:${byPriority.reduce((n, set) => n + set.size, 0)}`,
      ),
      ...[...editor._nodes]
        .filter(([, registered]) => registered.transforms.size > 0)
        .map(([type, registered]) => `${type}:${registered.transforms.size}`),
    ];
    const bareEditor = buildEditorFromExtensions(
      defineExtension({name: 'bare', nodes: NODES}),
    );
    bareEditor.dispose();
    const expectedEditor = editorListeners(bareEditor);
    const expectedDoc = docListeners(new Y.Doc());

    const atDestroy: string[][] = [];
    const destroy = Y.Doc.prototype.destroy;
    vi.spyOn(Y.Doc.prototype, 'destroy').mockImplementation(function (
      this: Y.Doc,
    ) {
      atDestroy.push(docListeners(this));
      destroy.call(this);
    });
    const editors: LexicalEditor[] = [];
    const state = seed('a');
    editYState(
      state,
      {...config, clientIDRange: 'uint32'},
      () => {
        editors.push($getEditor());
        $getRoot().append($p('b'));
      },
      {writer: null},
    );
    readYState(state, config, () => {
      editors.push($getEditor());
    });
    const handle = createHeadlessYEditor({...config, state});
    editors.push(handle.editor);
    handle.dispose();
    // Idempotent.
    handle.dispose();
    // The seed's document (with the two scratch documents of its
    // initialization and the one that compacts its state), the edit's (and
    // its compaction), the read's and the handle's.
    expect(atDestroy.length).toBe(8);
    for (const listeners of atDestroy) {
      expect(listeners).toEqual(expectedDoc);
    }
    for (const editor of editors) {
      expect(editorListeners(editor)).toEqual(expectedEditor);
      expect(editor._recordNodeMoves).toBe(bareEditor._recordNodeMoves);
    }
    expect(handle.doc.isDestroyed).toBe(true);
  });

  test('updates scheduled by an edit are part of its update', () => {
    const state = seedYState(bidConfig, () => $getRoot().append($p('a')));
    const seeded = readYState(state, bidConfig, $bids);
    expect(seeded).toMatch(/^b\d+$/);
    // Stored: every read agrees.
    expect(readYState(state, bidConfig, $bids)).toBe(seeded);
    const {state: next} = editYState(
      state,
      bidConfig,
      () => $getRoot().append($p('b')),
      {writer: null},
    );
    const ids = readYState(next, bidConfig, $bids);
    expect(ids).toMatch(/^b\d+,b\d+$/);
    expect(ids.startsWith(seeded + ',')).toBe(true);
    expect(readYState(next, bidConfig, $bids)).toBe(ids);
  });

  test('values assigned on open are stored by a no-op edit, not by a read', () => {
    // A document stored without ids.
    const state = seed('a', 'b');
    // Each read assigns ids that are never stored.
    const first = readYState(state, bidConfig, $bids);
    expect(first).not.toBe('');
    expect(readYState(state, bidConfig, $bids)).not.toBe(first);
    // A no-op edit returns what opening writes; once stored, reads agree.
    const opening = editYState(state, bidConfig, () => {}, {writer: null});
    expect(opening.update).not.toBeNull();
    const ids = readYState(opening.state, bidConfig, $bids);
    expect(readYState(opening.state, bidConfig, $bids)).toBe(ids);
    expect(
      editYState(opening.state, bidConfig, () => {}, {writer: null}).update,
    ).toBeNull();
  });

  test('warnings are reported and never refuse an edit', () => {
    const state = seed('a');
    const reported: LexicalWarning[] = [];
    const {update, warnings} = editYState(
      state,
      {...config, onWarn: warning => reported.push(warning)},
      () => {
        $getRoot().append($p('b'));
        $getEditor()._onWarn(new Error('a warning'));
      },
      {writer: null},
    );
    expect(update).not.toBeNull();
    expect(warnings.map(w => [w.code, w.message])).toEqual([
      ['@lexical/y/editor-warning', 'a warning'],
    ]);
    expect(warnings[0]).toBeInstanceOf(LexicalWarning);
    expect((warnings[0].data as {error: Error}).error.message).toBe(
      'a warning',
    );
    expect(reported).toEqual(warnings);
    // A LexicalWarning is passed on as it is.
    const own = new LexicalWarning('@example/app/odd', 'an app warning', 1);
    expect(
      editYState(
        state,
        {...config, onWarn: () => {}},
        () => $getEditor()._onWarn(own),
        {writer: null},
      ).warnings,
    ).toEqual([own]);
    // A handler that throws does not refuse the edit either: its error is
    // rethrown in a microtask, outside the helpers.
    const later: (() => void)[] = [];
    const microtask = vi
      .spyOn(globalThis, 'queueMicrotask')
      .mockImplementation(fn => later.push(fn));
    let thrown;
    try {
      thrown = editYState(
        state,
        {
          ...config,
          onWarn: () => {
            throw new Error('handler failure');
          },
        },
        () => {
          $getRoot().append($p('c'));
          $getEditor()._onWarn(new Error('a warning'));
        },
        {writer: null},
      );
    } finally {
      microtask.mockRestore();
    }
    expect(thrown.update).not.toBeNull();
    expect(thrown.warnings.map(w => w.message)).toEqual(['a warning']);
    expect(rethrown(later)).toEqual(['handler failure']);
    // The same in production.
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const prod = editYState(
        state,
        {...config, onWarn: warning => reported.push(warning)},
        () => {
          $getRoot().append($p('b'));
          $getEditor()._onWarn(new Error('a production warning'));
        },
        {writer: null},
      );
      expect(prod.update).not.toBeNull();
      expect(prod.warnings.map(w => [w.code, w.message])).toEqual([
        ['@lexical/y/editor-warning', 'a production warning'],
      ]);
      expect(reported.map(w => w.message)).toEqual([
        'a warning',
        'a production warning',
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
    // Without onWarn: console.warn outside production.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    editYState(
      state,
      config,
      () => {
        $getEditor()._onWarn(new Error('to the console'));
      },
      {writer: null},
    );
    expect(warn).toHaveBeenCalledWith('to the console');
    // The reason a document is read only is reported, with the binding's
    // code.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    doc.get('lexical-y').setAttr(`lexical-y:${LAYOUT_VERSION + 1}`, true);
    const readOnly: LexicalWarning[] = [];
    const refused = caught(() =>
      readYState(
        Y.encodeStateAsUpdate(doc),
        {...config, onWarn: warning => readOnly.push(warning)},
        $describe,
      ),
    );
    expect(refused.code).toBe('read-only');
    expect(readOnly.map(w => w.code)).toEqual([
      '@lexical/y/unsupported-layout',
    ]);
    expect(readOnly[0].data).toEqual({
      found: LAYOUT_VERSION + 1,
      reason: 'newer',
      supported: LAYOUT_VERSION,
    });
    expect(readOnly[0].message).toBe(
      `layout ${LAYOUT_VERSION + 1} is newer than ${LAYOUT_VERSION}. A newer version of the binding wrote this document, so this editor is read only: upgrade the binding on every client of the document`,
    );
    // The error carries the same warning, as data.
    expect(refused.warnings).toEqual([readOnly[0]]);
  });

  test("the binding's own updates are part of the edit, not left for later", async () => {
    // A new item at the front of a list. Whatever the binding still has to
    // do after an edit (in a client, its own updates wait for the editor to
    // be idle, in a microtask) is done before the helper returns.
    const state = seedYState(config, () => {
      const list = $createListNode('number');
      for (const text of ['a', 'b']) {
        list.append($createListItemNode().append($createTextNode(text)));
      }
      $getRoot().append(list);
    });
    const opened = openHeadlessYEditor({...config, state}, true);
    try {
      opened.runUpdate(() => {
        const list = $assertNodeType(
          $getRoot().getFirstChildOrThrow(),
          $isListNode,
        );
        list.getFirstChildOrThrow().insertBefore($createListItemNode());
      });
      const writes = opened.writes.length;
      let commits = 0;
      const stop = opened.handle.editor.registerUpdateListener(() => {
        commits++;
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      stop();
      // Nothing was left to commit or write after the edit returned.
      expect(commits).toBe(0);
      expect(opened.writes.length).toBe(writes);
      expect(opened.handle.editor.read($describe)).toBe(
        'list[number](listitem() listitem("a") listitem("b"))',
      );
    } finally {
      opened.handle.dispose();
    }
  });

  test('listeners that never stop scheduling updates are reported', () => {
    // Every committed update schedules another that changes the document,
    // so the follow-ups never run out.
    const tickState = createState('tick', {
      parse: v => (typeof v === 'number' ? v : 0),
    });
    let scheduled = 0;
    const Endless = defineExtension({
      name: 'test-endless',
      nodes: NODES,
      register: editor =>
        editor.registerUpdateListener(() => {
          scheduled++;
          editor.update(() => {
            const first = $getRoot().getFirstChild();
            if (first !== null) {
              $setState(first, tickState, scheduled);
            }
          });
        }),
    });
    const endless = {extensions: [Endless], schemaVersion: 1, selfCheck: true};
    // Seeding: the binding does not write yet, so each update a listener
    // schedules stays pending until the helper commits it, up to the cap.
    const seeded: LexicalWarning[] = [];
    const seededState = seedYState(
      {...endless, onWarn: warning => seeded.push(warning)},
      () => $getRoot().append($p('a')),
    );
    expect(readYState(seededState, config, $describe)).toBe('paragraph("a")');
    // Once for opening and once for the content; each stops after the cap.
    // Then `initialize()` reads the written seed back while the binding
    // writes, so the listener's updates commit at once and Lexical's own
    // guard stops them (an editor warning).
    expect(seeded.map(w => w.code)).toEqual([
      '@lexical/y/follow-ups-exhausted',
      '@lexical/y/follow-ups-exhausted',
      '@lexical/y/editor-warning',
    ]);
    expect(seeded[0].data).toEqual({limit: MAX_FOLLOW_UPS});
    expect(seeded[0].message).toContain(`${MAX_FOLLOW_UPS} follow-up`);
    expect(seeded[0].message).toContain(
      'have it write only what is missing, values that stay the same when it runs again',
    );
    expect(seeded[2].message).toContain('endlessly enqueueing');
    // Bounded: opening's and the content's update, each with its
    // follow-ups, then the read of the seed, stopped by Lexical's guard.
    expect(scheduled).toBeLessThan(150);
    // Editing: while the binding writes, an update that changes content
    // made after a commit in the same task (the one the listener schedules)
    // commits at once, so Lexical's own guard stops the listener (an editor
    // warning).
    scheduled = 0;
    const state = seed('a');
    const reported: LexicalWarning[] = [];
    const {update, warnings} = editYState(
      state,
      {...endless, onWarn: warning => reported.push(warning)},
      () => $getRoot().append($p('b')),
      {writer: null},
    );
    // The edit itself goes through.
    expect(update).not.toBeNull();
    const next = Y.mergeUpdates([state, update!] as Uint8Array<ArrayBuffer>[]);
    expect(readYState(next, config, $describe)).toBe(
      'paragraph("a") / paragraph("b")',
    );
    // Once for opening and once for the edit.
    expect(warnings.map(w => w.code)).toEqual([
      '@lexical/y/editor-warning',
      '@lexical/y/editor-warning',
    ]);
    expect(warnings[0].message).toContain('endlessly enqueueing');
    expect(reported).toEqual(warnings);
    // Listeners that settle are not reported.
    expect(
      editYState(state, bidConfig, () => $getRoot().append($p('b')), {
        writer: null,
      }).warnings,
    ).toEqual([]);
  });

  test('a seed merged next to an older layout converts the document', () => {
    // A stored document with content in the @lexical/yjs (v2) root.
    const legacy = new Y.Doc();
    legacy.get('root-v2').insert(0, [new Y.Node('paragraph')]);
    const stored = Y.encodeStateAsUpdate(legacy);
    // A client does not initialize it (it would hide the old content).
    const blocked = createYDoc();
    Y.applyUpdate(blocked, stored);
    const codes: string[] = [];
    const editor = buildEditorFromExtensions(
      defineExtension({
        name: 'client',
        nodes: NODES,
        onWarn: warning =>
          codes.push(warning instanceof LexicalWarning ? warning.code : ''),
      }),
    );
    const binding = new YBinding(editor, blocked, {
      schemaVersion: 1,
      selfCheck: true,
    });
    binding.start();
    binding.initialize();
    expect(binding.status).toBe('readonly');
    expect(codes).toEqual(['@lexical/y/unsupported-layout']);
    binding.dispose();
    editor.dispose();
    // The converter loads the old document into an editor (here, content
    // it holds), seeds that content and merges the seed into the stored
    // document.
    const source = buildEditorFromExtensions(
      defineExtension({name: 'source', nodes: NODES}),
    );
    source.update(() => $getRoot().clear().append($p('converted')), {
      discrete: true,
    });
    const json = source.getEditorState().toJSON();
    source.dispose();
    const converted = Y.mergeUpdates([
      stored,
      seedYState(config, () => {
        for (const child of json.root.children) {
          $getRoot().append($parseSerializedNode(child));
        }
      }),
    ] as Uint8Array<ArrayBuffer>[]);
    expect(readYState(converted, config, $describe)).toBe(
      'paragraph("converted")',
    );
    // The old root is left as it was.
    const after = new Y.Doc();
    Y.applyUpdate(after, converted);
    expect(after.get('root-v2').toString()).toBe(
      legacy.get('root-v2').toString(),
    );
  });

  test('extensions define the editor', () => {
    const state = seedYState(
      {
        extensions: [{dependencies: [], name: 'app', nodes: NODES}],
        schemaVersion: 1,
      },
      () => {
        $getRoot().append(
          $createHeadingNode('h1').append($createTextNode('Title')),
          $createParagraphNode(),
        );
      },
    );
    expect(readYState(state, config, $describe)).toBe(
      'heading[h1]("Title") / paragraph()',
    );
  });
});
