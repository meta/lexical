/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A generic set-valued NodeState (`arraySetValue`) on the places that store it
// one format per member (text, nodes stored as their own Y.Node) and on a
// line marker, which stores it whole.
// @vitest-environment node

import * as Y from '@y/y';
import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $getWritableNodeState,
  $isDecoratorNode,
  $isTextNode,
  $setState,
  arraySetValue,
  createEditor,
  createState,
  type LexicalEditor,
  type LexicalNode,
  type StateConfig,
  stringValue,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YBinding} from '../..';
import {editYState, readYState, seedYState} from '../../headless';
import {Writer} from '../../internal/Write';
import {
  $createEquation,
  $p,
  $selectIn,
  expectConverged,
  freshReader,
  NODES,
  type Peer,
  setup,
  WidgetNode,
} from '../utils/harness';

const tagsState = createState('tags', {parse: arraySetValue(stringValue())});
// Not a member entry of `tags`: a value state whose key contains U+001F.
const lookalikeState = createState('tags\u001fx', {
  parse: (v: unknown) => (typeof v === 'string' ? v : ''),
});
// The same name as a boolean, which a member entry's value looks like.
const lookalikeFlagState = createState('tags\u001fx', {
  parse: (v: unknown) => v === true,
});
// A set whose own key contains U+001F is stored whole.
const separatorSetState = createState('odd\u001fset', {
  parse: arraySetValue(stringValue()),
});

/** Register `states` on the node types used here, as an extension would */
function register(
  editor: LexicalEditor,
  states: readonly StateConfig<string, unknown>[],
): void {
  editor.update(
    () => {
      for (const node of [
        $createTextNode(),
        $createParagraphNode(),
        $create(WidgetNode),
        $createEquation(''),
      ]) {
        $getWritableNodeState(node);
        for (const state of states) {
          $getState(node, state);
        }
      }
    },
    {discrete: true},
  );
}

function prepare(editor: LexicalEditor): void {
  register(editor, [
    tagsState as StateConfig<string, unknown>,
    separatorSetState as StateConfig<string, unknown>,
  ]);
}

/** With a state named like a member entry of `tags` too (refused). */
function prepareLookalike(editor: LexicalEditor): void {
  register(editor, [
    tagsState as StateConfig<string, unknown>,
    lookalikeState as StateConfig<string, unknown>,
  ]);
}

function $tag(node: LexicalNode, tag: string, on = true): void {
  $setState(node, tagsState, prev =>
    on ? [...prev, tag] : prev.filter(t => t !== tag),
  );
}

/** The value read back is the canonical frozen array: sorted, no duplicates */
function expectCanonical(value: readonly string[]): void {
  expect(Object.isFrozen(value)).toBe(true);
  expect(value).toEqual(Array.from(new Set(value)).sort());
}

/** Every node of the document in order, with its tags */
function tags(peer: Peer): string {
  return peer.read(() => {
    const out: string[] = [];
    const visit = (node: LexicalNode) => {
      const value = $getState(node, tagsState);
      expectCanonical(value);
      out.push(`${node.getType()}[${value}]`);
      if ('getChildren' in node && typeof node.getChildren === 'function') {
        (node.getChildren() as LexicalNode[]).forEach(visit);
      }
    };
    $getRoot().getChildren().forEach(visit);
    return out.join(' ');
  });
}

/**
 * Every NodeState key in the root sequence, by where it is stored: `text`
 * (text formats), `¶` (line markers), or the stored node's name.
 */
function storedStateKeys(peer: Peer): Record<string, string[]> {
  const keys: Record<string, Set<string>> = {};
  const add = (where: string, attrs: Record<string, unknown> | undefined) => {
    for (const key of Object.keys(attrs || {})) {
      if (key.startsWith('s:')) {
        (keys[where] = keys[where] || new Set()).add(key);
      }
    }
  };
  // Through JSON text: nested nodes are plain only once stringified.
  const delta = JSON.parse(JSON.stringify(peer.binding.root.toDelta()));
  const children = delta.children as {
    insert?: unknown;
    format?: Record<string, unknown>;
  }[];
  for (const child of children) {
    if (typeof child.insert === 'string') {
      add('text', child.format);
    } else if (Array.isArray(child.insert)) {
      for (const node of child.insert as {
        name: string;
        attrs?: Record<string, unknown>;
      }[]) {
        add(node.name, node.attrs);
      }
    }
  }
  const out: Record<string, string[]> = {};
  for (const where of Object.keys(keys).sort()) {
    out[where] = Array.from(keys[where]).sort();
  }
  return out;
}

