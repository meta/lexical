/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {MdastConfig, MdastPunctuationMode} from '../../index';
import type {Table} from 'mdast';

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$createListItemNode, $createListNode} from '@lexical/list';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKeyOrThrow,
  $getRoot,
  $isElementNode,
  $isTextNode,
  configExtension,
  defineExtension,
  type LexicalEditor,
  ParagraphNode,
  TEXT_TYPE_TO_FORMAT,
  TextNode,
} from 'lexical';
import {assert, describe, expect, it, onTestFinished, vi} from 'vitest';

import {parseEvents} from '../../cjkFriendly';
import {
  $convertFromMarkdownString,
  $convertSelectionToMarkdownString,
  $convertToMarkdownString,
  MdastExtension,
  MdastGfmExtension,
  MdastListExtension,
} from '../../index';
import {createMdastExport} from '../../MdastExport';

// Counts the parses of the export, which the cmark-gfm pass alone makes in
// a strict export.
vi.mock('../../cjkFriendly', async importOriginal => {
  const original = await importOriginal<typeof import('../../cjkFriendly')>();
  return {...original, parseEvents: vi.fn(original.parseEvents)};
});

const {code, italic, strikethrough} = TEXT_TYPE_TO_FORMAT;

function createEditor(config: Partial<MdastConfig> = {}): LexicalEditor {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        MdastGfmExtension,
        configExtension(MdastExtension, config),
      ],
      name: '[root]',
    }),
  );
  onTestFinished(() => editor.dispose());
  return editor;
}

/** An editor whose export writes the text of each text node as raw HTML. */
function createRawEditor(
  exportPunctuation?: MdastPunctuationMode,
  importPunctuation?: MdastPunctuationMode,
): LexicalEditor {
  return createEditor({
    exportPunctuation,
    exportRules: [
      {
        $export: node =>
          $isTextNode(node)
            ? {type: 'html', value: node.getTextContent()}
            : null,
        type: TextNode,
      },
    ],
    importPunctuation,
  });
}

/**
 * How an export writes `markdown`, written as raw HTML, which the export
 * keeps as it is but for the references it writes.
 */
function exportRaw(
  markdown: string,
  exportPunctuation?: MdastPunctuationMode,
  importPunctuation?: MdastPunctuationMode,
  editor = createRawEditor(exportPunctuation, importPunctuation),
): string {
  editor.update(
    () =>
      $getRoot()
        .clear()
        .append($createParagraphNode().append($createTextNode(markdown))),
    {discrete: true},
  );
  return editor.read('latest', () => $convertToMarkdownString());
}

/**
 * An editor for {@link exportRaw} whose cmark-gfm pass has run the drift
 * probe of its model, which runs once for the editor's syntax and parses.
 */
function createProbedEditor(): LexicalEditor {
  const editor = createRawEditor();
  exportRaw('©_a_', undefined, undefined, editor);
  return editor;
}

/** How often a strict export of `markdown` parses it, the probe aside. */
function countParses(markdown: string): number {
  const editor = createProbedEditor();
  vi.mocked(parseEvents).mockClear();
  exportRaw(markdown, undefined, undefined, editor);
  return vi.mocked(parseEvents).mock.calls.length;
}

/** How a table with a row for each of `rows`, of raw HTML cells, exports. */
function exportTable(rows: string[][], definitions = ''): string {
  const table: Table = {
    align: rows[0].map(() => null),
    children: rows.map(cells => ({
      children: cells.map(value => ({
        children: [{type: 'html', value}],
        type: 'tableCell',
      })),
      type: 'tableRow',
    })),
    type: 'table',
  };
  const editor = createEditor({
    exportRules: [
      {
        $export: node =>
          node.getTextContent() === ''
            ? table
            : {type: 'html', value: node.getTextContent()},
        type: ParagraphNode,
      },
    ],
  });
  editor.update(
    () => {
      $getRoot().clear().append($createParagraphNode());
      if (definitions) {
        $getRoot().append(
          $createParagraphNode().append($createTextNode(definitions)),
        );
      }
    },
    {discrete: true},
  );
  return editor.read('latest', () => $convertToMarkdownString());
}

