/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, test} from 'vitest';

import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $getRoot,
  $getState,
  $isParagraphNode,
  $isTextNode,
  $setState,
  createEditor,
  createState,
  IS_BOLD,
  LineBreakNode,
  NODE_STATE_KEY,
  nodeSchema,
  numberValue,
  objectValue,
  ParagraphNode,
  type SerializedTextNode,
  stringValue,
  TabNode,
  TextNode,
  withAccessors,
  withField,
} from '../..';
import {
  GENERATED_LINEBREAK,
  GENERATED_PARAGRAPH,
  GENERATED_TAB,
  GENERATED_TEXT,
  type GeneratedJSONFactory,
} from '../../LexicalGeneratedJSON';
import {
  type CompactDefaultTest,
  getGeneratedJSON,
  getStaticNodeConfig,
} from '../../LexicalUtils';
import {
  $expectSameJSON,
  $expectSameParse,
  initializeUnitTest,
  invariant,
} from '../utils';

const REPO = join(import.meta.dirname, '..', '..', '..', '..', '..');

describe('generated exportJSON', () => {
  test('the checked-in outputs are what the generator produces; `pnpm run generate-node-json` to fix', async () => {
    // A schema change that nobody regenerated for would otherwise ship
    // specialized code describing the previous schema.
    //
    // Generated somewhere else and compared, rather than regenerated in place:
    // the files under test are source modules other workers in this run
    // import, and rewriting one out from under them makes whichever happens to
    // be loading it fail. Run in-process rather than spawned: the generator
    // reads the schemas by importing the packages, which this worker has
    // already loaded, so nothing here waits on a second process, a loader, or
    // whatever else the machine is doing.
    const {generateNodeJSON} =
      await import('../../../../../scripts/shared/generateNodeJSON.mjs');
    const out = mkdtempSync(join(tmpdir(), 'lexical-codegen-'));
    const written = generateNodeJSON(out);
    expect(written.map(w => w.path)).toContain(
      'packages/lexical/src/LexicalGeneratedJSON.ts',
    );
    for (const {path, target} of written) {
      expect({content: readFileSync(target, 'utf8'), file: path}).toEqual({
        content: readFileSync(join(REPO, path), 'utf8'),
        file: path,
      });
    }
  }, 30_000);

  initializeUnitTest(
    testEnv => {
      test('every generated exporter agrees with the schema-driven walk', () => {
        testEnv.editor.update(
          () => {
            $expectSameJSON(
              $createTextNode('hello').setFormat('bold').setStyle('color: red'),
            );
            $expectSameJSON($createTextNode(''));
            $expectSameJSON(
              $createTextNode('tok')
                .setMode('token')
                .setDetail('directionless'),
            );
            $expectSameJSON($createLineBreakNode());
            $expectSameJSON($createTabNode());
            // ParagraphNode belongs here most of all: it is the only element
            // among them, so the only one whose generated code has to lead
            // with `children`, and the only one whose properties are a mix of
            // fields and methods. Its exportJSON override back-fills #7971 on
            // top of whichever of the two ran, so the two are compared
            // underneath it.
            $expectSameJSON(
              $createParagraphNode().setDirection('rtl').setIndent(3),
            );
            $expectSameJSON($createParagraphNode());
            // Both arms of the `when` gate, which the paragraphs above leave
            // at their defaults and so never enter: the generated code hoists
            // one shared `shouldSerializeTextStyles` where the walk tests the
            // default and calls the predicate per property, so agreeing when
            // the property is trivially omitted proves nothing about either.
            $expectSameJSON(
              $createParagraphNode()
                .setTextFormat(IS_BOLD)
                .setTextStyle('color: red'),
            );
            // Predicate false with a non-default value — the case the two
            // decide differently if the hoist ever stops mirroring the walk.
            $expectSameJSON(
              $createParagraphNode()
                .setTextFormat(IS_BOLD)
                .setTextStyle('color: red')
                .append($createTextNode('x')),
            );
          },
          {discrete: true},
        );
      });

      test('every generated parser agrees with the schema-driven walk', () => {
        testEnv.editor.update(
          () => {
            $expectSameParse(TextNode, {
              detail: 'directionless',
              format: 'bold',
              mode: 'token',
              style: 'color: red',
              text: 'hi',
            });
            $expectSameParse(TextNode, {});
            $expectSameParse(ParagraphNode, {
              direction: 'rtl',
              format: 'center',
              indent: 2,
              textFormat: 1,
              textStyle: 'color: red',
            });
            // Out of domain on both counts: the emitted bounds and enum test
            // have to fall back exactly where the schemas do.
            $expectSameParse(ParagraphNode, {format: 'nope', indent: -1});
            // TabNode applies only what it does not derive. The two forms of
            // `format` both reach the alias table, and `detail`, `mode` and
            // `text` are declared export-only — a tab's are fixed — so a
            // serialized document carrying them has to leave the node exactly
            // where the walk leaves it, which is untouched.
            $expectSameParse(TabNode, {format: 'bold', style: 'color: red'});
            $expectSameParse(TabNode, {format: 2});
            $expectSameParse(TabNode, {
              detail: 0,
              mode: 'normal',
              style: 'color: red',
              text: 'not a tab',
            });
            $expectSameParse(TabNode, {});
            // A key the serialized object only *inherits* is absent to the
            // walk, which reads with `hasOwnKey` — so it has to be absent to
            // the generated parser too. A bare `json.text` picked it up, which
            // a polluted `Object.prototype`, or a caller layering a partial
            // update over a defaults object, is enough to reach.
            $expectSameParse(
              TextNode,
              Object.create({
                style: 'color: red',
                text: 'inherited',
              }) as {readonly [key: string]: unknown},
            );
          },
          {discrete: true},
        );
      });

      test('an exportJSON override composes with its generated exporter', () => {
        // ParagraphNode writes textFormat/textStyle computed from its first text
        // child (#7971) — output no schema describes. It keeps doing that in an
        // ordinary exportJSON override: the override calls super, super is where
        // the generated literal comes from, and the override then adjusts it.
        testEnv.editor.update(
          () => {
            const paragraph = $createParagraphNode();
            paragraph.append($createTextNode('x').setFormat('bold'));
            const json = paragraph.exportJSON();
            // The first text child's format, not the paragraph's own.
            expect(json.textFormat).toBe(1);
            expect(json.textStyle).toBe('');
            // And the generated literal underneath it is intact. The literal
            // writes every schema key unconditionally — textFormat/textStyle as
            // undefined when the getters have nothing to say — so the override's
            // back-fill assigns into keys that already exist, and they sit at
            // their schema position rather than trailing after `version`.
            expect(json.type).toBe('paragraph');
            expect(Object.keys(json)).toEqual([
              'children',
              'direction',
              'format',
              'indent',
              'textFormat',
              'textStyle',
              'type',
              'version',
            ]);
          },
          {discrete: true},
        );
      });

      test('NodeState still reaches the JSON through a generated exporter', () => {
        testEnv.editor.update(
          () => {
            const node = $createTextNode('hi');
            // Whatever a node carries is not known when the code is generated,
            // so the dispatch appends it rather than the generated literal.
            expect(node.exportJSON()).not.toHaveProperty('$');
          },
          {discrete: true},
        );
      });
    },
    {
      namespace: 'test',
      nodes: [],
      theme: {},
    },
  );
});

