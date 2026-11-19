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
  $isAutoLinkNode,
  autoLinkEmailMatcher,
  AutoLinkExtension,
  autoLinkUrlMatcher,
} from '@lexical/link';
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  configExtension,
  type LexicalEditor,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

const urls = [
  'http://example.com',
  'https://example.com',
  'http://www.example.com',
  'https://www.example.com',
  'www.example.com',
  'http://example.org',
  'https://example.net',
  'http://example.co.uk',
  'https://example.xyz',
  'http://example.com/path/to/resource',
  'https://www.example.com/path/to/resource',
  'http://example.com/path?name=value',
  'https://www.example.com/path?name=value&another=value2',
  'http://example.com/path#section',
  'https://www.example.com/path/to/resource#fragment',
  'http://example.com:8080',
  'https://www.example.com:443/path',
  'http://192.168.0.1',
  'https://127.0.0.1',
  'http://example.com/path/to/res+ource',
  'https://example.com/path/to/res%20ource',
  'http://example.com/path?name=va@lue',
  'https://example.com/path?name=value&another=val%20ue',
  'http://subdomain.example.com',
  'https://sub.subdomain.example.com',
  'http://example.museum',
  'https://example.travel',
  'http://foo.bar',
  'https://foo.bar',
];
const emails = [
  'email@domain.com',
  'firstname.lastname@domain.com',
  'email@subdomain.domain.com',
  'firstname+lastname@domain.com',
  'email@[123.123.123.123]',
  '"email"@domain.com',
  '1234567890@domain.com',
  'email@domain-one.com',
  '_______@domain.com',
  'email@domain.name',
  'email@domain.co.uk',
  'firstname-lastname@domain.com',
];
const invalidUrls = [
  'example.com',
  'htp://example.com',
  'htps://example.com',
  'http://exa mple.com',
  'https://example .com',
  'http://example!.com',
  'http://.com',
  'https://.org',
  'http://',
  'https://',
  'not_a_url',
  'this is not a url',
  'example',
  'ftp://example.com',
];
const invalidEmails = [
  '@domain.com',
  '@subdomain.domain.com',
  'email@domain!.com',
  'email@domain.c',
  'email@.com',
  'email@.org',
  'email@',
  'not_an_email',
];

function buildEditor() {
  return buildEditorFromExtensions({
    $initialEditorState() {
      $getRoot().append($createParagraphNode()).selectEnd();
    },
    dependencies: [
      configExtension(AutoLinkExtension, {
        matchers: [autoLinkUrlMatcher, autoLinkEmailMatcher],
      }),
    ],
    name: '[test autolink samples]',
  });
}

function insertText(editor: LexicalEditor, text: string, incremental: boolean) {
  // Commit between characters so matching, splitting and link edits run at
  // every insertion boundary, as they do during typing.
  for (const chunk of incremental ? Array.from(text) : [text]) {
    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        selection.insertText(chunk);
      },
      {discrete: true},
    );
  }
}

const links = [
  ...urls.map(text => ({
    prefix: '',
    suffix: ' ltr',
    text,
    url: text.startsWith('http') ? text : `https://${text}`,
  })),
  ...emails.map(text => ({
    prefix: '',
    suffix: ' ltr',
    text,
    url: `mailto:${text}`,
  })),
  {
    prefix: 'مرحبا ',
    suffix: ' end',
    text: 'https://qabilah.com/posts/عربي',
    url: 'https://qabilah.com/posts/عربي',
  },
  {
    prefix: 'go ',
    suffix: ' done',
    text: 'http://예시.한국/경로?키=값#부분',
    url: 'http://예시.한국/경로?키=값#부분',
  },
];

describe.each([false, true])(
  'AutoLink transform (incremental: %s)',
  incremental => {
    test.each(links)('$text', ({prefix, text, url, suffix}) => {
      using editor = buildEditor();
      const input = prefix + text + suffix;
      insertText(editor, input, incremental);
      editor.read(() => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        assert($isParagraphNode(paragraph));
        expect($getRoot().getChildrenSize()).toBe(1);
        expect(paragraph.getTextContent()).toBe(input);
        expect(paragraph.getChildrenSize()).toBe(prefix ? 3 : 2);
        const link = paragraph.getChildAtIndex(prefix ? 1 : 0);
        assert($isAutoLinkNode(link));
        expect(link.getURL()).toBe(url);
        expect(link.getIsUnlinked()).toBe(false);
        expect(link.getChildrenSize()).toBe(1);
        expect(link.getFirstChildOrThrow().getTextContent()).toBe(text);
        if (prefix) {
          const before = paragraph.getFirstChildOrThrow();
          assert($isTextNode(before));
          expect(before.getTextContent()).toBe(prefix);
        }
        const after = paragraph.getLastChildOrThrow();
        assert($isTextNode(after));
        expect(after.getTextContent()).toBe(suffix);
      });
    });

    test.each([
      {label: 'invalid URLs', samples: invalidUrls},
      {label: 'invalid emails', samples: invalidEmails},
    ])('leaves $label unchanged', ({samples}) => {
      using editor = buildEditor();
      const text = samples.join(' ');
      insertText(editor, text, incremental);
      editor.read(() => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        assert($isParagraphNode(paragraph));
        expect($getRoot().getChildrenSize()).toBe(1);
        expect(paragraph.getChildrenSize()).toBe(1);
        const child = paragraph.getFirstChildOrThrow();
        assert($isTextNode(child));
        expect(child.getTextContent()).toBe(text);
      });
    });
  },
);
