/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {MdastConfig} from '../../index';
import type {
  Construct,
  Extension as MicromarkExtension,
  State,
} from 'micromark-util-types';

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  configExtension,
  defineExtension,
  type LexicalEditor,
  TextNode,
} from 'lexical';
import {attention} from 'micromark-core-commonmark';
import {afterEach, describe, expect, it, onTestFinished, vi} from 'vitest';

import {parseEvents, strictEmphasis} from '../../cjkFriendly';
import {
  CMARK_GFM_MODEL_FIXTURES,
  type CmarkGfmModel,
  createCmarkGfmModel,
  isModelConfiguration,
  keyConfiguration,
  type ModelSubject,
  SUBJECT_TYPES,
} from '../../cmarkGfmModel';
import {
  getStrictMicromarkExtensions,
  getStrikethroughSyntax,
  isReferenceAgnostic,
  isReferenceNeutral,
  referenceAgnostic,
  referenceNeutral,
} from '../../compile';
import {
  $convertToMarkdownString,
  MdastCommonMarkExtension,
  MdastExtension,
  MdastGfmExtension,
} from '../../index';
import {probeCmarkGfmModel} from '../../MdastExport';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    markSequence: 'markSequence';
  }
}

// Counts the parses of the export, which the cmark-gfm pass alone makes in
// a strict export.
vi.mock('../../cjkFriendly', async importOriginal => {
  const original = await importOriginal<typeof import('../../cjkFriendly')>();
  return {...original, parseEvents: vi.fn(original.parseEvents)};
});
// Turns the model off (an editor made while `isModelConfiguration` returns
// false keeps parse verdicts), and lets a test read or change its verdicts.
vi.mock('../../cmarkGfmModel', async importOriginal => {
  const original = await importOriginal<typeof import('../../cmarkGfmModel')>();
  return {
    ...original,
    createCmarkGfmModel: vi.fn(original.createCmarkGfmModel),
    isModelConfiguration: vi.fn(original.isModelConfiguration),
  };
});

afterEach(() => {
  vi.mocked(createCmarkGfmModel).mockRestore();
  vi.mocked(isModelConfiguration).mockRestore();
});

// The input of 'splits a proposal that changes the reading in halves' in
// MdastCmarkGfm.test.ts, whose search rejects proposals and tries halves.
const SPLITS = '~~_a\\~\\~ba\\~\\~b_€a_b\\a~~___`!_.`___';
const SPLITS_REPAIRED = '~~_a\\~\\~ba\\~\\~b_&#x20AC;a_b\\a~~___`!_.`___';

/**
 * An editor whose export writes the text of each text node as raw HTML,
 * with GFM unless `config` says otherwise, and with parse verdicts alone
 * if `withModel` is false. Unlike `createRawEditor` and `exportRaw` in
 * MdastCmarkGfm.test.ts, which make an editor for each export, the helpers
 * here take the editor, so that its drift probe runs once.
 */
function createModelEditor(
  withModel = true,
  extensions: Parameters<typeof defineExtension>[0]['dependencies'] = [
    MdastGfmExtension,
  ],
  config: Partial<MdastConfig> = {},
  isWarm = true,
): LexicalEditor {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        ...(extensions || []),
        configExtension(MdastExtension, {
          ...config,
          exportRules: [
            {
              $export: node =>
                $isTextNode(node)
                  ? {type: 'html', value: node.getTextContent()}
                  : null,
              type: TextNode,
            },
          ],
        }),
      ],
      name: '[root]',
    }),
  );
  onTestFinished(() => editor.dispose());
  if (!withModel) {
    vi.mocked(isModelConfiguration).mockReturnValueOnce(false);
  }
  // Runs the drift probe, which runs once for the syntax of the editor.
  if (isWarm) {
    exportWith(editor, '©_a_');
  }
  return editor;
}

/** The strict syntax that `editor` exports with. */
function getSyntax(editor: LexicalEditor): MicromarkExtension[] {
  const {registry} = getExtensionDependencyFromEditor(
    editor,
    MdastExtension,
  ).output;
  return getStrictMicromarkExtensions(registry)!;
}

/** How `editor` exports `markdown`, written as raw HTML. */
function exportWith(editor: LexicalEditor, markdown: string): string {
  editor.update(
    () =>
      $getRoot()
        .clear()
        .append($createParagraphNode().append($createTextNode(markdown))),
    {discrete: true},
  );
  return editor.read('latest', () => $convertToMarkdownString());
}

/** How often `editor` parses as it exports `markdown`. */
function countParsesWith(editor: LexicalEditor, markdown: string): number {
  vi.mocked(parseEvents).mockClear();
  exportWith(editor, markdown);
  return vi.mocked(parseEvents).mock.calls.length;
}

/**
 * Runs `fn` with each model it makes wrapped by `wrap`, and returns the
 * models as they were made.
 */
function wrapModels(
  fn: () => void,
  wrap: (model: CmarkGfmModel, markdown: string) => CmarkGfmModel,
): CmarkGfmModel[] {
  const original = vi.mocked(createCmarkGfmModel).getMockImplementation()!;
  const models: CmarkGfmModel[] = [];
  vi.mocked(createCmarkGfmModel).mockImplementation((markdown, events) => {
    const model = original(markdown, events);
    models.push(model);
    return wrap(model, markdown);
  });
  try {
    fn();
  } finally {
    vi.mocked(createCmarkGfmModel).mockImplementation(original);
  }
  return models;
}

/** The verdicts of the models made while `fn` runs, judged and whole. */
function recordVerdicts(fn: () => void) {
  const verdicts: {
    markdown: string;
    proposed: number[];
    verdict: boolean | null;
    whole: boolean | null;
  }[] = [];
  wrapModels(fn, (model, markdown) => ({
    ...model,
    judge(subject, accepted, proposed) {
      // The whole subject first, as the judgement may move the state on.
      const whole = model.judgeWhole(subject, accepted, proposed);
      const verdict = model.judge(subject, accepted, proposed);
      verdicts.push({markdown, proposed: [...proposed], verdict, whole});
      return verdict;
    },
  }));
  return verdicts;
}

/**
 * The judgements of the models made while `fn` runs, and the items they
 * read in all.
 */
function measureWork(fn: () => void) {
  let judgements = 0;
  const models = wrapModels(fn, model => ({
    ...model,
    judge(subject, accepted, proposed) {
      judgements++;
      return model.judge(subject, accepted, proposed);
    },
  }));
  const itemsRead = models.reduce(
    (sum, model) => sum + model.countItemsRead(),
    0,
  );
  const stateWork = models.reduce(
    (sum, model) => sum + model.countStateWork(),
    0,
  );
  return {itemsRead, judgements, stateWork};
}

/** How many drift probes run while `fn` runs. */
function countProbes(fn: () => void): number {
  let probes = 0;
  wrapModels(fn, (model, markdown) => {
    if (markdown === CMARK_GFM_MODEL_FIXTURES[0]) {
      probes++;
    }
    return model;
  });
  return probes;
}

/**
 * The elements that the typed arrays fill, and that the splices of lists of
 * the model's items move (micromark's own splices aside), while `fn` runs.
 */
function countMoves(fn: () => void): {filled: number; spliced: number} {
  const typedArray: Uint8Array = Object.getPrototypeOf(Uint8Array.prototype);
  const {fill} = typedArray;
  const {splice} = Array.prototype;
  const counts = {filled: 0, spliced: 0};
  const fillSpy = vi.spyOn(typedArray, 'fill').mockImplementation(function (
    this: Uint8Array,
    value: number,
    start = 0,
    end = this.length,
  ) {
    const from = start < 0 ? this.length + start : start;
    const to = end < 0 ? this.length + end : Math.min(end, this.length);
    counts.filled += Math.max(0, to - from);
    return fill.call(this, value, start, end);
  });
  const spliceSpy = vi
    .spyOn(Array.prototype, 'splice')
    .mockImplementation(function (this: unknown[], ...args: unknown[]) {
      const first = this[0];
      if (typeof first === 'object' && first !== null && 'canOpen' in first) {
        counts.spliced += Math.max(0, this.length - (Number(args[0]) || 0));
      }
      return Reflect.apply(splice, this, args);
    });
  try {
    fn();
  } finally {
    fillSpy.mockRestore();
    spliceSpy.mockRestore();
  }
  return counts;
}

/** A `==mark==` syntax, unknown to the model. */
function createMark(): Construct {
  return {
    name: 'mark',
    resolveAll: events => events,
    tokenize(effects, ok, nok) {
      const second: State = code => {
        if (code !== 61) {
          return nok(code);
        }
        effects.consume(code);
        effects.exit('markSequence');
        return ok;
      };
      return code => {
        if (code !== 61) {
          return nok(code);
        }
        effects.enter('markSequence');
        effects.consume(code);
        return second;
      };
    },
  };
}

/** Whether `extension` is the GFM literal syntax, which reads `www.`. */
function isAutolinkLiteralSyntax(extension: MicromarkExtension): boolean {
  return (
    isReferenceAgnostic(extension) &&
    Boolean(extension.text && extension.text[119])
  );
}

/**
 * A flow construct that matches nothing, marked as one the model may judge
 * beside, which makes a new configuration.
 */
function createUnusedSyntax(): MicromarkExtension {
  const unused: Construct = {
    name: 'unused',
    tokenize: (_effects, _ok, nok) => nok,
  };
  return referenceNeutral(() => ({flow: {9731: unused}}));
}