describe('generated code is inherited where it still applies', () => {
  // Handed over through `$config` rather than looked up by node type, so there
  // is no second derivation that could stop matching the first — the check is
  // that each class named its own.
  test.each([
    ['text', TextNode, GENERATED_TEXT],
    ['paragraph', ParagraphNode, GENERATED_PARAGRAPH],
    ['linebreak', LineBreakNode, GENERATED_LINEBREAK],
    ['tab', TabNode, GENERATED_TAB],
  ])('%s', (_type, klass, generated) => {
    const {ownNodeConfig} = getStaticNodeConfig(klass);
    expect(ownNodeConfig && ownNodeConfig.generated).toBe(generated);
    // The factory is called once, when the class's record is built, and the
    // functions it returned are what the class runs from then on.
    const bound = getGeneratedJSON(klass);
    expect(bound).not.toBeNull();
    expect(getGeneratedJSON(klass)).toBe(bound);
  });

  test('a subclass whose tables compile the same way inherits it', () => {
    // Its own `$config`, its own type, no accessor overridden and no property
    // added: the code TextNode was generated from reads and writes exactly
    // what the walk would for this class too, so it runs here as well.
    class PlainSub extends TextNode {
      $config() {
        return this.config('plain-sub', {extends: TextNode});
      }
    }
    const editor = createEditor({
      namespace: '',
      nodes: [PlainSub],
      onError: err => {
        throw err;
      },
    });
    editor.update(
      () => {
        // TextNode's factory, bound to this class's own composed schema — a
        // record of its own, so identity says nothing; what it runs does.
        expect(getGeneratedJSON(PlainSub)).not.toBeNull();
        const node = $create(PlainSub)
          .setTextContent('hi')
          .setStyle('color: red');
        // The exporter reads `type` off the node, so it is this class's.
        expect(node.exportJSON().type).toBe('plain-sub');
        $expectSameJSON(node);
        $expectSameParse(PlainSub, {style: 'color: red', text: 'hi'});
      },
      {discrete: true},
    );
  });

  test('a subclass that overrides an accessor a field stands in for takes the walk', () => {
    // No `$config` of its own, so it inherits TextNode's — the node type and
    // the generated code with it — while overriding an accessor that code
    // compiled away. Its tables resolve that property through the method, so
    // they are not the ones the code was generated from, and the override is
    // honored.
    class InheritsEverything extends TextNode {
      getStyle(): string {
        return `${super.getStyle()};extra`;
      }
    }
    const editor = createEditor({
      namespace: '',
      nodes: [InheritsEverything],
      onError: err => {
        throw err;
      },
    });
    editor.update(
      () => {
        $getRoot().clear();
        expect(getGeneratedJSON(InheritsEverything)).toBeNull();
        const node = $create(InheritsEverything).setStyle('color: red');
        expect(node.exportJSON().style).toBe('color: red;extra');
      },
      {discrete: true},
    );
  });

  test('a subclass that declares a property of its own takes the walk', () => {
    // Its tables carry an entry TextNode's code knows nothing about.
    class ExtraField extends TextNode {
      __extra = '';
      $config() {
        return this.config('extra-field', {
          extends: TextNode,
          json: nodeSchema<ExtraField>()({
            extra: withField(stringValue(), {field: '__extra'}),
          }),
        });
      }
    }
    createEditor({
      namespace: '',
      nodes: [ExtraField],
      onError: err => {
        throw err;
      },
    });
    expect(getGeneratedJSON(ExtraField)).toBeNull();
  });

  test('a subclass that re-declares a property with a different predicate takes the walk', () => {
    // The case a field-by-field comparison misses: everything the compiled
    // entry records is identical — same kind, key, field, default, equality,
    // no `getterTable` — and only the `when` predicate differs, which the entry
    // holds as a resolved function rather than the name the generated code
    // emits. Inheriting here would run code that calls the ancestor's
    // predicate. What separates them is that re-declaring means a new schema.
    // Stands in for a build-generated bundle, so that inheriting it is
    // observable: the marker is what a class running this code writes.
    const GENERATED_GATED: GeneratedJSONFactory = () => ({
      exportJSON: node => ({ranGeneratedCode: true, type: node.getType()}),
    });
    class GatedBase extends TextNode {
      __label = '';
      $config() {
        return this.config('gated-base', {
          extends: TextNode,
          generated: GENERATED_GATED,
          json: nodeSchema<GatedBase>()({
            // Export-only, so the two classes differ in nothing but the
            // predicate — no setter name to tell them apart either.
            label: withAccessors(stringValue(), {
              getter: {field: '__label', when: 'writeAlways'},
              setter: null,
            }),
          }),
        });
      }
      writeAlways(): boolean {
        return true;
      }
      writeNever(): boolean {
        return false;
      }
    }
    class GatedSub extends GatedBase {
      $config() {
        return this.config('gated-sub', {
          extends: GatedBase,
          json: nodeSchema<GatedSub>()({
            label: withAccessors(stringValue(), {
              getter: {field: '__label', when: 'writeNever'},
              setter: null,
            }),
          }),
        });
      }
    }
    const editor = createEditor({
      namespace: '',
      nodes: [GatedBase, GatedSub],
      onError: err => {
        throw err;
      },
    });
    expect(getGeneratedJSON(GatedBase)).not.toBeNull();
    expect(getGeneratedJSON(GatedSub)).toBeNull();
    editor.update(
      () => {
        const sub = $create(GatedSub);
        sub.__label = 'hidden';
        // The walk, honoring this class's own predicate rather than the
        // ancestor's — and not the generated code, which would have written
        // the marker.
        const json = sub.exportJSON();
        expect(json).not.toHaveProperty('ranGeneratedCode');
        // The legacy form writes every key, `undefined` where the predicate
        // says no — under the ancestor's predicate this would be 'hidden'.
        expect(json).toHaveProperty('label', undefined);
      },
      {discrete: true},
    );
  });

  test("a $config that names an ancestor's generated code is refused", () => {
    // Inheriting is automatic where it applies; a declaration that silently
    // ran the walk where it does not would leave the class believing it ships
    // the code it named, so this fails loudly, at registration.
    class PassesParentGenerated extends TextNode {
      $config() {
        return this.config('passes-parent-generated', {
          extends: TextNode,
          generated: GENERATED_TEXT,
        });
      }
    }
    expect(() =>
      createEditor({
        namespace: '',
        nodes: [PassesParentGenerated],
        onError: err => {
          throw err;
        },
      }),
    ).toThrow(/names the generated JSON code that TextNode declared/);
  });
});

