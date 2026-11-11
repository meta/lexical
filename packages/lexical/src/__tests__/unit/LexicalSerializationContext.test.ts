/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isCompactExport,
  $isElementNode,
  $setSlot,
  $withCompactExport,
  createEditor,
  type LexicalEditor,
  nodeSchema,
  rawValue,
  type SerializedElementNode,
  type SerializedLexicalNode,
  type SerializedPartial,
  type SerializedRootNode,
  TextNode,
  withAccessors,
} from 'lexical';
import {assert, beforeEach, describe, expect, expectTypeOf, test} from 'vitest';

import {
  $createTestDecoratorNode,
  $createTestShadowRootNode,
  TestDecoratorNode,
  TestShadowRootNode,
} from '../utils';

// The walk only ever produces elements where this is used, but serialized
// JSON carries no discriminator beyond `type`, so the shape is asserted here
// rather than at every call site. Typed for the compact shape, which the
// legacy one also satisfies, so both forms go through it.
function childrenOf(
  node: SerializedPartial<SerializedLexicalNode>,
): SerializedPartial<SerializedLexicalNode>[] {
  return (node as SerializedPartial<SerializedElementNode>).children!;
}

describe('compact export', () => {
  let editor: LexicalEditor;

  beforeEach(() => {
    editor = createEditor({
      namespace: '',
      onError: err => {
        throw err;
      },
    });
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('plain'),
              $createTextNode('bold').setFormat('bold'),
            ),
          );
      },
      {discrete: true},
    );
  });

  function toJSON(compact = false): SerializedRootNode {
    // The form is stated rather than left to an enclosing
    // $withCompactExport: a bare toJSON() writes the legacy form whatever
    // encloses it, which is what makes its return type true.
    return editor.read(
      () => editor.getEditorState().toJSON(compact).root as SerializedRootNode,
    );
  }

  test('legacy is the default and is unchanged', () => {
    const root = toJSON();
    const paragraph = childrenOf(root)[0];
    const [plain, bold] = childrenOf(paragraph);
    // every property written out, including the deprecated `version`
    expect(root.version).toBe(1);
    expect(paragraph).toMatchObject({
      direction: null,
      format: '',
      indent: 0,
      type: 'paragraph',
      version: 1,
    });
    expect(plain).toMatchObject({
      detail: 0,
      format: 0,
      mode: 'normal',
      style: '',
      text: 'plain',
      type: 'text',
      version: 1,
    });
    expect(bold).toMatchObject({format: 1, text: 'bold'});
  });

  test('compact omits version and every default-valued property', () => {
    const root = toJSON(true);
    const paragraph = childrenOf(root)[0];
    const [plain, bold] = childrenOf(paragraph);
    expect(root).not.toHaveProperty('version');
    // a paragraph with no formatting keeps only its structure
    expect(Object.keys(paragraph).sort()).toEqual(['children', 'type']);
    // text keeps what differs from the default, drops the rest
    expect(plain).toEqual({text: 'plain', type: 'text'});
    expect(bold).toEqual({format: 1, text: 'bold', type: 'text'});
  });

  test('compact JSON parses back to the same document as legacy JSON', () => {
    const legacy = toJSON();
    const compact = toJSON(true);
    expect(JSON.stringify(compact).length).toBeLessThan(
      JSON.stringify(legacy).length,
    );

    // No cast: parseEditorState accepts either form, which is the point of
    // the compact one being parseable at all.
    const fromCompact = editor.parseEditorState({root: compact});
    const fromLegacy = editor.parseEditorState({root: legacy});
    // both restore the same content, and re-exporting the compact-parsed state
    // in legacy form reproduces the original legacy JSON exactly
    for (const state of [fromCompact, fromLegacy]) {
      expect(
        state.read(() =>
          $getRoot()
            .getAllTextNodes()
            .map(n => [n.getTextContent(), n.getFormat()]),
        ),
      ).toEqual([
        ['plain', 0],
        ['bold', 1],
      ]);
    }
    expect(fromCompact.toJSON()).toEqual(fromLegacy.toJSON());
  });

  test('a formatted first text child survives compaction (#7971)', () => {
    // ParagraphNode back-fills textFormat/textStyle from its first text child
    // for backwards compatibility. That value is computed, not restored from a
    // schema default, so dropping it in the compact form would make the two
    // forms describe different documents.
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('bold').setFormat('bold').setStyle('color: red'),
            ),
          );
      },
      {discrete: true},
    );
    const legacy = toJSON();
    const compact = toJSON(true);
    expect(childrenOf(compact)[0]).toMatchObject({
      textFormat: 1,
      textStyle: 'color: red',
    });
    const fromLegacy = editor.parseEditorState({root: legacy});
    const fromCompact = editor.parseEditorState({root: compact});
    for (const state of [fromLegacy, fromCompact]) {
      expect(
        state.read(() => {
          const paragraph = $getRoot().getFirstChildOrThrow();
          assert($isElementNode(paragraph));
          return [paragraph.getTextFormat(), paragraph.getTextStyle()];
        }),
      ).toEqual([1, 'color: red']);
    }
  });

  test('the form does not leak outside its callback', () => {
    toJSON(true);
    expect(childrenOf(toJSON())[0].version).toBe(1);
  });
});

