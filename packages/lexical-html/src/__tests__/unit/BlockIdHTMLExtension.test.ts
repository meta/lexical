/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getBlockById,
  $getBlockHandles,
  $getBlockId,
  $isRootChildBlock,
  $resolveBlockHandle,
  BlockIdExtension,
  blockIdState,
  buildEditorFromExtensions,
  configExtension,
  getExtensionDependencyFromEditor,
  type LexicalEditorWithDispose,
  type Signal,
} from '@lexical/extension';
import {
  $generateDOMFromNodes,
  $generateHtmlFromNodes,
  $getSessionDOMRenderConfig,
  DOMImportExtension,
} from '@lexical/html';
import {
  BLOCK_HANDLE_ATTRIBUTE,
  BLOCK_ID_ATTRIBUTE,
  BLOCK_WRAPPER_ID_ATTRIBUTE,
  type BlockIdHTMLConfig,
  BlockIdHTMLExtension,
} from '@lexical/html/BlockIdHTMLExtension';
import {ListExtension} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
  $isElementNode,
  $setState,
  HISTORY_MERGE_TAG,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import {assert, describe, expect, expectTypeOf, test} from 'vitest';

import {$setBlockText} from '../utils/setBlockText';

function counter(prefix = 'b') {
  let n = 0;
  return () => `${prefix}${++n}`;
}

function withIds(ids: string[], then: () => string): () => string {
  let i = 0;
  return () => (i < ids.length ? ids[i++] : then());
}

/**
 * The first content an empty editor gets is a load, so its blocks get
 * positional ids (tested on their own). These tests are about edits, so their
 * editors have had content once and the first blocks they add get ids from
 * `generateId`.
 */
function asEdited<T extends LexicalEditor>(editor: T): T {
  const options = {discrete: true, tag: HISTORY_MERGE_TAG} as const;
  editor.update(() => {
    $getRoot().append($createParagraphNode());
  }, options);
  editor.update(() => {
    $getRoot().clear();
  }, options);
  return editor;
}

function build(
  options: {
    /** Skip {@link asEdited}: the first content the editor gets is a load. */
    fresh?: boolean;
    /** Ids that `generateId` hands out first, before the counter. */
    ids?: string[];
    html?: false | Partial<BlockIdHTMLConfig>;
    prefix?: string;
    /** Identify the root's children only. */
    rootOnly?: boolean;
  } = {},
): LexicalEditorWithDispose {
  return (
    options.fresh ? (editor: LexicalEditorWithDispose) => editor : asEdited
  )(
    buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        ListExtension,
        configExtension(BlockIdExtension, {
          generateId: withIds(options.ids || [], counter(options.prefix)),
          ...(options.rootOnly ? {$isIdentifiedBlock: $isRootChildBlock} : {}),
        }),
        ...(options.html === false
          ? []
          : [configExtension(BlockIdHTMLExtension, options.html || {})]),
      ],
      name: '[block-id-html]',
    }),
  );
}

/**
 * Parses a fixed HTML fixture. Tests never build markup from strings they
 * did not write: documents that carry other input (an exported document, an
 * attribute value) are built with DOM APIs.
 */
function parseFixture(fixture: string): Document {
  return new DOMParser().parseFromString(fixture, 'text/html');
}

/** A document whose body holds one `<p>` per entry, built with DOM APIs. */
function paragraphsDocument(
  entries: {id: string | null; tag?: string; text: string}[],
): Document {
  const doc = document.implementation.createHTMLDocument('');
  for (const {id, tag = 'p', text} of entries) {
    const element = doc.createElement(tag);
    if (id !== null) {
      element.setAttribute('data-block-id', id);
    }
    element.textContent = text;
    doc.body.append(element);
  }
  return doc;
}

function append(editor: LexicalEditor, dom: Document): void {
  editor.update(
    () =>
      $getRoot().append(
        ...getExtensionDependencyFromEditor(
          $getEditor(),
          DOMImportExtension,
        ).output.$generateNodesFromDOM(dom),
      ),
    {discrete: true},
  );
}