describe('the compact form is generated too', () => {
  // Which properties the compact form drops depends on a node's values, but the
  // rule does not: each is a comparison against a default the schema states. So
  // it generates the same way the legacy form does, and the `compact` argument
  // picks between two straight-line functions rather than branching inside one.
  test('every class that has a legacy form has one', () => {
    // No property can cost a class this form any more: one whose default the
    // generator cannot state as source compares through `isCompactDefault`
    // instead, so the form is always generated and this holds for every target
    // rather than for the one whose properties happen to compare cleanly.
    for (const klass of [TextNode, ParagraphNode, LineBreakNode, TabNode]) {
      const generated = getGeneratedJSON(klass);
      invariant(generated !== null, 'expected generated code');
      expect(generated.exportCompactJSON).toBeDefined();
      expect(generated.exportCompactJSON).not.toBe(generated.exportJSON);
    }
  });

  test('a property compared at run time omits exactly what the walk omits', () => {
    // The generated modules hold no value import — importing the classes they
    // were generated from would be a cycle — so a property whose default has
    // no literal to compare against is handed the class's own omission test by
    // the dispatch. Nothing in the manifest has such a property, so this is
    // the shape the generator emits for one, written out: `box` compares
    // through the parameter where `w` compares as source.
    // LineBreakNode declares no properties of its own, so `box` and `w` are the
    // whole schema and the hand-written literals below are the whole export.
    let received: undefined | CompactDefaultTest;
    class Boxed extends LineBreakNode {
      __box: {w: number} = {w: 0};
      __w = 0;
      $config() {
        return this.config('run-time-compared-box', {
          extends: LineBreakNode,
          generated: () => ({
            exportCompactJSON: (node, isCompactDefault) => {
              received = isCompactDefault;
              const json: {[key: string]: unknown} = {type: node.__type};
              // `box` has an object default, which has no literal a value
              // could be `===`, so the schema answers; `w`'s default is `0`,
              // which the generator would have written as source.
              const box = (node as Boxed).__box;
              if (box !== undefined && !isCompactDefault('box', box)) {
                json.box = box;
              }
              const w = (node as Boxed).__w;
              if (w !== undefined && w !== 0) {
                json.w = w;
              }
              return json;
            },
            // Schema order, then type and version, which is what the walk
            // writes and what `$expectSameJSON` compares key for key.
            /* eslint-disable sort-keys-fix/sort-keys-fix */
            exportJSON: node => ({
              box: (node as Boxed).__box,
              w: (node as Boxed).__w,
              type: node.__type,
              version: 1,
            }),
            /* eslint-enable sort-keys-fix/sort-keys-fix */
          }),
          json: nodeSchema<Boxed>()({
            box: withField(objectValue({w: numberValue()}), {field: '__box'}),
            w: withField(numberValue(), {field: '__w'}),
          }),
        });
      }
    }
    const editor = createEditor({
      namespace: '',
      nodes: [Boxed],
      onError: err => {
        throw err;
      },
    });
    editor.update(
      () => {
        // A fresh object each time, so identity is never the answer — the
        // schema's own `isEqual` is what decides, and it compares by content.
        const atDefault = $create(Boxed);
        atDefault.__box = {w: 0};
        expect(atDefault.exportJSON(true)).toEqual({
          type: 'run-time-compared-box',
        });
        expect(received).toBeDefined();
        // The value the walk would have kept is kept here too.
        const differs = $create(Boxed);
        differs.__box = {w: 3};
        expect(differs.exportJSON(true)).toEqual({
          box: {w: 3},
          type: 'run-time-compared-box',
        });
        // And both agree with the walk, which is the point of routing through
        // the schema rather than guessing.
        $expectSameJSON(atDefault);
        $expectSameJSON(differs);
      },
      {discrete: true},
    );
  });

  initializeUnitTest(testEnv => {
    test('it omits what parsing restores, and nothing else', () => {
      testEnv.editor.update(
        () => {
          // Every property at its default: the compact form is the type alone.
          expect($createTextNode('').exportJSON(true)).toEqual({type: 'text'});
          // And a property that differs is kept, with `version` still dropped.
          expect(
            $createTextNode('hi').setMode('token').exportJSON(true),
          ).toEqual({mode: 'token', text: 'hi', type: 'text'});
        },
        {discrete: true},
      );
    });
  });
});