/** The editors made with `configs` in turn, and whether each probed. */
function probeEach(configs: Partial<MdastConfig>[]): boolean[] {
  return configs.map(
    config =>
      countProbes(() => createModelEditor(true, [MdastGfmExtension], config)) >
      0,
  );
}

/** The model of `markdown` read with `syntax`, and its subjects. */
function readModel(
  markdown: string,
  syntax: MicromarkExtension[],
  change: (events: ReturnType<typeof parseEvents>) => void = () => {},
): {model: CmarkGfmModel; subjects: ModelSubject[]} {
  const events = parseEvents(markdown, syntax);
  change(events);
  const subjects: ModelSubject[] = [];
  for (const [kind, token] of events) {
    if (kind === 'enter' && SUBJECT_TYPES.test(token.type)) {
      subjects.push({
        end: token.end.offset,
        index: subjects.length,
        start: token.start.offset,
      });
    }
  }
  return {model: createCmarkGfmModel(markdown, events), subjects};
}

/**
 * The verdicts of the model of `markdown`, a paragraph, on `steps` of edits
 * as a search proposes them: each adds its edits to those accepted, which
 * take it in where the verdict is kept. Each verdict, judged around the
 * edits and from the whole subject.
 */
function judgeSteps(
  syntax: MicromarkExtension[],
  markdown: string,
  steps: number[][],
): {verdict: boolean | null; whole: boolean | null}[] {
  const {model, subjects} = readModel(markdown, syntax);
  // As the search, which adds the edits it accepts to the same set.
  const accepted = new Set<number>();
  return steps.map(step => {
    const proposed = [...new Set(step)].filter(edit => !accepted.has(edit));
    const whole = model.judgeWhole(subjects[0], accepted, proposed);
    const verdict = model.judge(subjects[0], accepted, proposed);
    if (verdict) {
      for (const edit of proposed) {
        accepted.add(edit);
      }
    }
    return {verdict, whole};
  });
}

/** A generator of numbers in [0, 1) from `seed` (mulberry32). */
function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The characters of the generated corpus.
const ALPHABET = [
  '*',
  '_',
  '~',
  'a',
  '©',
  '😀',
  '.',
  '`',
  '[',
  ']',
  '(',
  ')',
  '"',
  ' ',
];

// Inputs that the design review found the model reading otherwise, which
// each give the output of parse verdicts.
const COUNTEREXAMPLES = [
  '*~*a',
  '*`b`_©_a_©_a__©*a*',
  '*_._©*😀*',
  '*a _b_©*😀*',
  '~a _a_©~😀~',
  '*~*🎉_a_',
  'a*\u0000*a *~*a',
  '>_b\n>_*~*a',
  '[`b`_©_a_©_a__©*]()',
  'a_©~[~~**©~]~**~©]()',
  '[©_a_]\n\n[&#xA9;_a_]: /url',
  '[](u "b~*"*©_a_")',
  '[](u "€_©*"*©_~😀_")',
  '_a_©\udc00_a_',
  // A link's destination and title, and a full reference's label, hold
  // text that is not attention.
  '[x](u*a* "b*c*") ©_a_',
  '[a][b*c*] ©_a_\n\n[b*c*]: u',
  // The innermost label holds the items.
  '[*a ![b*](i) c*](u) ©_d_',
  // An edit that a closer after the window depends on.
  '~a~**~**😀_~~ ~_',
  '.***😀b ~~😀__b_a~',
  '©*a**😀__._😀___',
];

// Labels that a reference in them may make match a definition, where a
// parse judges the edit.
const BRACKETED = [
  '[\\[©_a_]\n\n[\\[&#xA9;_a_]: /url',
  '[©_a_\\]]\n\n[&#xA9;_a_\\]]: /url',
  '> [©_a_\n> b]\n>\n> [&#xA9;_a_ b]: /url',
  '[©_a_' + ' '.repeat(1000) + 'b]\n\n[&#xA9;_a_ b]: /url',
];

/** The generated corpus: `count` short inputs over {@link ALPHABET}. */
function generateCorpus(count: number): string[] {
  const random = createRandom(0x9983);
  const corpus: string[] = [];
  while (corpus.length < count) {
    const size = 3 + Math.floor(random() * 12);
    let markdown = '';
    for (let i = 0; i < size; i++) {
      markdown += ALPHABET[Math.floor(random() * ALPHABET.length)];
    }
    corpus.push(markdown.trim() || 'a');
  }
  return corpus;
}

const CORPUS = [...generateCorpus(3000), ...COUNTEREXAMPLES, ...BRACKETED];