describe('compact export: slot hosts', () => {
  test('a decorator host keeps its slots in both forms', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          const host = $createTestDecoratorNode().setIsInline(false);
          const slot = $createTestShadowRootNode();
          slot.append($createParagraphNode().append($createTextNode('inside')));
          $getRoot().clear().append(host);
          $setSlot(host, 'body', slot);
        },
        name: '[serialization-slots]',
        nodes: [TestDecoratorNode, TestShadowRootNode],
      }),
    );
    for (const compact of [false, true]) {
      const root = editor.read(
        () => editor.getEditorState().toJSON(compact).root,
      );
      // a decorator host has no children array, so its slots are the only
      // subtree it carries
      const host = childrenOf(root)[0];
      expect(host.type).toBe('test_decorator');
      expect(JSON.stringify(host.$slots)).toContain('inside');
    }
  });
});

describe('editorState.toJSON states its form at the call site', () => {
  const buildEditor = () =>
    buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode('hi')));
        },
        name: '[serialization-tojson]',
      }),
    );

  test('an explicit form wins over the ambient one, and types as itself', () => {
    using editor = buildEditor();
    // $initialEditorState is applied on the first read, so the state has to be
    // taken from inside one — otherwise every case below runs on an empty
    // document and proves much less than it looks like it does.
    const state = editor.read(() => editor.getEditorState());
    // The legacy form writes `version`; the compact form omits it, which is
    // the cheapest observable difference between the two.
    expect(JSON.stringify(state.toJSON())).toContain('hi');
    expect(state.toJSON().root).toHaveProperty('version');
    expect(state.toJSON(true).root).not.toHaveProperty('version');
    // …including against an enclosing $withCompactExport, so both overloads
    // are true of what they return rather than of what is ambient.
    $withCompactExport(true, () => {
      expect(state.toJSON(false).root).toHaveProperty('version');
      expect(state.toJSON(true).root).not.toHaveProperty('version');
    });
  });

  test('no argument writes the legacy form whatever encloses it', () => {
    // What makes the signature true: `toJSON(): SerializedEditorState` cannot
    // promise the full shape if an enclosing walk can turn it compact.
    using editor = buildEditor();
    // $initialEditorState is applied on the first read, so the state has to be
    // taken from inside one — otherwise every case below runs on an empty
    // document and proves much less than it looks like it does.
    const state = editor.read(() => editor.getEditorState());
    expect(state.toJSON().root).toHaveProperty('version');
    $withCompactExport(true, () => {
      expect(state.toJSON().root).toHaveProperty('version');
      // The form is still this call's to state.
      expect(state.toJSON(true).root).not.toHaveProperty('version');
    });
  });

  test('a nested editor follows the document containing it', () => {
    // The inheritance the ambient form exists for, now carried by
    // LexicalEditor.toJSON, which passes the enclosing form on explicitly
    // instead of leaving EditorState.toJSON to pick it up.
    using editor = buildEditor();
    editor.read(() => {
      expect(editor.toJSON().editorState.root).toHaveProperty('version');
    });
    $withCompactExport(true, () => {
      editor.read(() => {
        expect(editor.toJSON().editorState.root).not.toHaveProperty('version');
      });
    });
  });

  test('JSON.stringify passes a key, which must not select the compact form', () => {
    // `toJSON` is the JSON.stringify hook, and stringify invokes it with the
    // property name the value sits under: '' at the top level, but 'state'
    // here. A truthy test on the argument would silently write compact.
    using editor = buildEditor();
    // $initialEditorState is applied on the first read, so the state has to be
    // taken from inside one — otherwise every case below runs on an empty
    // document and proves much less than it looks like it does.
    const state = editor.read(() => editor.getEditorState());
    expect(JSON.parse(JSON.stringify({state})).state.root).toHaveProperty(
      'version',
    );
    expect(JSON.parse(JSON.stringify(state)).root).toHaveProperty('version');
  });
});

