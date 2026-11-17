/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {MdastConfig, MdastPunctuationMode} from '../../index';
import type {Paragraph} from 'mdast';
import type {Extension as MicromarkExtension} from 'micromark-util-types';

import {buildEditorFromExtensions} from '@lexical/extension';
import {$createLinkNode} from '@lexical/link';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  configExtension,
  defineExtension,
  type LexicalEditor,
  ParagraphNode,
  TEXT_TYPE_TO_FORMAT,
  TextNode,
} from 'lexical';
import {defaultHandlers} from 'mdast-util-to-markdown';
import {toString as mdastToString} from 'mdast-util-to-string';
import {assert, describe, expect, it, onTestFinished} from 'vitest';

import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  MdastExtension,
  MdastGfmExtension,
} from '../../index';

const {bold, italic, strikethrough} = TEXT_TYPE_TO_FORMAT;

type Runs = [text: string, format: number][];

function createEditor(
  exportPunctuation?: MdastPunctuationMode,
  importPunctuation?: MdastPunctuationMode,
  config: Partial<MdastConfig> = {},
): LexicalEditor {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        MdastGfmExtension,
        configExtension(MdastExtension, {
          ...config,
          exportPunctuation,
          importPunctuation,
        }),
      ],
      name: '[root]',
    }),
  );
  onTestFinished(() => editor.dispose());
  return editor;
}

function $appendRuns(runs: Runs): void {
  $getRoot()
    .clear()
    .append(
      $createParagraphNode().append(
        ...runs.map(([text, format]) =>
          $createTextNode(text).setFormat(format),
        ),
      ),
    );
}

function roundTrip(
  runs: Runs,
  exportPunctuation?: MdastPunctuationMode,
  importPunctuation?: MdastPunctuationMode,
): [markdown: string, runs: Runs] {
  const editor = createEditor(exportPunctuation, importPunctuation);
  editor.update(() => $appendRuns(runs), {discrete: true});
  const markdown = editor.read('latest', () => $convertToMarkdownString());
  return [markdown, importRuns(editor, markdown)];
}

function $getRuns(): Runs {
  return $getRoot()
    .getAllTextNodes()
    .map(node => [node.getTextContent(), node.getFormat()]);
}

/**
 * How a CJK-friendly export writes `markdown`, written as raw HTML, which
 * the export keeps as it is but for the references it rewrites.
 */
