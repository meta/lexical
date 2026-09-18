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
  HorizontalRuleExtension,
} from '@lexical/extension';
import {DOMImportExtension} from '@lexical/html';
import {
  $isListItemNode,
  $isListNode,
  ListExtension,
  ListImportExtension,
  ListItemNode,
  ListNode,
  WordListImportExtension,
} from '@lexical/list';
import {JSDOM} from 'jsdom';
import {
  $getEditor,
  $getRoot,
  defineExtension,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

class CustomListItemNode extends ListItemNode {
  $config() {
    return this.config('custom-listitem', {extends: ListItemNode});
  }
}

class CustomListNode extends ListNode {
  $config() {
    return this.config('custom-list', {extends: ListNode});
  }
  createListItemNode(): ListItemNode {
    return new CustomListItemNode();
  }
}

function buildEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      // ListExtension registers its own import rules (and the shared
      // CoreImportExtension baseline) — no dedicated import extension
      // required.
      dependencies: [ListExtension],
      name: 'list-host',
    }),
  );
}

function $generate(html: string): LexicalNode[] {
  const editor = $getEditor();
  const dep = getExtensionDependencyFromEditor(editor, DOMImportExtension);
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  return dep.output.$generateNodesFromDOM(dom.window.document);
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

function $rootList(): ListNode {
  const node = $getRoot().getFirstChild();
  assert($isListNode(node), 'expected ListNode at root');
  return node;
}

function $items(list: ListNode): ListItemNode[] {
  return list.getChildren().filter($isListItemNode);
}

describe('ListImportExtension', () => {
  test('<ul><li>a</li><li>b</li></ul> → bullet list with two items', () => {
    using editor = buildEditor();
    importInto(editor, '<ul><li>a</li><li>b</li></ul>');
    editor.read(() => {
      const list = $rootList();
      expect(list.getListType()).toBe('bullet');
      const items = $items(list);
      expect(items).toHaveLength(2);
      expect(items[0].getTextContent()).toBe('a');
      expect(items[1].getTextContent()).toBe('b');
    });
  });

  test('<ol start="3"> → number list with start=3', () => {
    using editor = buildEditor();
    importInto(editor, '<ol start="3"><li>x</li></ol>');
    editor.read(() => {
      const list = $rootList();
      expect(list.getListType()).toBe('number');
      expect(list.getStart()).toBe(3);
    });
  });

  test('GitHub task-list-item → checklist item', () => {
    using editor = buildEditor();
    importInto(
      editor,
      '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" checked/>done</li><li class="task-list-item"><input type="checkbox"/>todo</li></ul>',
    );
    editor.read(() => {
      const list = $rootList();
      expect(list.getListType()).toBe('check');
      const items = $items(list);
      expect(items).toHaveLength(2);
      expect(items[0].getChecked()).toBe(true);
      expect(items[1].getChecked()).toBe(false);
    });
  });

  test('aria-checked drives checklist state', () => {
    using editor = buildEditor();
    importInto(editor, '<ul><li aria-checked="true">a</li></ul>');
    editor.read(() => {
      const list = $rootList();
      expect(list.getListType()).toBe('check');
      const items = $items(list);
      expect(items[0].getChecked()).toBe(true);
    });
  });

  test('stray text inside <ul> gets wrapped via $normalizeListChildren', () => {
    using editor = buildEditor();
    importInto(editor, '<ul>stray <li>real item</li></ul>');
    editor.read(() => {
      const list = $rootList();
      const items = $items(list);
      // The framework's flattening of unmatched <ul> child text + the legacy
      // normalize step both produce list items; the real item must survive.
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items.some(i => i.getTextContent().includes('real item'))).toBe(
        true,
      );
    });
  });

  test('wrapper items come from ListNode.createListItemNode()', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [ListExtension],
        name: 'custom-list-host',
        nodes: [
          CustomListNode,
          CustomListItemNode,
          {
            replace: ListNode,
            with: (node: ListNode) =>
              new CustomListNode(node.getListType(), node.getStart()),
            withKlass: CustomListNode,
          },
        ],
      }),
    );
    // Both $normalizeListChildren branches: the nested <ul> is lifted into a
    // wrapper item, and the stray text is wrapped in one.
    importInto(editor, '<ul>stray<li>parent<ul><li>child</li></ul></li></ul>');
    editor.read(() => {
      const list = $rootList();
      expect(list.getType()).toBe('custom-list');
      const wrappers = $items(list).filter(
        item => !item.getTextContent().startsWith('parent'),
      );
      expect(wrappers.length).toBeGreaterThanOrEqual(2);
      for (const wrapper of wrappers) {
        expect(wrapper.getType()).toBe('custom-listitem');
      }
    });
  });

  test('deprecated ListImportExtension alias still imports lists', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [ListImportExtension],
        name: 'list-alias-host',
      }),
    );
    importInto(editor, '<ul><li>a</li></ul>');
    editor.read(() => {
      expect($items($rootList()).map(i => i.getTextContent())).toEqual(['a']);
    });
  });
});