describe('$isCompactExport reports the walk, not a single node', () => {
  const buildEditor = () =>
    buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode('hi')));
        },
        name: '[serialization-iscompact]',
      }),
    );

  test('the export walk establishes it, in both directions', () => {
    using editor = buildEditor();
    editor.read(() => {
      expect($isCompactExport()).toBe(false);
      $withCompactExport(true, () => expect($isCompactExport()).toBe(true));
      // …and restored, including from a nested scope that turns it back off.
      $withCompactExport(true, () => {
        $withCompactExport(false, () => expect($isCompactExport()).toBe(false));
        expect($isCompactExport()).toBe(true);
      });
      expect($isCompactExport()).toBe(false);
    });
  });

  test('a schema getter observes it, which is what it is for', () => {
    // The case the function exists for: the walk calls get<Prop>() with no
    // arguments, so this is the only way a getter can tell the two apart.
    const seen: boolean[] = [];
    class ProbeNode extends TextNode {
      $config() {
        return this.config('serialization-probe', {
          extends: TextNode,
          json: nodeSchema<ProbeNode>()({
            // Not `setter: null`: a derived property is skipped by the
            // compact walk without its getter being called at all, so the
            // probe would never run for the form under test.
            probe: withAccessors(rawValue<boolean>(), {
              getter: 'getSerializedProbe',
              setter: 'setProbe',
            }),
          }),
        });
      }
      getSerializedProbe(): boolean {
        seen.push($isCompactExport());
        return $isCompactExport();
      }
      setProbe(_probe: boolean | undefined): this {
        return this;
      }
    }
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          $getRoot()
            .clear()
            // A TextNode subclass with no text is removed by normalization,
            // so there would be nothing left for the walk to reach.
            .append(
              $createParagraphNode().append(
                $create(ProbeNode).setTextContent('x'),
              ),
            );
        },
        name: '[serialization-probe]',
        nodes: [ProbeNode],
      }),
    );
    const state = editor.read(() => editor.getEditorState());
    // Each document walk hands the getter the form that walk is writing.
    expect(state.toJSON(false).root).toBeDefined();
    expect(state.toJSON(true).root).toBeDefined();
    expect(seen).toEqual([false, true]);
  });

  test('a bare node.exportJSON(true) does not establish it', () => {
    // exportJSON takes its own `compact` and is called by the walk with the
    // walk's form already in effect. Setting this too would report a whole
    // document as compact when one node was asked to be.
    using editor = buildEditor();
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      paragraph.exportJSON(true);
      expect($isCompactExport()).toBe(false);
    });
  });
});

describe('$withCompactExport refuses an asynchronous callback', () => {
  test('at the call site, and at runtime for an untyped caller', () => {
    // The form is restored as soon as the callback returns, so an async one
    // gives it up at its first await and exports in whatever form is ambient
    // when it resumes — the caller gets a document in the form they did not
    // ask for.
    expect(() =>
      $withCompactExport(true, (async () => {
        await Promise.resolve();
        // eslint-disable-next-line no-console -- unreachable; the guard throws
        console.log('never');
      }) as unknown as () => void),
    ).toThrow(/thenable/);
    // A thenable that is not a promise is the same hazard.
    expect(() =>
      $withCompactExport(true, () => ({then: () => undefined})),
    ).toThrow(/thenable/);
    // Typed callers do not get that far: the trailing parameter is an empty
    // tuple for every type but a promise, so this is an arity error rather
    // than a runtime one.
    // @ts-expect-error -- the callback must be synchronous
    void (() => $withCompactExport(true, async () => 1));
    // …and a synchronous callback still infers its return type.
    expectTypeOf($withCompactExport(true, () => 1)).toEqualTypeOf<number>();
  });
});