const $init = () => {
  $getRoot().append($p('ab').append($createEquation('x')), $create(WidgetNode));
};

const $leaves = () => {
  const [paragraph, widget] = $getRoot().getChildren();
  const [text, equation] = (
    paragraph as unknown as {getChildren(): LexicalNode[]}
  ).getChildren();
  if (!$isTextNode(text) || !$isDecoratorNode(equation)) {
    throw new Error('unexpected document');
  }
  return {equation, paragraph, text, widget};
};

describe.each([[[1, 2]], [[2, 1]]])('arraySetValue state, ids %j', ids => {
  test('concurrent additions merge on text and stored nodes', async () => {
    const t = await setup($init, {ids, prepare});
    t.offline();
    // Each peer adds the member the other would sort after, so the members
    // are read back out of order and the state's parse sorts them
    t.a.update(() => {
      const {equation, text, widget} = $leaves();
      [text, equation, widget].forEach(n => $tag(n, 'b'));
    });
    t.b.update(() => {
      const {equation, text, widget} = $leaves();
      [text, equation, widget].forEach(n => $tag(n, 'a'));
    });
    await t.sync();
    await expectConverged(t.peers);
    for (const peer of t.peers) {
      expect(tags(peer)).toBe(
        'paragraph[] text[a,b] test_equation[a,b] test_widget[a,b]',
      );
      const members = ['s:tags\u001fa', 's:tags\u001fb'];
      expect(storedStateKeys(peer)).toEqual({
        'b:test_widget': members,
        'i:test_equation': members,
        text: members,
      });
      expect(peer.warnings).toEqual([]);
    }
  });

  test('a removal and a concurrent addition both apply', async () => {
    const t = await setup(
      () => {
        $init();
        const {equation, text, widget} = $leaves();
        [text, equation, widget].forEach(n => $tag(n, 'a'));
      },
      {ids, prepare},
    );
    t.offline();
    t.a.update(() => {
      const {equation, text, widget} = $leaves();
      [text, equation, widget].forEach(n => $tag(n, 'a', false));
    });
    t.b.update(() => {
      const {equation, text, widget} = $leaves();
      [text, equation, widget].forEach(n => $tag(n, 'c'));
    });
    await t.sync();
    await expectConverged(t.peers);
    for (const peer of t.peers) {
      expect(tags(peer)).toBe(
        'paragraph[] text[c] test_equation[c] test_widget[c]',
      );
    }
  });

  test('a paragraph stores the set as one value', async () => {
    const t = await setup($init, {ids, prepare});
    t.offline();
    t.a.update(() => $tag($leaves().paragraph, 'a'));
    t.b.update(() => $tag($leaves().paragraph, 'b'));
    await t.sync();
    await expectConverged(t.peers);
    const result = tags(t.a);
    expect([
      'paragraph[a] text[] test_equation[] test_widget[]',
      'paragraph[b] text[] test_equation[] test_widget[]',
    ]).toContain(result);
    for (const peer of t.peers) {
      expect(tags(peer)).toBe(result);
      expect(storedStateKeys(peer)).toEqual({'¶': ['s:tags']});
    }
  });
});