/** The editor's content exported as a DOM document (no HTML string). */
function exportDocument(editor: LexicalEditor): Document {
  const doc = document.implementation.createHTMLDocument('');
  editor.read(() => $generateDOMFromNodes(doc.body, null, editor));
  return doc;
}

/**
 * The editor's content exported as a DOM document, and the handles it shows,
 * in one read (`$generateHtmlFromNodes` and `$getBlockHandles()` in the
 * JSDoc example of `BlockIdHTMLConfig.export`; a DOM rather than a string).
 */
function exportWithHandles(
  editor: LexicalEditor,
): [Document, Map<string, string>] {
  const doc = document.implementation.createHTMLDocument('');
  return editor.read(() => {
    $generateDOMFromNodes(doc.body, null, editor);
    return [doc, $getBlockHandles()];
  });
}

function exportHTML(editor: LexicalEditor): string {
  return editor.read(() => $generateHtmlFromNodes(editor));
}

function tree(editor: LexicalEditor): string[] {
  return editor.read(() => {
    const out: string[] = [];
    const walk = (node: LexicalNode) => {
      if ($isElementNode(node)) {
        if (node.getType() !== 'root') {
          out.push(`${node.getType()}:${$getBlockId(node)}`);
        }
        node.getChildren().forEach(walk);
      }
    };
    walk($getRoot());
    return out;
  });
}

