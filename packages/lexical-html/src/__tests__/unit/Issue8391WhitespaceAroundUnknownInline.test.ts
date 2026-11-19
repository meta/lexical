/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Regression test for meta/lexical#8391.
 *
 * The reporter wants this HTML
 *
 *   <p>
 *     In web development, the DOM <tooltip>Document Object Model</tooltip> allows scripts to update content.
 *   </p>
 *
 * to import as three children of a paragraph, with the spaces around the
 * unknown `<tooltip>` element preserved:
 *
 *   paragraph
 *     ├ text "In web development, the DOM "
 *     ├ tooltip
 *     └ text " allows scripts to update content."
 *
 * With the legacy DOM importer, `<tooltip>` isn't in `isInlineDomNode`'s
 * fixed regex of known inline tags, so the surrounding text-node
 * whitespace handler treats it as a block sibling and trims the leading /
 * trailing spaces around it. The reporter's workaround was to monkey-set
 * `display: inline` on the tooltip element from inside an extended
 * TextNode importer — clunky and not composable.
 *
 * The new `DOMImportExtension` pipeline addresses the same case
 * declaratively via `ImportWhitespaceConfig`: the app configures
 * `isInline` to also recognize its custom tags as inline, and the
 * standard text-node whitespace logic preserves the surrounding spaces
 * without any importer-level monkey-patching.
 */

import {
  buildEditorFromExtensions,
  configExtension,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  contextValue,
  CoreImportExtension,
  defaultIsInline,
  defaultPreservesWhitespace,
  defineImportRule,
  DOMImportExtension,
  ImportWhitespaceConfig,
  sel,
} from '@lexical/html';
import {
  $createTextNode,
  $getEditor,
  $getRoot,
  $isParagraphNode,
  defineExtension,
  IS_HIGHLIGHT,
  isHTMLElement,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

const HTML = `<p>In web development, the DOM <tooltip>Document Object Model</tooltip> allows scripts to update content.</p>`;

// Stand-in for a real custom tooltip node: a formatted TextNode whose
// IS_HIGHLIGHT bit prevents the editor from merging it with the
// surrounding unformatted text (so the assertions can still see the
// three sibling text nodes that the issue calls for).
const TOOLTIP_MARKER = '[TOOLTIP]';

const TooltipRule = defineImportRule({
  $import: () => {
    const text = $createTextNode(TOOLTIP_MARKER);
    text.setFormat(IS_HIGHLIGHT);
    return [text];
  },
  match: sel.tag('tooltip'),
  name: 'test/tooltip',
});

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
      $getRoot().clear().splice(0, 0, nodes);
    },
    {discrete: true},
  );
}

function $rootParagraphTextContents(): string[] {
  const para = $getRoot().getFirstChild();
  assert($isParagraphNode(para), 'expected paragraph');
  return para.getChildren().map(c => c.getTextContent());
}

describe('issue #8391 — whitespace around unknown inline elements', () => {
  test('default config: spaces are trimmed against an unknown <tooltip> (reproduces the bug)', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          CoreImportExtension,
          configExtension(DOMImportExtension, {rules: [TooltipRule]}),
        ],
        name: 'host',
      }),
    );
    importInto(editor, HTML);
    editor.read(() => {
      const texts = $rootParagraphTextContents();
      // Default `isInline` doesn't know <tooltip>, so the surrounding
      // text-node whitespace handler treats it as a block sibling: the
      // trailing space after "DOM" and the leading space before "allows"
      // are stripped.
      expect(texts[0]).toBe('In web development, the DOM');
      expect(texts[1]).toBe(TOOLTIP_MARKER);
      expect(texts[2]).toBe('allows scripts to update content.');
    });
  });

  test('override isInline to recognize <tooltip>: spaces preserved', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          CoreImportExtension,
          configExtension(DOMImportExtension, {
            // Compose: keep the built-in inline detection and add the
            // app's custom tags on top. Multiple extensions could each
            // contribute their own `isInline` predicate by depending on
            // the previous one and ORing.
            contextDefaults: [
              contextValue(ImportWhitespaceConfig, {
                isInline: node =>
                  defaultIsInline(node) ||
                  (isHTMLElement(node) && node.nodeName === 'TOOLTIP'),
                preservesWhitespace: defaultPreservesWhitespace,
              }),
            ],
            rules: [TooltipRule],
          }),
        ],
        name: 'host',
      }),
    );
    importInto(editor, HTML);
    editor.read(() => {
      const texts = $rootParagraphTextContents();
      expect(texts[0]).toBe('In web development, the DOM ');
      expect(texts[1]).toBe(TOOLTIP_MARKER);
      expect(texts[2]).toBe(' allows scripts to update content.');
    });
  });

  test('per-call override: pass the isInline predicate via the context option', () => {
    // Same as above but supplied as a per-`$generateNodesFromDOM` context
    // override rather than a contextDefault — useful when one editor
    // needs source-specific whitespace rules.
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          CoreImportExtension,
          configExtension(DOMImportExtension, {rules: [TooltipRule]}),
        ],
        name: 'host',
      }),
    );
    editor.update(
      () => {
        const dep = getExtensionDependencyFromEditor(
          editor,
          DOMImportExtension,
        );
        const dom = new DOMParser().parseFromString(
          `<!doctype html><html><body>${HTML}</body></html>`,
          'text/html',
        );
        const nodes = dep.output.$generateNodesFromDOM(dom, {
          context: [
            contextValue(ImportWhitespaceConfig, {
              isInline: node =>
                defaultIsInline(node) ||
                (isHTMLElement(node) && node.nodeName === 'TOOLTIP'),
              preservesWhitespace: defaultPreservesWhitespace,
            }),
          ],
        });
        $getRoot().clear().splice(0, 0, nodes);
      },
      {discrete: true},
    );
    editor.read(() => {
      const texts = $rootParagraphTextContents();
      expect(texts[0]).toBe('In web development, the DOM ');
      expect(texts[1]).toBe(TOOLTIP_MARKER);
      expect(texts[2]).toBe(' allows scripts to update content.');
    });
  });
});
