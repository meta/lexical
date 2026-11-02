/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createAutoLinkNode,
  $createLinkNode,
  $isLinkNode,
  AutoLinkNode,
} from '@lexical/link';
import {$createListItemNode, $createListNode, $isListNode} from '@lexical/list';
import {
  $convertFromMarkdownString,
  $convertSelectionToMarkdownString,
  $convertToMarkdownString,
  CHECK_LIST,
  LINK,
  type TextMatchTransformer,
  TRANSFORMERS,
} from '@lexical/markdown';
import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isTextNode,
  DecoratorNode,
  defineExtension,
  ElementNode,
  type LexicalNode,
} from 'lexical';
import {assert, describe, expect, it} from 'vitest';

import {unescapeText} from '../../utils';
import {MarkdownTestExtension} from '../utils';

/** An inline element that exports only its children, like a comment mark. */
class TestInlineNode extends ElementNode {
  $config() {
    return this.config('markdown-test-inline', {extends: ElementNode});
  }
  isInline(): true {
    return true;
  }
  createDOM(): HTMLElement {
    throw new Error('not rendered');
  }
  updateDOM(): false {
    return false;
  }
}

/** An inline decorator exported as its text content. */
class TestDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('markdown-test-decorator', {extends: DecoratorNode});
  }
  isInline(): true {
    return true;
  }
  getTextContent(): string {
    return 'foo';
  }
  createDOM(): HTMLElement {
    throw new Error('not rendered');
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

class TestXDecoratorNode extends TestDecoratorNode {
  $config() {
    return this.config('markdown-test-x-decorator', {
      extends: TestDecoratorNode,
    });
  }
  getTextContent(): string {
    return 'x';
  }
}

const TestDecoratorExtension = defineExtension({
  name: '@lexical/markdown/test-decorator',
  nodes: [TestDecoratorNode, TestXDecoratorNode],
});

const AutoLinkNodeExtension = defineExtension({
  name: '@lexical/markdown/test-autolink',
  nodes: [AutoLinkNode],
});

const TestInlineExtension = defineExtension({
  name: '@lexical/markdown/test-inline',
  nodes: [TestInlineNode],
});

const LITERALS = [
  ['<b>text</b>', '&#60;b>text&#60;/b>'],
  ['<https://example.com>', '&#60;https://example.com>'],
  ['<0@a.b>', '&#60;0@a.b>'],
  ['<+@a.b>', '&#60;+@a.b>'],
  ['&#65;', '&#38;#65;'],
  ['&#x41;', '&#38;#x41;'],
  ['[label](uri)', '[label&#93;(uri)'],
  ['[ref]: uri', '[ref&#93;: uri'],
];

describe('literal Markdown text', () => {
  it.each(LITERALS)('escapes %j across styled text nodes', (text, expected) => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    for (let split = 0; split <= text.length; split++) {
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createTextNode(text.slice(0, split)).setStyle('color: red'),
                $createTextNode(text.slice(split)).setStyle('color: blue'),
              ),
            );
        },
        {discrete: true},
      );
      const written = editor.read(() => $convertToMarkdownString());
      expect(written).toBe(expected);
      editor.update(() => $convertFromMarkdownString(written), {
        discrete: true,
      });
      expect(editor.read(() => $getRoot().getTextContent())).toBe(text);
    }
  });

  it.each(['AT&T', 'a < b', '&nbsp;', '&copy;'])(
    'keeps legacy-readable text unchanged: %j',
    text => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode(text))),
        {discrete: true},
      );
      const written = editor.read(() => $convertToMarkdownString());
      expect(written).toBe(text);
      editor.update(() => $convertFromMarkdownString(written), {
        discrete: true,
      });
      expect(editor.read(() => $getRoot().getTextContent())).toBe(text);
    },
  );

  it.each(['bold', 'italic', 'strikethrough'] as const)(
    'preserves existing formatted markers after plain text: %s',
    format => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      editor.update(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('a'),
              $createTextNode('*').toggleFormat(format),
            ),
          ),
        {discrete: true},
      );
      const written = editor.read(() => $convertToMarkdownString());
      editor.update(() => $convertFromMarkdownString(written), {
        discrete: true,
      });
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('a*');
        const [plain, formatted] = $getRoot().getAllTextNodes();
        expect(plain.getFormat()).toBe(0);
        expect(formatted.hasFormat(format)).toBe(true);
      });
    },
  );

  it.each(['*', '**', '~~'])(
    'keeps literal delimiters beside escaped punctuation: %j',
    delimiter => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      for (const inside of ['[', '&', '<']) {
        for (const outside of ['[', '&', '<']) {
          const source = `a${delimiter}\\${inside}${delimiter}\\${outside}`;
          editor.update(() => $convertFromMarkdownString(source), {
            discrete: true,
          });
          editor.read(() => {
            expect($getRoot().getTextContent()).toBe(
              `a${delimiter}${inside}${delimiter}${outside}`,
            );
            for (const text of $getRoot().getAllTextNodes()) {
              expect(text.getFormat()).toBe(0);
            }
          });
        }
      }
    },
  );

  it.each([
    [['&', '#65;'], '&#38;#65;'],
    [['&', 'copy;'], '&#38;copy;'],
    [['<', 'b>text</b>'], '&#60;b>text&#60;/b>'],
    [['AT&', 'T'], 'AT&#38;T'],
    [['a <', ' b'], 'a &#60; b'],
  ] as const)('guards ambiguous node boundaries: %j', (pieces, expected) => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              ...pieces.map((text, index) =>
                $createTextNode(text).setStyle(
                  index ? 'color: blue' : 'color: red',
                ),
              ),
            ),
          ),
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe(expected);
  });

  it.each([
    ['\\<b>text\\</b>', '<b>text</b>'],
    ['&#60;b&#62;text&#60;/b&#62;', '<b>text</b>'],
    ['\\&#65;', '&#65;'],
    ['\\&#x41;', '&#x41;'],
    ['&#38;#65;', '&#65;'],
    ['&#x26;#x41;', '&#x41;'],
    ['\\[label\\](uri)', '[label](uri)'],
    ['\\[label](uri)', '[label](uri)'],
  ])(
    'keeps imported literal text through repeated conversion: %j',
    (source, text) => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      let written = source;
      for (let round = 0; round < 3; round++) {
        editor.update(() => $convertFromMarkdownString(written), {
          discrete: true,
        });
        expect(editor.read(() => $getRoot().getTextContent())).toBe(text);
        written = editor.read(() => $convertToMarkdownString());
      }
    },
  );

  it('escapes only the selected literal content', () => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    editor.update(
      () => {
        const text = $createTextNode('before <b>&copy; [x](u)</b> after');
        $getRoot().clear().append($createParagraphNode().append(text));
        text.select(7, text.getTextContentSize() - 6);
      },
      {discrete: true},
    );
    expect(
      editor.read(() =>
        $convertSelectionToMarkdownString(TRANSFORMERS, $getSelection()),
      ),
    ).toBe('&#60;b>&copy; [x&#93;(u)&#60;/b>');
  });

  it.each(['[label]', 'a]b', 'a[b', 'a](other)'])(
    'preserves real link label %j',
    label => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createLinkNode('uri').append($createTextNode(label)),
              ),
            ),
        {discrete: true},
      );
      const written = editor.read(() => $convertToMarkdownString());
      editor.update(() => $convertFromMarkdownString(written), {
        discrete: true,
      });
      editor.read(() => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        assert($isElementNode(paragraph));
        const link = paragraph.getFirstChildOrThrow();
        assert($isLinkNode(link));
        expect(link.getURL()).toBe('uri');
        expect(link.getTextContent()).toBe(label);
      });
    },
  );

  it.each(['[\\]', '\\[x]', '[\\]`'])(
    'preserves existing backslashes in code-formatted link label %j',
    label => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createLinkNode('uri').append(
                  $createTextNode(label).toggleFormat('code'),
                ),
              ),
            ),
        {discrete: true},
      );
      const written = editor.read(() => $convertToMarkdownString());
      editor.update(() => $convertFromMarkdownString(written), {
        discrete: true,
      });
      editor.read(() => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        assert($isElementNode(paragraph));
        const link = paragraph.getFirstChildOrThrow();
        assert($isLinkNode(link));
        const text = link.getFirstChildOrThrow();
        assert($isTextNode(text));
        expect(text.getTextContent()).toBe(label);
        expect(text.hasFormat('code')).toBe(true);
      });
    },
  );

  it.each([
    ['[', ']'],
    [']', '['],
  ])('preserves mixed code/plain brackets in a link: %j', (code, plain) => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createLinkNode('uri').append(
                $createTextNode(code).toggleFormat('code'),
                $createTextNode(plain),
              ),
            ),
          ),
      {discrete: true},
    );
    const written = editor.read(() => $convertToMarkdownString());
    editor.update(() => $convertFromMarkdownString(written), {discrete: true});
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isElementNode(paragraph));
      expect(paragraph.getChildrenSize()).toBe(1);
      const link = paragraph.getFirstChildOrThrow();
      assert($isLinkNode(link));
      expect(link.getURL()).toBe('uri');
      expect(
        link.getChildren().map(node => {
          assert($isTextNode(node));
          return [node.getTextContent(), node.hasFormat('code')];
        }),
      ).toEqual([
        [code, true],
        [plain, false],
      ]);
    });
  });

  it('continues searching after an escaped link opener', () => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    editor.update(
      () => $convertFromMarkdownString('\\[literal](a) [real](b)'),
      {discrete: true},
    );
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isElementNode(paragraph));
      const links = paragraph.getChildren().filter($isLinkNode);
      expect(links.map(link => link.getURL())).toEqual(['b']);
      expect(paragraph.getTextContent()).toBe('[literal](a) real');
    });
  });

  it('does not let an escaped closer absorb a later real link', () => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    editor.update(() => $convertFromMarkdownString('[a]\\](u) [b](v)'), {
      discrete: true,
    });
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isElementNode(paragraph));
      expect(paragraph.getTextContent()).toBe('[a]](u) b');
      const links = paragraph.getChildren().filter($isLinkNode);
      expect(links.map(link => [link.getTextContent(), link.getURL()])).toEqual(
        [['b', 'v']],
      );
    });
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const)(
    'preserves copied LINK imports (cloned pattern: %s, wrapped replace: %s)',
    (clonedPattern, wrappedReplace) => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      const exportLink = LINK.export;
      assert(exportLink);
      const pattern = LINK.importRegExp;
      assert(pattern);
      const replaceLink = LINK.replace;
      assert(replaceLink);
      const customLink: TextMatchTransformer = {
        ...LINK,
        export: (...args) => exportLink(...args),
        importRegExp: clonedPattern
          ? new RegExp(pattern.source, pattern.flags)
          : pattern,
        replace: wrappedReplace
          ? (...args) => replaceLink(...args)
          : replaceLink,
      };
      const transformers = TRANSFORMERS.map(transformer =>
        transformer === LINK ? customLink : transformer,
      );
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createTextNode('[a]](u) '),
                $createLinkNode('v', {title: 'title'}).append(
                  $createTextNode('b'),
                ),
              ),
            ),
        {discrete: true},
      );
      const written = editor.read(() => $convertToMarkdownString(transformers));
      editor.update(() => $convertFromMarkdownString(written, transformers), {
        discrete: true,
      });
      editor.read(() => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        assert($isElementNode(paragraph));
        const [text, link] = paragraph.getChildren();
        assert($isTextNode(text));
        expect(text.getTextContent()).toBe('[a]](u) ');
        assert($isLinkNode(link));
        expect([link.getTextContent(), link.getURL(), link.getTitle()]).toEqual(
          ['b', 'v', 'title'],
        );
      });
    },
  );

  it.each(['<', '&', '[', ']'])(
    'retains bold before an exported literal escape: %j',
    literal => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createTextNode('!').toggleFormat('bold'),
                $createTextNode(literal),
              ),
            ),
        {discrete: true},
      );
      const written = editor.read(() => $convertToMarkdownString());
      editor.update(() => $convertFromMarkdownString(written), {
        discrete: true,
      });
      editor.read(() => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        assert($isElementNode(paragraph));
        expect(
          paragraph.getChildren().map(node => {
            assert($isTextNode(node));
            return [node.getTextContent(), node.hasFormat('bold')];
          }),
        ).toEqual([
          ['!', true],
          [literal, false],
        ]);
      });
    },
  );

  it.each(['bold', 'italic', 'strikethrough', 'bold+italic'] as const)(
    'preserves formatted backslashes next to plain text: %s',
    format => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      for (const before of [false, true]) {
        const text = before ? '\\path' : 'path\\';
        let expectedFormat = 0;
        editor.update(
          () => {
            const formatted = $createTextNode(text);
            if (format === 'bold+italic') {
              formatted.toggleFormat('bold').toggleFormat('italic');
            } else formatted.toggleFormat(format);
            expectedFormat = formatted.getFormat();
            const plain = $createTextNode('file');
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append(
                  ...(before ? [plain, formatted] : [formatted, plain]),
                ),
              );
          },
          {discrete: true},
        );
        const written = editor.read(() => $convertToMarkdownString());
        editor.update(() => $convertFromMarkdownString(written), {
          discrete: true,
        });
        editor.read(() => {
          const paragraph = $getRoot().getFirstChildOrThrow();
          assert($isElementNode(paragraph));
          const expected = [
            [text, expectedFormat],
            ['file', 0],
          ];
          expect(
            paragraph.getChildren().map(node => {
              assert($isTextNode(node));
              return [node.getTextContent(), node.getFormat()];
            }),
          ).toEqual(before ? expected.reverse() : expected);
        });
      }
    },
  );

  it.each([
    ['[a\\]\\](u) ', '[a]](u) '],
    ['[&#65;\\]\\](u) ', '[A]](u) '],
    ['[\\&#65;\\]\\](u) ', '[&#65;]](u) '],
  ])('decodes escaped text before a later link: %j', (prefix, expected) => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    editor.update(() => $convertFromMarkdownString(prefix + '[ok](v)'), {
      discrete: true,
    });
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isElementNode(paragraph));
      const [text, link] = paragraph.getChildren();
      assert($isTextNode(text));
      expect(text.getTextContent()).toBe(expected);
      assert($isLinkNode(link));
      expect(link.getURL()).toBe('v');
      expect(link.getTextContent()).toBe('ok');
    });
  });

  it.each([
    ['[a\\][]\\](u) ', '[a][]](u) '],
    ['[&#65;\\][]\\](u) ', '[A][]](u) '],
  ])(
    'preserves balanced bracket prefixes before a later link: %j',
    (prefix, expected) => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      editor.update(() => $convertFromMarkdownString(prefix + '[ok](v)'), {
        discrete: true,
      });
      editor.read(() => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        assert($isElementNode(paragraph));
        const [text, link] = paragraph.getChildren();
        assert($isTextNode(text));
        expect(text.getTextContent()).toBe(expected);
        assert($isLinkNode(link));
        expect(link.getURL()).toBe('v');
        expect(link.getTextContent()).toBe('ok');
      });
    },
  );

  it.each([
    ['[[b](v)', '['],
    ['[a[b](v)', '[a'],
  ])(
    'preserves nested openers after an escaped prefix: %j',
    (suffix, prefix) => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      editor.update(() => $convertFromMarkdownString('[a\\]\\](u) ' + suffix), {
        discrete: true,
      });
      editor.read(() => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        assert($isElementNode(paragraph));
        const [text, link] = paragraph.getChildren();
        assert($isTextNode(text));
        expect(text.getTextContent()).toBe('[a]](u) ' + prefix);
        assert($isLinkNode(link));
        expect(link.getURL()).toBe('v');
        expect(link.getTextContent()).toBe('b');
      });
    },
  );

  it.each([
    ['~~[]~~~](u)', '~~[]~~~](u)', ''],
    ['~~[]~~~](u)', '~~[]~~~](u)', ' [ok](v)'],
    ['~~[\\a]~~~](u)', '~~[\\a]~~~](u)', ''],
    ['~~[\\a]~~~](u)', '~~[\\a]~~~](u)', ' [ok](v)'],
    ['~~[\\]]~~~](u)', '~~[]]~~~](u)', ''],
    ['~~[\\]]~~~](u)', '~~[]]~~~](u)', ' [ok](v)'],
  ])(
    'keeps legacy grouping for malformed link candidates: %j',
    (source, expected, suffix) => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      editor.update(() => $convertFromMarkdownString(source + suffix), {
        discrete: true,
      });
      editor.read(() => {
        const root = $getRoot();
        expect(root.getTextContent()).toBe(expected + (suffix ? ' ok' : ''));
        for (const text of root.getAllTextNodes()) {
          expect(text.getFormat()).toBe(0);
        }
        if (suffix) {
          const paragraph = root.getFirstChildOrThrow();
          assert($isElementNode(paragraph));
          const link = paragraph.getLastChildOrThrow();
          assert($isLinkNode(link));
          expect(link.getURL()).toBe('v');
          expect(link.getTextContent()).toBe('ok');
        }
      });
    },
  );

  it.each(['code', 'custom'] as const)(
    'runs import transformers after escaped link text: %s',
    kind => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      let calls = 0;
      const custom: TextMatchTransformer = {
        dependencies: [],
        importRegExp: /@\w+/,
        regExp: /@\w+$/,
        replace: node => {
          calls++;
          node.setTextContent('MENTION');
          return node;
        },
        type: 'text-match',
      };
      const middle = kind === 'code' ? '`code`' : '@name';
      editor.update(
        () =>
          $convertFromMarkdownString(
            '[a\\]\\](u) ' + middle + ' [link](v)',
            kind === 'custom' ? [custom, ...TRANSFORMERS] : TRANSFORMERS,
          ),
        {discrete: true},
      );
      editor.read(() => {
        const root = $getRoot();
        expect(root.getTextContent()).toBe(
          '[a]](u) ' + (kind === 'code' ? 'code' : 'MENTION') + ' link',
        );
        if (kind === 'code') {
          expect(
            root
              .getAllTextNodes()
              .find(node => node.hasFormat('code'))
              ?.getTextContent(),
          ).toBe('code');
        }
        const paragraph = root.getFirstChildOrThrow();
        assert($isElementNode(paragraph));
        const link = paragraph.getLastChildOrThrow();
        assert($isLinkNode(link));
        expect(link.getURL()).toBe('v');
        expect(link.getTextContent()).toBe('link');
      });
      expect(calls).toBe(kind === 'custom' ? 1 : 0);
    },
  );

  it('parses the text before an unbalanced link', () => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    // Code spans bind tighter than link brackets
    // (https://spec.commonmark.org/0.31.2/#code-spans), so this is `[`, a code
    // span and a link.
    editor.update(() => $convertFromMarkdownString('[`\\`[x](u)'), {
      discrete: true,
    });
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isElementNode(paragraph));
      const [text, code, link] = paragraph.getChildren();
      assert($isTextNode(text));
      expect(text.getTextContent()).toBe('[');
      assert($isTextNode(code));
      expect(code.hasFormat('code')).toBe(true);
      expect(code.getTextContent()).toBe('\\');
      assert($isLinkNode(link));
      expect(link.getURL()).toBe('u');
      expect(link.getTextContent()).toBe('x');
    });
    expect(editor.read(() => $convertToMarkdownString())).toBe('[`\\`[x](u)');
  });

  it('keeps the existing raw-source newline mode', () => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    const source = '\\&#65; \\<b> \\[x](u)';
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode(source))),
      {discrete: true},
    );
    expect(
      editor.read(() =>
        $convertToMarkdownString(TRANSFORMERS, undefined, true),
      ),
    ).toBe(source);
  });

  it('does not escape code or authored custom transformer output', () => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    const raw = '<b>&copy; [x](u)</b>';
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode(raw).toggleFormat('code'),
              $createTextNode('owned'),
            ),
          ),
      {discrete: true},
    );
    const custom: TextMatchTransformer = {
      dependencies: [],
      export: node => (node.getTextContent() === 'owned' ? raw : null),
      regExp: /$^/,
      type: 'text-match',
    };
    expect(
      editor.read(() => $convertToMarkdownString([custom, ...TRANSFORMERS])),
    ).toBe('`' + raw + '`' + raw);
  });

  it('keeps custom matchers responsible for their escape rules', () => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    let calls = 0;
    const custom: TextMatchTransformer = {
      dependencies: [],
      importRegExp: /@\w+/,
      regExp: /@\w+$/,
      replace: node => {
        calls++;
        node.setTextContent('seen');
      },
      type: 'text-match',
    };
    editor.update(() => $convertFromMarkdownString('\\@name', [custom]), {
      discrete: true,
    });
    expect(calls).toBe(1);
    expect(editor.read(() => $getRoot().getTextContent())).toBe('\\seen');
  });
});