describe('the synthesized importJSON', () => {
  // Builds the node, then applies the serialized properties through the same
  // walk everything else uses — which is where a generated parser is reached,
  // and where what it leaves alone (NodeState, a replacement class) is handled
  // around it.
  const probeState = createState('probeFlag', {
    parse: v => (typeof v === 'string' ? v : ''),
  });

  class StatefulText extends TextNode {
    $config() {
      return this.config('stateful-text', {
        extends: TextNode,
        stateConfigs: [{flat: false, stateConfig: probeState}],
      });
    }
  }

  class ReplacedText extends TextNode {
    $config() {
      return this.config('replaced-text', {extends: TextNode});
    }
  }

  test('NodeState in the JSON is applied', () => {
    const editor = createEditor({
      namespace: '',
      nodes: [StatefulText],
      onError: err => {
        throw err;
      },
    });
    editor.update(
      () => {
        const node = $create(StatefulText);
        node.setTextContent('hi');
        $setState(node, probeState, 'kept');
        $getRoot().clear().append($createParagraphNode().append(node));
      },
      {discrete: true},
    );
    const json = JSON.stringify(editor.getEditorState().toJSON());
    expect(json).toContain(`"${NODE_STATE_KEY}"`);
    editor.parseEditorState(json).read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      invariant($isParagraphNode(paragraph), 'expected a paragraph');
      expect($getState(paragraph.getFirstChildOrThrow(), probeState)).toBe(
        'kept',
      );
    });
  });

  test('a replacement of the class is imported as itself', () => {
    // $applyNodeReplacement hands back a ReplacedText where TextNode was asked
    // for, and the walk resolves what to run from the node it is given.
    const editor = createEditor({
      namespace: '',
      nodes: [
        ReplacedText,
        {
          replace: TextNode,
          with: (node: TextNode) => new ReplacedText(node.__text),
          withKlass: ReplacedText,
        },
      ],
      onError: err => {
        throw err;
      },
    });
    editor.update(
      () => {
        const node = $createTextNode('hello').setStyle('color: red');
        expect(node).toBeInstanceOf(ReplacedText);
        $getRoot().clear().append($createParagraphNode().append(node));
      },
      {discrete: true},
    );
    const json = JSON.stringify(editor.getEditorState().toJSON());
    editor.parseEditorState(json).read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      invariant($isParagraphNode(paragraph), 'expected a paragraph');
      const node = paragraph.getFirstChildOrThrow();
      expect(node).toBeInstanceOf(ReplacedText);
      expect(node.getTextContent()).toBe('hello');
    });
  });

  // A hand-built factory stands in for the generator's output: each class
  // declares it in its own $config, which is all the resolution asks.
  const replacingGenerated: GeneratedJSONFactory = () => ({
    exportJSON: node => ({text: (node as TextNode).__text}),
    updateFromJSON: (node, json) => {
      // What a schema setter that hands back another node looks like to the
      // parser: the walk follows it, so the parser's caller must too.
      const replacement = $createTextNode(String(json.text)).setStyle(
        'swapped',
      );
      node.remove();
      return replacement;
    },
  });

  class ReplacingText extends TextNode {
    $config() {
      return this.config('replacing-text', {
        extends: TextNode,
        generated: replacingGenerated,
      });
    }
  }

  test('follows the node the generated parser returns', () => {
    const editor = createEditor({
      namespace: '',
      nodes: [ReplacingText],
      onError: err => {
        throw err;
      },
    });
    editor.update(
      () => {
        const node = ReplacingText.importJSON({
          text: 'hello',
          type: 'replacing-text',
          version: 1,
        } as SerializedTextNode);
        // $applyJSONSetters returns what the parser returned, and importJSON
        // hands that on.
        expect(node).not.toBeInstanceOf(ReplacingText);
        invariant($isTextNode(node), 'expected the replacement TextNode');
        expect(node.getStyle()).toBe('swapped');
        expect(node.getTextContent()).toBe('hello');
      },
      {discrete: true},
    );
  });

  const ctorState = createState('ctorFlag', {
    parse: v => (typeof v === 'string' ? v : ''),
  });

  const passthroughGenerated: GeneratedJSONFactory = () => ({
    exportJSON: node => ({text: (node as TextNode).__text}),
    updateFromJSON: node => node,
  });

  class ConstructedStateText extends TextNode {
    constructor(text = '', key?: string) {
      super(text, key);
      // A node that carries state before any property is applied, which the
      // generated parser knows nothing about.
      $setState(this, ctorState, 'from-constructor');
    }
    $config() {
      return this.config('constructed-state-text', {
        extends: TextNode,
        generated: passthroughGenerated,
      });
    }
  }

  test('state a constructor set is reset from JSON that carries none', () => {
    const editor = createEditor({
      namespace: '',
      nodes: [ConstructedStateText],
      onError: err => {
        throw err;
      },
    });
    editor.update(
      () => {
        const fresh = $create(ConstructedStateText);
        expect($getState(fresh, ctorState)).toBe('from-constructor');
        const imported = ConstructedStateText.importJSON({
          text: '',
          type: 'constructed-state-text',
          version: 1,
        } as SerializedTextNode);
        // What $updateStateFromJSON does for a node that carries state when
        // the JSON carries none: known state goes back to its default. The
        // generated parser neither writes state nor resets it, so this has to
        // happen around it.
        expect($getState(imported, ctorState)).toBe('');
      },
      {discrete: true},
    );
  });

  const flatState = createState('flatFlag', {
    parse: v => (typeof v === 'string' ? v : ''),
  });

  // A parser that applies only the schema's fields, as every generated parser
  // does: what a node carries in state is not known when code is generated.
  const fieldsOnlyGenerated: GeneratedJSONFactory = () => ({
    exportJSON: node => ({text: (node as TextNode).__text}),
    updateFromJSON: (node, json) => {
      (node as TextNode).__text =
        typeof json.text === 'string' ? json.text : '';
      return node;
    },
  });

  class FlatStateText extends TextNode {
    $config() {
      return this.config('flat-state-text', {
        extends: TextNode,
        generated: fieldsOnlyGenerated,
        stateConfigs: [{flat: true, stateConfig: flatState}],
      });
    }
  }

  test('flat NodeState is applied before the generated parser runs', () => {
    // The mirror of export, where the dispatch appends `__state.toJSON()`
    // around the generated literal: here the walk applies the flat state and
    // then hands the node to the parser for the fields.
    const editor = createEditor({
      namespace: '',
      nodes: [FlatStateText],
      onError: err => {
        throw err;
      },
    });
    editor.update(
      () => {
        const node = FlatStateText.importJSON({
          flatFlag: 'set',
          text: 'hello',
          type: 'flat-state-text',
          version: 1,
        } as never);
        expect($getState(node, flatState)).toBe('set');
        expect(node.getTextContent()).toBe('hello');
      },
      {discrete: true},
    );
  });
});