// ----------------------------------------------------------------------------
// MS Word paste
//
// MS Word produces HTML where "lists" are actually flat runs of
// <p class="MsoListParagraph*"> with a marker like "1." or "·" inside a
// nested <span style='mso-list:Ignore'>...</span>. There are no <ol>/<ul>
// or <li> elements. The <p>'s carry style='mso-list:l<N> level<M> lfo<X>'
// where <N> identifies the list and <M> the nesting depth.
//
// `WordListImportExtension` (shipped by this package, opt-in) installs the
// preprocess that handles this: the overlay goes on only when the generator
// meta tag is present, so pastes from other sources pay nothing, and its
// rule walks forward through siblings to collect a complete list run and
// rebuild it as a nested list tree.
// ----------------------------------------------------------------------------

function buildWordPasteEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [WordListImportExtension],
      name: 'word-paste-host',
    }),
  );
}

function importHTMLDocument(editor: LexicalEditor, html: string): void {
  editor.update(
    () => {
      const dep = getExtensionDependencyFromEditor(editor, DOMImportExtension);
      const dom = new JSDOM(html);
      const nodes = dep.output.$generateNodesFromDOM(dom.window.document);
      $getRoot().clear().splice(0, 0, nodes);
    },
    {discrete: true},
  );
}

const WORD_HTML_WITH_LISTS = `<!doctype html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word">
<head>
  <meta name="Generator" content="Microsoft Word 15">
</head>
<body>
  <p class="MsoNormal">Body text<o:p></o:p></p>

  <p class="MsoListParagraphCxSpFirst" style="mso-list:l2 level1 lfo1">
    <span><span style="mso-list:Ignore">1.</span></span>
    Numbered List Item 1<o:p></o:p>
  </p>
  <p class="MsoListParagraphCxSpMiddle" style="mso-list:l2 level1 lfo1">
    <span><span style="mso-list:Ignore">2.</span></span>
    Numbered List Item 2<o:p></o:p>
  </p>
  <p class="MsoListParagraphCxSpLast" style="mso-list:l2 level1 lfo1">
    <span><span style="mso-list:Ignore">3.</span></span>
    Numbered List Item 3<o:p></o:p>
  </p>

  <p class="MsoNormal"><o:p>&nbsp;</o:p></p>

  <p class="MsoListParagraphCxSpFirst" style="mso-list:l0 level1 lfo2">
    <span><span style="mso-list:Ignore">&middot;</span></span>
    Bullet List Item 1<o:p></o:p>
  </p>
  <p class="MsoListParagraphCxSpLast" style="mso-list:l0 level1 lfo2">
    <span><span style="mso-list:Ignore">&middot;</span></span>
    Bullet List Item 2<o:p></o:p>
  </p>

  <p class="MsoNormal"><o:p>&nbsp;</o:p></p>

  <p class="MsoListParagraphCxSpFirst" style="mso-list:l1 level1 lfo3">
    <span><span style="mso-list:Ignore">1)</span></span>
    Outline numbered 1<o:p></o:p>
  </p>
  <p class="MsoListParagraphCxSpMiddle" style="mso-list:l1 level2 lfo3">
    <span><span style="mso-list:Ignore">a)</span></span>
    Outline numbered 1.a<o:p></o:p>
  </p>
  <p class="MsoListParagraphCxSpMiddle" style="mso-list:l1 level2 lfo3">
    <span><span style="mso-list:Ignore">b)</span></span>
    Outline numbered 1.b<o:p></o:p>
  </p>
  <p class="MsoListParagraphCxSpLast" style="mso-list:l1 level1 lfo3">
    <span><span style="mso-list:Ignore">2)</span></span>
    Outline numbered 2<o:p></o:p>
  </p>
</body>
</html>`;