describe('strict export for cmark-gfm', () => {
  // cmark-gfm skips a `~` run beside a `*` or `_` run and reads the
  // character beyond it, here the `a` that a `~~` pair holds.
  it.each([
    ['~~a~~*`b`*', '~~&#x61;~~*`b`*'],
    ['*`b`*~~a~~', '*`b`*~~&#x61;~~'],
    ['~~a~~_`b`_', '~~&#x61;~~_`b`_'],
    ['_`b`_~~a~~', '_`b`_~~&#x61;~~'],
    ['~~a~~**`b`**', '~~&#x61;~~**`b`**'],
    ['**`b`**~~a~~', '**`b`**~~&#x61;~~'],
    ['~~a~~*.*', '~~&#x61;~~*.*'],
    ['**.**~~a~~', '**.**~~&#x61;~~'],
  ])('writes a reference beyond a `~` run: %s', (markdown, expected) => {
    expect(exportRaw(markdown)).toBe(expected);
  });

  // cmark-gfm reads a symbol of the Basic Multilingual Plane as a letter,
  // beside `_` and beside `~`.
  it.each([
    ['©_a_', '&#xA9;_a_'],
    ['_a_©', '_a_&#xA9;'],
    ['©~~`b`~~', '&#xA9;~~`b`~~'],
    ['~~`b`~~©', '~~`b`~~&#xA9;'],
    ['©~`b`~', '&#xA9;~`b`~'],
  ])(
    'writes a symbol beside a run as a reference: %s',
    (markdown, expected) => {
      expect(exportRaw(markdown)).toBe(expected);
    },
  );

  it('leaves a symbol beside a `*` run, which flanks alike', () => {
    expect(exportRaw('©*a*')).toBe('©*a*');
    expect(exportRaw('©**a**')).toBe('©**a**');
  });

  describe('exports', () => {
    // Appends a paragraph with the runs, then another, and returns the
    // first.
    function $appendStockRuns(): ParagraphNode {
      const paragraph = $createParagraphNode().append(
        $createTextNode('a').setFormat(strikethrough),
        $createTextNode('b').setFormat(italic | code),
      );
      $getRoot()
        .clear()
        .append(paragraph, $createParagraphNode().append($createTextNode('c')));
      return paragraph;
    }

    it('writes the references in the export of a node', () => {
      const editor = createEditor();
      let key = '';
      editor.update(() => (key = $appendStockRuns().getKey()), {
        discrete: true,
      });
      expect(
        editor.read('latest', () => {
          const paragraph = $getNodeByKeyOrThrow(key);
          assert($isElementNode(paragraph));
          return $convertToMarkdownString(paragraph);
        }),
      ).toBe('~~&#x61;~~*`b`*');
    });

    it('writes the references in the export of a selection', () => {
      const editor = createEditor();
      editor.update(
        () => {
          const paragraph = $appendStockRuns();
          paragraph.select(0, paragraph.getChildrenSize());
        },
        {discrete: true},
      );
      expect(
        editor.read('latest', () => $convertSelectionToMarkdownString()),
      ).toBe('~~&#x61;~~*`b`*');
    });

    it('writes the references in an editor without strikethrough', () => {
      const editor = buildEditorFromExtensions(
        defineExtension({dependencies: [MdastExtension], name: '[root]'}),
      );
      onTestFinished(() => editor.dispose());
      editor.update(() => $convertFromMarkdownString('©_a_'), {
        discrete: true,
      });
      expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
        '&#xA9;_a_',
      );
    });
  });

  it('repairs a strikethrough and emphasis that a stock export writes', () => {
    const editor = createEditor();
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('a').setFormat(strikethrough),
              $createTextNode('b').setFormat(italic | code),
            ),
          ),
      {discrete: true},
    );
    const markdown = editor.read('latest', () => $convertToMarkdownString());
    expect(markdown).toBe('~~&#x61;~~*`b`*');
    editor.update(() => $convertFromMarkdownString(markdown), {
      discrete: true,
    });
    expect(
      editor.read('latest', () =>
        $getRoot()
          .getAllTextNodes()
          .map(node => [node.getTextContent(), node.getFormat()]),
      ),
    ).toEqual([
      ['a', strikethrough],
      ['b', italic | code],
    ]);
  });

  it.each([
    // Both sides of one run.
    ['**a&#x20;**~~b~~a', '**a&#x20;**~~&#x62;~~&#x61;'],
    ['_©___©.__', '_&#xA9;___&#xA9;.__'],
    // A supporting reference beyond the far side of a touching `~` run.
    ['你~~a~~_b_', '&#x4F60;~~&#x61;~~_b_'],
    ['b~~a~~*`b`*', '&#x62;~~&#x61;~~*`b`*'],
  ])(
    'writes two references where one is not enough: %s',
    (markdown, expected) => {
      expect(exportRaw(markdown)).toBe(expected);
    },
  );

  it('repairs a run that a repair beside it depends on', () => {
    expect(exportRaw('©~~你~~_`b`_')).toBe('&#xA9;~~&#x4F60;~~_`b`_');
  });

  it.each([
    ['# ©_a_', '# &#xA9;_a_'],
    ['Title ©_a_\n===', 'Title &#xA9;_a_\n==='],
    ['- ©_a_', '- &#xA9;_a_'],
    ['1. ©_a_', '1. &#xA9;_a_'],
    ['> ©_a_', '> &#xA9;_a_'],
    ['[©_a_](u)', '[&#xA9;_a_](u)'],
    ['~~a~~*`b`*\n\n©_a_', '~~&#x61;~~*`b`*\n\n&#xA9;_a_'],
  ])(
    'repairs headings, lists, quotes and link text: %j',
    (markdown, expected) => {
      expect(exportRaw(markdown)).toBe(expected);
    },
  );

  it.each([
    // Image labels, and shortcut, collapsed and full reference labels,
    // which are identifiers.
    '![©_a_](u)',
    '[©_a_]\n\n[©_a_]: u',
    '[©_a_][]\n\n[©_a_]: u',
    '[r][©_a_]\n\n[©_a_]: u',
    // Code and autolinks, which hold no runs.
    '`©_a_`',
    '<https://a.co/©_a_>',
    '```\n©_a_\n```',
  ])('leaves labels, code and autolinks as they are: %j', markdown => {
    expect(exportRaw(markdown)).toBe(markdown);
  });

  it('leaves characters without a lossless reference', () => {
    // The opening `~~` would need its control character as a reference.
    expect(exportRaw('\u0001~~a~~*`b`*')).toBe('\u0001~~a~~*`b`*');
    expect(exportRaw('\u0080~~a~~*`b`*')).toBe('\u0080~~a~~*`b`*');
    // At the endpoints of the C1 controls and of the noncharacters U+FDD0
    // to U+FDEF, whose numeric references micromark decodes as U+FFFD.
    for (const character of ['\u007f', '\u009f', '\ufdd0', '\ufdef']) {
      expect(exportRaw(`${character}~~a~~*\`b\`*`)).toBe(
        `${character}~~a~~*\`b\`*`,
      );
    }
    // Just outside U+FDD0 to U+FDEF, which have one.
    expect(exportRaw('\ufdcf_a_')).toBe('&#xFDCF;_a_');
    expect(exportRaw('~~\ufdf0~~*`b`*')).toBe('~~&#xFDF0;~~*`b`*');
    // Without even trying it: the reading alone.
    expect(countParses('\u0001~~a~~*`b`*')).toBe(1);
  });

  it('leaves punctuation that cmark-gfm may not have in its table', () => {
    // U+2E4F is punctuation for the host, a letter for cmark-gfm.
    expect(exportRaw('⹏_a_')).toBe('⹏_a_');
    expect(exportRaw('*⹏*~~a~~⹏')).toBe('*⹏*~~&#x61;~~&#x2E4F;');
    // A run that does not fail, in a subject with a literal marker of its
    // character, keeps both of its flags however cmark-gfm reads U+061D.
    expect(exportRaw('~~*~__؝~~©`b`→©→**')).toBe('~~*~__؝~~©`b`→©→**');
  });

  it('leaves a CJK-friendly export as it is', () => {
    for (const markdown of ['~~a~~*`b`*', '©_a_', '你~~a~~_b_']) {
      expect(exportRaw(markdown, 'cjk-friendly')).toBe(markdown);
    }
  });

  it('reads with the strict syntax whatever the import reads', () => {
    expect(exportRaw('你~~a~~_b_', undefined, 'strict-commonmark')).toBe(
      '&#x4F60;~~&#x61;~~_b_',
    );
    expect(exportRaw('你~~a~~_b_', undefined, 'cjk-friendly')).toBe(
      '&#x4F60;~~&#x61;~~_b_',
    );
    // A CJK-friendly reading would ask for a reference here that strict
    // readers do not need.
    expect(exportRaw('~~*~~你', undefined, 'cjk-friendly')).toBe('~~*~~你');
  });

  it('leaves the export of a registry that it did not compile', () => {
    const editor = createEditor({
      exportRules: [
        {
          $export: node =>
            $isTextNode(node)
              ? {type: 'html', value: node.getTextContent()}
              : null,
          type: TextNode,
        },
      ],
    });
    const {registry} = getExtensionDependencyFromEditor(
      editor,
      MdastExtension,
    ).output;
    const {$exportToMarkdown} = createMdastExport({...registry});
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('©_a_'))),
      {discrete: true},
    );
    expect(editor.read('latest', $exportToMarkdown)).toBe('©_a_');
  });

  describe('word guard', () => {
    it.each([
      'localhost//©_a_',
      '//localhost©_a_',
      'x नमस्ते.com→_x_',
      'see readme.md→_x_',
      'x 1.2.3.4©_a_',
      'x a@b©_a_',
      'x mailto:a©_a_',
      // Unlike JavaScript's \s, linkify-it's word boundary does not include
      // U+FEFF.
      'http://a.com/\uFEFF©_a_',
      'x a.co/\uFEFF©_x_',
    ])('leaves a word with a link shape: %j', markdown => {
      expect(exportRaw(markdown)).toBe(markdown);
    });

    it('repairs a word without one', () => {
      expect(exportRaw('localhost©_a_')).toBe('localhost&#xA9;_a_');
      // A `:` that ends the word starts no link.
      expect(exportRaw('©_a_:')).toBe('&#xA9;_a_:');
      expect(exportRaw('**`.b`**~~你b~~©©')).toBe('**`.b`**~~&#x4F60;b~~©©');
    });

    describe('bare URLs of cmark-gfm', () => {
      const urls = [
        'http://a.co/',
        'https://a.co/',
        'FTP://a.co/',
        'hTtP://a.co/',
        'www.a.co/',
      ];
      const spaces = ['\u3000', '\u00a0', '\u2028', '\u2029', '\u000b'];
      // cmark-gfm takes a URL up to an ASCII space, so the space between is
      // in it, and a reference after it would show as text in the link.
      it.each(urls.flatMap(url => spaces.map(space => [url, space])))(
        'leaves %s%j and what follows',
        (url, space) => {
          const markdown = `${url}${space}©_a_`;
          expect(exportRaw(markdown)).toBe(markdown);
          const lines = exportTable([['x'], [markdown]]).split('\n');
          expect(lines[2]).toBe(`| ${markdown} |`);
          expect(new Set(lines.map(line => line.length)).size).toBe(1);
        },
      );

      it.each(['*', '_', '~', '(', '>'])(
        'leaves a `www.` URL after %s',
        start => {
          const markdown = `${start}www.a.co\u3000©_a_`;
          expect(exportRaw(markdown)).toBe(markdown);
        },
      );

      it('leaves a URL across a form feed', () => {
        // `cmark_isspace` does not read a form feed as a space.
        expect(exportRaw('http://a.co/\f©_a_')).toBe('http://a.co/\f©_a_');
      });

      it('leaves them through an import and an export', () => {
        const editor = createEditor({importPunctuation: 'strict-commonmark'});
        for (const url of urls) {
          for (const space of spaces.slice(0, 4)) {
            const markdown = `${url}${space}©_a_`;
            editor.update(() => $convertFromMarkdownString(markdown), {
              discrete: true,
            });
            // The export escapes a `:` after `P` as it does that of `http:`,
            // and then cmark-gfm reads no URL here, so the `©` before `_a_`
            // is written as a reference.
            expect(
              editor.read('latest', () => $convertToMarkdownString()),
            ).toBe(
              url === 'FTP://a.co/'
                ? `FTP\\://a.co/${space}&#xA9;_a_`
                : markdown,
            );
          }
        }
      });

      it('repairs what is not in one', () => {
        // After an ASCII space, before the URL, and after letters that
        // make no scheme cmark-gfm links, or no space before `www.`.
        expect(exportRaw('http://a.co/ ©_a_')).toBe('http://a.co/ &#xA9;_a_');
        expect(exportRaw('©_a_\u3000http://a.co/')).toBe(
          '&#xA9;_a_\u3000http://a.co/',
        );
        expect(exportRaw('xhttp://a.co/\u3000©_a_')).toBe(
          'xhttp://a.co/\u3000&#xA9;_a_',
        );
        expect(exportRaw('你好www.a.co\u3000©_a_')).toBe(
          '你好www.a.co\u3000&#xA9;_a_',
        );
        // A tab, a line ending or a `<` ends the URL; `www.` is not read
        // in another case, nor a scheme without `//`.
        expect(exportRaw('http://a.co/\t©_a_')).toBe('http://a.co/\t&#xA9;_a_');
        expect(exportRaw('http://a.co/\n©_a_')).toBe('http://a.co/\n&#xA9;_a_');
        expect(exportRaw('http://a.co/\r©_a_')).toBe('http://a.co/\r&#xA9;_a_');
        expect(exportRaw('http://a.co/<\u3000©_a_')).toBe(
          'http://a.co/<\u3000&#xA9;_a_',
        );
        expect(exportRaw('WWW.a.co\u3000©_a_')).toBe('WWW.a.co\u3000&#xA9;_a_');
        // `cmark_isspace` reads bytes, so a space outside ASCII before `www.`
        // starts no link; nor does a `[`, which is not in the set.
        expect(exportRaw('a\u3000www.a.co\u3000©_a_')).toBe(
          'a\u3000www.a.co\u3000&#xA9;_a_',
        );
        expect(exportRaw('[www.a.co\u3000©_a_')).toBe(
          '[www.a.co\u3000&#xA9;_a_',
        );
        expect(exportRaw('http:a.co\u3000©_a_')).toBe(
          'http:a.co\u3000&#xA9;_a_',
        );
        // cmark-gfm reads each table cell on its own.
        expect(exportRaw('http://a.co/|\u3000©_a_\n-|-')).toBe(
          'http://a.co/|\u3000&#xA9;_a_\n-|-',
        );
      });
    });

    it('joins the words beside a candidate that is a word break', () => {
      expect(exportRaw('\u2028*&*~~&')).toBe('&#x2028;*&*~~&');
      expect(exportRaw('x.co\u2028*&*~~&')).toBe('x.co\u2028*&*~~&');
      expect(exportRaw('. a~~©\n a&_a_\u2028x.co')).toBe(
        '. a~~©\n a&_a_\u2028x.co',
      );
    });
  });

  describe('region check', () => {
    it.each([
      // `~` that markdown-it may pair, in a literal autolink, an autolink,
      // raw HTML or a definition next to the paragraph.
      'www.a.com/~~x *&*~~a~~',
      '<javascript:~~x> *&*~~a~~',
      '<b title="~~">x *&*~~a~~',
      '[r]: javascript:~~x\n*&*~~a~~',
      '<pre>~~x</pre>\n*&*~~a~~',
      // A literal `~` run that a reference would let pair.
      '\\~~~~*&*~~a~~',
      '**a&#x20;**~~b~~a x~y',
      // A backtick that other readers may read as code.
      'a`b ©_a_',
    ])('leaves a subject with loose markers or backticks: %j', markdown => {
      expect(exportRaw(markdown)).toBe(markdown);
    });

    it('repairs a run that loose markers do not read', () => {
      expect(exportRaw('\\~~~~*&*~~a~~ ©_a_')).toBe('\\~~~~*&*~~a~~ &#xA9;_a_');
      expect(exportRaw('`x`©_a_')).toBe('`x`&#xA9;_a_');
    });

    it('counts list markers and thematic breaks as syntax', () => {
      expect(exportRaw('* *&*~~a~~')).toBe('* *&*~~&#x61;~~');
      expect(exportRaw('* 你*~.* ~~')).toBe('* &#x4F60;*~.* ~~');
      expect(exportRaw('* * *\n你*~*')).toBe('* * *\n&#x4F60;*~*');
    });

    it('keeps the flags of a run that loose markers may pair with', () => {
      // A reference to `©` would let the closing `~~` close in cmark-gfm,
      // but would change how cmark-gfm reads the literal `*` across it,
      // which another reader may pair.
      expect(exportRaw('~~b*~~©')).toBe('~~b*~~©');
    });
  });

  describe('work', () => {
    // How many regular expression tests an export of `$fill(n)` makes,
    // which the scans of the pass make once for each character they read.
    function countTests(fill: (size: number) => void, n: number): number {
      const editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [MdastGfmExtension, MdastListExtension, MdastExtension],
          name: '[root]',
        }),
      );
      onTestFinished(() => editor.dispose());
      editor.update(() => fill(n), {discrete: true});
      // Counted, not recorded: a spy would keep every call. The method is
      // put back below.
      const {test} = RegExp.prototype;
      let count = 0;
      // eslint-disable-next-line no-extend-native
      RegExp.prototype.test = function (this: RegExp, value: string) {
        count++;
        return test.call(this, value);
      };
      try {
        editor.read('latest', () => $convertToMarkdownString());
        return count;
      } finally {
        // eslint-disable-next-line no-extend-native
        RegExp.prototype.test = test;
      }
    }

    it.each([
      [
        'a list of items that each repair, each its own region',
        (n: number) => {
          const list = $createListNode('bullet');
          $getRoot().clear().append(list);
          for (let i = 0; i < n; i++) {
            list.append(
              $createListItemNode().append(
                $createTextNode('The current section is approved. '),
                $createTextNode('a').setFormat(strikethrough),
                $createTextNode('b').setFormat(italic | code),
              ),
            );
          }
        },
      ],
      [
        'a paragraph of CJK text, one word',
        (n: number) => {
          const paragraph = $createParagraphNode();
          $getRoot().clear().append(paragraph);
          for (let i = 0; i < n; i++) {
            paragraph.append(
              $createTextNode('甲').setFormat(strikethrough),
              $createTextNode('乙').setFormat(italic | code),
              $createTextNode('这是下一句。'),
            );
          }
        },
      ],
    ])('reads %s in linear work', (_, fill) => {
      // Four times the input is about four times the work, not sixteen.
      const ratio = countTests(fill, 800) / countTests(fill, 200);
      expect(ratio).toBeLessThan(6);
    });
  });

  describe('search', () => {
    it('reads nothing where no marker may read otherwise', () => {
      expect(countParses('*a* _b_ ~~c~~')).toBe(0);
    });

    it('checks the edits of every subject in one parse', () => {
      // The reading and one parse for the edits, which also serves the
      // final check of the document, as the edits are all kept.
      expect(countParses('~~a~~*`b`*\n\n©_a_\n\n# _a_©')).toBe(2);
    });

    it('blocks a pair that it cannot repair whole, and searches again', () => {
      // The `_` pair around `©` is repaired; the `**` pair around `*~*©`
      // cannot be, and its opener is not repaired alone.
      expect(exportRaw('_©___©.__ 你→€b*~*©** ©€')).toBe(
        '_&#xA9;___&#xA9;.__ 你→€b*~*©** ©€',
      );
      // The reading and the final check: the model judges the rounds.
      expect(countParses('_©___©.__ 你→€b*~*©** ©€')).toBe(2);
      expect(
        exportRaw(
          '***a\\~\\~b***~~你\\~\\~\\\\~~©***`.。`***~~a_b\\_!~~**\\~**',
        ),
      ).toBe(
        '***a\\~\\~b***~~你\\~\\~\\\\~~&#xA9;***`.。`***~~a_b\\_!~~**\\~**',
      );
      expect(
        countParses(
          '***a\\~\\~b***~~你\\~\\~\\\\~~©***`.。`***~~a_b\\_!~~**\\~**',
        ),
      ).toBe(2);
    });

    it('splits a proposal that changes the reading in halves', () => {
      expect(exportRaw('~~_a\\~\\~ba\\~\\~b_€a_b\\a~~___`!_.`___')).toBe(
        '~~_a\\~\\~ba\\~\\~b_&#x20AC;a_b\\a~~___`!_.`___',
      );
      // The reading and the document: the model judges the batch and the
      // four rounds (the second for each half).
      expect(countParses('~~_a\\~\\~ba\\~\\~b_€a_b\\a~~___`!_.`___')).toBe(2);
    });

    it('stays within a few parses for a long paragraph', () => {
      const markdown =
        `__b &#x20;*x&#x20;~*a_© ${'_©___©.__ '.repeat(400)}`.trim();
      const out = exportRaw(markdown);
      expect(out.split('&#xA9;___&#xA9;.__').length).toBe(401);
      expect(countParses(markdown)).toBeLessThan(6);
    });
  });

  describe('whitespace', () => {
    it('reads the whitespace that cmark-gfm reads beside a run', () => {
      expect(exportRaw('©_a_\u3000b')).toBe('&#xA9;_a_\u3000b');
      expect(exportRaw('©_a_\fb')).toBe('&#xA9;_a_\fb');
      expect(exportRaw('©_a_\nb')).toBe('&#xA9;_a_\nb');
      expect(exportRaw('©_a_\tb')).toBe('&#xA9;_a_\tb');
      expect(exportRaw('©_a_\r\nb')).toBe('&#xA9;_a_\r\nb');
      expect(exportRaw('*©©__a_\u3000©_\u3000')).toBe(
        '*©&#xA9;__a_\u3000©_\u3000',
      );
    });

    it('reads U+FEFF and U+2028 as letters in the region check', () => {
      // micromark reads them as whitespace, CommonMark readers as letters,
      // so a reference beside the closing `_` would change its flags there.
      expect(exportRaw('©_a_\uFEFF _')).toBe('©_a_\uFEFF _');
      expect(exportRaw('._a_\u2028→~~~~_')).toBe('._a_\u2028→~~~~_');
    });
  });

  describe('guards', () => {
    it('writes no reference to a control character', () => {
      expect(exportRaw('\u001f~~a~~*`b`*')).toBe('\u001f~~a~~*`b`*');
    });

    it('writes a character outside the plane as one reference', () => {
      expect(exportRaw('🎉~~a~~*`b`*')).toBe('&#x1F389;~~&#x61;~~*`b`*');
    });

    it('reads the lines below a subject and stops at its container', () => {
      expect(exportRaw('©_a_\n<pre>`</pre>')).toBe('©_a_\n<pre>`</pre>');
      expect(exportRaw('> ©_a_\n<pre>`</pre>')).toBe(
        '> &#xA9;_a_\n<pre>`</pre>',
      );
      // A container that has closed holds the lines below it no more.
      expect(exportRaw('> x\n\n©_a_\n<pre>`</pre>')).toBe(
        '> x\n\n©_a_\n<pre>`</pre>',
      );
      // The innermost container bounds the region, above and below.
      expect(exportRaw('> - ©_a_\n> <pre>`</pre>')).toBe(
        '> - &#xA9;_a_\n> <pre>`</pre>',
      );
      expect(exportRaw('a`b\n> ©_a_')).toBe('a`b\n> &#xA9;_a_');
    });

    it('stops at a blank line, a blank quote line too', () => {
      expect(exportRaw('©_a_\n\na`')).toBe('&#xA9;_a_\n\na`');
      expect(exportRaw('> ©_a_\n>\n> a`')).toBe('> &#xA9;_a_\n>\n> a`');
      expect(exportRaw('> a`b\n>\n> ©_a_')).toBe('> a`b\n>\n> &#xA9;_a_');
    });

    it('keeps the cmark-gfm flags of a run that does not fail', () => {
      expect(exportRaw('~~`b`©~~**⹏aa**.~~')).toBe('~~`b`©~~**⹏aa**.~~');
    });

    it('checks the attempts of a group together', () => {
      expect(exportRaw('__→_©**~~**xx`b`→ b_')).toBe(
        '__&#x2192;_©**~~**xx`b`→ b_',
      );
      expect(exportRaw('©_©_a_→a a_a_&😀.uk_a_')).toBe(
        '&#xA9;_©_a_→a a_a_&😀.uk_a_',
      );
      expect(exportRaw(';→~~*&*~~→_a_©_**')).toBe(
        ';&#x2192;~~*&#x26;*~~&#x2192;_a_©_**',
      );
    });

    it('lists the attempts again from the edits a round keeps', () => {
      expect(exportRaw('*&*~~a~~a~~a~~_a_')).toBe(
        '*&*~~&#x61;~~&#x61;~~&#x61;~~_a_',
      );
    });

    it('gives no `~~` run a flag that pairs it across an enclosing one', () => {
      // The reference to `a` would let the `~~` before it close for
      // CommonMark readers, as the `*` before it and the `&` after it are
      // punctuation, and markdown-it and cmark-gfm would then close the
      // outer `~~` there, which micromark pairs with the last `~~`.
      expect(exportRaw('*&*~~*~~a~~_a_* a~~')).toBe('*&*~~*~~a~~_a_* a~~');
      // A reference to `©`, a letter for cmark-gfm, would do so there alone.
      expect(exportRaw('*&*~~*~~©~~_©_* ©~~')).toBe('*&*~~*~~©~~_©_* ©~~');
      // The `~~` pair that holds the run is inside a `_` pair.
      expect(exportRaw('_*~~a *~~a~~*~~©_')).toBe('_*~~a *~~a~~*~~©_');
      // U+2E4F is newer than cmark-gfm's table, which may read it as
      // punctuation or as a letter: under either, the reference must not
      // give the run that flag.
      expect(exportRaw('*~~a *~~⹏~~*~~©')).toBe('*~~a *~~⹏~~*~~©');
      // A single `~` pair holds the run. Only `~` runs are read: were the
      // `_` runs read too, the `a` and `©` attempt would be blocked, `©`
      // alone would be written, and cmark-gfm would close the outer `_`
      // before `~©`.
      expect(exportRaw('_~*~a~_a_~©_')).toBe('_~*~a~_a_~©_');
    });

    it.each([
      // A flag that the run's role asks for, which pairs it as before.
      ['~~*~~a *~~©~~', '~~*~~a *~~&#xA9;~~'],
      ['~~*~~a~~a~~*&*', '~~*~~a~~&#x61;~~*&*'],
      // An enclosing pair of another marker, or of another length.
      ['~~a~~*&***~~a~~**→&', '~~&#x61;~~*&***~~&#x61;~~**&#x2192;&'],
      ['~~*~a~_a_~~', '~~*~&#x61;~_a_~~'],
      ['©~~*~a *a*~*~~*', '&#xA9;~~*~&#x61; *a*~*~~*'],
    ])(
      'repairs a nested `~` run that pairs as before: %s',
      (markdown, expected) => {
        expect(exportRaw(markdown)).toBe(expected);
      },
    );

    it('counts no blocked run as repaired', () => {
      expect(exportRaw('©_©*&*~~a©_*&*~~a~~.')).toBe(
        '&#xA9;_©*&*~~a©_*&*~~a~~.',
      );
    });

    it('keeps the flags of a run that is not missing any', () => {
      expect(exportRaw('__ _] ⹏_→~')).toBe('__ _] ⹏_&#x2192;~');
    });

    it('reads a matched run with the literal markers beside it', () => {
      expect(exportRaw('& ©__a_→;a;')).toBe('& ©__a_→;a;');
    });

    it('writes references in the text of a full reference link', () => {
      expect(exportRaw('[©_a_][r]\n\n[r]: u')).toBe('[&#xA9;_a_][r]\n\n[r]: u');
    });

    it('tries nothing in a shortcut reference label', () => {
      // The reading alone: a reference there would not match the label.
      expect(countParses('[©_a_]\n\n[©_a_]: u')).toBe(1);
    });

    it('returns the export as it is when micromark reads it otherwise', () => {
      const editor = createProbedEditor();
      const original = vi.mocked(parseEvents).getMockImplementation()!;
      const asQuote: typeof original = (markdown, extensions) => {
        const events = original(markdown, extensions);
        events[0][1].type = 'blockQuote';
        return events;
      };
      // The reading, and then the parses of the edits, in which the heading
      // reads as a quote: its text reads as before, the document does not.
      // The final check after the model's verdicts fails, and so does the
      // one of the search with parse verdicts after it.
      vi.mocked(parseEvents)
        .mockImplementationOnce(original)
        .mockImplementationOnce(asQuote)
        .mockImplementationOnce(asQuote);
      expect(exportRaw('# ©_a_', undefined, undefined, editor)).toBe('# ©_a_');
      expect(exportRaw('# ©_a_', undefined, undefined, editor)).toBe(
        '# &#xA9;_a_',
      );
    });
  });

  describe('tables', () => {
    it('repairs a cell whose only brackets are of an inline link', () => {
      for (const cell of ['\\][©_a_](u)', '`]`[©_a_](u)']) {
        const lines = exportTable([['x'], [cell]]).split('\n');
        expect(lines[2]).toBe(`| ${cell.replace('©', '&#xA9;')} |`);
        expect(new Set(lines.map(line => line.length)).size).toBe(1);
      }
    });

    it('reads each cell on its own', () => {
      // A backtick or a link shape in another cell does not stop a repair.
      expect(exportRaw('a`b|©_a_\n-|-')).toBe('a`b|&#xA9;_a_\n-|-');
      expect(exportRaw('a.co|©_a_\n-|-')).toBe('a.co|&#xA9;_a_\n-|-');
    });

    it('aligns a cell that it repairs', () => {
      expect(
        exportTable([
          ['x', 'y'],
          ['©_a_', '[©_a_](u)'],
        ]),
      ).toBe(
        [
          '| x         | y              |',
          '| --------- | -------------- |',
          '| &#xA9;_a_ | [&#xA9;_a_](u) |',
        ].join('\n'),
      );
    });

    it.each([
      ['[©_a_](x y)', '[x y]: u'],
      ['[r][©_a_](u)', '[r]: u'],
      ['[©_a_]', '[©_a_]: u'],
      // A pair across a bracket, which the definition makes a link of.
      ['©_[a_][r]', '[r]: u'],
      ['©_[a_]', '[a_]: u'],
      ['©*[a*][r]', '[r]: u'],
      ['©~~[a~~][r]', '[r]: u'],
      ['*©_a_©_[a_]*', '[a_]: u'],
      // Brackets that a definition makes a link of, beside the run.
      ['©_a_ [x]', '[x]: u'],
      ['©_a_ [x][r]', '[r]: u'],
      ['[©_a_][r]', '[r]: u'],
      // A bracket beside an inline link, and on its own.
      ['[©_a_](u)]', ''],
      ['[[©_a_](u)', ''],
      ['©_a_ ]', ''],
      ['©_a_ [', ''],
      ['![i](u) ©_a_', ''],
      // An escaped backslash, after which the bracket opens.
      ['\\\\[©_a_]', '[©_a_]: u'],
      ['[©_a_\\]]', '[©_a_\\]]: u'],
    ])(
      'leaves bracketed text in a cell, as it measures it: %s',
      (cell, definition) => {
        const markdown = exportTable([['x'], [cell]], definition);
        const lines = markdown.split('\n');
        expect(lines[2]).toBe(`| ${cell} |`);
        expect(new Set(lines.slice(0, 3).map(line => line.length)).size).toBe(
          1,
        );
      },
    );
  });
});