describe('generated updateFromJSON', () => {
  test('only a class the generator could compile has one', () => {
    // Every property of TextNode and of ParagraphNode has a domain the
    // compiler can state — a field write, or a set<Prop> whose return is
    // followed the way the walk follows it.
    expect(getGeneratedJSON(TextNode)?.updateFromJSON).toBeDefined();
    expect(getGeneratedJSON(ParagraphNode)?.updateFromJSON).toBeDefined();
    // TabNode declares three of its own properties export-only — the values
    // are fixed for a tab, so the walk derives them on import rather than
    // applying them — and inherits `format` and `style`, which it applies the
    // way TextNode does. A property with nothing to apply is one the parser
    // omits, not one that costs the class a parser: what the generated one
    // applies is exactly what the walk would.
    expect(getGeneratedJSON(TabNode)?.updateFromJSON).toBeDefined();
    // LineBreakNode declares no properties at all, so there is nothing for a
    // parser to do and the generator emits none rather than an empty one.
    expect(getGeneratedJSON(LineBreakNode)).not.toBeNull();
    expect(getGeneratedJSON(LineBreakNode)?.updateFromJSON).toBeUndefined();
  });

  test('a generated parser returns the node the walk would have', () => {
    // It can now apply a property through a method, and a setter is free to
    // return a different node — so the parser threads the return the way
    // $applyJSONSetters does, and hands back what it ended on.
    const updateParagraph = getGeneratedJSON(ParagraphNode)?.updateFromJSON;
    invariant(updateParagraph !== undefined, 'expected a generated parser');
    const editor = createEditor({onError: e => Promise.reject(e)});
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().clear().append(paragraph);
        expect(updateParagraph(paragraph, {format: 'center', indent: 3})).toBe(
          paragraph.getLatest(),
        );
        expect(paragraph.getLatest().getFormatType()).toBe('center');
        expect(paragraph.getLatest().getIndent()).toBe(3);
        // The constrained domain is enforced by the emitted bounds, not by a
        // setter: indent is `integer, min 0`.
        updateParagraph(paragraph.getLatest(), {indent: -2});
        expect(paragraph.getLatest().getIndent()).toBe(0);
        updateParagraph(paragraph.getLatest(), {indent: 1.5});
        expect(paragraph.getLatest().getIndent()).toBe(0);
      },
      {discrete: true},
    );
  });

  initializeUnitTest(testEnv => {
    test('a hostile key cannot reach Object.prototype through a table', () => {
      // The alias and `setterTable`s are indexed with a value straight out of
      // the JSON, so a plain object literal would resolve 'toString' to a
      // function and store it as the node's format.
      testEnv.editor.update(
        () => {
          for (const hostile of [
            'toString',
            'constructor',
            'hasOwnProperty',
            '__proto__',
            'valueOf',
          ]) {
            const node = $createTextNode('');
            node.updateFromJSON({
              detail: hostile,
              format: hostile,
              mode: hostile,
              style: '',
              text: '',
            } as never);
            expect(node.getFormat()).toBe(0);
            expect(node.getDetail()).toBe(0);
            expect(node.getMode()).toBe('normal');
          }
        },
        {discrete: true},
      );
    });

    test('the legacy string spellings still parse', () => {
      testEnv.editor.update(
        () => {
          const node = $createTextNode('');
          node.updateFromJSON({
            detail: 'unmergeable',
            format: 'bold',
            mode: 'token',
            style: '',
            text: 'x',
          } as never);
          expect(node.getFormat()).toBe(1);
          expect(node.getDetail()).toBe(2);
          expect(node.getMode()).toBe('token');
        },
        {discrete: true},
      );
    });
  });
});