describe('keys that contain U+001F', () => {
  test('a state named like a member entry of a set is refused', async () => {
    // `tags\u001fx` is the name of the entry of member `x` of `tags`: storing
    // both would write one attribute for two values.
    const t = await setup($init, {prepare: prepareLookalike});
    expect(() =>
      t.a.update(() => {
        const {text} = $leaves();
        $tag(text, 'x');
        $setState(text, lookalikeState, 'v');
      }),
    ).toThrow(
      '@lexical/y: the NodeState key "tags\\u001fx" has the name of a member entry of the set-valued state "tags"',
    );
    await t.sync();
    for (const peer of t.peers) {
      expect(storedStateKeys(peer)).toEqual({});
    }
  });

  test('a state named like a member entry is refused even without a value', async () => {
    // Registered on every client but never set: a reader that knows it reads
    // the entry of member `x` as that state, and drops `x` from the set.
    const t = await setup($init, {prepare: prepareLookalike});
    expect(() =>
      t.a.update(() => {
        const {text} = $leaves();
        $tag(text, 'x');
        $tag(text, 'y');
      }),
    ).toThrow(
      '@lexical/y: the NodeState key "tags\\u001fx" has the name of a member entry of the set-valued state "tags"',
    );
    await t.sync();
    for (const peer of t.peers) {
      expect(storedStateKeys(peer)).toEqual({});
    }
  });

  test('a value state stored by a client that has no set of that name is read as itself', async () => {
    // The first client knows only the value state, so it stores it (all
    // clients should register the same states). The others know `tags` too,
    // and read the entry as the value state they also know, not as a member.
    let created = 0;
    const t = await setup($init, {
      prepare: editor => {
        const states: StateConfig<string, unknown>[] =
          created++ === 0
            ? [lookalikeFlagState as StateConfig<string, unknown>]
            : [
                tagsState as StateConfig<string, unknown>,
                lookalikeFlagState as StateConfig<string, unknown>,
              ];
        editor.update(
          () => {
            const text = $createTextNode();
            $getWritableNodeState(text);
            for (const state of states) {
              $getState(text, state);
            }
          },
          {discrete: true},
        );
      },
    });
    t.a.update(() => $setState($leaves().text, lookalikeFlagState, true));
    await t.sync();
    expect(storedStateKeys(t.a)).toEqual({text: ['s:tags\u001fx']});
    t.b.read(() => {
      const {text} = $leaves();
      expect($getState(text, lookalikeFlagState)).toBe(true);
      expect($getState(text, tagsState)).toEqual([]);
    });
    // A structural edit makes the self-check read the whole container again
    // with a fresh editor, which must know the value state as well.
    t.b.update(() => $getRoot().append($p('more')));
    await t.sync();
    await expectConverged(t.peers);
    for (const peer of t.peers) {
      expect(peer.warnings).toEqual([]);
    }
  });

  test('a set-valued state is stored whole', async () => {
    const t = await setup($init, {prepare});
    t.a.update(() =>
      $setState($leaves().text, separatorSetState, ['b', 'a', 'a']),
    );
    await t.sync();
    for (const peer of t.peers) {
      expect(storedStateKeys(peer)).toEqual({text: ['s:odd\u001fset']});
      peer.read(() => {
        const value = $getState($leaves().text, separatorSetState);
        expectCanonical(value);
        expect(value).toEqual(['a', 'b']);
      });
      expect(peer.warnings).toEqual([]);
    }
  });
});

// A set-valued state used the usual way: `createState`, then `$getState` and
// `$setState`, with nothing registered before the binding reads the document.
// A client's first `$getState` or `$setState` registers the state for the
// node type, which can happen after it read nodes that hold the set.
describe.each([[[1, 2]], [[2, 1]]])(
  'a set used without registration, ids %j',
  ids => {
    const $text = () => $leaves().text;
    const read = (peer: Peer) =>
      peer.read(() => [...$getState($text(), tagsState)]);

    test('a client that starts using the set after it read the document reads the members, and its writes keep them', async () => {
      const t = await setup($init, {ids});
      // Only a has used the state.
      t.a.update(() => $tag($text(), 'a'));
      await t.sync();
      expect(storedStateKeys(t.a)).toEqual({text: ['s:tags\u001fa']});
      // b read the text before it knew the state: its first read of the state
      // gets the member.
      expect(read(t.b)).toEqual(['a']);
      // b types in the tagged text, then adds a member and removes one.
      t.b.update(() => $selectIn([0], 1).insertText('!'));
      await t.sync();
      t.b.update(() => $tag($text(), 'b'));
      await t.sync();
      for (const peer of t.peers) {
        expect(read(peer)).toEqual(['a', 'b']);
        expect(peer.read(() => $text().getTextContent())).toBe('a!b');
      }
      t.b.update(() => $tag($text(), 'a', false));
      await t.sync();
      await expectConverged(t.peers);
      for (const peer of t.peers) {
        expect(read(peer)).toEqual(['b']);
        expect(storedStateKeys(peer)).toEqual({text: ['s:tags\u001fb']});
        expect(peer.errors).toEqual([]);
        expect(peer.warnings).toEqual([]);
      }
      const fresh = await freshReader(t.a);
      expect(read(fresh)).toEqual(['b']);
    });

    test('concurrent changes merge when one client learned the set late', async () => {
      const t = await setup($init, {ids});
      t.a.update(() => $tag($text(), 'a'));
      await t.sync();
      t.offline();
      t.a.update(() => $tag($text(), 'c'));
      // b's first use of the state is its own change.
      t.b.update(() => $tag($text(), 'b'));
      await t.sync();
      await expectConverged(t.peers);
      for (const peer of t.peers) {
        expect(read(peer)).toEqual(['a', 'b', 'c']);
        expect(peer.warnings).toEqual([]);
      }
    });

    test('a client that never uses the set keeps its members', async () => {
      const t = await setup($init, {ids});
      t.a.update(() => $tag($text(), 'a'));
      await t.sync();
      // b edits the text without ever using the state.
      t.b.update(() => $selectIn([0], 2).insertText('?'));
      await t.sync();
      await expectConverged(t.peers);
      expect(read(t.a)).toEqual(['a']);
      for (const peer of t.peers) {
        expect(storedStateKeys(peer)).toEqual({text: ['s:tags\u001fa']});
        expect(peer.warnings).toEqual([]);
      }
    });
  },
);

