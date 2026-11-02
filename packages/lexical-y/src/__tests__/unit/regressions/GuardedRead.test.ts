/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Every read of the binding goes through one fail-closed entry point
// (YBinding#guardedRead). These cases pin what it owns beyond the read
// itself: the local updates it commits before the read, a recovery that
// runs after the update the read is nested in, and a read that runs after
// the binding failed closed. Each case is named after its finding.

import * as Y from '@y/y';
import {$createTextNode, $getRoot, type LexicalEditor} from 'lexical';
import {afterEach, describe, expect, test, vi} from 'vitest';

import {Reader} from '../../../internal/Read';
import {
  $block,
  $createBoxNode,
  $p,
  $selectIn,
  BoxNode,
  flush,
  freshReader,
  NODES,
  Peer,
  setup,
} from '../../utils/harness';

/** A network of its own, for a peer the case connects by hand. */
const network = (): ConstructorParameters<typeof Peer>[1] => ({
  delivery: 'causal',
  peers: [],
  pumping: false,
  queue: [],
});

/**
 * Run every microtask as usual, and collect what those that throw threw
 * (an error the binding rethrows in a microtask, which would otherwise be
 * an uncaught error).
 */
function catchMicrotasks(): unknown[] {
  const caught: unknown[] = [];
  const original = globalThis.queueMicrotask.bind(globalThis);
  vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(fn =>
    original(() => {
      try {
        fn();
      } catch (error) {
        caught.push(error);
      }
    }),
  );
  return caught;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const LINE = 't1z t2z t3z t4z t5z t6z t7z t8z t9z';

function $selectWord(word: string) {
  const at = $block([0]).getTextContent().indexOf(word);
  return $selectIn([0], at, at + word.length);
}

describe('N4: a throw committing the updates pending before a read reaches no provider', () => {
  /**
   * A deletes `t2z` while B, offline, bolds `t7z` in an update still
   * pending when A's change arrives; `arm` makes the commit of B's update
   * throw. Requires: nothing thrown into the sync, B reads A's change, the
   * app's error is rethrown in a microtask, and B's next edit lands where B
   * made it, on every client.
   */
  async function run(
    arm: (b: Peer, error: Error) => void,
    onError: 'rethrows' | 'reports',
  ) {
    const t = await setup(() => $getRoot().append($p(LINE), $p('tail')));
    if (onError === 'reports') {
      t.b.editor._onError = e => void t.b.errors.push(e);
    }
    t.offline();
    t.a.update(() => void $selectWord('t2z').removeText());
    t.b.editor.update(() => void $selectWord('t7z').formatText('bold'));
    const error = new Error('app failure');
    arm(t.b, error);
    const caught = catchMicrotasks();
    await expect(t.sync()).resolves.toBeUndefined();
    expect(caught).toContain(error);
    expect(t.b.binding.status).toBe('active');
    expect(t.b.describe()).toBe((await freshReader(t.a)).describe());
    expect(t.b.describe()).not.toContain('t2z');
    t.b.update(() => void $selectWord('t5z').removeText());
    await t.sync();
    const fresh = await freshReader(t.a);
    expect(t.a.describe()).toBe(fresh.describe());
    expect(t.b.describe()).toBe(fresh.describe());
    expect(fresh.read(() => $getRoot().getTextContent())).toBe(
      't1z  t3z t4z  t6z t7z t8z t9z\n\ntail',
    );
  }

  describe.each(['rethrows', 'reports'] as const)('onError %s', onError => {
    test('N4: an update listener of the app throws on that commit', async () => {
      await run((b, error) => {
        let armed = true;
        b.editor.registerUpdateListener(() => {
          if (armed) {
            armed = false;
            throw error;
          }
        });
      }, onError);
    });
  });

  test('N4: an update an app listener queues throws, and onError rethrows', async () => {
    await run((b, error) => {
      let armed = true;
      b.editor.registerUpdateListener(() => {
        if (armed) {
          armed = false;
          b.editor.update(() => {
            $selectWord('t9z').removeText();
            throw error;
          });
        }
      });
    }, 'rethrows');
  });
});

describe('N5: a recovery nested in an update settles on the rebuild it runs', () => {
  /** Make every read of the reader throw, until restored. */
  function failEveryRead(): () => void {
    const proto = Reader.prototype;
    const {$apply, $readFull} = proto;
    proto.$apply = () => {
      throw new Error('reader failure');
    };
    proto.$readFull = () => {
      throw new Error('reader failure');
    };
    return () => {
      proto.$apply = $apply;
      proto.$readFull = $readFull;
    };
  }

  test.each(['a remote change', 'an undo'] as const)(
    'N5: %s read inside an app update, whose recovery fails too, fails closed',
    async entry => {
      const t = await setup(() => $getRoot().append($p('hello')));
      let update = new Uint8Array();
      if (entry === 'a remote change') {
        t.offline();
        t.b.update(() => void $block([0]).append($createTextNode(' remote')));
        update = Y.encodeStateAsUpdate(t.b.doc, Y.encodeStateVector(t.a.doc));
      } else {
        t.a.update(() => void $block([0]).append($createTextNode(' local')));
        expect(t.a.binding.undoManager!.canUndo()).toBe(true);
      }
      const shown = t.a.describe();
      const restore = failEveryRead();
      try {
        expect(() =>
          t.a.editor.update(
            () => {
              if (entry === 'a remote change') {
                Y.applyUpdate(t.a.doc, update);
              } else {
                t.a.binding.undo();
              }
            },
            {discrete: true},
          ),
        ).not.toThrow();
        await flush();
      } finally {
        restore();
      }
      expect(t.a.binding.status).toBe('readonly');
      expect(t.a.describe()).toBe(shown);
      expect(t.a.errors).toEqual([]);
      expect(t.a.warnings).toEqual([
        'the document cannot be read: reader failure. This editor is read only until it is built again: data.error holds what the read threw; fix that, then reload the editor',
      ]);
    },
  );

  test('N5: a remote change read inside an app update, recovered: warned once the rebuild committed', async () => {
    const t = await setup(() => $getRoot().append($p('hello')));
    t.offline();
    t.b.update(() => void $block([0]).append($createTextNode(' remote')));
    const update = Y.encodeStateAsUpdate(t.b.doc, Y.encodeStateVector(t.a.doc));
    const proto = Reader.prototype;
    const {$apply} = proto;
    proto.$apply = () => {
      throw new Error('reader failure');
    };
    const shownAtWarning: string[] = [];
    t.a.editor._onWarn = w => {
      shownAtWarning.push(`${(w as Error).message}: ${t.a.describe()}`);
    };
    try {
      t.a.editor.update(() => Y.applyUpdate(t.a.doc, update), {
        discrete: true,
      });
      await flush();
    } finally {
      proto.$apply = $apply;
    }
    expect(t.a.binding.status).toBe('active');
    expect(t.a.describe()).toBe('paragraph("hello remote")');
    expect(shownAtWarning).toEqual([
      'a remote change could not be read: reader failure: paragraph("hello remote")',
    ]);
  });
});

describe('N6: a read admitted before the binding failed closed reads nothing after it', () => {
  test('N6: a remote change an update listener applies while a failing read of the whole document waits', async () => {
    const author = new Peer(2, network());
    author.update(() =>
      $getRoot()
        .clear()
        .append($p('hello'), $createBoxNode('t').append($p('inside'))),
    );
    author.binding.initialize();
    await flush();
    // A reader without the box class: read only, still reading what changes.
    const reader = new Peer(
      1,
      network(),
      NODES.filter(k => k !== BoxNode),
    );
    Y.applyUpdate(reader.doc, Y.encodeStateAsUpdate(author.doc));
    reader.binding.initialize();
    await flush();
    expect(reader.binding.status).toBe('readonly');
    // A layout record this reader reads, which makes it read the whole
    // document again, and a content change after it.
    const seen = Y.encodeStateVector(reader.doc);
    author.doc.transact(() =>
      (author.doc.get('lexical-y') as Y.Node).setAttr('lexical-y:2', true),
    );
    const layout = Y.encodeStateAsUpdate(author.doc, seen);
    const afterLayout = Y.encodeStateVector(author.doc);
    author.update(() => void $block([0]).append($createTextNode(' remote')));
    await flush();
    const content = Y.encodeStateAsUpdate(author.doc, afterLayout);
    const shown = reader.describe();
    // The whole read fails once (the binding fails closed); before that
    // settles, an update listener applies the content change.
    const proto = Reader.prototype;
    const {$readFull} = proto;
    let failed = false;
    proto.$readFull = function (this: Reader, ...args) {
      if (!failed && this.state.doc === reader.doc) {
        failed = true;
        throw new Error('reader failure');
      }
      return $readFull.apply(this, args);
    };
    let applied = false;
    const off = reader.editor.registerUpdateListener(() => {
      if (failed && !applied) {
        applied = true;
        Y.applyUpdate(reader.doc, content);
      }
    });
    try {
      expect(() =>
        reader.editor.update(() => Y.applyUpdate(reader.doc, layout), {
          discrete: true,
        }),
      ).not.toThrow();
      await flush();
    } finally {
      off();
      proto.$readFull = $readFull;
    }
    expect(applied).toBe(true);
    expect(reader.warnings).toContain(
      'the document cannot be read: reader failure. This editor is read only until it is built again: data.error holds what the read threw; fix that, then reload the editor',
    );
    expect(reader.binding.status).toBe('readonly');
    expect(reader.describe()).toBe(shown);
    expect(shown).not.toContain('remote');
  });
});

describe('R2-1: a read runs only once no local update is pending or queued', () => {
  /**
   * A deletes the first character while B, offline, has a bold edit
   * pending; `arm` makes B's listeners queue local updates on that commit.
   */
  async function run(arm: (b: Peer) => void) {
    const t = await setup(() =>
      $getRoot().append($p('alpha beta gamma'), $p('tail')),
    );
    t.offline();
    t.a.update(() => void $selectIn([0], 0, 1).removeText());
    t.b.editor.update(() => void $selectWord('beta').formatText('bold'));
    arm(t.b);
    const caught = catchMicrotasks();
    await expect(t.sync()).resolves.toBeUndefined();
    await t.sync();
    const fresh = await freshReader(t.a);
    expect(t.b.binding.status).toBe('active');
    expect(t.a.describe()).toBe(fresh.describe());
    expect(t.b.describe()).toBe(fresh.describe());
    return {b: t.b, caught, fresh};
  }

  test('R2-1: an update listener queues a local update, then throws', async () => {
    const error = new Error('app failure');
    const {caught, fresh} = await run(b => {
      let armed = true;
      b.editor.registerUpdateListener(() => {
        if (armed) {
          armed = false;
          b.editor.update(() => void $getRoot().append($p('queued edit')));
          throw error;
        }
      });
    });
    expect(caught).toEqual([error]);
    expect(fresh.describe()).toContain('lpha');
    expect(fresh.describe()).not.toContain('alpha');
    expect(fresh.describe()).toContain('paragraph("queued edit")');
  });

  test('R2-1: listeners that queue local updates past the commits a read makes first: recovered, every update written', async () => {
    const {b, caught, fresh} = await run(peer => {
      // Each commit's listener queues the next update and throws, so that
      // each update waits for a commit of its own.
      let left = 20;
      peer.editor.registerUpdateListener(({tags}) => {
        if (left > 0 && !tags.has('collaboration')) {
          const n = left--;
          peer.editor.update(() => void $getRoot().append($p(`queued ${n}`)));
          throw new Error(`app failure ${n}`);
        }
      });
    });
    expect(caught).toHaveLength(20);
    for (let n = 1; n <= 20; n++) {
      expect(fresh.describe()).toContain(`paragraph("queued ${n}")`);
    }
    expect(b.warnings).toEqual([
      'a remote change could not be read: local updates were still pending after 16 commits',
    ]);
  });
});

describe('R3-1: local updates a recovery commits are written on the document the editor shows', () => {
  test('R3-1: listeners that queue local deletions past the commits a read makes first, while a remote insert waits', async () => {
    const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
    const t = await setup(() => $getRoot().append($p(ALPHABET)));
    t.offline();
    t.a.update(() => void $selectIn([0], 0).insertText('!'));
    // B deletes its first character 20 times: once pending when A's insert
    // arrives, then from a listener of each commit that queues the next
    // deletion and throws, so that each waits for a commit of its own (past
    // the 16 a read commits first).
    let left = 19;
    t.b.editor.registerUpdateListener(({tags}) => {
      if (left > 0 && !tags.has('collaboration')) {
        left--;
        t.b.editor.update(() => void $selectIn([0], 0, 1).removeText());
        throw new Error('app failure');
      }
    });
    t.b.editor.update(() => void $selectIn([0], 0, 1).removeText());
    const caught = catchMicrotasks();
    await expect(t.sync()).resolves.toBeUndefined();
    await t.sync();
    expect(caught).toHaveLength(19);
    expect(left).toBe(0);
    expect(t.b.warnings).toEqual([
      'a remote change could not be read: local updates were still pending after 16 commits',
    ]);
    const fresh = await freshReader(t.a);
    // As if the two edits had met concurrently: A's insert kept, B's 20
    // deletions applied to B's own text.
    const expected = `paragraph("!${ALPHABET.slice(20)}")`;
    expect(fresh.describe()).toBe(expected);
    expect(t.a.describe()).toBe(expected);
    expect(t.b.describe()).toBe(expected);
    expect(t.b.binding.status).toBe('active');
  });
});

describe('R-1: an update listener of the app that throws on the commit of a read leaves the read standing', () => {
  test.each(
    [1, 2, 3, Infinity].flatMap(n => [
      [n, 'after'],
      [n, 'before'],
    ]),
  )(
    "R-1: it throws on %d commits while B reads A's insert (registered %s the binding's)",
    async (throws, order) => {
      let left = 0;
      let armed: LexicalEditor | null = null;
      const listener = (editor: LexicalEditor) =>
        editor.registerUpdateListener(() => {
          if (editor === armed && left > 0) {
            left--;
            throw new Error('app failure');
          }
        });
      const t = await setup(
        () => $getRoot().append($p('t1z t2z t3z'), $p('tail')),
        order === 'before' ? {prepare: listener} : {},
      );
      if (order === 'after') {
        listener(t.b.editor);
      }
      armed = t.b.editor;
      left = throws as number;
      const caught = catchMicrotasks();
      t.a.update(() => void $selectIn([0], 3).insertText(' one'));
      await t.sync();
      expect(t.b.warnings).toEqual([]);
      expect(t.b.binding.status).toBe('active');
      expect(t.b.describe()).toBe(
        'paragraph("t1z one t2z t3z") / paragraph("tail")',
      );
      expect(caught.length).toBeGreaterThan(0);
      left = 0;
      t.a.update(() => void $selectIn([1], 4).insertText(' two'));
      t.b.update(() => void $selectIn([0], 15).insertText(' three'));
      await t.sync();
      const expected =
        'paragraph("t1z one t2z t3z three") / paragraph("tail two")';
      expect(t.a.describe()).toBe(expected);
      expect(t.b.describe()).toBe(expected);
      expect((await freshReader(t.a)).describe()).toBe(expected);
    },
  );
});

describe("R-1: a binding that fails closed ends read only whatever the app's listeners throw", () => {
  test("R-1: a document B cannot read, and an update listener of B's that throws on every commit", async () => {
    const t = await setup(() => $getRoot().append($p('t1z t2z t3z')));
    let throwing = true;
    t.b.editor.registerUpdateListener(() => {
      if (throwing) {
        throw new Error('app failure');
      }
    });
    const proto = Reader.prototype;
    const {$apply, $readFull} = proto;
    proto.$apply = () => {
      throw new Error('reader failure');
    };
    proto.$readFull = () => {
      throw new Error('reader failure');
    };
    const caught = catchMicrotasks();
    try {
      t.a.update(() => void $selectIn([0], 3).insertText(' one'));
      await expect(t.sync()).resolves.toBeUndefined();
    } finally {
      proto.$apply = $apply;
      proto.$readFull = $readFull;
    }
    throwing = false;
    expect(t.b.binding.status).toBe('readonly');
    expect(caught.length).toBeGreaterThan(0);
    // B's next edit is refused, not written from what B no longer reads.
    const stored = Y.encodeStateVector(t.b.doc);
    t.b.update(() => void $selectIn([0], 0, 3).removeText());
    await t.sync();
    expect(Y.encodeStateVector(t.b.doc)).toEqual(stored);
    const expected = 'paragraph("t1z one t2z t3z")';
    expect(t.a.describe()).toBe(expected);
    expect((await freshReader(t.a)).describe()).toBe(expected);
  });
});

describe("R-1: a binding opened through the provider's sync becomes active whatever its first read's listeners throw", () => {
  test("R-1: opened through the provider's sync, an update listener that throws on the first read's commit: the binding becomes active and the edit is written", async () => {
    const author = new Peer(1, network());
    author.update(() => $getRoot().clear().append($p('hello')));
    author.binding.initialize();
    await flush();
    let left = 1;
    const reader = new Peer(2, network(), NODES, editor => {
      editor.registerUpdateListener(() => {
        if (left > 0) {
          left--;
          throw new Error('app failure');
        }
      });
    });
    const caught = catchMicrotasks();
    // No initialize(): the provider's first sync opens the document.
    expect(() =>
      Y.applyUpdate(reader.doc, Y.encodeStateAsUpdate(author.doc)),
    ).not.toThrow();
    await flush();
    expect(left).toBe(0);
    expect(reader.binding.status).toBe('active');
    expect(reader.editor.isEditable()).toBe(true);
    expect(reader.describe()).toBe('paragraph("hello")');
    expect(caught.length).toBeGreaterThan(0);
    reader.update(() => void $selectIn([0], 5).insertText(' world'));
    await flush();
    Y.applyUpdate(
      author.doc,
      Y.encodeStateAsUpdate(reader.doc, Y.encodeStateVector(author.doc)),
    );
    await flush();
    expect(author.describe()).toBe('paragraph("hello world")');
  });
});
