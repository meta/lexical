/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {DOMImportExtension} from '@lexical/html';
import {$isLinkNode, LinkExtension, type LinkNode} from '@lexical/link';
import {$isHeadingNode, RichTextExtension} from '@lexical/rich-text';
import {
  $getEditor,
  $getRoot,
  $isParagraphNode,
  defineExtension,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

function buildEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      // LinkExtension registers its own import rules (and the shared
      // CoreImportExtension baseline) — no dedicated import extension
      // required.
      dependencies: [LinkExtension],
      name: 'link-host',
    }),
  );
}

function $generate(html: string): LexicalNode[] {
  const editor = $getEditor();
  const dep = getExtensionDependencyFromEditor(editor, DOMImportExtension);
  const dom = new DOMParser().parseFromString(
    `<!doctype html><html><body>${html}</body></html>`,
    'text/html',
  );
  return dep.output.$generateNodesFromDOM(dom);
}

function importInto(editor: LexicalEditor, html: string): void {
  editor.update(
    () => {
      const nodes = $generate(html);
      $getRoot()
        .clear()
        .append(...nodes);
    },
    {discrete: true},
  );
}

function $firstLink(): LinkNode {
  const para = $getRoot().getFirstChild();
  assert($isParagraphNode(para), 'expected paragraph');
  const link = para.getFirstChild();
  assert($isLinkNode(link), 'expected LinkNode');
  return link;
}

describe('LinkImportExtension', () => {
  test('<a href="…">text</a> → LinkNode with TextNode child', () => {
    using editor = buildEditor();
    importInto(editor, '<p><a href="https://example.com">click</a></p>');
    editor.read(() => {
      const link = $firstLink();
      // href is read via getAttribute, so JSDOM's URL resolution is bypassed.
      expect(link.getURL()).toBe('https://example.com');
      expect(link.getTextContent()).toBe('click');
    });
  });

  test('rel, target, title preserved', () => {
    using editor = buildEditor();
    importInto(
      editor,
      '<p><a href="/x" target="_blank" rel="noopener" title="hello">x</a></p>',
    );
    editor.read(() => {
      const link = $firstLink();
      expect(link.getTarget()).toBe('_blank');
      expect(link.getRel()).toBe('noopener');
      expect(link.getTitle()).toBe('hello');
    });
  });

  test('empty <a> with no children is skipped', () => {
    using editor = buildEditor();
    importInto(editor, '<p>before<a href="/x"></a>after</p>');
    editor.read(() => {
      const para = $getRoot().getFirstChild();
      assert($isParagraphNode(para), 'expected paragraph');
      expect(para.getTextContent()).toBe('beforeafter');
    });
  });
});

describe('LinkImportExtension — block children lifted out of inline parent', () => {
  function buildRichEditor() {
    return buildEditorFromExtensions(
      defineExtension({
        dependencies: [LinkExtension, RichTextExtension],
        name: 'rich-link-host',
      }),
    );
  }

  test('<a><h1>x</h1><div>y</div></a> lifts the heading and re-wraps both runs with the link', () => {
    using editor = buildRichEditor();
    importInto(
      editor,
      '<a href="https://example.com"><h1>some text</h1><div>more text</div></a>',
    );
    editor.read(() => {
      const root = $getRoot();
      const children = root.getChildren();
      expect(children.length).toBe(2);

      const heading = children[0];
      assert($isHeadingNode(heading), 'expected HeadingNode at index 0');
      const headingLink = heading.getFirstChild();
      assert($isLinkNode(headingLink), 'expected LinkNode inside heading');
      expect(headingLink.getURL()).toBe('https://example.com');
      expect(headingLink.getTextContent()).toBe('some text');

      const paragraph = children[1];
      assert($isParagraphNode(paragraph), 'expected ParagraphNode at index 1');
      const paragraphLink = paragraph.getFirstChild();
      assert($isLinkNode(paragraphLink), 'expected LinkNode inside paragraph');
      expect(paragraphLink.getURL()).toBe('https://example.com');
      expect(paragraphLink.getTextContent()).toBe('more text');
    });
  });

  test('<a><h1>x</h1>y<h1>z</h1></a> wraps the middle inline run in its own paragraph + link', () => {
    using editor = buildRichEditor();
    importInto(editor, '<a href="/u"><h1>x</h1>middle<h1>z</h1></a>');
    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children.length).toBe(3);

      const [h1, mid, h3] = children;
      assert($isHeadingNode(h1), 'expected HeadingNode');
      const h1Link = h1.getFirstChild();
      assert($isLinkNode(h1Link), 'expected LinkNode');
      expect(h1Link.getTextContent()).toBe('x');

      assert($isParagraphNode(mid), 'expected ParagraphNode');
      const midLink = mid.getFirstChild();
      assert($isLinkNode(midLink), 'expected LinkNode');
      expect(midLink.getTextContent()).toBe('middle');
      // Each lifted block gets its own fresh link wrapper (not a shared instance).
      expect(midLink.is(h1Link)).toBe(false);

      assert($isHeadingNode(h3), 'expected HeadingNode');
      const h3Link = h3.getFirstChild();
      assert($isLinkNode(h3Link), 'expected LinkNode');
      expect(h3Link.getTextContent()).toBe('z');
    });
  });

  test('all-inline <a> retains the single-wrapping fast path', () => {
    using editor = buildRichEditor();
    importInto(editor, '<p><a href="/x">just text</a></p>');
    editor.read(() => {
      const para = $getRoot().getFirstChild();
      assert($isParagraphNode(para), 'expected ParagraphNode');
      const link = para.getFirstChild();
      assert($isLinkNode(link), 'expected LinkNode');
      expect(link.getTextContent()).toBe('just text');
      expect(link.getURL()).toBe('/x');
    });
  });
});