describe('MS Word paste — preprocess-installed overlay', () => {
  test('converts MsoListParagraph runs into nested ListNodes', () => {
    using editor = buildWordPasteEditor();
    importHTMLDocument(editor, WORD_HTML_WITH_LISTS);
    editor.read(() => {
      const lists = $getRoot().getChildren().filter($isListNode);
      expect(lists).toHaveLength(3);

      const [numbered, bullet, outline] = lists;

      expect(numbered.getListType()).toBe('number');
      expect($items(numbered).map(li => li.getTextContent().trim())).toEqual([
        'Numbered List Item 1',
        'Numbered List Item 2',
        'Numbered List Item 3',
      ]);

      expect(bullet.getListType()).toBe('bullet');
      expect($items(bullet).map(li => li.getTextContent().trim())).toEqual([
        'Bullet List Item 1',
        'Bullet List Item 2',
      ]);

      // Outline list (Lexical convention): three top-level
      // ListItemNodes — the two content items "1" and "2" plus a
      // *wrapper* item between them whose only child is the nested
      // 2-item sublist.
      expect(outline.getListType()).toBe('number');
      const outlineItems = $items(outline);
      expect(outlineItems).toHaveLength(3);
      const firstContent = outlineItems[0].getFirstChild();
      assert(firstContent !== null, 'expected first content child');
      expect(firstContent.getTextContent().trim()).toBe('Outline numbered 1');
      const nested = outlineItems[1].getFirstChild();
      assert($isListNode(nested), 'expected nested sublist on wrapper item');
      expect(nested.getListType()).toBe('number');
      expect($items(nested).map(li => li.getTextContent().trim())).toEqual([
        'Outline numbered 1.a',
        'Outline numbered 1.b',
      ]);
      const lastContent = outlineItems[2].getFirstChild();
      assert(lastContent !== null, 'expected last content child');
      expect(lastContent.getTextContent().trim()).toBe('Outline numbered 2');
    });
  });

  test('survives the stylesheet-inlining preprocess', () => {
    // Real Word output carries a <style> block, which makes the default
    // `$inlineStylesFromStyleSheets` preprocess rewrite every element's
    // style attribute through CSSStyleDeclaration and drop the unknown
    // `mso-list` property. The overlay's preprocess runs first and
    // snapshots `mso-list` onto data-mso-list precisely so the levels and
    // markers still resolve afterwards; without that snapshot every item
    // reads as level 1 with no marker and the nesting collapses.
    using editor = buildWordPasteEditor();
    importHTMLDocument(
      editor,
      WORD_HTML_WITH_LISTS.replace(
        '</head>',
        `<style>
          p.MsoListParagraphCxSpFirst, p.MsoListParagraphCxSpMiddle,
          p.MsoListParagraphCxSpLast, p.MsoListParagraph
            {margin-top:0in; margin-left:.5in;}
        </style></head>`,
      ),
    );
    editor.read(() => {
      const lists = $getRoot().getChildren().filter($isListNode);
      expect(lists).toHaveLength(3);
      expect(lists[0].getListType()).toBe('number');
      expect(lists[1].getListType()).toBe('bullet');
      const outlineItems = $items(lists[2]);
      expect(outlineItems).toHaveLength(3);
      const nested = outlineItems[1].getFirstChild();
      assert($isListNode(nested), 'expected nested sublist on wrapper item');
      expect($items(nested).map(li => li.getTextContent().trim())).toEqual([
        'Outline numbered 1.a',
        'Outline numbered 1.b',
      ]);
    });
  });

  test('without the Generator meta the overlay is not installed', () => {
    // Same body, no <meta name="Generator"> — the Word overlay must not
    // fire, so the MsoListParagraph elements fall through to normal
    // paragraph handling.
    using editor = buildWordPasteEditor();
    const htmlWithoutMeta = WORD_HTML_WITH_LISTS.replace(
      /<meta name="Generator"[^>]*>/,
      '',
    );
    importHTMLDocument(editor, htmlWithoutMeta);
    editor.read(() => {
      expect($getRoot().getChildren().some($isListNode)).toBe(false);
    });
  });
});

describe('ListItemNode block flattening', () => {
  function $liChildTypes(): string[] {
    const list = $getRoot().getFirstChild();
    assert($isListNode(list), 'expected a ListNode');
    const li = list.getFirstChild();
    assert($isListItemNode(li), 'expected a ListItemNode');
    return li.getChildren().map(c => `${c.getType()}:${c.getTextContent()}`);
  }

  test('keeps contiguous inlines together, breaking only at block boundaries', () => {
    using editor = buildEditor();
    importInto(editor, '<ul><li>a <b>b</b><div>c</div></li></ul>');
    editor.read(() => {
      // `a ` and `b` are inline siblings and must stay on the same line; the
      // <div> (lowered to a ParagraphNode) is the sole boundary.
      expect($liChildTypes()).toEqual([
        'text:a ',
        'text:b',
        'linebreak:\n',
        'text:c',
      ]);
    });
  });

  test('treats a non-paragraph block (<hr>) as a boundary, not inline content', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [HorizontalRuleExtension, ListExtension],
        name: 'list-hr-host',
      }),
    );
    importInto(editor, '<ul><li>x<hr />y</li></ul>');
    editor.read(() => {
      // A HorizontalRuleNode is block-level but not a ParagraphNode; it must
      // still split the run rather than be spliced inline between x and y.
      expect($liChildTypes().map(s => s.split(':')[0])).toEqual([
        'text',
        'linebreak',
        'horizontalrule',
        'linebreak',
        'text',
      ]);
    });
  });

  test('preserves a nested list instead of flattening it', () => {
    using editor = buildEditor();
    importInto(editor, '<ul><li>parent<ul><li>child</li></ul></li></ul>');
    editor.read(() => {
      const findNested = (node: LexicalNode): boolean => {
        if ($isListItemNode(node)) {
          return node.getChildren().some($isListNode);
        }
        return $isListNode(node) && node.getChildren().some(findNested);
      };
      // The nested <ul> survives as a ListNode (lifted into a sibling item by
      // $normalizeListChildren), not demoted to line-break-separated text.
      const outer = $getRoot().getFirstChild();
      assert($isListNode(outer), 'expected a ListNode');
      expect(outer.getChildren().some(findNested)).toBe(true);
    });
  });
});