test('the headless API seeds, reads and edits a set used without registration', () => {
  const config = {nodes: NODES, schemaVersion: 1, selfCheck: true};
  const $hText = () => {
    const text = $getRoot().getFirstDescendant();
    if (!$isTextNode(text)) {
      throw new Error('expected text');
    }
    return text;
  };
  const state = seedYState(config, () => {
    $getRoot().append($p('tagged'));
    $setState($hText(), tagsState, ['a']);
  });
  expect(
    readYState(state, config, () => [...$getState($hText(), tagsState)]),
  ).toEqual(['a']);
  const added = editYState(
    state,
    config,
    () => $setState($hText(), tagsState, prev => [...prev, 'b']),
    {writer: null},
  );
  expect(added.warnings).toEqual([]);
  expect(
    readYState(added.state, config, () => [...$getState($hText(), tagsState)]),
  ).toEqual(['a', 'b']);
  // An edit that does not use the state keeps the members.
  const typed = editYState(
    added.state,
    config,
    () => $hText().spliceText(0, 0, 'x'),
    {writer: null},
  );
  expect(typed.warnings).toEqual([]);
  expect(
    readYState(typed.state, config, () => [
      $hText().getTextContent(),
      ...$getState($hText(), tagsState),
    ]),
  ).toEqual(['xtagged', 'a', 'b']);
});

describe('a set-valued state whose key is empty', () => {
  const emptyState = createState('', {parse: arraySetValue(stringValue())});
  const prepareEmpty = (editor: LexicalEditor) => {
    editor.update(
      () => {
        for (const node of [
          $createTextNode(),
          $createLineBreakNode(),
          $create(WidgetNode),
          $createEquation(''),
        ]) {
          $getWritableNodeState(node);
          $getState(node, emptyState);
        }
      },
      {discrete: true},
    );
  };
  const $members = (): string[] => {
    const [paragraph, widget] = $getRoot().getChildren();
    const nodes = [
      ...(paragraph as unknown as {getChildren(): LexicalNode[]}).getChildren(),
      widget,
    ];
    return nodes.map(
      node => `${node.getType()}${JSON.stringify($getState(node, emptyState))}`,
    );
  };

  test('its members are joined on read', async () => {
    const t = await setup(
      () => {
        $getRoot().append(
          $p('ab').append($createLineBreakNode(), $createEquation('x')),
          $create(WidgetNode),
        );
      },
      {prepare: prepareEmpty},
    );
    const members = ['x', '', 'a\u001fb'];
    t.a.update(() => {
      const [paragraph, widget] = $getRoot().getChildren();
      for (const node of [
        ...(
          paragraph as unknown as {getChildren(): LexicalNode[]}
        ).getChildren(),
        widget,
      ]) {
        $setState(node, emptyState, members);
      }
    });
    await t.sync();
    await expectConverged(t.peers);
    const expected = [
      'text["","a\\u001fb","x"]',
      'linebreak["","a\\u001fb","x"]',
      'test_equation["","a\\u001fb","x"]',
      'test_widget["","a\\u001fb","x"]',
    ];
    for (const peer of t.peers) {
      expect(peer.read($members)).toEqual(expected);
      expect(peer.warnings).toEqual([]);
    }
    const fresh = await freshReader(t.a);
    expect(fresh.read($members)).toEqual(expected);
  });
});

