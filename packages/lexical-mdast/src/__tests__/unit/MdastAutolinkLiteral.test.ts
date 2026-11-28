/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {MdastPunctuationMode} from '../../index';
import type {AnyLexicalExtensionArgument} from '@lexical/extension';
import type {Link, Paragraph, PhrasingContent, Root} from 'mdast';

import {buildEditorFromExtensions} from '@lexical/extension';
import {$isLinkNode} from '@lexical/link';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  configExtension,
  defineExtension,
  type LexicalEditor,
  type LexicalEditorWithDispose,
} from 'lexical';
import {describe, expect, it} from 'vitest';

import {gfmAutolinkLiteralFromSource} from '../../autolinkLiteral';
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  MdastExtension,
  MdastGfmExtension,
} from '../../index';

type Links = [text: string, url: string][];
type Children = Paragraph['children'];

// A paragraph of an emphasis and a text with a URL.
function createTree(): Root {
  return {
    children: [
      {
        children: [
          {children: [{type: 'text', value: 'b'}], type: 'emphasis'},
          {type: 'text', value: 'a www.x.com'},
        ],
        type: 'paragraph',
      },
    ],
    type: 'root',
  };
}

function createLink(url: string, value: string): Link {
  return {children: [{type: 'text', value}], type: 'link', url};
}

const modes: MdastPunctuationMode[] = ['strict-commonmark', 'cjk-friendly'];

function createEditor(
  mode: MdastPunctuationMode,
  dependencies: AnyLexicalExtensionArgument[] = [MdastGfmExtension],
): LexicalEditorWithDispose {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        ...dependencies,
        configExtension(MdastExtension, {
          exportPunctuation: mode,
          importPunctuation: mode,
        }),
      ],
      name: '[root]',
    }),
  );
}

/** The text that `markdown` imports to in `editor`, and its links. */
function importMarkdown(
  editor: LexicalEditor,
  markdown: string,
): [text: string, links: Links] {
  editor.update(() => $convertFromMarkdownString(markdown), {discrete: true});
  return editor.read('latest', () => [
    $getRoot().getTextContent(),
    $getRoot()
      .getAllTextNodes()
      .flatMap(node => {
        const link = node.getParent();
        return $isLinkNode(link)
          ? [[node.getTextContent(), link.getURL()] satisfies Links[number]]
          : [];
      }),
  ]);
}

