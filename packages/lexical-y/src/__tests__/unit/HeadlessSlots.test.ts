/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Named slots through `@lexical/y/headless`: a seeded document keeps its
// slots, `readYState` reads them, an edit (`editYState`) inside a slot or of
// the slots themselves merges with a client typing in the same slot, and a
// slot the document cannot store is refused with a warning.

import {BlockIdExtension} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $getEditor,
  $getRoot,
  $getSlot,
  $getSlotNames,
  $removeSlot,
  $setSlot,
  defineExtension,
  type LexicalNode,
  type LexicalWarning,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {UNSUPPORTED_SLOTS_WARNING} from '../..';
import {
  editYState,
  readYState,
  seedYState,
  YHeadlessError,
} from '../../headless';
import {$p, expectConverged, freshReader, setup} from '../utils/harness';
import {
  $body,
  $caretAt,
  $component,
  $li,
  type ComponentNode,
  SLOT_NODES,
} from '../utils/slots';

const config = {nodes: SLOT_NODES, schemaVersion: 1, selfCheck: true};

function $build() {
  $getRoot().append(
    $p('Intro'),
    $component({
      body: $body($p('Body one'), $li('lone item')),
      caption: $p('Figure 1'),
    }),
  );
}

/** Each top-level host's slots as `name=text`. */
function $slots(): string[] {
  return $getRoot()
    .getChildren()
    .filter(n => $getSlotNames(n).length > 0)
    .map(n =>
      $getSlotNames(n)
        .map(name => `${name}=${$getSlot(n, name)!.getTextContent()}`)
        .join('|'),
    );
}

const $host = () =>
  $getRoot()
    .getChildren()
    .find(n => n.getType() === 'test_component') as ComponentNode;

describe('named slots, headless', () => {
  test('seedYState keeps slots and readYState reads them', () => {
    const warnings: LexicalWarning[] = [];
    const state = seedYState(
      {...config, onWarn: w => warnings.push(w)},
      $build,
    );
    expect(readYState(state, config, $slots)).toEqual([
      'body=Body one\n\nlone item|caption=Figure 1',
    ]);
    // The JSON a reader gets has the slots, as the seeded editor had them.
    const json = readYState(state, config, () =>
      $getEditor().getEditorState().toJSON(),
    );
    const host = json.root.children[1] as unknown as {
      $slots: Record<string, unknown>;
    };
    expect(Object.keys(host.$slots)).toEqual(['body', 'caption']);
    expect(warnings).toEqual([]);
  });

  test('an edit in a slot merges with a client typing in the same slot', async () => {
    const t = await setup($build, {nodes: SLOT_NODES});
    const stored = Y.encodeStateAsUpdate(t.a.doc);
    t.a.update(() => $caretAt('Figure', true).insertText(' (client)'));
    const result = editYState(
      stored,
      config,
      () => {
        $caretAt('Figure').insertText('Agent ');
        $caretAt('Body one', true).insertText(' edited');
      },
      {writer: null},
    );
    expect(result.warnings).toEqual([]);
    Y.applyUpdate(t.a.doc, result.update!, 'agent');
    await t.sync();
    await expectConverged([t.a, t.b]);
    expect(t.b.read($slots)).toEqual([
      'body=Body one edited\n\nlone item|caption=Agent Figure (client) 1',
    ]);
    expect(readYState(result.state, config, $slots)).toEqual([
      'body=Body one edited\n\nlone item|caption=Agent Figure 1',
    ]);
  });

  test('an edit that adds, replaces and removes slots', async () => {
    const t = await setup($build, {nodes: SLOT_NODES});
    const stored = Y.encodeStateAsUpdate(t.a.doc);
    const result = editYState(
      stored,
      config,
      () => {
        const host = $host();
        $setSlot(host, 'aside', $body($p('Added by the agent')));
        $setSlot(host, 'caption', $p('Figure 2'));
        $removeSlot(host, 'body');
      },
      {writer: null},
    );
    expect(readYState(result.state, config, $slots)).toEqual([
      'aside=Added by the agent|caption=Figure 2',
    ]);
    Y.applyUpdate(t.b.doc, result.update!, 'agent');
    await t.sync();
    await expectConverged([t.a, t.b]);
    expect(t.a.read($slots)).toEqual([
      'aside=Added by the agent|caption=Figure 2',
    ]);
    const fresh = await freshReader(t.a);
    expect(fresh.read($slots)).toEqual(t.a.read($slots));
  });

  test('slots with BlockIdExtension: ids stored on seed, read back the same', () => {
    const extensions = [
      defineExtension({
        dependencies: [BlockIdExtension],
        name: 'slots-headless-ids',
        nodes: SLOT_NODES,
      }),
    ];
    const state = seedYState({extensions, schemaVersion: 1}, $build);
    const ids = () =>
      readYState(state, {extensions, schemaVersion: 1}, () => {
        const out: string[] = [];
        const $visit = (n: LexicalNode) => {
          const json = n.exportJSON() as {$?: {blockId?: string}};
          if (json.$ && json.$.blockId) {
            out.push(`${n.getType()}:${json.$.blockId}`);
          }
          for (const name of $getSlotNames(n)) {
            $visit($getSlot(n, name)!);
          }
          if ('getChildren' in n) {
            (n as unknown as {getChildren(): LexicalNode[]})
              .getChildren()
              .forEach($visit);
          }
        };
        $visit($getRoot());
        return out;
      });
    const first = ids();
    // The slot's lines and the one-line caption have ids, stored in the seed.
    expect(first.filter(s => s.startsWith('paragraph:')).length).toBe(3);
    expect(ids()).toEqual(first);
  });

  test('an edit with a slot on a line is refused (read-only), with the warning', async () => {
    const t = await setup($build, {nodes: SLOT_NODES});
    const stored = Y.encodeStateAsUpdate(t.a.doc);
    const warnings: LexicalWarning[] = [];
    let error: unknown = null;
    try {
      editYState(
        stored,
        {...config, onWarn: w => warnings.push(w)},
        () => {
          const intro = $getRoot().getFirstChildOrThrow();
          $setSlot(intro as never, 'note', $p('not stored'));
        },
        {writer: null},
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(YHeadlessError);
    expect((error as YHeadlessError).code).toBe('read-only');
    expect((error as YHeadlessError).message).toBe(
      `@lexical/y: the change was not written: ${warnings
        .map(w => w.message)
        .join('; ')}`,
    );
    expect(warnings.map(w => w.code)).toEqual([UNSUPPORTED_SLOTS_WARNING]);
    expect((error as YHeadlessError).warnings).toEqual(warnings);
  });

  test('seeding a slot on a line throws, with the warning', () => {
    const warnings: LexicalWarning[] = [];
    expect(() =>
      seedYState({...config, onWarn: w => warnings.push(w)}, () => {
        const p = $p('Text');
        $setSlot(p, 'note', $p('not stored'));
        $getRoot().append(p);
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'read-only',
        name: 'YHeadlessError',
      }) as unknown as Error,
    );
    expect(warnings.map(w => w.code)).toEqual([UNSUPPORTED_SLOTS_WARNING]);
  });
});