describe('the model of the cmark-gfm pass', () => {
  it('parses a long paragraph twice', () => {
    const editor = createModelEditor();
    // The reading and the final check, where parse verdicts take 6n + 1
    // parses (769 here). They repair each copy, as alone.
    const markdown = Array(128).fill(SPLITS).join(' ');
    expect(countParsesWith(editor, markdown)).toBe(2);
    expect(exportWith(editor, markdown)).toBe(
      Array(128).fill(SPLITS_REPAIRED).join(' '),
    );
    const shorter = Array(16).fill(SPLITS).join(' ');
    expect(exportWith(editor, shorter)).toBe(
      exportWith(createModelEditor(false), shorter),
    );
  });

  it('judges as a parse, and exports as with parse verdicts', () => {
    const withModel = createModelEditor();
    const withParses = createModelEditor(false);
    expect(probeCmarkGfmModel(CORPUS, getSyntax(withModel))).toEqual([]);
    for (const markdown of CORPUS) {
      expect(exportWith(withModel, markdown)).toBe(
        exportWith(withParses, markdown),
      );
    }
  });

  it('judges around the edits as from the whole subject', () => {
    const editor = createModelEditor();
    const verdicts = recordVerdicts(() => {
      for (const markdown of CORPUS) {
        exportWith(editor, markdown);
      }
    });
    expect(verdicts.filter(({verdict}) => verdict !== null).length).toBe(
      verdicts.filter(({whole}) => whole !== null).length,
    );
    expect(verdicts.filter(({verdict, whole}) => verdict !== whole)).toEqual(
      [],
    );
    // Some proposals are kept and some are not.
    expect(verdicts.some(({verdict}) => verdict === true)).toBe(true);
    expect(verdicts.some(({verdict}) => verdict === false)).toBe(true);
  });

  it('searches again with parse verdicts when the final check fails', () => {
    const editor = createModelEditor();
    let flipped = 0;
    let parses = 0;
    let out = '';
    // A model that keeps every proposal.
    wrapModels(
      () => {
        parses = countParsesWith(editor, SPLITS);
        out = exportWith(editor, SPLITS);
      },
      model => ({
        ...model,
        judge(subject, accepted, proposed) {
          const verdict = model.judge(subject, accepted, proposed);
          if (verdict === false) {
            flipped++;
          }
          return verdict === null ? null : true;
        },
      }),
    );
    expect(flipped).toBeGreaterThan(0);
    // The reading, the final check, and the six parses of the search with
    // parse verdicts (seven with a reading of its own, which it reuses).
    expect(parses).toBe(2 + 6);
    expect(out).toBe(SPLITS_REPAIRED);
  });

  describe('configuration', () => {
    const mark = createMark();

    it.each<[string, () => LexicalEditor]>([
      ['without GFM strikethrough', () => createModelEditor(true, [])],
      [
        'with a syntax that disables a construct',
        () =>
          createModelEditor(true, [MdastGfmExtension], {
            micromarkExtensions: [{disable: {null: ['codeIndented']}}],
          }),
      ],
      [
        'with an unknown text construct',
        () =>
          createModelEditor(true, [MdastGfmExtension], {
            micromarkExtensions: [{text: {61: mark}}],
          }),
      ],
    ])('judges by parsing %s', (_, create) => {
      const editor = create();
      expect(isModelConfiguration(getSyntax(editor))).toBe(false);
      vi.mocked(createCmarkGfmModel).mockClear();
      expect(exportWith(editor, '©_a_')).toBe('&#xA9;_a_');
      expect(createCmarkGfmModel).not.toHaveBeenCalled();
    });

    it('judges with the model with the stock GFM extension', () => {
      const editor = createModelEditor();
      expect(isModelConfiguration(getSyntax(editor))).toBe(true);
      vi.mocked(createCmarkGfmModel).mockClear();
      expect(exportWith(editor, '©_a_')).toBe('&#xA9;_a_');
      expect(createCmarkGfmModel).toHaveBeenCalledTimes(1);
      expect(countParsesWith(editor, SPLITS)).toBe(2);
    });
  });

  describe('counterexamples', () => {
    it.each(COUNTEREXAMPLES)('exports %j as with parse verdicts', markdown => {
      const withModel = createModelEditor();
      expect(probeCmarkGfmModel([markdown], getSyntax(withModel))).toEqual([]);
      expect(exportWith(withModel, markdown)).toBe(
        exportWith(createModelEditor(false), markdown),
      );
    });

    it.each(BRACKETED)(
      'judges an edit in brackets by parsing with a definition: %j',
      markdown => {
        const editor = createModelEditor();
        const symbol = markdown.indexOf('©');
        const verdicts = recordVerdicts(() => exportWith(editor, markdown));
        for (const {proposed, verdict} of verdicts) {
          if (proposed.includes(symbol)) {
            expect(verdict).toBe(null);
          }
        }
        expect(exportWith(editor, markdown)).toBe(
          exportWith(createModelEditor(false), markdown),
        );
      },
    );

    it('stays fast after an opener left over before a long paragraph', () => {
      // Every window may reach back to the opener: the window ends at the
      // nearest closer that may take it, not at the end of the paragraph.
      const editor = createModelEditor();
      const markdown = `x *b ${Array(64).fill(`*${SPLITS}*`).join(' ')}`;
      const start = performance.now();
      expect(countParsesWith(editor, markdown)).toBe(2);
      expect(performance.now() - start).toBeLessThan(2_000);
      expect(exportWith(editor, markdown)).toBe(
        `x *b ${Array(64).fill(`*${SPLITS_REPAIRED}*`).join(' ')}`,
      );
      const shorter = `x *b ${Array(8).fill(`*${SPLITS}*`).join(' ')}`;
      expect(exportWith(editor, shorter)).toBe(
        exportWith(createModelEditor(false), shorter),
      );
    });
  });
  describe('work', () => {
    it('marks nested brackets in time linear in their number', () => {
      const editor = createModelEditor();
      const markdown = (size: number) =>
        '`' + '['.repeat(size) + ']'.repeat(size) + '` ©_a_\n\n[x]: /u';
      const long = markdown(2000);
      const {filled} = countMoves(() => exportWith(editor, long));
      expect(filled).toBeLessThan(64 * long.length);
      expect(exportWith(editor, long)).toBe(long.replace('©', '&#xA9;'));
      expect(exportWith(editor, markdown(8))).toBe(
        exportWith(createModelEditor(false), markdown(8)),
      );
    });

    it('reads the brackets of an inline link without definitions', () => {
      // The label of an inline link does not match a definition, so the
      // model judges an edit in it; the brackets inside it may.
      const editor = createModelEditor();
      const outside = '[a ©_a_ b](u)\n\n[©_a_]: /u';
      const inside = '[a [©_a_] b](u)\n\n[©_a_]: /u';
      const symbol = (markdown: string) => markdown.indexOf('©');
      const outer = recordVerdicts(() => exportWith(editor, outside)).filter(
        ({proposed}) => proposed.includes(symbol(outside)),
      );
      expect(outer.length).toBeGreaterThan(0);
      expect(outer.every(({verdict}) => verdict === true)).toBe(true);
      const inner = recordVerdicts(() => exportWith(editor, inside)).filter(
        ({proposed}) => proposed.includes(symbol(inside)),
      );
      expect(inner.every(({verdict}) => verdict === null)).toBe(true);
      const withParses = createModelEditor(false);
      expect(exportWith(editor, outside)).toBe(exportWith(withParses, outside));
      expect(exportWith(editor, inside)).toBe(exportWith(withParses, inside));
    });

    it('stops widening a window past twice the items of the subject', () => {
      // Each closer pulled in fails on the rule of three, and widens the
      // window again to the opener before it.
      const markdown = (size: number) =>
        'x*a ©_a_ ' + Array(size).fill('a** ').join(' ');
      const editor = createModelEditor();
      const long = markdown(256);
      const items = long.match(/[*_~]+/g)!.length;
      const {itemsRead, judgements} = measureWork(() =>
        exportWith(editor, long),
      );
      expect(judgements).toBeGreaterThan(0);
      expect(itemsRead).toBeLessThan(8 * (judgements + 1) * items);
      const verdicts = recordVerdicts(() => exportWith(editor, long));
      expect(verdicts.filter(({verdict, whole}) => verdict !== whole)).toEqual(
        [],
      );
      expect(exportWith(editor, long)).toBe(
        exportWith(createModelEditor(false), long),
      );
    });

    it('judges a paragraph that one pair wraps around the edits', () => {
      // No item of the paragraph is outside the pair, or the two pairs:
      // windows inside them read less than one copy's items each time.
      const items = SPLITS.match(/[*_~]+/g)!.length;
      for (const wrap of [
        (inner: string) => `*x ${inner} x*`,
        (inner: string) => `**y *x ${inner} x* y**`,
        (inner: string) => `***z ${inner} z***`,
      ]) {
        const editor = createModelEditor();
        const markdown = wrap(Array(256).fill(SPLITS).join(' '));
        const {itemsRead, judgements} = measureWork(() =>
          exportWith(editor, markdown),
        );
        expect(judgements).toBeGreaterThan(256);
        expect(itemsRead).toBeLessThan(judgements * items);
        expect(exportWith(editor, markdown)).toBe(
          wrap(Array(256).fill(SPLITS_REPAIRED).join(' ')),
        );
      }
    });

    it('judges a long paragraph around the edits', () => {
      // Each judgement reads less than one copy's items: windows around the
      // edits, against the state of the edits accepted so far.
      const editor = createModelEditor();
      const markdown = Array(1024).fill(SPLITS).join(' ');
      const items = SPLITS.match(/[*_~]+/g)!.length;
      const {itemsRead, judgements} = measureWork(() =>
        exportWith(editor, markdown),
      );
      expect(judgements).toBeGreaterThan(1024);
      expect(itemsRead).toBeLessThan(judgements * items);
    });

    it('keeps the state of a long paragraph around the edits', () => {
      // A kept proposal changes the state only in its windows, and a
      // judgement does not read the edits accepted before.
      const editor = createModelEditor();
      const markdown = Array(1024).fill(SPLITS).join(' ');
      const {judgements, stateWork} = measureWork(() =>
        exportWith(editor, markdown),
      );
      expect(judgements).toBeGreaterThan(1024);
      expect(stateWork).toBeLessThan(16 * judgements);
    });

    it('widens a window only to leftovers before its first item', () => {
      // Each edit makes a closer of a `*` that no opener before it takes.
      const syntax = getSyntax(createModelEditor());
      const markdown = `x *a ${Array(200).fill('a©_a_ ©*a').join(' ')}`;
      const {model, subjects} = readModel(markdown, syntax);
      const accepted = new Set<number>();
      let judgements = 0;
      for (let i = 0; i < markdown.length; i++) {
        if (markdown[i] === '©' || markdown[i] === 'a') {
          judgements++;
          if (model.judge(subjects[0], accepted, [i])) {
            accepted.add(i);
          }
        }
      }
      expect(model.countItemsRead()).toBeLessThan(16 * judgements);
    });

    it('reads the runs of labels and of three `~` within the budget', () => {
      // Neither is an item of a window, but a window reads them.
      const syntax = getSyntax(createModelEditor());
      const later = Array(1024).fill('a** ').join(' ');
      for (const inside of [
        `[${Array(4096).fill('*b*').join(' ')}](u)`,
        Array(4096).fill('a~~~b~~~c').join(' '),
      ]) {
        const markdown = `x*a ©_a_ ${inside} ${later}`;
        const {model, subjects} = readModel(markdown, syntax);
        model.judge(subjects[0], new Set(), [4]);
        // The state, the windows up to the budget, and the whole subject.
        expect(model.countPositionsRead()).toBeLessThan(
          8 * markdown.match(/[*_~]/g)!.length,
        );
      }
    });

    it('takes off what the items of a kept window left over before', () => {
      // Each edit, from the end, makes the `*` of a copy a closer that
      // leaves no opener over: a state that kept the old leftovers would
      // pull every later window back to them.
      const syntax = getSyntax(createModelEditor());
      const markdown = `x~ ${Array(60).fill('a*aa *').join(' ')}x`;
      const {model, subjects} = readModel(markdown, syntax);
      const accepted = new Set<number>();
      let judgements = 0;
      for (let i = markdown.length - 1; i >= 0; i--) {
        if (markdown[i] === 'a') {
          judgements++;
          if (model.judge(subjects[0], accepted, [i])) {
            accepted.add(i);
          }
        }
      }
      expect(model.countItemsRead()).toBeLessThan(8 * judgements);
    });

    it('keeps the state of a kept judgement of the whole subject', () => {
      // An edit in a label is judged from the whole subject, whose state the
      // next judgement starts from rather than building it again.
      const syntax = getSyntax(createModelEditor());
      const markdown = Array(50).fill('[©_a_](u)').join(' ');
      const {model, subjects} = readModel(markdown, syntax);
      const items = markdown.match(/[*_~]+/g)!.length;
      const accepted = new Set<number>();
      let judgements = 0;
      for (let i = 0; i < markdown.length; i++) {
        if (markdown[i] === '©') {
          judgements++;
          if (model.judge(subjects[0], accepted, [i])) {
            accepted.add(i);
          }
        }
      }
      expect(accepted.size).toBe(50);
      expect(model.countItemsRead()).toBeLessThanOrEqual(
        (judgements + 2) * items,
      );
    });

    it('finds the brackets of a subject once', () => {
      // With a definition, a parse judges an edit in brackets; whether an
      // edit is in brackets is read from one scan of the subject.
      const editor = createModelEditor();
      const markdown = `${Array(256).fill(SPLITS).join(' ')}\n\n[x]: /u`;
      let positions = 0;
      const models = wrapModels(
        () => exportWith(editor, markdown),
        model => model,
      );
      for (const model of models) {
        positions += model.countPositionsRead();
      }
      expect(positions).toBeLessThan(8 * markdown.length);
    });

    it('reads the runs of a window, not the text between them', () => {
      const editor = createModelEditor();
      const markdown = (gap: number) =>
        `x*a ©_a_ ${'b'.repeat(gap)} ${Array(256).fill('a** ').join(' ')}`;
      const long = markdown(65536);
      let positions = 0;
      wrapModels(
        () => exportWith(editor, long),
        model => ({
          ...model,
          judge(subject, accepted, proposed) {
            const before = model.countPositionsRead();
            const verdict = model.judge(subject, accepted, proposed);
            positions += model.countPositionsRead() - before;
            return verdict;
          },
        }),
      );
      expect(positions).toBeGreaterThan(0);
      expect(positions).toBeLessThan(16 * long.match(/[*_~]+/g)!.length);
      expect(exportWith(editor, markdown(64))).toBe(
        exportWith(createModelEditor(false), markdown(64)),
      );
    });

    it('pairs a long paragraph without moving its items', () => {
      const editor = createModelEditor();
      const long = `${Array(4000).fill('*a* _b_').join(' ')} ©_a_`;
      const {spliced} = countMoves(() => exportWith(editor, long));
      expect(spliced).toBeLessThan(64 * long.length);
      const short = `${Array(8).fill('*a* _b_').join(' ')} ©_a_`;
      expect(exportWith(editor, short)).toBe(
        exportWith(createModelEditor(false), short),
      );
    });
  });
  describe('drift probe', () => {
    it('reads each fixture as one paragraph', () => {
      const syntax = getSyntax(createModelEditor());
      for (const fixture of CMARK_GFM_MODEL_FIXTURES) {
        const types = parseEvents(fixture, syntax)
          .filter(([kind]) => kind === 'enter')
          .map(([, token]) => token.type);
        expect(types.filter(type => type === 'paragraph')).toEqual([
          'paragraph',
        ]);
        expect(types).not.toContain('codeFenced');
      }
    });

    it('runs once for a configuration, whatever editor has it', () => {
      createModelEditor();
      const unused = createUnusedSyntax();
      const create = () =>
        createModelEditor(
          true,
          [MdastGfmExtension],
          {
            micromarkExtensions: [unused],
          },
          false,
        );
      const probes = countProbes(() => {
        // The first editor of the configuration probes: 25 fixtures parse
        // once or more each.
        expect(countParsesWith(create(), '©_a_')).toBeGreaterThan(25);
        // Another editor of it, or of the stock one, reads the result.
        expect(countParsesWith(create(), '©_a_')).toBe(2);
        expect(
          countParsesWith(
            createModelEditor(true, undefined, {}, false),
            '©_a_',
          ),
        ).toBe(2);
      });
      expect(probes).toBe(1);
    });

    it('keeps the last 16 configurations it probed', () => {
      const configs = Array.from({length: 17}, () => ({
        micromarkExtensions: [createUnusedSyntax()],
      }));
      // 16 configurations, the first of them read again, which keeps it,
      // then one more, which drops the one read longest ago.
      expect(probeEach(configs.slice(0, 16))).toEqual(Array(16).fill(true));
      expect(probeEach([configs[0], configs[16]])).toEqual([false, true]);
      expect(probeEach([configs[0], configs[2], configs[1]])).toEqual([
        false,
        false,
        true,
      ]);
    });

    it('reads the configuration of an editor once', () => {
      const editor = createModelEditor();
      vi.mocked(isModelConfiguration).mockClear();
      expect(exportWith(editor, '©_a_')).toBe('&#xA9;_a_');
      expect(exportWith(editor, '©_b_')).toBe('&#xA9;_b_');
      expect(isModelConfiguration).not.toHaveBeenCalled();
    });

    it('runs once for editors whose syntax is made anew', () => {
      const probes = countProbes(() => {
        for (let i = 0; i < 3; i++) {
          createModelEditor(true, [], {
            micromarkExtensions: [getStrikethroughSyntax()],
          });
        }
      });
      expect(probes).toBe(1);
    });

    it.each<
      [string, (model: CmarkGfmModel, markdown: string) => CmarkGfmModel]
    >([
      [
        'pairs',
        (model, markdown) => ({
          ...model,
          readsBase: subject => markdown !== SPLITS && model.readsBase(subject),
        }),
      ],
      [
        'verdicts around the edits',
        (model, markdown) => ({
          ...model,
          judge(subject, accepted, proposed) {
            const verdict = model.judge(subject, accepted, proposed);
            return markdown === SPLITS && verdict !== null ? !verdict : verdict;
          },
        }),
      ],
      [
        'verdicts of the whole subject',
        (model, markdown) => ({
          ...model,
          judgeWhole(subject, accepted, proposed) {
            const verdict = model.judgeWhole(subject, accepted, proposed);
            return markdown === SPLITS && verdict !== null ? !verdict : verdict;
          },
        }),
      ],
    ])('turns the model off where it reads the %s otherwise', (_, misread) => {
      const config = {micromarkExtensions: [createUnusedSyntax()]};
      let editor!: LexicalEditor;
      wrapModels(() => {
        editor = createModelEditor(true, [MdastGfmExtension], config);
        expect(
          probeCmarkGfmModel(CMARK_GFM_MODEL_FIXTURES, getSyntax(editor)),
        ).not.toEqual([]);
      }, misread);
      // The search with parse verdicts, also in another editor of the
      // configuration, which reads the result of the probe.
      expect(countParsesWith(editor, SPLITS)).toBe(7);
      expect(exportWith(editor, SPLITS)).toBe(SPLITS_REPAIRED);
      const other = createModelEditor(true, [MdastGfmExtension], config, false);
      expect(countParsesWith(other, SPLITS)).toBe(7);
    });

    it('compares the pairs of every fixture, searched or not', () => {
      const syntax = getSyntax(createModelEditor());
      for (const fixture of CMARK_GFM_MODEL_FIXTURES) {
        wrapModels(
          () => expect(probeCmarkGfmModel([fixture], syntax)).not.toEqual([]),
          (model, markdown) => ({
            ...model,
            readsBase: () => markdown !== fixture,
          }),
        );
      }
    });
  });

  describe('guards', () => {
    it('accepts the strict emphasis and the strikethrough by identity', () => {
      const strikethrough = getStrikethroughSyntax();
      const copy: Construct = {...attention};
      expect(isModelConfiguration([strictEmphasis(), strikethrough])).toBe(
        true,
      );
      for (const emphasis of [
        {insideSpan: {null: [attention]}, text: {42: copy, 95: attention}},
        {insideSpan: {null: [attention]}, text: {42: attention, 95: copy}},
        {insideSpan: {null: [copy]}, text: {42: attention, 95: attention}},
        {
          attentionMarkers: {null: [126]},
          insideSpan: {null: [attention]},
          text: {42: attention, 95: attention},
        },
      ]) {
        expect(isModelConfiguration([emphasis, strikethrough])).toBe(false);
      }
      expect(isModelConfiguration([strictEmphasis(), {...strikethrough}])).toBe(
        false,
      );
      // One that derives from it holds the brand only through its prototype.
      expect(
        isModelConfiguration([strictEmphasis(), Object.create(strikethrough)]),
      ).toBe(false);
    });

    it('judges a subject by parsing where it misreads its pairs', () => {
      const syntax = getSyntax(createModelEditor());
      // The first paragraph's emphasis read as strong.
      const {model, subjects} = readModel(
        '©_a_ *b*\n\n©_a_ *b*',
        syntax,
        events => {
          const pair = events.find(([, token]) => token.type === 'emphasis')!;
          pair[1].type = 'strong';
        },
      );
      expect(model.readsBase(subjects[0])).toBe(false);
      expect(model.readsBase(subjects[1])).toBe(true);
      expect(model.judge(subjects[0], new Set(), [0])).toBe(null);
      expect(model.judge(subjects[1], new Set(), [10])).toBe(true);
    });

    it('judges by parsing while an accepted edit is ASCII punctuation', () => {
      const syntax = getSyntax(createModelEditor());
      const {model, subjects} = readModel('.*a* ©_a_', syntax);
      expect(model.judge(subjects[0], new Set(), [5])).toBe(true);
      expect(model.judge(subjects[0], new Set([0]), [5])).toBe(null);
    });

    it.each([
      ['ASCII punctuation', '\\©_a_ b', [0, 6], 1],
      ['whitespace', 'www.a \\©_a_ b', [5, 12], 7],
      ['a literal run', 'www.ab \\©_a_ b', [4, 13], 8],
    ])(
      'keeps the parse guard after a later accepted text edit (%s)',
      (_name, markdown, accepted, proposed) => {
        // The first accepted edit needs a parse, the last one does not.
        const syntax = getSyntax(createModelEditor());
        const {model, subjects} = readModel(markdown, syntax);
        expect(model.judge(subjects[0], new Set(accepted), [proposed])).toBe(
          null,
        );
      },
    );

    it('reads an ASCII punctuation edit that joins the same set', () => {
      // The search takes in the first `©` that the model kept, then the `.`
      // that a parse kept: the set it judges against grows by an ASCII
      // punctuation edit, and a parse judges from then on.
      const syntax = getSyntax(createModelEditor());
      const markdown = '.*a* ©_a_ ©_b_';
      const {model, subjects} = readModel(markdown, syntax);
      const accepted = new Set<number>();
      const first = markdown.indexOf('©');
      expect(model.judge(subjects[0], accepted, [first])).toBe(true);
      accepted.add(first);
      expect(model.judge(subjects[0], accepted, [0])).toBe(null);
      accepted.add(0);
      expect(
        model.judge(subjects[0], accepted, [markdown.lastIndexOf('©')]),
      ).toBe(null);
    });

    it('reads a syntax made from a marked one as unmarked', () => {
      // A flow construct that a reference at the start of a line turns off,
      // in place of the table syntax's.
      const flow: Construct = {
        name: 'euro',
        tokenize(effects, ok, nok) {
          const inside: State = code => {
            if (code === null || code < 0) {
              effects.exit('chunkText');
              effects.exit('markSequence');
              effects.exit('paragraph');
              return ok(code);
            }
            effects.consume(code);
            return inside;
          };
          return code => {
            if (code !== 8364) {
              return nok(code);
            }
            effects.enter('paragraph');
            effects.enter('markSequence');
            effects.enter('chunkText', {contentType: 'text'});
            return inside(code);
          };
        },
      };
      const table = getSyntax(createModelEditor()).find(isReferenceNeutral)!;
      const derived: MicromarkExtension = Object.assign(Object.create(table), {
        flow: {8364: flow},
      });
      expect(isReferenceNeutral(derived)).toBe(false);
      // The same for the GFM literal syntax with a text construct replaced.
      const literals = getSyntax(createModelEditor()).find(
        isAutolinkLiteralSyntax,
      )!;
      expect(
        isModelConfiguration([
          strictEmphasis(),
          getStrikethroughSyntax(),
          Object.assign(Object.create(literals), {text: {61: createMark()}}),
        ]),
      ).toBe(false);
      // A spread of the table syntax, which the mark does not reach, as it
      // is not enumerable.
      const spread: MicromarkExtension = {...table, flow: {8364: flow}};
      for (const extension of [derived, spread]) {
        const editor = createModelEditor(true, [MdastGfmExtension], {
          micromarkExtensions: [extension],
        });
        expect(isModelConfiguration(getSyntax(editor))).toBe(false);
        vi.mocked(createCmarkGfmModel).mockClear();
        expect(exportWith(editor, '€_a_')).toBe('€_a_');
        expect(createCmarkGfmModel).not.toHaveBeenCalled();
      }
    });

    it('resolves a label strikethrough first', () => {
      // micromark pairs the `~` in the label, and the `*` stays text.
      const syntax = getSyntax(createModelEditor());
      const markdown = '[~a *b~ c*](u)';
      const types = parseEvents(markdown, syntax)
        .filter(([kind]) => kind === 'enter')
        .map(([, token]) => token.type);
      expect(types).toContain('strikethrough');
      expect(types).not.toContain('emphasis');
      const {model, subjects} = readModel(markdown, syntax);
      expect(model.readsBase(subjects[0])).toBe(true);
      expect(CMARK_GFM_MODEL_FIXTURES).toContain(markdown);
    });

    it('parses the edits of a round once each', () => {
      // A flow block whose line, with references read as their characters,
      // holds `€€`, which neither paragraph does: the edits of a later
      // subject's parse must not hold an earlier subject's twice.
      const flow: Construct = {
        name: 'doubleEuro',
        tokenize(effects, ok, nok) {
          let line = '';
          effects.enter('thematicBreak');
          const inside: State = code => {
            if (code === null || code < 0) {
              const read = line.replace(
                /&#(?:x([0-9a-f]+)|(\d+));/gi,
                (_, hex, decimal) =>
                  String.fromCodePoint(parseInt(hex || decimal, hex ? 16 : 10)),
              );
              if (!read.includes('€€')) {
                return nok(code);
              }
              effects.exit('thematicBreak');
              return ok(code);
            }
            line += String.fromCharCode(code);
            effects.consume(code);
            return inside;
          };
          return inside;
        },
      };
      const config = {
        micromarkExtensions: [referenceNeutral(() => ({flow: {null: flow}}))],
      };
      const markdown = `${SPLITS}\n\n[${SPLITS}]\n\n[x]: /u`;
      const editor = createModelEditor(true, [MdastGfmExtension], config);
      vi.mocked(parseEvents).mockClear();
      const out = exportWith(editor, markdown);
      for (const [parsed] of vi.mocked(parseEvents).mock.calls) {
        expect(parsed).not.toContain('&#x20AC;&#x20AC;');
      }
      expect(out).toBe(
        exportWith(
          createModelEditor(false, [MdastGfmExtension], config),
          markdown,
        ),
      );
      expect(out).toBe(`${SPLITS_REPAIRED}\n\n[${SPLITS_REPAIRED}]\n\n[x]: /u`);
    });

    it('resolves strikethrough first where a label holds the first item', () => {
      // micromark resolves in the order its constructs are first used, and
      // reads a label's text as it reads the rest: the label's `~` comes
      // first, so `~b*c~` pairs, not `*a~b*`.
      const syntax = getSyntax(createModelEditor());
      const markdown = '[~x~](u) *a~b*c~';
      const types = parseEvents(markdown, syntax)
        .filter(([kind]) => kind === 'enter')
        .map(([, token]) => token.type);
      expect(types.filter(type => type === 'strikethrough').length).toBe(2);
      expect(types).not.toContain('emphasis');
      const {model, subjects} = readModel(markdown, syntax);
      expect(model.readsBase(subjects[0])).toBe(true);
      // The state that a judgement reads against follows the same order.
      for (const edit of [10, 12, 14]) {
        expect(model.judge(subjects[0], new Set(), [edit])).toBe(
          model.judgeWhole(subjects[0], new Set(), [edit]),
        );
      }
    });

    it('judges an edit beside a label from the whole subject', () => {
      // A window leaves label items out, so an edit that makes a pair in a
      // label is judged with the whole subject.
      const syntax = getSyntax(createModelEditor());
      const {model, subjects} = readModel('[a_a_](u) *b*', syntax);
      expect(model.judgeWhole(subjects[0], new Set(), [1])).toBe(false);
      expect(model.judge(subjects[0], new Set(), [1])).toBe(false);
    });

    it('keeps the CJK-friendly export of a syntax made from a marked one', () => {
      // A syntax made from the GFM literal syntax, as the CJK-friendly export
      // read it before: the references beside its markers still go.
      const stock = getSyntax(createModelEditor()).find(
        isAutolinkLiteralSyntax,
      )!;
      const editor = createModelEditor(true, [MdastGfmExtension], {
        exportPunctuation: 'cjk-friendly',
        micromarkExtensions: [Object.create(stock)],
      });
      for (const [markdown, expected] of [
        ['*&#x4F60;.', '*你.'],
        ['*&#x4F60;+', '*你+'],
        ['-&#x4F60;*', '-你*'],
        ['*&#x4F60;_', '*&#x4F60;_'],
        ['*&#x4F60;!', '*你!'],
      ]) {
        expect(exportWith(editor, markdown)).toBe(expected);
      }
    });

    it('judges an edit in brackets without a definition', () => {
      const syntax = getSyntax(createModelEditor());
      const {model, subjects} = readModel('[©_a_] b', syntax);
      expect(model.judge(subjects[0], new Set(), [1])).toBe(true);
    });

    it('reads the edits that a parse kept since its last judgement', () => {
      // The search takes in an edit that a parse judged: the set grows past
      // the edits of the last kept judgement.
      const syntax = getSyntax(createModelEditor());
      const markdown = 'x😀___*😀.aa*a* *~a__😀 . _~ x';
      const {model, subjects} = readModel(markdown, syntax);
      const accepted = new Set<number>();
      const steps: [number[], boolean][] = [
        [[10, 18, 7], false],
        [[13, 1], true],
        [[11], false],
        [[21], false],
      ];
      for (const [step, byParse] of steps) {
        const proposed = step.filter(edit => !accepted.has(edit));
        const whole = model.judgeWhole(subjects[0], accepted, proposed);
        if (!byParse) {
          expect(model.judge(subjects[0], accepted, proposed)).toBe(whole);
        }
        if (whole) {
          for (const edit of proposed) {
            accepted.add(edit);
          }
        }
      }
    });

    // The brackets of an inline link consult no definition, but a label
    // inside them does.
    it.each([
      ['[[©_a_]]\n\n[&#xA9;_a_]: /u', 2],
      ['[[©_a_]](u)\n\n[&#xA9;_a_]: /u', 2],
      ['[x [©_a_]](u)\n\n[&#xA9;_a_]: /u', 4],
    ])('judges a nested unresolved label in %j by parsing', (markdown, at) => {
      const syntax = getSyntax(createModelEditor());
      const {model, subjects} = readModel(markdown, syntax);
      expect(model.readsBase(subjects[0])).toBe(true);
      expect(markdown[at]).toBe('©');
      expect(model.judge(subjects[0], new Set(), [at])).toBe(null);
      expect(model.judgeWhole(subjects[0], new Set(), [at])).toBe(null);
      expect(probeCmarkGfmModel([markdown], syntax)).toEqual([]);
    });

    it('reads an escaped bracket as text', () => {
      const syntax = getSyntax(createModelEditor());
      // The `]` closes no bracket, so the model judges the edit.
      const {model, subjects} = readModel('\\[©_a_]\n\n[x]: /u', syntax);
      expect(model.judge(subjects[0], new Set(), [2])).toBe(true);
    });

    it('exports a document that starts with a byte order mark as before', () => {
      // micromark drops the mark, so the search finds nothing to repair, as
      // on main; one later in the document is a character.
      const editor = createModelEditor();
      expect(exportWith(editor, '\ufeff©_a_ *b*')).toBe('\ufeff©_a_ *b*');
      expect(exportWith(editor, 'x\n\n\ufeff©_a_')).toBe(
        exportWith(createModelEditor(false), 'x\n\n\ufeff©_a_'),
      );
    });

    it('reads the edits of each subject alone', () => {
      // A proposal after a literal backslash in the second paragraph is
      // not the first paragraph's.
      const editor = createModelEditor();
      const markdown = '©_a_\n\n\\©_a_';
      expect(exportWith(editor, markdown)).toBe(
        exportWith(createModelEditor(false), markdown),
      );
      expect(exportWith(editor, markdown).split('\n\n')[0]).toBe('&#xA9;_a_');
      // Nor are the edits of an earlier paragraph the later one's, though
      // the search lists every edit, unsorted.
      expect(exportWith(editor, '\\©_a_\n\n©_a_')).toBe('\\©_a_\n\n&#xA9;_a_');
      expect(countParsesWith(editor, `${SPLITS}\n\n©_a_`)).toBe(2);
    });

    it('repairs after a backslash that another escapes', () => {
      const editor = createModelEditor();
      expect(exportWith(editor, '\\\\©_a_')).toBe('\\\\&#xA9;_a_');
    });

    it('reads every construct of an extension it knows', () => {
      const mark = createMark();
      const strikethrough = getStrikethroughSyntax();
      strikethrough.text = {...strikethrough.text, 61: mark};
      const combined = (): MicromarkExtension => ({
        ...strictEmphasis(),
        text: {42: attention, 61: mark, 95: attention},
      });
      const inherited: MicromarkExtension = {text: Object.create({61: mark})};
      const inheritedHook: MicromarkExtension = Object.create({
        text: {61: mark},
      });
      expect(isModelConfiguration([combined(), getStrikethroughSyntax()])).toBe(
        false,
      );
      expect(isModelConfiguration([strictEmphasis(), strikethrough])).toBe(
        false,
      );
      expect(
        isModelConfiguration([
          strictEmphasis(),
          getStrikethroughSyntax(),
          inherited,
        ]),
      ).toBe(false);
      expect(
        isModelConfiguration([
          strictEmphasis(),
          getStrikethroughSyntax(),
          inheritedHook,
        ]),
      ).toBe(false);
      const config = {micromarkExtensions: [combined()]};
      const editor = createModelEditor(true, [MdastGfmExtension], config);
      expect(isModelConfiguration(getSyntax(editor))).toBe(false);
      vi.mocked(createCmarkGfmModel).mockClear();
      expect(exportWith(editor, '*~*a==©b==')).toBe(
        exportWith(
          createModelEditor(false, [MdastGfmExtension], config),
          '*~*a==©b==',
        ),
      );
      expect(createCmarkGfmModel).not.toHaveBeenCalled();
    });

    it('reads an empty list or a falsy value as no construct', () => {
      // micromark adds no construct for either, so the model stays on.
      for (const empty of [[], null, undefined, 0, '']) {
        expect(
          isModelConfiguration([
            strictEmphasis(),
            getStrikethroughSyntax(),
            {text: {61: empty as never}},
          ]),
        ).toBe(true);
      }
    });

    it('searches again with parses only when the model judged', () => {
      const editor = createModelEditor(false);
      const original = vi.mocked(parseEvents).getMockImplementation()!;
      const asQuote: typeof original = (markdown, extensions) => {
        const events = original(markdown, extensions);
        events[0][1].type = 'blockQuote';
        return events;
      };
      // The reading, and then every parse reads the heading as a quote, so
      // the final check fails. Every verdict was a parse already: the
      // search does not run again.
      vi.mocked(parseEvents)
        .mockClear()
        .mockImplementationOnce(original)
        .mockImplementation(asQuote);
      expect(exportWith(editor, '# ©_a_')).toBe('# ©_a_');
      const parses = vi.mocked(parseEvents).mock.calls.length;
      vi.mocked(parseEvents).mockImplementation(original);
      // The reading and the final check.
      expect(parses).toBe(2);
    });

    it('reads every hook of an extension it does not know as unknown', () => {
      // A flow construct that a reference at the start of a line turns off.
      const flow: Construct = {
        name: 'euro',
        tokenize(effects, ok, nok) {
          const inside: State = code => {
            if (code === null || code < 0) {
              effects.exit('chunkText');
              effects.exit('markSequence');
              effects.exit('paragraph');
              return ok(code);
            }
            effects.consume(code);
            return inside;
          };
          return code => {
            if (code !== 8364) {
              return nok(code);
            }
            effects.enter('paragraph');
            effects.enter('markSequence');
            effects.enter('chunkText', {contentType: 'text'});
            return inside(code);
          };
        },
      };
      const config = {micromarkExtensions: [{flow: {8364: flow}}]};
      const editor = createModelEditor(true, [MdastGfmExtension], config);
      expect(isModelConfiguration(getSyntax(editor))).toBe(false);
      vi.mocked(createCmarkGfmModel).mockClear();
      expect(exportWith(editor, '€_a_')).toBe('€_a_');
      expect(createCmarkGfmModel).not.toHaveBeenCalled();
      // The stock syntax, tables too, keeps the model.
      const stock = createModelEditor(true, [
        MdastCommonMarkExtension,
        MdastGfmExtension,
      ]);
      expect(isModelConfiguration(getSyntax(stock))).toBe(true);
      vi.mocked(createCmarkGfmModel).mockClear();
      expect(exportWith(stock, '| x |\n| - |\n| ©_a_ |')).toBe(
        '| x |\n| - |\n| &#xA9;_a_ |',
      );
      expect(createCmarkGfmModel).toHaveBeenCalled();
    });

    it('turns the model off for any construct it does not read', () => {
      const mark = createMark();
      const strikethrough = (change: (syntax: MicromarkExtension) => void) => {
        const syntax = getStrikethroughSyntax();
        change(syntax);
        return syntax;
      };
      const other: Construct = {tokenize: (_effects, _ok, nok) => nok};
      const another: Construct = {tokenize: (_effects, _ok, nok) => nok};
      for (const extensions of [
        // No construct at `*`.
        [
          {insideSpan: {null: [attention]}, text: {42: [], 95: attention}},
          getStrikethroughSyntax(),
        ],
        // A hook of the strict emphasis that is not an object.
        [{...strictEmphasis(), note: 'x'}, getStrikethroughSyntax()],
        // Two constructs at `~`, and a strikethrough with one more construct,
        // beside the stock one.
        [
          strictEmphasis(),
          strikethrough(syntax => {
            syntax.text = {126: [other, another]};
            syntax.insideSpan = {null: [other, another]};
          }),
        ],
        [
          strictEmphasis(),
          getStrikethroughSyntax(),
          strikethrough(syntax => {
            syntax.text = {...syntax.text, 61: mark};
          }),
        ],
        // Attention markers or a span resolver, even in syntax marked as
        // one the model may judge beside, or a marker construct.
        [
          strictEmphasis(),
          getStrikethroughSyntax(),
          referenceNeutral(() => ({attentionMarkers: {null: [64]}})),
        ],
        [
          strictEmphasis(),
          getStrikethroughSyntax(),
          referenceNeutral(() => ({
            insideSpan: {null: [{resolveAll: events => events}]},
          })),
        ],
        [
          strictEmphasis(),
          getStrikethroughSyntax(),
          referenceAgnostic(() => ({text: {42: mark}})),
        ],
        [
          strictEmphasis(),
          getStrikethroughSyntax(),
          referenceAgnostic(() => ({text: {126: mark}})),
        ],
        // A construct disabled, even in syntax marked as one the model may
        // judge beside.
        [
          strictEmphasis(),
          getStrikethroughSyntax(),
          referenceNeutral(() => ({disable: {null: ['labelStartLink']}})),
        ],
        [
          strictEmphasis(),
          getStrikethroughSyntax(),
          referenceAgnostic(() => ({disable: {null: ['labelStartLink']}})),
        ],
        // No strict emphasis.
        [getStrikethroughSyntax()],
      ]) {
        expect(isModelConfiguration(extensions)).toBe(false);
      }
      const editor = createModelEditor(true, [MdastGfmExtension], {
        micromarkExtensions: [{attentionMarkers: {null: [64]}}],
      });
      vi.mocked(createCmarkGfmModel).mockClear();
      expect(exportWith(editor, '©_a_')).toBe('&#xA9;_a_');
      expect(createCmarkGfmModel).not.toHaveBeenCalled();
    });

    it('keys a configuration by what micromark reads of it', () => {
      const one: Construct = {tokenize: (_effects, _ok, nok) => nok};
      const two: Construct = {tokenize: (_effects, _ok, nok) => nok};
      const three: Construct = {tokenize: (_effects, _ok, nok) => nok};
      // The same constructs in other objects, and every strikethrough
      // syntax of lexical, read alike.
      expect(keyConfiguration([{flow: {1: one}}])).toBe(
        keyConfiguration([{flow: {1: one}}]),
      );
      expect(
        keyConfiguration([strictEmphasis(), getStrikethroughSyntax()]),
      ).toBe(keyConfiguration([strictEmphasis(), getStrikethroughSyntax()]));
      // Where one extension ends, every construct of a code, and inherited
      // constructs count.
      expect(keyConfiguration([{flow: {1: one}}, {flow: {2: two}}])).not.toBe(
        keyConfiguration([{flow: {1: one, 2: two}}]),
      );
      expect(keyConfiguration([{flow: {1: [one, two]}}])).not.toBe(
        keyConfiguration([{flow: {1: [one, three]}}]),
      );
      expect(keyConfiguration([{flow: Object.create({1: one})}])).not.toBe(
        keyConfiguration([{}]),
      );
    });
  });

  describe('windows', () => {
    it('reads U+0000 as a replacement character beside attention', () => {
      const syntax = getSyntax(createModelEditor());
      const {model, subjects} = readModel('__\u0000__a', syntax);
      const accepted = new Set<number>();
      const proposed = [5];
      expect(model.readsBase(subjects[0])).toBe(true);
      expect(model.judgeWhole(subjects[0], accepted, proposed)).toBe(false);
      expect(model.judge(subjects[0], accepted, proposed)).toBe(false);
    });

    it('masks variation selector flags in strict flanking', () => {
      const syntax = getSyntax(createModelEditor());
      const {model, subjects} = readModel('\ufe00*a*', syntax);
      const accepted = new Set<number>();
      const proposed = [2];
      expect(model.readsBase(subjects[0])).toBe(true);
      expect(model.judgeWhole(subjects[0], accepted, proposed)).toBe(false);
      expect(model.judge(subjects[0], accepted, proposed)).toBe(false);
    });

    it('discards the sequences of a completed pass', () => {
      const syntax = getSyntax(createModelEditor());
      const {model, subjects} = readModel('_~~a**_x****a*~~', syntax);
      const accepted = new Set<number>();
      const proposed = [3];
      expect(model.readsBase(subjects[0])).toBe(true);
      expect(model.judgeWhole(subjects[0], accepted, proposed)).toBe(true);
      expect(model.judge(subjects[0], accepted, proposed)).toBe(true);
    });

    it('pairs random sequences as micromark does', () => {
      // The probe compares the pairs the model records with those of a
      // micromark parse of each document.
      const random = createRandom(0x5e9);
      const parts = ['*', '**', '***', '_', '__', '~', '~~', 'a', ' ', '.'];
      const documents: string[] = [];
      for (let n = 0; n < 1500; n++) {
        let markdown = '';
        for (let i = 3 + Math.floor(random() * 20); i > 0; i--) {
          markdown += parts[Math.floor(random() * parts.length)];
        }
        documents.push(markdown);
      }
      expect(
        probeCmarkGfmModel(documents, getSyntax(createModelEditor())),
      ).toEqual([]);
    });

    it('judges random searches inside pairs around a paragraph as from the whole subject', () => {
      // Paragraphs inside pairs at several depths, some of which leave a
      // remnant (`***a* b**`), judged over rounds of proposals that the
      // search takes in where they are kept.
      const syntax = getSyntax(createModelEditor());
      const random = createRandom(0x9e57);
      const pick = <T>(values: readonly T[]) =>
        values[Math.floor(random() * values.length)];
      const inner = ['*', '*', '_', '_', '~', '~~', 'a', 'a', '©', '😀'];
      const more = ['.', ' ', ' ', '**', '__', '***', 'b'];
      const wraps = ['*', '**', '_', '__', '~', '~~', '***', '___'];
      let judged = 0;
      for (let n = 0; n < 1500; n++) {
        let markdown = '';
        for (let i = 4 + Math.floor(random() * 40); i > 0; i--) {
          markdown += pick(random() < 0.6 ? inner : more);
        }
        for (let depth = Math.floor(random() * 4); depth > 0; depth--) {
          const wrap = pick(wraps);
          const left = pick(['x', 'x', 'a', '©', '.', 'x ']);
          const right = pick(['x', 'x', 'a', '©', '.', ' x']);
          markdown = `${wrap}${left}${markdown}${right}${random() < 0.15 ? pick(wraps) : wrap}`;
        }
        markdown = `q${markdown}q`;
        const {model, subjects} = readModel(markdown, syntax);
        if (subjects.length !== 1) {
          continue;
        }
        const offsets = [...markdown]
          .map((_, i) => i)
          .filter(i => /^(?:a|b|©|\ud83d)$/.test(markdown[i]));
        let accepted = new Set<number>();
        for (let step = 0; step < 10 && offsets.length > 0; step++) {
          const proposed = [
            ...new Set(
              Array.from({length: 1 + Math.floor(random() * 3)}, () =>
                pick(offsets),
              ),
            ),
          ].filter(edit => !accepted.has(edit));
          if (random() < 0.1) {
            accepted = new Set(accepted);
          }
          const whole = model.judgeWhole(subjects[0], accepted, proposed);
          const verdict = model.judge(subjects[0], accepted, proposed);
          if (verdict !== null) {
            judged++;
            expect(verdict, `${markdown} ${[...accepted]} ${proposed}`).toBe(
              whole,
            );
          }
          if (verdict) {
            for (const edit of proposed) {
              accepted.add(edit);
            }
          }
        }
      }
      expect(judged).toBeGreaterThan(5000);
    });

    it('reads what reaches a window inside pairs around a paragraph', () => {
      // The closer of a pair that holds the pair the window is in, formed
      // before the window is taken out of its list, takes an opener the
      // window leaves over; and an opener that a pair took out of a pass
      // that read the window too is one the window's closers reach.
      const syntax = getSyntax(createModelEditor());
      for (const [markdown, accepted, proposed] of [
        [
          'q___x_x~aa  **a~a.~~😀 *****____©. a*****😀a*a~~**  **aa. .😀x_x___q',
          [41, 54, 59, 20, 32, 14],
          [43],
        ],
        [
          'q_©***x~x ~~© _aa😀 .~~©b~~______a.©~x***©_q',
          [23, 41, 24, 35, 12, 16, 17, 15, 2],
          [33],
        ],
        [
          'q***x___x__x****~~_~~ *©~~_😀_ab* _ **~~*a*b._a.*  ~~©x__.___x***q',
          [31, 23, 53, 41, 46, 43],
          [27],
        ],
        [
          'q__a*~  a___~~**_~~_😀_*bb😀 .a.*_b*a ~b*_ ~a_ a__x__q',
          [25, 39, 3, 36, 47],
          [20],
        ],
      ] as const) {
        const {model, subjects} = readModel(markdown, syntax);
        expect(model.judge(subjects[0], new Set(accepted), [...proposed])).toBe(
          false,
        );
        expect(
          model.judgeWhole(subjects[0], new Set(accepted), [...proposed]),
        ).toBe(false);
      }
    });

    it('judges random searches around the edits as from the whole subject', () => {
      // Random paragraphs, each judged over a few rounds of proposals that
      // the search takes in where they are kept; now and then the search
      // replaces its set, as a pair restart does.
      const syntax = getSyntax(createModelEditor());
      const random = createRandom(0x4d10);
      const characters = [
        '*',
        '*',
        '_',
        '_',
        '~',
        'a',
        'a',
        '©',
        '😀',
        '.',
        ' ',
      ];
      let judged = 0;
      for (let n = 0; n < 2000; n++) {
        let markdown = 'x';
        for (let i = 4 + Math.floor(random() * 28); i > 0; i--) {
          markdown += characters[Math.floor(random() * characters.length)];
        }
        markdown += 'x';
        const {model, subjects} = readModel(markdown, syntax);
        if (subjects.length !== 1) {
          continue;
        }
        const offsets = [...markdown]
          .map((_, i) => i)
          .filter(i => /^(?:a|©|\ud83d)$/.test(markdown[i]));
        let accepted = new Set<number>();
        for (let step = 0; step < 6 && offsets.length > 0; step++) {
          const proposed = [
            ...new Set(
              Array.from(
                {length: 1 + Math.floor(random() * 3)},
                () => offsets[Math.floor(random() * offsets.length)],
              ),
            ),
          ].filter(edit => !accepted.has(edit));
          if (random() < 0.15) {
            accepted = new Set(accepted);
          }
          const whole = model.judgeWhole(subjects[0], accepted, proposed);
          const verdict = model.judge(subjects[0], accepted, proposed);
          if (verdict !== null) {
            judged++;
            expect(verdict, `${markdown} ${[...accepted]} ${proposed}`).toBe(
              whole,
            );
          }
          if (verdict) {
            for (const edit of proposed) {
              accepted.add(edit);
            }
          }
        }
      }
      expect(judged).toBeGreaterThan(5000);
    });

    // Inputs and proposals on which a window that missed a dependency
    // would keep or drop a proposal otherwise than the whole subject.
    it.each<[string, string, number[][]]>([
      ['insideSpan order inside a pair', '_**©~*******a*~_', [[3]]],
      [
        'insideSpan order inside a pair, two edits',
        '_~\u00a0**~©a****😀*_',
        [[2, 6]],
      ],
      [
        'pass chain by invocation',
        '_~__😀*_😀\u00a0a_****😀**©a****~*😀*©****__~',
        [[11, 10, 22]],
      ],
      ['strikethrough first in a window', '~_*ab~_', [[4, 3]]],
      ['widening right to a failed closer', '_ ba~.~', [[3]]],
      ['widening right after an astral edit', '~a~**~**😀_~~ ~_', [[8]]],
      ['the leftovers of a kept window', '~~abb__~__ba', [[4], [10, 11]]],
      ['the failed closers of a kept window', '\ude00*__b*.*a', [[8], [4]]],
      ['a failed closer at its item', '~ ~a*.*a**', [[3]]],
      ['what is left of a failed closer', '©*a**😀__._😀___', [[2], [2, 5]]],
      ['the run after an astral edit', '*~~😀_©_', [[3]]],
      ['an opener that an earlier window leaves', '*~~😀_b_a', [[8, 3]]],
      ['two windows', '.***😀b ~~😀__b_a~', [[16, 10]]],
      [
        'an opener that a window before a taken-in window leaves',
        '😀_a_a😀.~_😀😀~~~~',
        [[0, 6, 11]],
      ],
      [
        'a failed closer before the end of a window and one after it',
        'x___*a©*a_a© a_~_x',
        [[6], [5, 6], [8, 10], [8], [10, 11, 5], [6, 6]],
      ],
      [
        'a region that passes the end of the window',
        '~_.~~_©~ b😀© .😀_.©b_*__*©a_*©',
        [[15, 10]],
      ],
      ['a pair of a strikethrough kind', '~~****_******~a* x~~', [[14]]],
      ['the leftovers of every window', 'a~~.*b_ ~© ©~~😀', [[14, 0, 5, 9]]],
    ])('reads %s', (_, markdown, steps) => {
      const syntax = getSyntax(createModelEditor());
      const verdicts = judgeSteps(syntax, markdown, steps);
      expect(verdicts.every(({verdict}) => verdict !== null)).toBe(true);
      expect(verdicts.map(({verdict}) => verdict)).toEqual(
        verdicts.map(({whole}) => whole),
      );
      expect(probeCmarkGfmModel([markdown], syntax)).toEqual([]);
    });

    it('reads the first text character after a container prefix', () => {
      const syntax = getSyntax(createModelEditor());
      const [verdict] = judgeSteps(syntax, '>x\n>a_a_b', [[8]]);
      expect(verdict).toEqual({verdict: true, whole: true});
    });

    it('keeps the verdicts of a pair and of windows that leave openers', () => {
      const syntax = getSyntax(createModelEditor());
      const [kind] = judgeSteps(syntax, '~~****_******~a* x~~', [[14]]);
      expect(kind).toEqual({verdict: true, whole: true});
      const [leftovers] = judgeSteps(syntax, 'a~~.*b_ ~© ©~~😀', [
        [14, 0, 5, 9],
      ]);
      expect(leftovers).toEqual({verdict: false, whole: false});
    });
  });

  describe('literal autolinks', () => {
    // Whitespace ends a literal autolink, so a reference in its place can
    // make or end one, which the model does not read.
    const WITNESS = '_____\\[www._____\u2028©~';

    it('judges a whitespace edit by parsing where a literal may be', () => {
      const editor = createModelEditor();
      const syntax = getSyntax(editor);
      expect(WITNESS[16]).toBe('\u2028');
      const {model, subjects} = readModel(WITNESS, syntax);
      expect(model.readsBase(subjects[0])).toBe(true);
      expect(model.judge(subjects[0], new Set(), [16])).toBe(null);
      expect(probeCmarkGfmModel([WITNESS], syntax)).toEqual([]);
      expect(exportWith(editor, WITNESS)).toBe(
        exportWith(createModelEditor(false), WITNESS),
      );
    });

    it('judges a whitespace edit with the model without a trigger', () => {
      const markdown = 'a\u2028*b* ©_c_';
      const {model, subjects} = readModel(
        markdown,
        getSyntax(createModelEditor()),
      );
      expect(model.judge(subjects[0], new Set(), [1])).not.toBe(null);
    });

    // A space or a tab ends an autolink and a link destination, so a
    // reference in its place makes one without a trigger.
    it.each(['<ab:c d>', '[a](b c)', '<ab:c\td>', '[a](b\tc)'])(
      'judges a space or a tab edit in %j by parsing',
      markdown => {
        const syntax = getSyntax(createModelEditor());
        const {model, subjects} = readModel(markdown, syntax);
        expect(model.readsBase(subjects[0])).toBe(true);
        expect(markdown[5]).toMatch(/^[ \t]$/);
        expect(model.judge(subjects[0], new Set(), [5])).toBe(null);
        expect(model.judgeWhole(subjects[0], new Set(), [5])).toBe(null);
        expect(probeCmarkGfmModel([markdown], syntax)).toEqual([]);
      },
    );

    it('judges by parsing while an accepted edit is whitespace', () => {
      const markdown = 'www.a\u2028*b* ©_c_';
      const {model, subjects} = readModel(
        markdown,
        getSyntax(createModelEditor()),
      );
      // Offset 10 is `©`, not ASCII punctuation, so only the accepted
      // whitespace edit at 5 sends the judgement to a parse.
      expect(markdown[10]).toBe('©');
      expect(model.judge(subjects[0], new Set(), [10])).not.toBe(null);
      expect(model.judge(subjects[0], new Set([5]), [10])).toBe(null);
    });

    it('judges an edit by parsing in a run that holds a trigger', () => {
      // `&#x62;` in place of `b` ends the domain at `&`, so that the `_`
      // after it is no longer in a domain, and `www.` starts a literal that
      // takes the closing `_`.
      const markdown = '_]www.b_*q';
      const syntax = getSyntax(createModelEditor());
      const {model, subjects} = readModel(markdown, syntax);
      expect(model.readsBase(subjects[0])).toBe(true);
      expect(markdown[6]).toBe('b');
      expect(model.judge(subjects[0], new Set(), [6])).toBe(null);
      expect(model.judgeWhole(subjects[0], new Set(), [6])).toBe(null);
      expect(probeCmarkGfmModel([markdown], syntax)).toEqual([]);
    });

    // A reference writes `&#x…;`. In place of the first or the last
    // character of a run, it changes where a literal starts or ends, so a
    // parse must judge it. Each case is a character that a search may
    // propose (DATA), in a run whose literal it changes.
    it.each([
      // First character of a run: `;` then comes before `http`.
      ['x ahttp://b.c/_d_', 2],
      ['x ahttps://b.c/_d_', 2],
      ['x aHTTP://b.c/_d_', 2],
      // Last character of a run, after the trigger.
      ['a~~c-http://ac', 13],
      ['((www.a /www.b(', 6],
      // The last character of a trigger at the end of a run.
      ['www. d_a\u00a91', 0],
      ['www. d_a\u00a91', 3],
      // A letter of an email: `@` marks the run; `_`, `-` and `+` stay in it.
      ['ab@c.de', 0],
      ['x_a@b.c', 0],
      ['x+a@b.c', 0],
    ] as const)(
      'judges by parsing at the edge of a literal run: %s at %s',
      (markdown, offset) => {
        const syntax = getSyntax(createModelEditor());
        const {model, subjects} = readModel(markdown, syntax);
        expect(model.readsBase(subjects[0])).toBe(true);
        expect(model.judge(subjects[0], new Set(), [offset])).toBe(null);
        expect(model.judgeWhole(subjects[0], new Set(), [offset])).toBe(null);
      },
    );

    // A subject may end at a character that is not whitespace, as a table
    // cell does at its `|`: its last run is read at the end of the subject.
    it('judges by parsing in the last run of a table cell', () => {
      const markdown = '|a|\n|-|\n|_]www.b_*q|';
      const syntax = getSyntax(createModelEditor());
      const {model, subjects} = readModel(markdown, syntax);
      const subject = subjects[subjects.length - 1];
      const offset = markdown.indexOf('b_');
      expect(markdown[subject.end]).toBe('|');
      expect(model.readsBase(subject)).toBe(true);
      expect(model.judge(subject, new Set(), [offset])).toBe(null);
      expect(model.judgeWhole(subject, new Set(), [offset])).toBe(null);
    });

    // The marks of a run belong to their subject: a subject without a
    // literal must not switch off the guard of another, whichever the model
    // reads first. `&#x77;` in place of the `w` that starts `www.` ends the
    // literal, so a parse must judge it. The other subject has no literal.
    it.each([
      ['www. d_a\n\nb ~', 0, 0, 1, 10],
      ['b ~\n\nwww. d_a', 1, 5, 0, 0],
    ] as const)(
      'judges by parsing in the subject of a literal run: %j',
      (markdown, literal, offset, other, otherOffset) => {
        const syntax = getSyntax(createModelEditor());
        const {model, subjects} = readModel(markdown, syntax);
        expect(subjects).toHaveLength(2);
        expect(markdown[offset]).toBe('w');
        expect(markdown[otherOffset]).toMatch(/[b ]/);
        for (const order of [
          [other, literal],
          [literal, other, literal, other, literal],
        ]) {
          for (const index of order) {
            const at = index === literal ? offset : otherOffset;
            const subject = subjects[index];
            expect(model.readsBase(subject)).toBe(true);
            if (index === literal) {
              expect(model.judge(subject, new Set(), [at])).toBe(null);
              expect(model.judgeWhole(subject, new Set(), [at])).toBe(null);
            } else {
              model.judge(subject, new Set(), [at]);
            }
          }
        }
      },
    );

    it('matches a literal trigger without regard to case', () => {
      const markdown = '_____WWW._____ ©~';
      const syntax = getSyntax(createModelEditor());
      const {model, subjects} = readModel(markdown, syntax);
      expect(model.readsBase(subjects[0])).toBe(true);
      expect(markdown[14]).toBe(' ');
      expect(model.judge(subjects[0], new Set(), [14])).toBe(null);
      expect(probeCmarkGfmModel([markdown], syntax)).toEqual([]);
    });
  });
});