describe('BlockIdHTMLExtension', () => {
  test('without it, HTML carries no ids', () => {
    using editor = build({html: false});
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('one')),
        );
      },
      {discrete: true},
    );
    expect(exportHTML(editor)).not.toContain('data-block-id');
  });

  test('exports data-block-id on identified blocks only', () => {
    using editor = build();
    append(
      editor,
      parseFixture('<h1>Title</h1><p>Text</p><ul><li>a</li><li>b</li></ul>'),
    );
    expect(tree(editor)).toEqual([
      'heading:b1',
      'paragraph:b2',
      'list:b3',
      'listitem:b4',
      'listitem:b5',
    ]);
    expect(exportHTML(editor)).toBe(
      [
        '<h1 data-block-id="b1"><span style="white-space: pre-wrap;">Title</span></h1>',
        '<p data-block-id="b2"><span style="white-space: pre-wrap;">Text</span></p>',
        '<ul data-block-id="b3">',
        '<li value="1" data-block-id="b4"><span style="white-space: pre-wrap;">a</span></li>',
        '<li value="2" data-block-id="b5"><span style="white-space: pre-wrap;">b</span></li>',
        '</ul>',
      ].join(''),
    );
  });

  test('a root-only predicate exports no list item ids', () => {
    using editor = build({rootOnly: true});
    append(editor, parseFixture('<ul><li>a</li><li>b</li></ul>'));
    expect(tree(editor)).toEqual(['list:b1', 'listitem:null', 'listitem:null']);
    expect(exportHTML(editor)).toBe(
      [
        '<ul data-block-id="b1">',
        '<li value="1"><span style="white-space: pre-wrap;">a</span></li>',
        '<li value="2"><span style="white-space: pre-wrap;">b</span></li>',
        '</ul>',
      ].join(''),
    );
  });

  test('round-trips ids through HTML', () => {
    using source = build({prefix: 's'});
    append(
      source,
      parseFixture(
        '<h2>Title</h2><p>Text</p><ul><li>a</li></ul><blockquote>q</blockquote>',
      ),
    );
    const exported = exportDocument(source);
    expect(exported.querySelectorAll('[data-block-id]')).toHaveLength(5);
    using target = build({prefix: 't'});
    append(target, exported);
    expect(tree(target)).toEqual(tree(source));
    expect(tree(target)).toEqual([
      'heading:s1',
      'paragraph:s2',
      'list:s3',
      'listitem:s4',
      'quote:s5',
    ]);
  });

  test('imported ids pass through the uniqueness rule', () => {
    using editor = build();
    append(editor, parseFixture('<p>existing</p>'));
    const [existing] = tree(editor);
    const existingId = existing.slice(existing.indexOf(':') + 1);
    append(
      editor,
      paragraphsDocument([
        {id: 'x', text: 'first x'},
        {id: 'x', text: 'second x'},
        {id: existingId, text: 'clashes with the document'},
        {id: 'kept', tag: 'h3', text: 'kept'},
      ]),
    );
    const after = tree(editor);
    expect(after[0]).toBe(existing);
    expect(after[1]).toBe('paragraph:x');
    expect(after[4]).toBe('heading:kept');
    const ids = after.map(entry => entry.slice(entry.indexOf(':') + 1));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('invalid imported ids are ignored; valid foreign ids are kept', () => {
    using editor = build();
    const invalid = ['', 'z'.repeat(65), 'a b', 'line\nbreak', '"><x', 'é'];
    append(
      editor,
      paragraphsDocument([
        ...invalid.map(id => ({id, text: 'invalid'})),
        {id: 'y'.repeat(64), text: 'longest valid'},
        {id: 'bk3j9x0a2zq', text: 'an 11-character id'},
      ]),
    );
    const ids = tree(editor).map(entry => entry.slice(entry.indexOf(':') + 1));
    expect(ids.slice(-2)).toEqual(['y'.repeat(64), 'bk3j9x0a2zq']);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(invalid).not.toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('an imported id is dropped from a block that is not identified', () => {
    using editor = build();
    append(
      editor,
      parseFixture(
        '<ul data-block-id="outer"><li data-block-id="item">a' +
          '<ul data-block-id="nested"><li>b</li></ul></li></ul>',
      ),
    );
    const outline = tree(editor);
    expect(outline[0]).toBe('list:outer');
    expect(outline[1]).toBe('listitem:item');
    // The nested list is not identified: it keeps no id.
    expect(outline).toContain('list:null');
    expect(JSON.stringify(editor.getEditorState().toJSON())).not.toContain(
      '"nested"',
    );
  });

  test('export into a document of another realm writes the attribute', () => {
    using editor = build();
    append(editor, parseFixture('<p>x</p>'));
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const doc = iframe.contentDocument!;
    expect(doc.defaultView).not.toBe(window);
    editor.read(() => $generateDOMFromNodes(doc.body, null, editor));
    expect(doc.body.querySelector('p')!.getAttribute('data-block-id')).toBe(
      editor.read(() => $getBlockId($getRoot().getFirstChildOrThrow())),
    );
    iframe.remove();
  });

  test('export: false leaves the export override out of every export session', () => {
    using editor = build({html: {export: false}});
    append(editor, parseFixture('<p>a</p>'));
    const {export: exportSignal, handles: handlesSignal} =
      getExtensionDependencyFromEditor(editor, BlockIdHTMLExtension).output;
    // Whether an export session runs with the editor's own render config
    // (every override, this extension's included) or one compiled without
    // an override that its disabledForSession turned off.
    const sessionHasAllOverrides = () =>
      editor.read(
        () => $getSessionDOMRenderConfig(editor) === editor._config.dom,
      );
    expect(sessionHasAllOverrides()).toBe(false);
    expect(exportHTML(editor)).not.toContain('data-block');
    // handles alone does not turn the export on.
    handlesSignal.value = true;
    expect(sessionHasAllOverrides()).toBe(false);
    expect(exportHTML(editor)).not.toContain('data-block');
    exportSignal.value = true;
    expect(sessionHasAllOverrides()).toBe(true);
    expect(exportHTML(editor)).toContain('data-block-handle');
    handlesSignal.value = false;
    expect(sessionHasAllOverrides()).toBe(true);
    expect(exportHTML(editor)).toContain('data-block-id');
    exportSignal.value = false;
    expect(sessionHasAllOverrides()).toBe(false);
    expect(exportHTML(editor)).not.toContain('data-block');
  });

  test('the released types of export still hold: a boolean, and a Signal<boolean>', () => {
    using editor = build({html: {handles: true}});
    const output = getExtensionDependencyFromEditor(
      editor,
      BlockIdHTMLExtension,
    ).output;
    // Code written against v0.53.0's types: these must keep compiling
    // (pnpm run tsc-test type-checks this file).
    const on: boolean = output.export.value;
    const exportSignal: Signal<boolean> = output.export;
    // A whole config as written for v0.53.0, without handles.
    const config: BlockIdHTMLConfig = {export: true, import: true};
    const partial: Partial<BlockIdHTMLConfig> = {export: false};
    expectTypeOf(output.export).toEqualTypeOf<Signal<boolean>>();
    expectTypeOf<BlockIdHTMLConfig['export']>().toEqualTypeOf<boolean>();
    expectTypeOf(output.handles).toEqualTypeOf<Signal<boolean>>();
    expectTypeOf(output.import).toEqualTypeOf<Signal<boolean>>();
    expect([on, exportSignal.value, config.export, partial.export]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    // The default configuration is unchanged, with handles off.
    using defaults = build();
    const {handles} = getExtensionDependencyFromEditor(
      defaults,
      BlockIdHTMLExtension,
    ).output;
    expect(handles.value).toBe(false);
  });

  test('import: false ignores the attribute; export: false omits it', () => {
    using editor = build({html: {export: false, import: false}});
    append(editor, parseFixture('<p data-block-id="from-html">a</p>'));
    expect(tree(editor)).toEqual(['paragraph:b1']);
    expect(exportHTML(editor)).not.toContain('data-block-id');
  });
});

describe('BlockIdHTMLExtension: documents read without ids', () => {
  test('every reader exports the same data-block-id for a document stored without ids', () => {
    const html: string[][] = [];
    for (const prefix of ['x', 'y']) {
      using editor = build({fresh: true, prefix});
      // The first content of an empty editor is a load: positional ids, not
      // `generateId`'s.
      append(
        editor,
        paragraphsDocument([
          {id: null, text: 'one'},
          {id: null, tag: 'h2', text: 'two'},
        ]),
      );
      html.push(
        Array.from(
          exportDocument(editor).querySelectorAll('[data-block-id]'),
          element => element.getAttribute('data-block-id')!,
        ),
      );
      expect(
        editor.read(() => $getRoot().getChildren().map($getBlockId)),
      ).toEqual(html[html.length - 1]);
    }
    expect(html[0]).toEqual(html[1]);
    for (const id of html[0]) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    }
  });
});

describe('BlockIdHTMLExtension: handles: true', () => {
  const IDS = [
    'V1StGXR8_Z5jdHi6B-myT',
    '9xQeLm2Pq0aK7cTb_wYuA',
    'Rk8pZc41Uo-HsVd2NnFjB',
    // Its hash starts like the first id's: both handles take 5 characters.
    'qfapyr',
    'u7NnPz2Kq0aK7cTb_wYuA',
  ];

  test('exports data-block-handle instead of data-block-id', () => {
    using editor = build({html: {handles: true}, ids: IDS});
    append(
      editor,
      parseFixture(
        '<h2>Q3 plan</h2><p>Revenue grew 4% in Q3.</p><ul><li>a</li><li>b</li></ul>',
      ),
    );
    expect(exportHTML(editor)).toBe(
      [
        '<h2 data-block-handle="2bNoq"><span style="white-space: pre-wrap;">Q3 plan</span></h2>',
        '<p data-block-handle="gTtF"><span style="white-space: pre-wrap;">Revenue grew 4% in Q3.</span></p>',
        '<ul data-block-handle="xt6z">',
        '<li value="1" data-block-handle="2bNoV"><span style="white-space: pre-wrap;">a</span></li>',
        '<li value="2" data-block-handle="Wbjb"><span style="white-space: pre-wrap;">b</span></li>',
        '</ul>',
      ].join(''),
    );
    expect(BLOCK_HANDLE_ATTRIBUTE).toBe('data-block-handle');
    expect(BLOCK_ID_ATTRIBUTE).toBe('data-block-id');
  });

  test('export: true and export: false are unchanged', () => {
    const fixture =
      '<h2>Q3 plan</h2><p>Revenue grew 4% in Q3.</p><ul><li>a</li><li>b</li></ul>';
    const html: Record<string, string> = {};
    for (const [name, config] of [
      ['default', {}],
      ['true', {export: true}],
      ['false', {export: false}],
      ['without', false],
    ] as const) {
      using editor = build({html: config, ids: IDS});
      append(editor, parseFixture(fixture));
      html[name] = exportHTML(editor);
    }
    expect(html.true).toBe(html.default);
    expect(html.true).toBe(
      [
        '<h2 data-block-id="V1StGXR8_Z5jdHi6B-myT"><span style="white-space: pre-wrap;">Q3 plan</span></h2>',
        '<p data-block-id="9xQeLm2Pq0aK7cTb_wYuA"><span style="white-space: pre-wrap;">Revenue grew 4% in Q3.</span></p>',
        '<ul data-block-id="Rk8pZc41Uo-HsVd2NnFjB">',
        '<li value="1" data-block-id="qfapyr"><span style="white-space: pre-wrap;">a</span></li>',
        '<li value="2" data-block-id="u7NnPz2Kq0aK7cTb_wYuA"><span style="white-space: pre-wrap;">b</span></li>',
        '</ul>',
      ].join(''),
    );
    expect(html.false).toBe(html.without);
    expect(html.false).not.toContain('data-block');
  });

  test('import never reads data-block-handle as an id', () => {
    using editor = build({ids: ['abcdEFGH', 'V1StGXR8_Z5jdHi6B-myT']});
    append(editor, parseFixture('<p>existing</p>'));
    expect(tree(editor)).toEqual(['paragraph:abcdEFGH']);
    append(
      editor,
      parseFixture(
        // A handle of a block of this document, a handle that looks like a
        // whole id, and a handle next to a real id.
        '<p data-block-handle="abcd">handle of existing</p>' +
          '<p data-block-handle="kept-if-read-as-id">no id</p>' +
          '<h3 data-block-handle="zzzz" data-block-id="real-id">with id</h3>',
      ),
    );
    expect(tree(editor)).toEqual([
      'paragraph:abcdEFGH',
      'paragraph:V1StGXR8_Z5jdHi6B-myT',
      'paragraph:b1',
      'heading:real-id',
    ]);
    // With the import on, as by default, and an export of handles.
    using handles = build({html: {handles: true}});
    append(handles, parseFixture('<p data-block-handle="from-html">a</p>'));
    expect(tree(handles)).toEqual(['paragraph:b1']);
  });

  test('round trip: export handles, edit by handle, resolve', () => {
    using editor = build({html: {handles: true}, ids: IDS});
    append(
      editor,
      parseFixture(
        '<h2>Q3 plan</h2><p>Revenue grew 4% in Q3.</p><p>Hiring is on track.</p>',
      ),
    );
    // 1. The HTML the model reads, and the handles it is shown, in one read
    //    (as in BlockIdHTMLConfig.export's example).
    const [exported, shown] = exportWithHandles(editor);
    const elements = Array.from(
      exported.querySelectorAll(`[${BLOCK_HANDLE_ATTRIBUTE}]`),
    );
    expect(exported.querySelectorAll(`[${BLOCK_ID_ATTRIBUTE}]`)).toHaveLength(
      0,
    );
    expect(
      elements.map(element => element.getAttribute(BLOCK_HANDLE_ATTRIBUTE)),
    ).toEqual(['2bNo', 'gTtF', 'xt6z']);
    expect(Array.from(shown.values())).toEqual(
      expect.arrayContaining(['2bNo', 'gTtF', 'xt6z']),
    );
    const keyBefore = editor.read(() => $getBlockById(IDS[1])!.getKey());
    // 2. What the model answers.
    const revenue = elements.find(element =>
      element.textContent!.startsWith('Revenue'),
    )!;
    const ops = [
      {
        block: revenue.getAttribute(BLOCK_HANDLE_ATTRIBUTE)!,
        text: 'Revenue grew 6% in Q3.',
      },
      {block: '9xQf', text: 'a typo'},
    ];
    // 3. Applied by the app, one update per operation, in place.
    const statuses: string[] = [];
    for (const op of ops) {
      editor.update(
        () => {
          const result = $resolveBlockHandle(op.block, {read: shown});
          statuses.push(result.status);
          if (result.status === 'found') {
            expect($setBlockText(result.node, op.text)).toBe(true);
          }
        },
        {discrete: true},
      );
    }
    expect(statuses).toEqual(['found', 'not-found']);
    editor.read(() => {
      const block = $getBlockById(IDS[1]);
      assert(block !== null);
      expect(block.getTextContent()).toBe('Revenue grew 6% in Q3.');
      // Changed in place: the same block.
      expect(block.getKey()).toBe(keyBefore);
    });
    expect(exportHTML(editor)).toBe(
      [
        '<h2 data-block-handle="2bNo"><span style="white-space: pre-wrap;">Q3 plan</span></h2>',
        '<p data-block-handle="gTtF"><span style="white-space: pre-wrap;">Revenue grew 6% in Q3.</span></p>',
        '<p data-block-handle="xt6z"><span style="white-space: pre-wrap;">Hiring is on track.</span></p>',
      ].join(''),
    );
  });

  test('a handle from exported HTML never names a block added since whose handle would be the same', () => {
    using editor = build({
      html: {handles: true},
      ids: ['p18f', 'Rk8pZc41'],
    });
    append(editor, parseFixture('<p>Revenue grew 4%.</p><p>Hiring.</p>'));
    const [exported, shown] = exportWithHandles(editor);
    expect(
      exported.querySelector('p')!.getAttribute(BLOCK_HANDLE_ATTRIBUTE),
    ).toBe('NnGk');
    // Before the model's answer arrives, the block it was shown is deleted
    // and a block whose hash starts the same way is added.
    editor.update(
      () => {
        $getBlockById('p18f')!.remove();
        const node = $createParagraphNode().append(
          $createTextNode('Not shown to the model.'),
        );
        $setState(node, blockIdState, 'p2cs');
        $getRoot().append(node);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        // Without the read, the handle names the new block.
        const unpinned = $resolveBlockHandle('NnGk');
        assert(unpinned.status === 'found');
        expect($getBlockId(unpinned.node)).toBe('p2cs');
        // With the handles of the export, as in the JSDoc: not found.
        const result = $resolveBlockHandle('NnGk', {read: shown});
        expect(result.status).toBe('not-found');
        if (result.status === 'found') {
          $setBlockText(result.node, 'Revenue grew 6%.');
        }
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($getBlockById('p2cs')!.getTextContent()).toBe(
        'Not shown to the model.',
      );
    });
  });
});

// #9606: a list item that only wraps a nested list (Lexical's shape for a
// nested list) has no element of its own in exported HTML: the nested list
// is written inside the previous item's element. Its id goes on the nested
// list's element in data-block-wrapper-id, and import puts it back on the
// item the importer wraps that list in.
describe('BlockIdHTMLExtension: a list item that only wraps a nested list', () => {
  const NESTED =
    '<ul><li>first</li><li>second<ul><li>inner one</li>' +
    '<li>inner two<ol><li>deep</li></ol></li></ul></li><li>third</li></ul>';

  test('exports its id on the nested list, and round-trips it', () => {
    using source = build({prefix: 's'});
    append(source, parseFixture(NESTED));
    const outline = tree(source);
    // first, second, the inner list's wrapper, inner one, inner two, the
    // deep list's wrapper, deep, third.
    expect(outline.filter(entry => entry.startsWith('listitem:'))).toHaveLength(
      8,
    );
    const exported = exportDocument(source);
    const wrapped = Array.from(
      exported.querySelectorAll(`[${BLOCK_WRAPPER_ID_ATTRIBUTE}]`),
    );
    expect(wrapped.map(el => el.tagName)).toEqual(['UL', 'OL']);
    // Every identified block's id is in the HTML exactly once.
    const written = Array.from(
      exported.querySelectorAll(
        `[${BLOCK_ID_ATTRIBUTE}], [${BLOCK_WRAPPER_ID_ATTRIBUTE}]`,
      ),
    ).flatMap(el =>
      [BLOCK_ID_ATTRIBUTE, BLOCK_WRAPPER_ID_ATTRIBUTE].flatMap(name => {
        const id = el.getAttribute(name);
        return id === null ? [] : [id];
      }),
    );
    const ids = outline
      .map(entry => entry.slice(entry.indexOf(':') + 1))
      .filter(id => id !== 'null');
    expect([...written].sort()).toEqual([...ids].sort());
    using target = build({prefix: 't'});
    append(target, exported);
    expect(tree(target)).toEqual(outline);
  });

  test('pasted twice, the second copy gets fresh ids, the wrapper items too', () => {
    using source = build({prefix: 's'});
    append(source, parseFixture(NESTED));
    const exported = exportDocument(source);
    using target = build({prefix: 't'});
    append(target, exported);
    append(target, exported);
    const ids = tree(target)
      .map(entry => entry.slice(entry.indexOf(':') + 1))
      .filter(id => id !== 'null');
    expect(new Set(ids).size).toBe(ids.length);
    expect(tree(target).slice(0, tree(source).length)).toEqual(tree(source));
  });

  test('export: false writes no wrapper id; import: false reads none', () => {
    using off = build({html: {export: false}, prefix: 's'});
    append(off, parseFixture(NESTED));
    expect(
      exportDocument(off).querySelector(`[${BLOCK_WRAPPER_ID_ATTRIBUTE}]`),
    ).toBe(null);
    using source = build({prefix: 's'});
    append(source, parseFixture(NESTED));
    using target = build({html: {import: false}, prefix: 't'});
    append(target, exportDocument(source));
    expect(tree(target).some(entry => entry.includes(':s'))).toBe(false);
  });

  test('a wrapper id goes only on a block that holds that list alone', () => {
    using editor = build({prefix: 'e'});
    append(
      editor,
      parseFixture(
        // A top-level list: its parent is the root, which takes no id.
        '<ul data-block-wrapper-id="top"><li>a</li></ul>' +
          // A nested list after the item's text: the importer wraps it in an
          // item of its own, which takes the id.
          '<ul><li data-block-id="item">text' +
          '<ul data-block-wrapper-id="w"><li>inner</li></ul></li></ul>',
      ),
    );
    const outline = tree(editor);
    expect(outline).toContain('listitem:item');
    expect(outline).toContain('listitem:w');
    expect(outline.some(entry => entry.endsWith(':top'))).toBe(false);
    expect(JSON.stringify(editor.getEditorState().toJSON())).not.toContain(
      '"top"',
    );
  });

  test('handles: true writes no wrapper id', () => {
    using editor = build({html: {handles: true}, prefix: 'h'});
    append(editor, parseFixture(NESTED));
    const [doc] = exportWithHandles(editor);
    expect(doc.querySelector(`[${BLOCK_WRAPPER_ID_ATTRIBUTE}]`)).toBe(null);
    expect(doc.querySelector(`[${BLOCK_ID_ATTRIBUTE}]`)).toBe(null);
  });
});