describe('MdastAutolinkLiteralExtension', () => {
  // text, and its export.
  it.each([
    ['https://x.com', 'https\\://x.com'],
    ['HTTPS://x.com', 'HTTPS\\://x.com'],
    ['www.x.com', 'www\\.x.com'],
    ['世www.x.com', '世www\\.x.com'],
    ['www.', 'www\\.'],
    ['a www. b', 'a www\\. b'],
    // No literal starts at a single `w`, so its `.` needs no escape.
    ['new.file', 'new.file'],
  ])('reads back the export of %j as text', (text, markdown) => {
    for (const mode of modes) {
      using editor = createEditor(mode);
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode(text)));
        },
        {discrete: true},
      );
      expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
        markdown,
      );
      expect(importMarkdown(editor, markdown)).toEqual([text, []]);
      expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
        markdown,
      );
    }
  });

  // Markdown, its text, and its links, as cmark-gfm 0.29.0.gfm.14 reads
  // them, but where a comment says otherwise. To check one again:
  // `printf '%s\n' '<markdown>' | cmark-gfm -e autolink`.
  it.each<[string, string, Links]>([
    // GitHub finds a URL in the source in comments, so one that an escape
    // or a reference writes stays text.
    ['https\\://x.com', 'https://x.com', []],
    ['&#x77;ww.x.com', 'www.x.com', []],
    ['www&#46;', 'www.', []],
    ['&#95;www.x.com', '_www.x.com', []],
    ['&#40;www.x.com', '(www.x.com', []],
    ['WWW\\.x.com', 'WWW.x.com', []],
    ['wwww.x.com', 'wwww.x.com', []],
    // A reference that decodes to two characters.
    ['&ThickSpace;www.x.com', '\u205F\u200Awww.x.com', []],
    ['https\\://x.com and www\\.y.com', 'https://x.com and www.y.com', []],
    // Before `www.`, it reads the character as written, so an escaped `*`,
    // `_`, `~` or `(` starts a literal as the character does.
    ['\\*www.x.com', '*www.x.com', [['www.x.com', 'http://www.x.com']]],
    ['\\(www.x.com', '(www.x.com', [['www.x.com', 'http://www.x.com']]],
    // GFM starts no `www.` literal after other punctuation or a code span.
    ['see .www.x.com here', 'see .www.x.com here', []],
    ['wow!www.x.com', 'wow!www.x.com', []],
    ['`code`www.a.example', 'codewww.a.example', []],
    ['"www.x.com"', '"www.x.com"', []],
    // It starts a `http(s)://` literal there, as GitHub does.
    [
      'see .https://x.com here',
      'see .https://x.com here',
      [['https://x.com', 'https://x.com']],
    ],
    [
      'wow!https://x.com',
      'wow!https://x.com',
      [['https://x.com', 'https://x.com']],
    ],
    [
      '`c`https://x.com',
      'chttps://x.com',
      [['https://x.com', 'https://x.com']],
    ],
    [
      '"https://x.com"',
      '"https://x.com"',
      [['https://x.com', 'https://x.com']],
    ],
    // micromark links these from the source, with the characters as
    // written.
    ['https://x.com', 'https://x.com', [['https://x.com', 'https://x.com']]],
    [
      'https://x&#46;com',
      'https://x&#46;com',
      [['https://x&#46;com', 'https://x&#46;com']],
    ],
    [
      'https://x\\.com',
      'https://x\\.com',
      [['https://x\\.com', 'https://x\\.com']],
    ],
    [
      'www.x.co/a\\_b',
      'www.x.co/a\\_b',
      [['www.x.co/a\\_b', 'http://www.x.co/a\\_b']],
    ],
    [
      'https\\://x.com/(www.y.com) z',
      'https://x.com/(www.y.com) z',
      [['www.y.com', 'http://www.y.com']],
    ],
    [
      'www&#46;x.com(https://y.com next',
      'www.x.com(https://y.com next',
      [['https://y.com', 'https://y.com']],
    ],
    [
      'www\\.x.com/https://y.com/a@b.co',
      'www.x.com/https://y.com/a@b.co',
      [['https://y.com/a@b.co', 'https://y.com/a@b.co']],
    ],
    // GitHub finds emails in the decoded text, so an escape or a reference
    // does not keep one text.
    ['a\\@b.co', 'a@b.co', [['a@b.co', 'mailto:a@b.co']]],
    ['a&#64;b.co', 'a@b.co', [['a@b.co', 'mailto:a@b.co']]],
    ['世a\\@b.co', '世a@b.co', [['a@b.co', 'mailto:a@b.co']]],
    ['mailto:a\\@b.co', 'mailto:a@b.co', [['mailto:a@b.co', 'mailto:a@b.co']]],
    // micromark links only the email of this one, where cmark-gfm links
    // all of it.
    ['mailto:a@b.co', 'mailto:a@b.co', [['a@b.co', 'mailto:a@b.co']]],
    ['xmpp:a\\@b.co', 'xmpp:a@b.co', [['xmpp:a@b.co', 'xmpp:a@b.co']]],
    ['xmpp:a\\@b.co/r', 'xmpp:a@b.co/r', [['xmpp:a@b.co/r', 'xmpp:a@b.co/r']]],
    // and an email in or around a URL that stays text links, with the
    // letters of `www` and `http` as written.
    [
      'https\\://x.com/a@b.co',
      'https://x.com/a@b.co',
      [['a@b.co', 'mailto:a@b.co']],
    ],
    [
      'https\\://www.x.com/a@b.co',
      'https://www.x.com/a@b.co',
      [['a@b.co', 'mailto:a@b.co']],
    ],
    [
      'https\\://x.com/www.y.com/a@b.co',
      'https://x.com/www.y.com/a@b.co',
      [['a@b.co', 'mailto:a@b.co']],
    ],
    ['www\\.x\\@b.co', 'www.x@b.co', [['www.x@b.co', 'mailto:www.x@b.co']]],
    ['-www\\.x\\@b.co', '-www.x@b.co', [['-www.x@b.co', 'mailto:-www.x@b.co']]],
    ['a@www\\.x.co', 'a@www.x.co', [['a@www.x.co', 'mailto:a@www.x.co']]],
    ['Www.x@b.co', 'Www.x@b.co', [['Www.x@b.co', 'mailto:Www.x@b.co']]],
    ['Www\\.x\\@b.co', 'Www.x@b.co', [['Www.x@b.co', 'mailto:Www.x@b.co']]],
    // Known differences. micromark leaves out the last `.` before it checks
    // the `_` in the last two parts of the domain, and so finds no URL,
    // where cmark-gfm checks first and links `www._x.com` and
    // `https://x_y.com`. A URL that GitHub links but micromark does not
    // find in the source stays text. Another case: micromark finds no URL
    // when a `_` follows a non-ASCII letter in the last two parts of the
    // domain, where cmark-gfm stops checking at that letter and links it.
    ['www._x.com. next', 'www._x.com. next', []],
    ['https://x_y.com. next', 'https://x_y.com. next', []],
    ['see www.café_bar.com x', 'see www.café_bar.com x', []],
    ['see https://x.café_bar.com x', 'see https://x.café_bar.com x', []],
    // micromark links an email from the source, so a reference before an
    // unescaped `@` ends the local part, where cmark-gfm links `abc@d.co`.
    ['x a&#98;c@d.co y', 'x abc@d.co y', [['c@d.co', 'mailto:c@d.co']]],
    // The email pattern of the library takes the first `@`, where cmark-gfm
    // links `www.x.com@b.co`.
    [
      'a\\@www.x.com\\@b.co',
      'a@www.x.com@b.co',
      [['a@www.x.com', 'mailto:a@www.x.com']],
    ],
  ])('imports %j', (markdown, text, links) => {
    for (const mode of modes) {
      using editor = createEditor(mode);
      expect(importMarkdown(editor, markdown)).toEqual([text, links]);
    }
  });

  // Markdown, its text, and its links.
  it.each<[string, string, Links]>([
    ['- [ ] https\\://a.co', 'https://a.co', []],
    ['- [ ] x https\\://a.co', 'x https://a.co', []],
    ['- [ ] www.x.com', 'www.x.com', [['www.x.com', 'http://www.x.com']]],
    [
      '- [ ] www\\.x\\@b.co',
      'www.x@b.co',
      [['www.x@b.co', 'mailto:www.x@b.co']],
    ],
    ['*https\\://x.com*', 'https://x.com', []],
    ['*www\\.x\\@b.co*', 'www.x@b.co', [['www.x@b.co', 'mailto:www.x@b.co']]],
    ['# https\\://x.com', 'https://x.com', []],
    ['| a |\n| - |\n| https\\://x.com |', 'a\n\nhttps://x.com', []],
    ['[a](u) https\\://x.com', 'a https://x.com', [['a', 'u']]],
    // A paragraph that mixes the forms keeps the email link.
    [
      '*b* https\\://x.com a\\@b.co',
      'b https://x.com a@b.co',
      [['a@b.co', 'mailto:a@b.co']],
    ],
    ['[https\\://x.com](u)', 'https://x.com', [['https://x.com', 'u']]],
    [
      '[https\\://x.com][r]\n\n[r]: u',
      'https://x.com',
      [['https://x.com', 'u']],
    ],
  ])('imports %j inside other syntax', (markdown, text, links) => {
    for (const mode of modes) {
      using editor = createEditor(mode);
      expect(importMarkdown(editor, markdown)).toEqual([text, links]);
    }
  });

  it('reads back the export of an email that starts with `www.`', () => {
    for (const mode of modes) {
      using editor = createEditor(mode);
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append($createTextNode('www.x@b.co')),
            );
        },
        {discrete: true},
      );
      const markdown = editor.read('latest', () => $convertToMarkdownString());
      expect(markdown).toBe('www\\.x\\@b.co');
      expect(importMarkdown(editor, markdown)).toEqual([
        'www.x@b.co',
        [['www.x@b.co', 'mailto:www.x@b.co']],
      ]);
    }
  });

  it('finds no URL in text that a transform before it adds', () => {
    using editor = createEditor('strict-commonmark', [
      configExtension(MdastExtension, {
        mdastExtensions: [
          {
            transforms: [
              tree => {
                const [paragraph] = tree.children;
                if (paragraph.type === 'paragraph') {
                  paragraph.children.push({
                    type: 'text',
                    value: ' www.x.com a@b.co',
                  });
                }
              },
            ],
          },
        ],
      }),
      MdastGfmExtension,
    ]);
    expect(importMarkdown(editor, 'a')).toEqual([
      'a www.x.com a@b.co',
      [['a@b.co', 'mailto:a@b.co']],
    ]);
  });

  it('leaves the transforms no URL to find in a masked text', () => {
    // The mask copies the start of the library's URL pattern. A later
    // version that finds URLs of another form in the decoded text would
    // link them here, as this text has every form we know of.
    const {transforms} = gfmAutolinkLiteralFromSource();
    const value =
      'http://a.co HTTPS://b.co Http://c.co www.d.co WWW.e.co Www.f.co ' +
      'ftp://g.co FTP://h.co file://i.co a@b.co';
    const tree: Root = {
      children: [{children: [{type: 'text', value}], type: 'paragraph'}],
      type: 'root',
    };
    for (const transform of transforms || []) {
      transform(tree);
    }
    expect(tree.children).toEqual([
      {
        children: [
          {type: 'text', value: value.slice(0, -'a@b.co'.length)},
          {...createLink('mailto:a@b.co', 'a@b.co'), title: null},
        ],
        type: 'paragraph',
      },
    ]);
  });

  it('masks the URLs of a long text in linear time', () => {
    // A text with a place where the URL pattern starts every five
    // characters, read by the transforms alone, as the parse would take
    // most of the time of an import. Four times the text takes about four
    // times as long, not sixteen; the fastest of five runs keeps a pause
    // out.
    const {transforms} = gfmAutolinkLiteralFromSource();
    const time = (n: number) => {
      const value = 'www. '.repeat(n);
      let fastest = Infinity;
      for (let i = 0; i < 5; i++) {
        const tree: Root = {
          children: [{children: [{type: 'text', value}], type: 'paragraph'}],
          type: 'root',
        };
        const start = performance.now();
        for (const transform of transforms || []) {
          transform(tree);
        }
        fastest = Math.min(fastest, performance.now() - start);
        expect(tree.children).toEqual([
          {children: [{type: 'text', value}], type: 'paragraph'},
        ]);
      }
      return fastest;
    };
    time(20000);
    expect(time(80000) / time(20000)).toBeLessThan(8);
  });

  // How transforms other than the library's replace the children of the
  // paragraph of `createTree()`, an emphasis and a text that reads
  // `a qww.x.com` once masked. Where they do not split the text as the
  // library's do, the paragraph gets its children back, with no `q`.
  it.each<
    [string, (emphasis: PhrasingContent, text: PhrasingContent) => Children]
  >([
    ['leave the text as it is', (emphasis, text) => [emphasis, text]],
    [
      'replace the text with texts shorter than it',
      emphasis => [emphasis, {type: 'text', value: 'a qww.x.co'}],
    ],
    [
      'link a url that does not end with its text',
      emphasis => [
        emphasis,
        {type: 'text', value: 'a '},
        createLink('https://y.com', 'qww.x.com'),
      ],
    ],
    [
      'link two texts',
      emphasis => [
        emphasis,
        {type: 'text', value: 'a '},
        {
          children: [
            {type: 'text', value: 'qww.x.com'},
            {type: 'text', value: '!'},
          ],
          type: 'link',
          url: 'http://qww.x.com',
        },
      ],
    ],
    [
      'replace the text with other characters',
      emphasis => [
        emphasis,
        {type: 'text', value: 'a '},
        createLink('http://ooo', 'ooo'),
        {type: 'text', value: 'oooooo'},
      ],
    ],
    [
      'replace the text with pieces of it and then code',
      emphasis => [
        emphasis,
        {type: 'text', value: 'a '},
        createLink('http://qww.x', 'qww.x'),
        {type: 'inlineCode', value: '.com'},
      ],
    ],
    ['drop the emphasis', (_emphasis, text) => [text]],
    [
      'add a child after the text',
      (emphasis, text) => [emphasis, text, {type: 'text', value: '!'}],
    ],
  ])(
    'puts back the children of a paragraph where the transforms %s',
    (_, replace) => {
      const tree = createTree();
      const expected = createTree();
      const masked: string[] = [];
      const {transforms} = gfmAutolinkLiteralFromSource({
        transforms: [
          root => {
            const [paragraph] = root.children;
            if (paragraph.type === 'paragraph') {
              const [emphasis, text] = paragraph.children;
              if (text.type === 'text') {
                masked.push(text.value);
              }
              paragraph.children = replace(emphasis, text);
            }
          },
        ],
      });
      for (const transform of transforms || []) {
        transform(tree);
      }
      expect(masked).toEqual(['a qww.x.com']);
      expect(tree).toEqual(expected);
    },
  );
});
