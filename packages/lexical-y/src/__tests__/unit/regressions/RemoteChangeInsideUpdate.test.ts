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
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $onUpdate,
  COLLABORATION_TAG,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {expectConverged, freshReader, setup} from '../../utils/harness';

const APPLY = createCommand<Uint8Array>('APPLY_REMOTE');

async function twoPeers(gc: boolean) {
  const t = await setup(
    () =>
      $getRoot().append(
        $createParagraphNode().append($createTextNode('one two')),
      ),
    {gc},
  );
  t.offline();
  // A remote change: b bolds "one".
  t.b.update(() =>
    $getRoot().getAllTextNodes()[0].select(0, 3).formatText('bold'),
  );
  const delta = Y.encodeStateAsUpdate(t.b.doc, Y.encodeStateVector(t.a.doc));
  return {delta, t};
}

const $appendX = () =>
  $getRoot().getAllTextNodes().at(-1)!.selectEnd().insertText('X');

describe.each([false, true])(
  'a remote change applied during a local update, gc %s',
  gc => {
    test('inside editor.update, after a local edit', async () => {
      const {t, delta} = await twoPeers(gc);
      t.a.update(() => {
        $appendX();
        Y.applyUpdate(t.a.doc, delta, 'provider');
      });
      await t.sync();
      expect(t.a.read(() => $getRoot().getTextContent())).toBe('one twoX');
      await expectConverged(t.peers);
      expect((await freshReader(t.a)).describe()).toBe(t.a.describe());
    });

    test('inside editor.update, before a local edit', async () => {
      const {t, delta} = await twoPeers(gc);
      t.a.update(() => {
        Y.applyUpdate(t.a.doc, delta, 'provider');
        $appendX();
      });
      await t.sync();
      expect(t.a.read(() => $getRoot().getTextContent())).toBe('one twoX');
      await expectConverged(t.peers);
      expect((await freshReader(t.a)).describe()).toBe(t.a.describe());
    });

    test('in a node transform', async () => {
      const {t, delta} = await twoPeers(gc);
      let applied = false;
      t.a.editor.registerNodeTransform(TextNode, () => {
        if (!applied) {
          applied = true;
          Y.applyUpdate(t.a.doc, delta, 'provider');
        }
      });
      t.a.update(() => $appendX());
      await t.sync();
      expect(t.a.read(() => $getRoot().getTextContent())).toBe('one twoX');
      await expectConverged(t.peers);
      expect((await freshReader(t.a)).describe()).toBe(t.a.describe());
    });

    test('in a command dispatched inside editor.update', async () => {
      const {t, delta} = await twoPeers(gc);
      t.a.editor.registerCommand(
        APPLY,
        update => {
          Y.applyUpdate(t.a.doc, update, 'provider');
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      );
      t.a.update(() => {
        $appendX();
        t.a.editor.dispatchCommand(APPLY, delta);
      });
      await t.sync();
      expect(t.a.read(() => $getRoot().getTextContent())).toBe('one twoX');
      await expectConverged(t.peers);
      expect((await freshReader(t.a)).describe()).toBe(t.a.describe());
    });

    test('in an update listener after a local edit', async () => {
      const {t, delta} = await twoPeers(gc);
      let applied = false;
      t.a.editor.registerUpdateListener(() => {
        if (!applied) {
          applied = true;
          Y.applyUpdate(t.a.doc, delta, 'provider');
        }
      });
      t.a.update(() => $appendX());
      await t.sync();
      expect(t.a.read(() => $getRoot().getTextContent())).toBe('one twoX');
      await expectConverged(t.peers);
      expect((await freshReader(t.a)).describe()).toBe(t.a.describe());
    });

    test('between two queued updates', async () => {
      const {t, delta} = await twoPeers(gc);
      t.a.editor.update(() => $appendX());
      Y.applyUpdate(t.a.doc, delta, 'provider');
      t.a.editor.update(() => $appendX());
      await t.sync();
      expect(t.a.read(() => $getRoot().getTextContent())).toBe('one twoXX');
      await expectConverged(t.peers);
      expect((await freshReader(t.a)).describe()).toBe(t.a.describe());
    });

    test('inside a non-discrete editor.update', async () => {
      const {t, delta} = await twoPeers(gc);
      t.a.editor.update(() => {
        $appendX();
        Y.applyUpdate(t.a.doc, delta, 'provider');
      });
      await t.sync();
      expect(t.a.read(() => $getRoot().getTextContent())).toBe('one twoX');
      await expectConverged(t.peers);
      expect((await freshReader(t.a)).describe()).toBe(t.a.describe());
    });

    test('two remote changes inside one update, read in order', async () => {
      const {t, delta} = await twoPeers(gc);
      t.b.update(() =>
        $getRoot().getAllTextNodes().at(-1)!.selectEnd().insertText('!'),
      );
      const second = Y.encodeStateAsUpdate(
        t.b.doc,
        Y.encodeStateVector(t.a.doc),
      );
      t.a.update(() => {
        $appendX();
        Y.applyUpdate(t.a.doc, delta, 'provider');
        Y.applyUpdate(t.a.doc, second, 'provider');
      });
      await t.sync();
      expect(t.a.read(() => $getRoot().getTextContent())).toMatch(
        /^one two(X!|!X)$/,
      );
      await expectConverged(t.peers);
      expect((await freshReader(t.a)).describe()).toBe(t.a.describe());
    });

    test('an update that throws after the remote change is applied', async () => {
      const {t, delta} = await twoPeers(gc);
      expect(() =>
        t.a.editor.update(
          () => {
            $appendX();
            Y.applyUpdate(t.a.doc, delta, 'provider');
            throw new Error('app');
          },
          {discrete: true},
        ),
      ).toThrow('app');
      // The app's own error, which the test editor records.
      t.a.errors.length = 0;
      await t.sync();
      expect(t.a.read(() => $getRoot().getTextContent())).toBe('one two');
      await expectConverged(t.peers);
      expect((await freshReader(t.a)).describe()).toBe(t.a.describe());
    });

    test('the local edit undoes on its own', async () => {
      const {t, delta} = await twoPeers(gc);
      t.a.update(() => {
        $appendX();
        Y.applyUpdate(t.a.doc, delta, 'provider');
      });
      await t.sync();
      t.a.binding.undo();
      await t.sync();
      expect(t.a.read(() => $getRoot().getTextContent())).toBe('one two');
      expect(
        t.a.read(() => $getRoot().getAllTextNodes()[0].hasFormat('bold')),
      ).toBe(true);
      await expectConverged(t.peers);
    });

    test('the local update commits and is written first, then the remote change in a commit of its own', async () => {
      const {t, delta} = await twoPeers(gc);
      const commits: {collab: boolean; stored: string; text: string}[] = [];
      const root = t.a.doc.get('lexical-y') as unknown as {
        toDelta(): {children: {insert: unknown}[]};
      };
      const stored = () =>
        root
          .toDelta()
          .children.map(p => (typeof p.insert === 'string' ? p.insert : ''))
          .join('');
      t.a.editor.registerUpdateListener(({editorState, tags}) => {
        commits.push({
          collab: tags.has(COLLABORATION_TAG),
          stored: stored(),
          text: editorState.read(() => {
            const first = $getRoot().getAllTextNodes()[0];
            return `${$getRoot().getTextContent()}${first.hasFormat('bold') ? ' bold' : ''}`;
          }),
        });
      });
      t.a.update(() => {
        $appendX();
        Y.applyUpdate(t.a.doc, delta, 'provider');
      });
      await t.sync();
      expect(commits.slice(0, 2)).toEqual([
        {
          collab: false,
          stored: expect.stringContaining('one twoX'),
          text: 'one twoX',
        },
        {
          collab: true,
          stored: expect.stringContaining('one twoX'),
          text: 'one twoX bold',
        },
      ]);
    });

    for (const path of [
      'edit queued, then the change applied',
      'the change applied, then an edit queued',
      'an edit queued and the change applied in an $onUpdate callback',
    ] as const) {
      test(`on a remote read's commit, ${path}`, async () => {
        const {t, delta} = await twoPeers(gc);
        const seen = Y.encodeStateVector(t.b.doc);
        t.b.update(() =>
          $getRoot().getAllTextNodes().at(-1)!.selectEnd().insertText('!'),
        );
        const second = Y.encodeStateAsUpdate(t.b.doc, seen);
        const edit = () => t.a.editor.update($appendX, {discrete: true});
        const apply = () => Y.applyUpdate(t.a.doc, second, 'provider');
        let once = true;
        t.a.editor.registerUpdateListener(({tags}) => {
          if (once && tags.has(COLLABORATION_TAG)) {
            once = false;
            if (path === 'edit queued, then the change applied') {
              edit();
              apply();
            } else if (path === 'the change applied, then an edit queued') {
              apply();
              edit();
            } else {
              t.a.editor.update(
                () =>
                  $onUpdate(() => {
                    edit();
                    apply();
                  }),
                {discrete: true},
              );
            }
          }
        });
        t.a.editor.update(() => Y.applyUpdate(t.a.doc, delta, 'provider'), {
          discrete: true,
        });
        await new Promise(r => setTimeout(r, 0));
        await t.sync();
        expect(t.a.read(() => $getRoot().getTextContent())).toMatch(
          /^one two(X!|!X)$/,
        );
        expect(
          t.a.read(() => $getRoot().getAllTextNodes()[0].hasFormat('bold')),
        ).toBe(true);
        await expectConverged(t.peers);
        expect((await freshReader(t.a)).describe()).toBe(t.a.describe());
      });
    }

    test('a remote change during a deferred read keeps what that read showed', async () => {
      const {t, delta} = await twoPeers(gc);
      const seen = Y.encodeStateVector(t.b.doc);
      t.b.update(() =>
        $getRoot().getAllTextNodes().at(-1)!.selectEnd().insertText('!'),
      );
      const second = Y.encodeStateAsUpdate(t.b.doc, seen);
      let once = true;
      t.a.editor.registerUpdateListener(({tags}) => {
        if (once && tags.has(COLLABORATION_TAG)) {
          once = false;
          t.a.editor.update(() => $getRoot().selectEnd(), {discrete: true});
          Y.applyUpdate(t.a.doc, second, 'provider');
        }
      });
      // An update that changes nothing: the change is read once idle.
      t.a.editor.update(() => Y.applyUpdate(t.a.doc, delta, 'provider'), {
        discrete: true,
      });
      await new Promise(r => setTimeout(r, 0));
      await t.sync();
      expect(
        t.a.read(() => $getRoot().getAllTextNodes()[0].hasFormat('bold')),
      ).toBe(true);
      await expectConverged(t.peers);
      expect((await freshReader(t.a)).describe()).toBe(t.a.describe());
    });

    test('the caret the update set stays where it set it', async () => {
      const {t, delta} = await twoPeers(gc);
      t.a.update(() => {
        Y.applyUpdate(t.a.doc, delta, 'provider');
        $getRoot().getAllTextNodes()[0].select(2, 2);
      });
      await t.sync();
      expect(
        t.a.read(() => {
          const selection = $getSelection();
          return $isRangeSelection(selection)
            ? [
                selection.anchor.getNode().getTextContent(),
                selection.anchor.offset,
                selection.isCollapsed(),
              ]
            : null;
        }),
      ).toEqual(['one', 2, true]);
    });
  },
);