describe('brackets that cannot become Markdown syntax', () => {
  function $exportParagraph(...texts: string[]) {
    $getRoot()
      .clear()
      .append(
        $createParagraphNode().append(
          ...texts.map((text, index) =>
            $createTextNode(text).setStyle(`color: #${index}${index}${index}`),
          ),
        ),
      );
  }

  it.each([
    'cleared review [1][2]',
    'Narrative claim [1].',
    'done [x] and [ ] todo',
    'array[0] and map[key]',
    'see [1]: the note',
    'a [label] (not a link)',
    '[label]\n(next line)',
    'nested [[1]] and [a [b] c]',
    '[',
    ']',
    '][',
  ])('leaves %j as typed', text => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    for (let split = 0; split <= text.length; split++) {
      editor.update(
        () => $exportParagraph(text.slice(0, split), text.slice(split)),
        {discrete: true},
      );
      const written = editor.read(() => $convertToMarkdownString());
      expect(written).toBe(text);
      editor.update(() => $convertFromMarkdownString(written), {
        discrete: true,
      });
      expect(editor.read(() => $getRoot().getTextContent())).toBe(text);
    }
  });

  it.each([
    ['[a](b)', '[a&#93;(b)'],
    ['![a](b)', '![a&#93;(b)'],
    ['[a]: b', '[a&#93;: b'],
    ['   [a]: b', '   [a&#93;: b'],
    ['[a](b) and [c](d)', '[a&#93;(b) and [c&#93;(d)'],
    ['x](y)', 'x&#93;(y)'],
    ['[[1]](url)', '[[1]&#93;(url)'],
  ])('escapes the closing bracket of %j', (text, expected) => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    for (let split = 0; split <= text.length; split++) {
      editor.update(
        () => $exportParagraph(text.slice(0, split), text.slice(split)),
        {discrete: true},
      );
      const written = editor.read(() => $convertToMarkdownString());
      expect(written).toBe(expected);
      editor.update(() => $convertFromMarkdownString(written), {
        discrete: true,
      });
      expect(editor.read(() => $getRoot().getTextContent())).toBe(text);
      editor.read(() => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        assert($isElementNode(paragraph));
        expect(paragraph.getChildren().some($isLinkNode)).toBe(false);
      });
    }
  });

  it('escapes a definition label after a line break', () => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    editor.update(() => $exportParagraph('intro\n[a]: b'), {discrete: true});
    expect(editor.read(() => $convertToMarkdownString())).toBe(
      'intro\n[a&#93;: b',
    );
  });

  it.each([
    ['[1]', '[[1]](uri)'],
    ['claim [2]', '[claim [2]](uri)'],
    ['[a [b] c]', '[[a [b] c]](uri)'],
    ['a]b', '[a&#93;b](uri)'],
    ['a[b', '[a&#91;b](uri)'],
    ['[x](y)', '[&#91;x&#93;(y)](uri)'],
    ['a](other)', '[a&#93;(other)](uri)'],
  ])('writes link text %j as %j', (label, expected) => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createLinkNode('uri').append($createTextNode(label)),
            ),
          ),
      {discrete: true},
    );
    const written = editor.read(() => $convertToMarkdownString());
    expect(written).toBe(expected);
    editor.update(() => $convertFromMarkdownString(written), {
      discrete: true,
    });
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isElementNode(paragraph));
      expect(paragraph.getChildrenSize()).toBe(1);
      const link = paragraph.getFirstChildOrThrow();
      assert($isLinkNode(link));
      expect(link.getURL()).toBe('uri');
      expect(link.getTextContent()).toBe(label);
    });
  });

  it.each([
    ['[x] done', '[x&#93; done'],
    ['[X] done', '[X&#93; done'],
    ['[ ] todo', '[ &#93; todo'],
    ['[] todo', '[&#93; todo'],
    ['  [x] indented', '  [x&#93; indented'],
  ])('escapes the task marker %j at the start of a line', (text, expected) => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    for (let split = 0; split <= text.length; split++) {
      editor.update(
        () => $exportParagraph(text.slice(0, split), text.slice(split)),
        {discrete: true},
      );
      const written = editor.read(() => $convertToMarkdownString());
      expect(written).toBe(expected);
      editor.update(
        () =>
          $convertFromMarkdownString(written, [CHECK_LIST, ...TRANSFORMERS]),
        {discrete: true},
      );
      editor.read(() => {
        const block = $getRoot().getFirstChildOrThrow();
        expect($isListNode(block)).toBe(false);
        expect(block.getTextContent()).toBe(text);
      });
    }
  });

  it('escapes a task marker that starts a bullet item', () => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createListNode('bullet').append(
              $createListItemNode().append($createTextNode('[ ] todo')),
            ),
          ),
      {discrete: true},
    );
    const written = editor.read(() =>
      $convertToMarkdownString([CHECK_LIST, ...TRANSFORMERS]),
    );
    expect(written).toBe('- [ &#93; todo');
    editor.update(
      () => $convertFromMarkdownString(written, [CHECK_LIST, ...TRANSFORMERS]),
      {discrete: true},
    );
    editor.read(() => {
      const list = $getRoot().getFirstChildOrThrow();
      assert($isListNode(list));
      expect(list.getListType()).toBe('bullet');
      expect(list.getTextContent()).toBe('[ ] todo');
    });
  });

  it('keeps a real check list item as a check list', () => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    editor.update(
      () =>
        $convertFromMarkdownString('- [ ] todo\n- [x] done', [
          CHECK_LIST,
          ...TRANSFORMERS,
        ]),
      {discrete: true},
    );
    expect(
      editor.read(() =>
        $convertToMarkdownString([CHECK_LIST, ...TRANSFORMERS]),
      ),
    ).toBe('- [ ] todo\n- [x] done');
  });

  it.each([
    // [a\ + ]: /url in two nodes: the backslash is exported doubled.
    [['[a\\', ']: /url'], '[a\\\\&#93;: /url'],
    // The first ] is escaped, so the second still closes a label.
    [['[a](x]: /url'], '[a&#93;(x&#93;: /url'],
    [['[foo', '\n', 'bar]: /url'], '[foo\nbar&#93;: /url'],
    [['intro', '\n', '[a]: b'], 'intro\n[a&#93;: b'],
  ])('escapes the definition label in %j', (parts, expected) => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              ...parts.map((part, index) =>
                part === '\n'
                  ? $createLineBreakNode()
                  : $createTextNode(part).setStyle(
                      `color: #${index}${index}${index}`,
                    ),
              ),
            ),
          ),
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe(expected);
  });

  it('treats the start of an exported selection as a line start', () => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    editor.update(
      () => {
        const intro = $createTextNode('intro ');
        const definition = $createTextNode('[a]: /url').setStyle('color: red');
        $getRoot()
          .clear()
          .append($createParagraphNode().append(intro, definition));
        definition.select(0, definition.getTextContentSize());
      },
      {discrete: true},
    );
    expect(
      editor.read(() =>
        $convertSelectionToMarkdownString(TRANSFORMERS, $getSelection()),
      ),
    ).toBe('[a&#93;: /url');
  });

  describe('across inline elements', () => {
    it('escapes a bracket inside an inline element followed by (', () => {
      using editor = buildEditorFromExtensions(
        MarkdownTestExtension,
        TestInlineExtension,
      );
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $create(TestInlineNode).append($createTextNode('[a]')),
                $createTextNode('(b)'),
              ),
            ),
        {discrete: true},
      );
      const written = editor.read(() => $convertToMarkdownString());
      expect(written).toBe('[a&#93;(b)');
      editor.update(() => $convertFromMarkdownString(written), {
        discrete: true,
      });
      expect(editor.read(() => $getRoot().getTextContent())).toBe('[a](b)');
    });

    it('escapes a pair inside link text that an inline element splits from (', () => {
      using editor = buildEditorFromExtensions(
        MarkdownTestExtension,
        TestInlineExtension,
      );
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createLinkNode('url').append(
                  $create(TestInlineNode).append($createTextNode('[x]')),
                  $createTextNode('(y)'),
                ),
              ),
            ),
        {discrete: true},
      );
      const written = editor.read(() => $convertToMarkdownString());
      expect(written).toBe('[&#91;x&#93;(y)](url)');
      editor.update(() => $convertFromMarkdownString(written), {
        discrete: true,
      });
      editor.read(() => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        assert($isElementNode(paragraph));
        const link = paragraph.getFirstChildOrThrow();
        assert($isLinkNode(link));
        expect(link.getURL()).toBe('url');
        expect(link.getTextContent()).toBe('[x](y)');
      });
    });

    it.each([
      [['[a]', ': b'], 'inline first'],
      [['[a', ']: /url'], 'inline second'],
    ])(
      'escapes a definition label split by an inline element: %j (%s)',
      (parts, which) => {
        using editor = buildEditorFromExtensions(
          MarkdownTestExtension,
          TestInlineExtension,
        );
        editor.update(
          () => {
            const [first, second] = parts;
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append(
                  which === 'inline first'
                    ? $create(TestInlineNode).append($createTextNode(first))
                    : $createTextNode(first),
                  which === 'inline first'
                    ? $createTextNode(second)
                    : $create(TestInlineNode).append($createTextNode(second)),
                ),
              );
          },
          {discrete: true},
        );
        const written = editor.read(() => $convertToMarkdownString());
        expect(written).toContain('&#93;:');
      },
    );
  });

  describe('round trips text with brackets before a link', () => {
    function $describe(node: LexicalNode): string {
      if ($isLinkNode(node)) {
        return `{${node.getURL()}:${node.getChildren().map($describe).join('')}}`;
      } else if ($isTextNode(node)) {
        return `<${node.getFormat()}:${node.getTextContent()}>`;
      }
      return $isElementNode(node)
        ? node.getChildren().map($describe).join('')
        : node.getTextContent();
    }

    it.each([
      [
        'Claim [1] is *important*, see [source](https://example.com)',
        '<0:Claim [1] is ><2:important><0:, see >{https://example.com:<0:source>}',
      ],
      ['[1] **bold** [link](u)', '<0:[1] ><1:bold><0: >{u:<0:link>}'],
      ['[1] `c` [link](u)', '<0:[1] ><16:c><0: >{u:<0:link>}'],
      ['**[1]** [l](u)', '<1:[1]><0: >{u:<0:l>}'],
      ['[a](b) **x** [l](u)', '{b:<0:a>}<0: ><1:x><0: >{u:<0:l>}'],
      ['[a&#93;(b) **x** [l](u)', '<0:[a](b) ><1:x><0: >{u:<0:l>}'],
      [
        'see [1] and ~~[2]~~ [link](u)',
        '<0:see [1] and ><4:[2]><0: >{u:<0:link>}',
      ],
      ['[h[ello](u)', '<0:[h>{u:<0:ello>}'],
      ['[foo [bar](/uri)&#93;(/uri)', '<0:[foo >{/uri:<0:bar>}<0:](/uri)>'],
    ])('imports %j and exports it again unchanged', (markdown, nodes) => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      editor.update(() => $convertFromMarkdownString(markdown), {
        discrete: true,
      });
      expect(editor.read(() => $describe($getRoot()))).toBe(nodes);
      const written = editor.read(() => $convertToMarkdownString());
      expect(written).toBe(markdown);
      editor.update(() => $convertFromMarkdownString(written), {
        discrete: true,
      });
      expect(editor.read(() => $describe($getRoot()))).toBe(nodes);
    });
  });

  describe('around a decorator', () => {
    it.each([
      [TestDecoratorNode, ']: done', '&#91;foo&#93;: done'],
      [TestXDecoratorNode, '] todo', '&#91;x&#93; todo'],
      [TestDecoratorNode, '](b)', '&#91;foo&#93;(b)'],
    ])('escapes the brackets around %o', (Klass, after, expected) => {
      using editor = buildEditorFromExtensions(
        MarkdownTestExtension,
        TestDecoratorExtension,
      );
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createTextNode('['),
                $create(Klass),
                $createTextNode(after),
              ),
            ),
        {discrete: true},
      );
      expect(
        editor.read(() =>
          $convertToMarkdownString([CHECK_LIST, ...TRANSFORMERS]),
        ),
      ).toBe(expected);
    });

    it('leaves a bracket away from a decorator as typed', () => {
      using editor = buildEditorFromExtensions(
        MarkdownTestExtension,
        TestDecoratorExtension,
      );
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $create(TestDecoratorNode),
                $createTextNode(' cleared review [1][2]'),
              ),
            ),
        {discrete: true},
      );
      expect(editor.read(() => $convertToMarkdownString())).toBe(
        'foo cleared review [1][2]',
      );
    });
  });

  it.each([
    [['[a', ']:b'], '&#91;a`]:b`'],
    [['[a b', 'c]: d'], '&#91;a b`c]: d`'],
    [['[a', 'b]'], '[a`b]`'],
    [['[a', '[b]: c'], '[a`[b]: c`'],
  ])(
    'escapes the [ of a label that inline code %j would close',
    (parts, expected) => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createTextNode(parts[0]),
                $createTextNode(parts[1]).toggleFormat('code'),
              ),
            ),
        {discrete: true},
      );
      expect(editor.read(() => $convertToMarkdownString())).toBe(expected);
    },
  );

  it.each([
    [['[a](b) ', ']:x'], '&#91;a&#93;(b) `]:x`'],
    [['[] ', ']:url'], '&#91;&#93; `]:url`'],
    [['[x] see ', ']:url'], '&#91;x&#93; see `]:url`'],
    [['[a]: b ', ']:c'], '&#91;a&#93;: b `]:c`'],
  ])(
    'escapes a line-start [ whose label an escaped ] leaves open to inline code: %j',
    (parts, expected) => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createTextNode(parts[0]),
                $createTextNode(parts[1]).toggleFormat('code'),
              ),
            ),
        {discrete: true},
      );
      expect(editor.read(() => $convertToMarkdownString())).toBe(expected);
    },
  );

  it('does not read a link whose syntax is inside inline code', () => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('see ['),
              $createTextNode('](').toggleFormat('code'),
              $createTextNode('x) now'),
            ),
          ),
      {discrete: true},
    );
    const written = editor.read(() => $convertToMarkdownString());
    expect(written).toBe('see [`](`x) now');
    editor.update(() => $convertFromMarkdownString(written), {
      discrete: true,
    });
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isElementNode(paragraph));
      expect(paragraph.getChildren().some($isLinkNode)).toBe(false);
      expect(paragraph.getTextContent()).toBe('see [](x) now');
    });
  });

  it('escapes a task marker after a decorator that may end a line', () => {
    using editor = buildEditorFromExtensions(
      MarkdownTestExtension,
      TestDecoratorExtension,
    );
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('a '),
              $create(TestDecoratorNode),
              $createTextNode('[x] done'),
            ),
          ),
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe(
      'a foo[x&#93; done',
    );
  });

  describe('custom transformers', () => {
    const TEST_LINK: TextMatchTransformer = {
      dependencies: [TestInlineNode],
      export: (node, exportChildren) =>
        node instanceof TestInlineNode
          ? `[${exportChildren(node)}](custom)`
          : null,
      importRegExp: /$^/,
      regExp: /$^/,
      type: 'text-match',
    };
    const HTML_LINK: TextMatchTransformer = {
      dependencies: [],
      export: (node, exportChildren) =>
        $isLinkNode(node)
          ? `<a href="${node.getURL()}">${exportChildren(node)}</a>`
          : null,
      importRegExp: /$^/,
      regExp: /$^/,
      type: 'text-match',
    };

    it('applies the link text rules inside an element a transformer writes as [text](url)', () => {
      using editor = buildEditorFromExtensions(
        MarkdownTestExtension,
        TestInlineExtension,
      );
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $create(TestInlineNode).append($createTextNode('a]')),
              ),
            ),
        {discrete: true},
      );
      expect(
        editor.read(() =>
          $convertToMarkdownString([TEST_LINK, ...TRANSFORMERS]),
        ),
      ).toBe('[a&#93;](custom)');
    });

    it.each([
      ['(note)', 'see [', 'a]', 'see [a&#93;(note)'],
      [': note', '', '[a]', '&#91;a&#93;: note'],
    ])(
      'escapes at the edge of an element a transformer writes with %j after it',
      (suffix, before, inner, expected) => {
        const NOTE: TextMatchTransformer = {
          dependencies: [TestInlineNode],
          export: (node, exportChildren) =>
            node instanceof TestInlineNode
              ? `${exportChildren(node)}${suffix}`
              : null,
          importRegExp: /$^/,
          regExp: /$^/,
          type: 'text-match',
        };
        using editor = buildEditorFromExtensions(
          MarkdownTestExtension,
          TestInlineExtension,
        );
        editor.update(
          () =>
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append(
                  ...(before === '' ? [] : [$createTextNode(before)]),
                  $create(TestInlineNode).append($createTextNode(inner)),
                ),
              ),
          {discrete: true},
        );
        expect(
          editor.read(() => $convertToMarkdownString([NOTE, ...TRANSFORMERS])),
        ).toBe(expected);
      },
    );

    it('reads a link a transformer writes in another syntax as unknown', () => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createTextNode('['),
                $createLinkNode('u').append($createTextNode('a')),
                $createTextNode(']: /x'),
              ),
            ),
        {discrete: true},
      );
      expect(
        editor.read(() =>
          $convertToMarkdownString([HTML_LINK, ...TRANSFORMERS]),
        ),
      ).toBe('&#91;<a href="u">a</a>&#93;: /x');
    });
  });

  it('reads typed control characters as text', () => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    editor.update(() => $exportParagraph('[a\u0001]: /url'), {
      discrete: true,
    });
    expect(editor.read(() => $convertToMarkdownString())).toBe(
      '[a\u0001&#93;: /url',
    );
  });

  describe('links not written in brackets', () => {
    it('escapes a definition label around autolinks', () => {
      using editor = buildEditorFromExtensions(
        MarkdownTestExtension,
        AutoLinkNodeExtension,
      );
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createTextNode('[see '),
                $createAutoLinkNode('https://example.com').append(
                  $createTextNode('https://example.com'),
                ),
                $createTextNode(' today]: '),
                $createAutoLinkNode('https://example.com').append(
                  $createTextNode('https://example.com'),
                ),
              ),
            ),
        {discrete: true},
      );
      expect(editor.read(() => $convertToMarkdownString())).toBe(
        '[see https://example.com today&#93;: https://example.com',
      );
    });

    it('escapes a bracket at the end of an autolink followed by (', () => {
      using editor = buildEditorFromExtensions(
        MarkdownTestExtension,
        AutoLinkNodeExtension,
      );
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createAutoLinkNode('https://example.com').append(
                  $createTextNode('https://example.com/[a]'),
                ),
                $createTextNode('(b)'),
              ),
            ),
        {discrete: true},
      );
      const written = editor.read(() => $convertToMarkdownString());
      expect(written).toBe('https://example.com/[a&#93;(b)');
      editor.update(() => $convertFromMarkdownString(written), {
        discrete: true,
      });
      editor.read(() => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        assert($isElementNode(paragraph));
        expect(paragraph.getChildren().some($isLinkNode)).toBe(false);
      });
    });

    const WITHOUT_LINK = TRANSFORMERS.filter(
      transformer => transformer !== LINK,
    );

    it('treats link text as literal text when LINK is not exported', () => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createLinkNode('url').append($createTextNode('[a]')),
                $createTextNode('(b)'),
              ),
            ),
        {discrete: true},
      );
      expect(editor.read(() => $convertToMarkdownString(WITHOUT_LINK))).toBe(
        '[a&#93;(b)',
      );
    });

    it('escapes a definition label across a link when LINK is not exported', () => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createTextNode('['),
                $createLinkNode('url').append($createTextNode('a')),
                $createTextNode(']: /url'),
              ),
            ),
        {discrete: true},
      );
      expect(editor.read(() => $convertToMarkdownString(WITHOUT_LINK))).toBe(
        '[a&#93;: /url',
      );
    });
  });

  it.each([
    ['- [x] done', '- [x&#93; done'],
    ['+ [ ] todo', '+ [ &#93; todo'],
    ['* [] todo', '\\* [] todo'],
    ['1. [x] done', '1. [x&#93; done'],
    ['> [a]: b', '> [a&#93;: b'],
    ['- [a]: b', '- [a&#93;: b'],
    ['2) [a]: b', '2) [a&#93;: b'],
  ])('escapes %j where a container marker precedes it', (text, expected) => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    editor.update(() => $exportParagraph(text), {discrete: true});
    expect(
      editor.read(() =>
        $convertToMarkdownString([CHECK_LIST, ...TRANSFORMERS]),
      ),
    ).toBe(expected);
  });

  it.each(['a- [x] done', '-[x] done', '1.[a]: b', 'x > [a]: b'])(
    'leaves %j as typed',
    text => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      editor.update(() => $exportParagraph(text), {discrete: true});
      expect(editor.read(() => $convertToMarkdownString())).toBe(text);
    },
  );

  it('imports a code span full of [ before a link in linear time', () => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    const markdown = '`' + '['.repeat(80000) + '`](u)';
    const start = performance.now();
    editor.update(() => $convertFromMarkdownString(markdown), {
      discrete: true,
    });
    expect(performance.now() - start).toBeLessThan(10000);
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isElementNode(paragraph));
      expect(paragraph.getChildren().some($isLinkNode)).toBe(false);
    });
  });

  it.each([
    ['\u00A0[x] done', '\u00A0[x&#93; done'],
    ['\u3000[ ] todo', '\u3000[ &#93; todo'],
  ])(
    'escapes a task marker indented with Unicode whitespace: %j',
    (text, expected) => {
      using editor = buildEditorFromExtensions([MarkdownTestExtension]);
      editor.update(() => $exportParagraph(text), {discrete: true});
      const written = editor.read(() =>
        $convertToMarkdownString([CHECK_LIST, ...TRANSFORMERS]),
      );
      expect(written).toBe(expected);
      editor.update(
        () =>
          $convertFromMarkdownString(written, [CHECK_LIST, ...TRANSFORMERS]),
        {discrete: true},
      );
      expect(editor.read(() => $getRoot().getTextContent())).toBe(text);
    },
  );

  it('imports a line of many code spans holding link syntax', () => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    const markdown = '[a`](x)` '.repeat(2000);
    const start = performance.now();
    editor.update(() => $convertFromMarkdownString(markdown), {
      discrete: true,
    });
    expect(performance.now() - start).toBeLessThan(10000);
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isElementNode(paragraph));
      expect(paragraph.getChildren().some($isLinkNode)).toBe(false);
    });
  });

  it.each([
    [
      'many styled nodes',
      () =>
        Array.from({length: 8000}, (_, index) =>
          $createTextNode('xa]:').setStyle(`color: #${index % 2}00`),
        ),
    ],
    ['one long node', () => [$createTextNode('xa]:'.repeat(20000))]],
    [
      'many brackets in one node',
      () => [$createTextNode('[a] '.repeat(20000))],
    ],
  ])('exports %s in linear time', (_name, $children) => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append($createParagraphNode().append(...$children())),
      {discrete: true},
    );
    const start = performance.now();
    editor.read(() => $convertToMarkdownString());
    // Linear exports take tens of milliseconds; a quadratic one takes tens of
    // seconds, so this bound leaves room for a busy machine.
    expect(performance.now() - start).toBeLessThan(10000);
  });

  it('reads brackets written as references by earlier versions', () => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    editor.update(
      () => $convertFromMarkdownString('cleared review &#91;1&#93;&#91;2&#93;'),
      {discrete: true},
    );
    expect(editor.read(() => $getRoot().getTextContent())).toBe(
      'cleared review [1][2]',
    );
  });
});

describe('one-pass numeric reference decoding', () => {
  it.each([
    ['&#65;', 'A'],
    ['&#x41;', 'A'],
    ['&#X41;', 'A'],
    ['\\&#65;', '&#65;'],
    ['\\&#x41;', '&#x41;'],
    ['&#38;#65;', '&#65;'],
    ['&#x26;#x41;', '&#x41;'],
    ['\\\\&#65;', '\\A'],
    ['&copy;', '&copy;'],
    ['&#0;', '\uFFFD'],
    ['&#xD800;', '\uFFFD'],
    ['&#x110000;', '\uFFFD'],
  ])('decodes %j once', (source, expected) => {
    expect(unescapeText(source)).toBe(expected);
  });
});
