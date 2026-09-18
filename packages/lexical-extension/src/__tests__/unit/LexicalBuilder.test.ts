/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {AnyLexicalExtensionArgument} from '@lexical/extension';

import {
  buildEditorFromExtensions,
  configExtension,
  declarePeerDependency,
  defineExtension,
  LexicalBuilder,
  safeCast,
} from '@lexical/extension';
import {$create, $createParagraphNode, $getRoot, TextNode} from 'lexical';
import {assert, describe, expect, it} from 'vitest';

const InitialStateExtensionName = '@lexical/extension/InitialState';

describe('LexicalBuilder', () => {
  const ConfigExtension = defineExtension({
    config: safeCast<{a: 1; b: string | null}>({a: 1, b: 'b'}),
    name: 'Config',
  });
  it('merges extension configs (siblings)', () => {
    const builder = LexicalBuilder.fromEditor(
      buildEditorFromExtensions(
        ConfigExtension,
        configExtension(ConfigExtension, {b: null}),
      ),
    );
    const reps = builder.sortedExtensionReps();
    expect(reps.length).toBe(2);
    const [rep] = reps.slice(-1);
    expect(rep.extension).toBe(ConfigExtension);
    expect(rep.getState().config).toEqual({a: 1, b: null});
  });
  it('merges extension configs (parent override child)', () => {
    const builder = LexicalBuilder.fromEditor(
      buildEditorFromExtensions(
        defineExtension({
          dependencies: [configExtension(ConfigExtension, {b: null})],
          name: 'parent',
        }),
      ),
    );
    const reps = builder.sortedExtensionReps();
    expect(reps.length).toBe(3);
    const rep = reps.find(r => r.extension === ConfigExtension);
    assert(rep, 'ConfigExtension not found');
    expect(rep.extension).toBe(ConfigExtension);
    expect(rep.getState().config).toEqual({a: 1, b: null});
  });
  it('merges extension configs (grandparent override child) override after', () => {
    const builder = LexicalBuilder.fromEditor(
      buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            defineExtension({dependencies: [ConfigExtension], name: 'parent'}),
            configExtension(ConfigExtension, {b: null}),
          ],
          name: 'grandparent',
        }),
      ),
    );
    const reps = builder.sortedExtensionReps();
    expect(reps.length).toBe(4);
    const rep = reps.find(r => r.extension === ConfigExtension);
    assert(rep, 'ConfigExtension not found');
    expect(rep.extension).toBe(ConfigExtension);
    expect(rep.getState().config).toEqual({a: 1, b: null});
  });
  it('merges extension configs (grandparent override child) override before', () => {
    const builder = LexicalBuilder.fromEditor(
      buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            configExtension(ConfigExtension, {b: null}),
            defineExtension({dependencies: [ConfigExtension], name: 'parent'}),
          ],
          name: 'grandparent',
        }),
      ),
    );
    const reps = builder.sortedExtensionReps();
    expect(reps.length).toBe(4);
    const rep = reps.find(r => r.extension === ConfigExtension);
    assert(rep, 'ConfigExtension not found');
    expect(rep.extension).toBe(ConfigExtension);
    expect(rep.getState().config).toEqual({a: 1, b: null});
  });
  describe('a dependency configured more than once by one extension', () => {
    const PairExtension = defineExtension({
      config: safeCast<{first: string; second: string}>({
        first: 'default',
        second: 'default',
      }),
      name: 'Pair',
    });
    const configOf = (...dependencies: AnyLexicalExtensionArgument[]) => {
      const builder = LexicalBuilder.fromEditor(
        buildEditorFromExtensions(
          defineExtension({dependencies, name: 'root'}),
        ),
      );
      const rep = builder
        .sortedExtensionReps()
        .find(r => r.extension === PairExtension);
      assert(rep, 'PairExtension not found');
      return rep.getState().config;
    };

    it('applies every config rather than only the last', () => {
      expect(
        configOf(
          configExtension(PairExtension, {first: 'one'}),
          configExtension(PairExtension, {second: 'two'}),
        ),
      ).toEqual({first: 'one', second: 'two'});
    });

    it('applies them in order, so the last one wins a conflict', () => {
      expect(
        configOf(
          configExtension(PairExtension, {first: 'one'}),
          configExtension(PairExtension, {first: 'two'}),
        ),
      ).toEqual({first: 'two', second: 'default'});
    });

    it('keeps a peer dependency config alongside a direct one', () => {
      const PeerExtension = defineExtension({
        name: 'Peer',
        peerDependencies: [
          declarePeerDependency<typeof PairExtension>('Pair', {second: 'peer'}),
        ],
      });
      expect(
        configOf(
          configExtension(PairExtension, {first: 'direct'}),
          PeerExtension,
        ),
      ).toEqual({first: 'direct', second: 'peer'});
    });
  });

  it('handles circular dependencies', () => {
    const ExtensionA = defineExtension({dependencies: [], name: 'A'});
    const ExtensionB = defineExtension({dependencies: [ExtensionA], name: 'B'});
    const ExtensionC = defineExtension({dependencies: [ExtensionB], name: 'C'});
    // This is silly and hard to do but why not prevent it
    ExtensionA.dependencies?.push(ExtensionC);
    expect(() => buildEditorFromExtensions(ExtensionA)).toThrowError(
      'LexicalBuilder: Circular dependency detected for Extension A from B',
    );
  });
  describe('nodes configuration', () => {
    const ExtDefer = defineExtension({
      name: 'A',
      nodes: () => [NodeA],
    });
    class NodeA extends TextNode {
      $config() {
        return this.config('node-a', {extends: TextNode});
      }
    }
    class NodeB extends TextNode {
      $config() {
        return this.config('node-b', {extends: TextNode});
      }
    }
    const ExtDirect = defineExtension({
      name: 'B',
      nodes: [NodeB],
    });
    it('can mix deferred and direct node config', () => {
      using editor = buildEditorFromExtensions(ExtDefer, ExtDirect, {
        $initialEditorState() {
          $getRoot().append(
            $createParagraphNode().append(
              $create(NodeA).setTextContent('defer'),
              $create(NodeB).setTextContent('direct'),
            ),
          );
        },
        name: 'state',
      });
      editor.read(() => {
        expect(
          $getRoot()
            .getAllTextNodes()
            .map(node => ({[node.getType()]: node.getTextContent()})),
        ).toEqual([{'node-a': 'defer'}, {'node-b': 'direct'}]);
      });
    });
  });
  describe('handles peer dependency configuration', () => {
    const ExtensionA = defineExtension({
      name: 'A',
      peerDependencies: [
        declarePeerDependency<typeof ConfigExtension>('Config', {b: 'A'}),
      ],
    });
    it('peer-first', () => {
      const builder = LexicalBuilder.fromEditor(
        buildEditorFromExtensions(ExtensionA, ConfigExtension),
      );
      const reps = builder.sortedExtensionReps();
      expect(reps.map(rep => rep.extension.name)).toEqual([
        InitialStateExtensionName,
        'Config',
        'A',
      ]);
      expect(reps[1].getState().config).toEqual({
        a: 1,
        b: 'A',
      });
    });
    it('peer-last', () => {
      const builder = LexicalBuilder.fromEditor(
        buildEditorFromExtensions(ExtensionA, ConfigExtension),
      );
      const reps = builder.sortedExtensionReps();
      expect(reps.map(rep => rep.extension.name)).toEqual([
        InitialStateExtensionName,
        'Config',
        'A',
      ]);
      expect(reps[1].getState().config).toEqual({
        a: 1,
        b: 'A',
      });
    });
  });
});