describe('members that are not well-formed UTF-16', () => {
  // Yjs stores names as UTF-8, which turns a lone surrogate into U+FFFD: the
  // binding escapes such a member (and one that starts with U+001F) in the
  // entry's name, so it reads back exactly.
  const members = [
    '\ud800',
    '\ud801',
    '\udfff',
    '\ud83d\ude00',
    '\u001fz',
    'z',
  ];
  const $nodes = (): LexicalNode[] => {
    const [paragraph, widget] = $getRoot().getChildren();
    return [
      ...(paragraph as unknown as {getChildren(): LexicalNode[]}).getChildren(),
      widget,
    ];
  };
  const read = (peer: Peer) =>
    peer.read(() =>
      $nodes().map(
        node =>
          `${node.getType()}${JSON.stringify($getState(node, tagsState))}`,
      ),
    );

  test('are read back exactly on text, a line break and stored nodes', async () => {
    const t = await setup(
      () => {
        $getRoot().append(
          $p('ab').append($createLineBreakNode(), $createEquation('x')),
          $create(WidgetNode),
        );
      },
      {prepare},
    );
    t.a.update(() => {
      for (const node of $nodes()) {
        $setState(node, tagsState, members);
      }
    });
    await t.sync();
    await expectConverged(t.peers);
    const value = JSON.stringify([...members].sort());
    const expected = ['text', 'linebreak', 'test_equation', 'test_widget'].map(
      type => type + value,
    );
    for (const peer of t.peers) {
      expect(read(peer)).toEqual(expected);
      expect(peer.warnings).toEqual([]);
    }
    expect(read(await freshReader(t.a))).toEqual(expected);
  });
});