function exportRaw(markdown: string): string {
  const editor = createEditor('cjk-friendly', undefined, {
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
  editor.update(() => $appendRuns([[markdown, 0]]), {discrete: true});
  return editor.read('latest', () => $convertToMarkdownString());
}

/** The runs `markdown` imports to in `editor`. */
function importRuns(editor: LexicalEditor, markdown: string): Runs {
  editor.update(() => $convertFromMarkdownString(markdown), {discrete: true});
  return editor.read('latest', $getRuns);
}

describe('Mdast punctuation modes', () => {
  // runs, export for strict readers, export for CJK-friendly readers.
  it.each<[runs: Runs, strict: string, cjkFriendly: string]>([
    [
      [
        ['你好。', bold],
        ['世界', 0],
      ],
      '**你好。**&#x4E16;界',
      '**你好。**世界',
    ],
    // A CJK-friendly reader reads a run with a CJK character on one side as
    // opening and closing beside any letter on the other.
    [
      [
        ['你好。', bold],
        ['abc', 0],
      ],
      '**你好。**&#x61;bc',
      '**你好。**abc',
    ],
    // Or beside a reference to one, which is written as it too.
    [
      [
        ['a', 0],
        ['。', bold | italic],
        ['世', italic],
        ['b', 0],
      ],
      '&#x61;***。**&#x4E16;*&#x62;',
      'a***。**世*b',
    ],
    // An escaped marker is no run.
    [
      [
        ['x*a', 0],
        ['。', bold],
      ],
      'x\\*&#x61;**。**',
      'x\\*a**。**',
    ],
    [
      [
        ['abc', 0],
        ['「强调」', bold],
      ],
      'ab&#x63;**「强调」**',
      'abc**「强调」**',
    ],
    [
      [
        ['你好。', strikethrough],
        ['abc', 0],
      ],
      '~~你好。~~&#x61;bc',
      '~~你好。~~abc',
    ],
    [
      [
        ['a', 0],
        ['\u{1f200}', bold],
        ['b', 0],
      ],
      '&#x61;**&#x1F200;**&#x62;',
      'a**\u{1f200}**b',
    ],
    // A backslash before the letter is no escape, so the one that escaped it
    // goes with the reference.
    [
      [
        ['a\\b', 0],
        ['。', bold],
      ],
      'a\\\\&#x62;**。**',
      'a\\b**。**',
    ],
    [
      [
        ['a\\\\b', 0],
        ['「x」', bold],
      ],
      'a\\\\\\\\&#x62;**「x」**',
      'a\\\\\\b**「x」**',
    ],
    // Not where a run beside the reference has none.
    [
      [
        ['a.', bold],
        ['b', 0],
        ['你。', bold],
      ],
      '**a.**&#x62;**你。**',
      '**a.**&#x62;**你。**',
    ],
    // The escape that keeps the text from reading as an autolink stays.
    [
      [
        ['你好。', bold],
        ['www.example.com', 0],
      ],
      '**你好。**&#x77;ww\\.example.com',
      '**你好。**www\\.example.com',
    ],
    // Strikethrough writes references as emphasis does.
    [
      [
        ['世', 0],
        ['「x」', strikethrough],
        ['界', 0],
      ],
      '&#x4E16;~~「x」~~&#x754C;',
      '世~~「x」~~界',
    ],
    // A selector before a closing `~~` goes out as a reference, which
    // micromark-extension-cjk-friendly-gfm-strikethrough reads as other
    // readers do.
    [
      [
        ['x ', 0],
        ['Done \u2714\ufe0e', strikethrough],
        [' y', 0],
      ],
      'x ~~Done \u2714&#xFE0E;~~ y',
      'x ~~Done \u2714&#xFE0E;~~ y',
    ],
    // A reference to whitespace inside a run stays.
    [
      [
        ['世', 0],
        [' a', bold],
      ],
      '&#x4E16;**&#x20;a**',
      '世**&#x20;a**',
    ],
    // `_` does not open between two letters for any reader.
    [
      [
        ['世', italic],
        ['「a」', bold],
      ],
      '*世*__「a」__',
      '*世*__「a」__',
    ],
    // Text that is not CJK keeps its references.
    [
      [
        ['a', 0],
        ['“b”', bold],
      ],
      '&#x61;**“b”**',
      '&#x61;**“b”**',
    ],
    // An emoji, outside the Basic Multilingual Plane, is punctuation for
    // CJK-friendly readers as for CommonMark, so a letter beside a run that
    // starts or ends with one goes out as a reference. micromark without the
    // CJK-friendly extension reads it as a letter, so for strict readers the
    // emoji goes out as one too where that would change how the run beside
    // it flanks.
    [
      [
        ['Hello', 0],
        ['\u{1f389} launch', bold],
      ],
      'Hell&#x6F;**&#x1F389; launch**',
      'Hell&#x6F;**\u{1f389} launch**',
    ],
    [
      [
        ['Release', 0],
        ['\u{1f680}', bold],
        ['now', 0],
      ],
      'Releas&#x65;**&#x1F680;**&#x6E;ow',
      'Releas&#x65;**\u{1f680}**&#x6E;ow',
    ],
    [
      [
        ['foo', 0],
        ['\u{1f525}hot', italic],
        ['bar', 0],
      ],
      'fo&#x6F;*&#x1F525;hot*bar',
      'fo&#x6F;*\u{1f525}hot*bar',
    ],
    [
      [
        ['a', 0],
        ['\u{1f44d}ok', strikethrough],
      ],
      '&#x61;~~&#x1F44D;ok~~',
      '&#x61;~~\u{1f44d}ok~~',
    ],
    // The closing run of one attention and the opening run of the next are
    // one run, which both opens and closes for some readers.
    [
      [
        ['a\u{1f389}', italic],
        ['“b”', bold],
      ],
      '*a&#x1F389;***“b”**',
      '*a\u{1f389}***“b”**',
    ],
    // A CJK character beside the emoji needs one only for strict readers.
    [
      [
        ['你好', 0],
        ['\u{1f389}', bold],
      ],
      '你&#x597D;**&#x1F389;**',
      '你好**\u{1f389}**',
    ],
    // micromark without the CJK-friendly extension reads an emoji as a
    // letter, so one that would keep the run from opening for it goes out as
    // a reference.
    [
      [
        ['b\u{1f600}', 0],
        ['」0你', strikethrough],
      ],
      'b&#x1F600;~~」0你~~',
      'b\u{1f600}~~」0你~~',
    ],
    // A variation selector before a marker reads, for CJK-friendly readers,
    // as the character it varies; for others it is a letter.
    [
      [
        ['\u00a9\ufe0e', bold],
        ['2024', 0],
      ],
      '**\u00a9&#xFE0E;**&#x32;024',
      '**\u00a9&#xFE0E;**&#x32;024',
    ],
    [
      [
        ['x', 0],
        ['\ufe0e', italic],
        ['b', 0],
      ],
      '&#x78;*&#xFE0E;*&#x62;',
      '&#x78;*&#xFE0E;*&#x62;',
    ],
    [
      [['Done \u2714\ufe0e', strikethrough]],
      '~~Done \u2714&#xFE0E;~~',
      '~~Done \u2714&#xFE0E;~~',
    ],
    [
      [
        ['Done \u2714\ufe0e', bold],
        ['next', 0],
      ],
      '**Done \u2714&#xFE0E;**&#x6E;ext',
      '**Done \u2714&#xFE0E;**&#x6E;ext',
    ],
    // A backslash before a character that goes out as a reference is
    // escaped.
    [
      [
        ['a\\\ufe0e', bold],
        ['b', 0],
      ],
      '**a\\\\&#xFE0E;**&#x62;',
      '**a\\\\&#xFE0E;**&#x62;',
    ],
    // Other backslashes go out as typed.
    [[['C:\\dir\\x', 0]], 'C:\\dir\\x', 'C:\\dir\\x'],
    [
      [
        ['C:\\dir\\x', 0],
        ['y', bold],
      ],
      'C:\\dir\\x**y**',
      'C:\\dir\\x**y**',
    ],
    [[['Use \\n', bold]], '**Use \\n**', '**Use \\n**'],
    // A backslash before another is escaped, as to-markdown escapes it.
    [[['Use \\\\n', bold]], '**Use \\\\\\n**', '**Use \\\\\\n**'],
    [
      [
        ['a\\\\b', 0],
        ['x', bold],
      ],
      'a\\\\\\b**x**',
      'a\\\\\\b**x**',
    ],
    // Every backslash of a run before a reference is escaped, and the
    // escape of the last goes where the reference becomes its character.
    [
      [
        ['a\\\\\ufe0e', bold],
        ['b', 0],
      ],
      '**a\\\\\\\\&#xFE0E;**&#x62;',
      '**a\\\\\\\\&#xFE0E;**&#x62;',
    ],
    [
      [
        ['a\\\\世', 0],
        ['。', bold],
      ],
      'a\\\\\\\\&#x4E16;**。**',
      'a\\\\\\世**。**',
    ],
    // micromark reads U+FEFF as whitespace, CommonMark as a letter.
    [
      [
        ['\u00a9', italic],
        ['\ufeff\u3002世', 0],
      ],
      '*\u00a9*&#xFEFF;\u3002世',
      '*\u00a9*&#xFEFF;\u3002世',
    ],
    // An escaped marker beside an emoji is punctuation like any other.
    [
      [
        ['a*\u{1f389} ', 0],
        ['b', italic],
      ],
      'a\\*\u{1f389} *b*',
      'a\\*\u{1f389} *b*',
    ],
    // A reference that is not beside a marker stays.
    [[['&世', 0]], '&世', '&世'],
    // No reference stands for `\v`, which micromark reads as whitespace.
    [
      [
        ['x\v', 0],
        ['!b', bold],
      ],
      'x\v**!b**',
      'x\v**!b**',
    ],
  ])('exports %j', (runs, strict, cjkFriendly) => {
    expect(roundTrip(runs)).toEqual([strict, runs]);
    expect(roundTrip(runs, 'strict-commonmark')).toEqual([strict, runs]);
    expect(roundTrip(runs, 'strict-commonmark', 'strict-commonmark')).toEqual([
      strict,
      runs,
    ]);
    expect(roundTrip(runs, 'cjk-friendly')).toEqual([cjkFriendly, runs]);
  });

  it('reads an emoji beside a marker as the punctuation it is', () => {
    const editor = createEditor(undefined, 'cjk-friendly');
    const read = (markdown: string) => importRuns(editor, markdown);
    // As markdown-it-cjk-friendly and micromark-extension-cjk-friendly read
    // them: a run between a letter and punctuation does not open, and one
    // between punctuation and a letter does not close.
    expect(read('Hello**🎉 launch**')).toEqual([['Hello**🎉 launch**', 0]]);
    expect(read('a~~🎉 x~~')).toEqual([['a~~🎉 x~~', 0]]);
    expect(read('**🎉**b')).toEqual([['**🎉**b', 0]]);
    expect(read('~~🎉~~b')).toEqual([['~~🎉~~b', 0]]);
  });

  it('reads a selector as the character it varies', () => {
    const editor = createEditor(undefined, 'cjk-friendly');
    const read = (markdown: string) => importRuns(editor, markdown);
    // As markdown-it-cjk-friendly and micromark-extension-cjk-friendly read
    // them: a selector after an astral ideograph reads as that ideograph, and
    // U+FE01 shows a quotation mark full width, as CJK punctuation.
    expect(read('a\u{20000}\ufe0e**“x”** b')).toEqual([
      ['a\u{20000}\ufe0e', 0],
      ['“x”', bold],
      [' b', 0],
    ]);
    expect(read('**x“\ufe01**a')).toEqual([
      ['x“\ufe01', bold],
      ['a', 0],
    ]);
    expect(read('**x“**a')).toEqual([['**x“**a', 0]]);
    // An ideographic variation selector reads as CJK, and a selector after
    // one reads as neither, as a character that is not CJK.
    expect(read('葛\u{e0100}**(a)**')).toEqual([
      ['葛\u{e0100}', 0],
      ['(a)', bold],
    ]);
    expect(read('中\u{e0100}\ufe0e**“x”** b')).toEqual([
      ['中\u{e0100}\ufe0e**“x”** b', 0],
    ]);
  });

  it('reads a selector after a code of its own in a chunk of its own', () => {
    const editor = createEditor(undefined, 'cjk-friendly');
    const read = (markdown: string) => importRuns(editor, markdown);
    // As markdown-it-cjk-friendly and @lexical/markdown read them, where
    // micromark-extension-cjk-friendly reads the selector itself.
    expect(read('a\0\ufe0e**“x”** b')).toEqual([
      ['a\ufffd\ufe0e', 0],
      ['“x”', bold],
      [' b', 0],
    ]);
    expect(read('a**x\0\ufe0e**b')).toEqual([['a**x\ufffd\ufe0e**b', 0]]);
    // After a tab (with virtual spaces after it or not) or a line ending, as
    // after a space, the selector reads as itself, not as what comes before
    // the code, as micromark-extension-cjk-friendly reads it, where
    // markdown-it-cjk-friendly reads the whitespace before it.
    expect(read('中\t\ufe0e**“x”** b')).toEqual([
      ['中', 0],
      ['\t', 0],
      ['\ufe0e**“x”** b', 0],
    ]);
    expect(read('ab中\t\ufe0e**“x”** b')).toEqual([
      ['ab中', 0],
      ['\t', 0],
      ['\ufe0e**“x”** b', 0],
    ]);
    for (const lineEnding of ['\r\n', '\n']) {
      expect(read(`中${lineEnding}\ufe0e**“x”** b`)).toEqual([
        ['中', 0],
        ['\ufe0e**“x”** b', 0],
      ]);
    }
    expect(read('**x“\t\ufe0e**b')).toEqual([
      ['x“', bold],
      ['\t', bold],
      ['\ufe0e', bold],
      ['b', 0],
    ]);
  });

  it('writes U+0000 as the U+FFFD symbol readers replace it with', () => {
    const runs: Runs = [
      ['a\0', bold],
      ['b', 0],
    ];
    for (const mode of ['strict-commonmark', 'cjk-friendly'] as const) {
      expect(roundTrip(runs, mode)).toEqual([
        '**a\0**&#x62;',
        [
          ['a\ufffd', bold],
          ['b', 0],
        ],
      ]);
    }
  });

  it('writes no reference beside `~` without strikethrough', () => {
    const editor = buildEditorFromExtensions(
      defineExtension({dependencies: [MdastExtension], name: '[root]'}),
    );
    onTestFinished(() => editor.dispose());
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('\u{1f389}~a ok \u2714\ufe0e~~b'),
            ),
          ),
      {discrete: true},
    );
    expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
      '\u{1f389}~a ok \u2714\ufe0e~~b',
    );
  });

  it('reads a `*` run beside a `_` run alike in both import modes', () => {
    for (const importPunctuation of [
      'strict-commonmark',
      'cjk-friendly',
    ] as const) {
      expect(
        importRuns(
          createEditor(undefined, importPunctuation),
          'foo**_bar_**baz',
        ),
      ).toEqual([
        ['foo**', 0],
        ['bar', italic],
        ['**baz', 0],
      ]);
    }
  });

  it('keeps backslashes before a reference and a leading U+FEFF', () => {
    for (const runs of [
      [
        ['\\a', 0],
        ['\u{1f389}a', bold],
      ],
      [
        ['\\0', 0],
        ['\ufe0e', italic],
      ],
      [
        ['a\\b', 0],
        ['。', bold],
      ],
      [
        ['a\\\\b', 0],
        ['“x”', bold],
      ],
      [['\ufeffabc', 0]],
    ] as Runs[]) {
      for (const mode of ['strict-commonmark', 'cjk-friendly'] as const) {
        expect(roundTrip(runs, mode)[1]).toEqual(runs);
      }
    }
  });

  it('keeps references in code and escaped ones', () => {
    const editor = createEditor('cjk-friendly');
    const markdown = '`**&#x4E16;`\n\n\\&#x4E16;**a**';
    editor.update(() => $convertFromMarkdownString(markdown), {
      discrete: true,
    });
    expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
      markdown,
    );
  });

  it('writes no reference for a stand-in whose readings all flank alike', () => {
    // The selector beyond the run goes out as a reference of its own.
    expect(
      roundTrip([
        ['“\u{20000}\0', 0],
        ['\ufe0e', bold],
      ]),
    ).toEqual([
      '“\u{20000}\0**&#xFE0E;**',
      [
        ['“\u{20000}\ufffd', 0],
        ['\ufe0e', bold],
      ],
    ]);
  });

  it.each<[string, MicromarkExtension]>([
    ['declares', {attentionMarkers: {null: [61]}}],
    [
      'starts its syntax with',
      {text: {61: {tokenize: (_effects, _ok, nok) => nok}}},
    ],
  ])('keeps a reference beside a marker an extension %s', (_, extension) => {
    // As `_` does, a marker that a syntax extension adds may open or close
    // beside the reference other than beside its character.
    const editor = createEditor('cjk-friendly', undefined, {
      micromarkExtensions: [extension],
    });
    editor.update(
      () =>
        $appendRuns([
          ['你好。', bold],
          ['世=', 0],
        ]),
      {discrete: true},
    );
    expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
      '**你好。**&#x4E16;=',
    );
  });

  it.each([
    // Written as its character, the run would close as well as open.
    [
      'a reference to a CJK character with a letter beyond the run',
      '&#x4E16;**a**',
    ],
    // With `b` beyond its run, the reference to 世 stays, and so the one to
    // `a` beyond the run on its other side does too.
    [
      'a letter reference beside a CJK reference that stays',
      '*c **b**&#x4E16;*&#x61;**。**',
    ],
  ])('keeps %s', (_, markdown) => {
    expect(exportRaw(markdown)).toBe(markdown);
  });

  it.each([
    // A CJK character beside a run opens and closes it beside a reference
    // that stays on the other side.
    ['**。**&#x4E16;**&#x754C;**b', '**。**世**&#x754C;**b'],
    // The backslash that stays is before 世, not after it.
    ['&\\\\&#x4E16;**&#x61;', '&\\世**a'],
  ])('rewrites the references of %j', (markdown, cjkFriendly) => {
    expect(exportRaw(markdown)).toBe(cjkFriendly);
  });

  it('keeps a reference to a lone surrogate beside a CJK run', () => {
    const editor = createEditor('cjk-friendly');
    editor.update(
      () =>
        $appendRuns([
          ['a\ud800', 0],
          ['。', bold],
        ]),
      {discrete: true},
    );
    expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
      'a&#xD800;**。**',
    );
  });

  // micromark reads each of these references as U+FFFD, as typed or not.
  it.each([
    ['\x01', '&#x1;'],
    ['\x85', '&#x85;'],
    ['\ufdd0', '&#xFDD0;'],
    ['\u{1fffe}', '&#x1FFFE;'],
  ])('keeps a reference to %j beside a CJK run', (character, reference) => {
    const editor = createEditor('cjk-friendly');
    editor.update(
      () =>
        $appendRuns([
          [`a${character}`, 0],
          ['。', bold],
        ]),
      {discrete: true},
    );
    expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
      `a${reference}**。**`,
    );
  });

  it('keeps a reference past the last code point', () => {
    const editor = createEditor('cjk-friendly');
    const markdown = '\\&#9999999;**x**';
    editor.update(() => $convertFromMarkdownString(markdown), {
      discrete: true,
    });
    expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
      markdown,
    );
  });

  it('picks emoji stand-ins that handlers do not write', () => {
    // A handler that writes a character the export would otherwise use as
    // the emoji's stand-in, and one it would use next.
    const editor = createEditor(undefined, undefined, {
      toMarkdownExtensions: [
        {
          handlers: {
            paragraph: (node, parent, state, info) =>
              defaultHandlers.paragraph(node, parent, state, info) +
              ' \u2e00\u2e01',
          },
        },
      ],
    });
    editor.update(
      () =>
        $appendRuns([
          ['Hello', 0],
          ['\u{1f389} launch', bold],
        ]),
      {discrete: true},
    );
    expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
      'Hell&#x6F;**&#x1F389; launch** \u2e00\u2e01',
    );
  });

  it('leaves the mdast tree as it was, data that is not JSON included', () => {
    const paragraphs: Paragraph[] = [];
    const editor = createEditor(undefined, undefined, {
      exportRules: [
        {
          $export: (_node, context) => {
            const [paragraph] = context.next();
            assert(paragraph.type === 'paragraph');
            paragraph.data = {
              cycle: paragraph,
              size: BigInt(1),
            } as Paragraph['data'];
            paragraphs.push(paragraph);
            return paragraph;
          },
          type: ParagraphNode,
        },
      ],
    });
    editor.update(
      () =>
        $appendRuns([
          ['Hello', 0],
          ['\u{1f389} launch', bold],
        ]),
      {discrete: true},
    );
    expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
      'Hell&#x6F;**&#x1F389; launch**',
    );
    expect(paragraphs.map(paragraph => mdastToString(paragraph))).toEqual([
      'Hello\u{1f389} launch',
    ]);
  });

  it('writes a leading U+FEFF as a reference', () => {
    const editor = createEditor('cjk-friendly');
    editor.update(
      () =>
        $appendRuns([
          ['\ufeff\u3002', 0],
          ['你好。', bold],
          ['世界', 0],
        ]),
      {discrete: true},
    );
    expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
      '&#xFEFF;\u3002**你好。**世界',
    );
  });

  it('writes no reference in an autolink', () => {
    for (const url of ['https://x.com/_\u{1f389}', 'https://x.com/a_\ufe0e']) {
      const editor = createEditor();
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createLinkNode(url).append($createTextNode(url)),
              ),
            ),
        {discrete: true},
      );
      const markdown = editor.read('latest', () => $convertToMarkdownString());
      expect(markdown).toBe(`<${url}>`);
      editor.update(() => $convertFromMarkdownString(markdown), {
        discrete: true,
      });
      expect(editor.read('latest', () => $getRoot().getTextContent())).toBe(
        url,
      );
    }
  });

  it('counts the stand-ins text writes, not text an autolink writes', () => {
    // A text handler that writes U+2E00, the first stand-in, after `b`.
    const editor = createEditor(undefined, undefined, {
      toMarkdownExtensions: [
        {
          handlers: {
            text: (node, parent, state, info) =>
              defaultHandlers.text(node, parent, state, info) +
              (node.value === 'b' ? '\u2e00' : ''),
          },
        },
      ],
    });
    const url = 'https://x.com/\u{1f389}';
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createLinkNode(url).append($createTextNode(url)),
              $createTextNode('b'),
            ),
          ),
      {discrete: true},
    );
    expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
      `<${url}>b\u2e00`,
    );
  });

  it('calls handlers with the state as this', () => {
    const editor = createEditor(undefined, undefined, {
      toMarkdownExtensions: [
        {
          handlers: {
            paragraph(this: unknown, node, parent, state, info) {
              expect(this).toBe(state);
              return defaultHandlers.paragraph(node, parent, state, info);
            },
          },
        },
      ],
    });
    editor.update(
      () =>
        $appendRuns([
          ['Hello', 0],
          ['\u{1f389} launch', bold],
        ]),
      {discrete: true},
    );
    expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
      'Hell&#x6F;**&#x1F389; launch**',
    );
  });

  it('counts no text that a look ahead at a link writes', () => {
    // A handler that writes U+2E00, the emoji's first stand-in, once.
    const editor = createEditor(undefined, undefined, {
      toMarkdownExtensions: [
        {
          handlers: {
            paragraph: (node, parent, state, info) =>
              defaultHandlers.paragraph(node, parent, state, info) + ' \u2e00',
          },
        },
      ],
    });
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('x\u{1f389} '),
              $createLinkNode('https://x.com').append(
                $createTextNode('\u{1f389}'),
              ),
            ),
          ),
      {discrete: true},
    );
    expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
      'x\u{1f389} [\u{1f389}](https://x.com) \u2e00',
    );
  });

  it('aligns table cells as a CJK-friendly export writes them', () => {
    const editor = createEditor('cjk-friendly');
    editor.update(
      () =>
        $convertFromMarkdownString(
          '| a | b |\n| - | - |\n| **你好。**世界 | x |',
        ),
      {discrete: true},
    );
    const lines = editor
      .read('latest', () => $convertToMarkdownString())
      .split('\n');
    expect(lines[2]).toBe('| **你好。**世界 | x |');
    expect(lines.map(line => line.length)).toEqual(
      lines.map(() => lines[2].length),
    );
  });

  it('aligns table cells with references a CJK-friendly export keeps', () => {
    const editor = createEditor('cjk-friendly');
    editor.update(
      () =>
        $convertFromMarkdownString(
          '| a | b |\n| - | - |\n| `a&#x4E16;**` | x |\n| a\\&#x4E16;**b** | x |\n| yyyyyyyyyyyyyyyyyy | z |',
        ),
      {discrete: true},
    );
    const lines = editor
      .read('latest', () => $convertToMarkdownString())
      .split('\n');
    expect(lines[2]).toContain('`a&#x4E16;**`');
    expect(lines[3]).toContain('&#x4E16;**b**');
    expect(lines.map(line => line.length)).toEqual(
      lines.map(() => lines[4].length),
    );
  });

  it('measures a cell as inline text in a CJK-friendly export', () => {
    // Writes text that starts with `<` as raw HTML.
    const editor = createEditor('cjk-friendly', undefined, {
      exportRules: [
        {
          $export: node =>
            $isTextNode(node) && node.getTextContent().startsWith('<')
              ? {type: 'html', value: node.getTextContent()}
              : null,
          type: TextNode,
        },
      ],
    });
    editor.update(
      () => {
        $convertFromMarkdownString(
          '| a | b |\n| - | - |\n| cell | x |\n| yyyyyyyyyyyyyyyyyy | z |',
        );
        const cell = $getRoot()
          .getAllTextNodes()
          .find(node => node.getTextContent() === 'cell');
        assert(cell !== undefined);
        // Underlined so that it stays a node of its own.
        const html = cell.replace(
          $createTextNode('<div>').setFormat('underline'),
        );
        html
          .insertAfter($createTextNode('世'))
          .insertAfter($createTextNode('。').setFormat('bold'));
      },
      {discrete: true},
    );
    const lines = editor
      .read('latest', () => $convertToMarkdownString())
      .split('\n');
    expect(lines[2]).toContain('<div>世**。**');
    expect(lines.map(line => line.length)).toEqual(
      lines.map(() => lines[3].length),
    );
  });

  it('aligns table cells by the characters put back', () => {
    const editor = createEditor();
    editor.update(
      () =>
        $convertFromMarkdownString(
          '| \u{1f389}\u{1f389}\u{1f389} | x |\n| - | - |\n| &#x61;**\u{1f389}**&#x62; | b |',
        ),
      {discrete: true},
    );
    const lines = editor
      .read('latest', () => $convertToMarkdownString())
      .split('\n');
    expect(lines[2]).toBe('| &#x61;**&#x1F389;**&#x62; | b |');
    expect(lines.map(line => line.length)).toEqual(
      lines.map(() => lines[2].length),
    );
  });
});