describe('the layout record', () => {
  const record = (doc: Y.Doc): string[] =>
    Object.keys(doc.get('lexical-y').getAttrs())
      .filter(key => key.startsWith('lexical-y:'))
      .sort();
  const docOf = (...updates: Uint8Array[]): Y.Doc => {
    const doc = new Y.Doc();
    for (const update of updates) {
      Y.applyUpdate(doc, update);
    }
    return doc;
  };
  const hasMember = (doc: Y.Doc, name: string): boolean =>
    JSON.stringify(doc.get('lexical-y').toDelta().toJSON()).includes(
      JSON.stringify(name).slice(1, -1),
    );

  test('the first member entry records layout 2 in its own update, and undo keeps it', async () => {
    const t = await setup($init, {prepare});
    // A set stored whole (on a line marker) is layout 1.
    t.a.update(() => $tag($leaves().paragraph, 'p'));
    await t.sync();
    for (const peer of t.peers) {
      expect(record(peer.doc)).toEqual(['lexical-y:1']);
    }
    const before = Y.encodeStateAsUpdate(t.a.doc);
    const updates: Uint8Array[] = [];
    const onUpdate = (update: Uint8Array) => {
      updates.push(update);
    };
    t.a.doc.on('update', onUpdate);
    t.a.update(() => $tag($leaves().text, 'a'));
    t.a.doc.off('update', onUpdate);
    // Each update applied on its own: the one that holds the member entry
    // holds the version too.
    const withMember = updates.filter(update =>
      hasMember(docOf(before, update), 's:tags\u001fa'),
    );
    expect(withMember.length).toBe(1);
    expect(record(docOf(before, withMember[0]))).toEqual([
      'lexical-y:1',
      'lexical-y:2',
    ]);
    await t.sync();
    for (const peer of t.peers) {
      expect(record(peer.doc)).toEqual(['lexical-y:1', 'lexical-y:2']);
    }
    // Undo removes the member, not the version.
    t.a.undo();
    await t.sync();
    await expectConverged(t.peers);
    for (const peer of t.peers) {
      expect(
        peer.read(() => [...$getState($leaves().text, tagsState)]),
      ).toEqual([]);
      expect(record(peer.doc)).toEqual(['lexical-y:1', 'lexical-y:2']);
      expect(peer.warnings).toEqual([]);
    }
  });

  test('the headless API records layout 2 with the first member entry only', () => {
    const config = {nodes: NODES, schemaVersion: 1, selfCheck: true};
    const $hText = () => {
      const text = $getRoot().getFirstDescendant();
      if (!$isTextNode(text)) {
        throw new Error('expected text');
      }
      return text;
    };
    const plain = seedYState(config, () => $getRoot().append($p('x')));
    expect(record(docOf(plain))).toEqual(['lexical-y:1']);
    const typed = editYState(
      plain,
      config,
      () => $hText().spliceText(0, 0, 'y'),
      {writer: null},
    );
    expect(record(docOf(typed.state))).toEqual(['lexical-y:1']);
    const tagged = editYState(
      typed.state,
      config,
      () => $setState($hText(), tagsState, ['a']),
      {writer: null},
    );
    expect(tagged.update).not.toBeNull();
    // The update alone carries the version with the member.
    expect(record(docOf(typed.state, tagged.update!))).toEqual([
      'lexical-y:1',
      'lexical-y:2',
    ]);
    const seeded = seedYState(config, () => {
      $getRoot().append($p('x'));
      $setState($hText(), tagsState, ['a']);
    });
    expect(record(docOf(seeded))).toEqual(['lexical-y:1', 'lexical-y:2']);
    expect(
      readYState(seeded, config, () => [...$getState($hText(), tagsState)]),
    ).toEqual(['a']);
  });

  // Yjs commits and sends what a transaction wrote even when its callback
  // throws: the version goes in the same transaction whatever happens.
  test('a write that throws part way still sends layout 2 with the member entries it wrote, in development and production', async () => {
    const env = process.env.NODE_ENV;
    const proto = Writer.prototype as unknown as {$run: () => void};
    const run = proto.$run;
    try {
      for (const nodeEnv of ['development', 'production']) {
        process.env.NODE_ENV = nodeEnv;
        const t = await setup($init, {prepare});
        const before = Y.encodeStateAsUpdate(t.a.doc);
        const updates: Uint8Array[] = [];
        const onUpdate = (update: Uint8Array) => {
          updates.push(update);
        };
        t.a.doc.on('update', onUpdate);
        // The write, and the rewrite that recovers from it, each write
        // everything, then throw.
        proto.$run = function (this: Writer) {
          run.call(this);
          throw new Error('simulated writer failure');
        };
        try {
          t.a.update(() => $tag($leaves().text, 'a'));
        } catch (_e) {
          // The rewrite's failure goes to the editor's onError, which
          // rethrows.
        } finally {
          proto.$run = run;
          t.a.doc.off('update', onUpdate);
        }
        expect(updates.length).toBeGreaterThan(0);
        const first = docOf(before, updates[0]);
        expect(hasMember(first, 's:tags\u001fa')).toBe(true);
        expect(record(first)).toEqual(['lexical-y:1', 'lexical-y:2']);
      }
    } finally {
      proto.$run = run;
      process.env.NODE_ENV = env;
    }
  });

  test('an initial write that throws part way sends nothing', () => {
    // A root inside another shared type is written as a seed built in a copy
    // of the document first (see YBinding#seedUpdate): a write that throws
    // there never reaches the document, so no member entry is sent without
    // layout 2.
    const doc = createYDoc();
    const root = new Y.Node('editor-root');
    doc.get('app').setAttr('editor', root);
    const editor = createEditor({
      nodes: NODES,
      onError: e => {
        throw e;
      },
    });
    prepare(editor);
    editor.update(
      () => {
        $init();
        $tag($leaves().text, 'a');
      },
      {discrete: true},
    );
    const binding = new YBinding(editor, doc, {root, schemaVersion: 1});
    binding.start();
    const updates: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array) => {
      updates.push(update);
    });
    const proto = Writer.prototype as unknown as {
      $writeContainer: (...args: unknown[]) => unknown;
    };
    const write = proto.$writeContainer;
    let depth = 0;
    // The outermost container is written in full, then the write throws.
    proto.$writeContainer = function (this: Writer, ...args: unknown[]) {
      depth++;
      const result = write.apply(this, args);
      depth--;
      if (depth === 0) {
        throw new Error('simulated writer failure');
      }
      return result;
    };
    try {
      expect(() => binding.initialize()).toThrow('simulated writer failure');
    } finally {
      proto.$writeContainer = write;
      binding.dispose();
    }
    expect(updates).toEqual([]);
    expect(root.length).toBe(0);
    expect(Object.keys(root.getAttrs())).toEqual([]);
  });
});
