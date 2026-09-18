/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $isCodeNode,
  CodeExtension,
  CodeImportExtension,
  type CodeNode,
} from '@lexical/code-core';
import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {DOMImportExtension} from '@lexical/html';
import {$isTableNode, TableExtension} from '@lexical/table';
import {JSDOM} from 'jsdom';
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
      // CodeExtension registers its own import rules (and the shared
      // CoreImportExtension baseline) — no dedicated import extension
      // required.
      dependencies: [CodeExtension],
      name: 'code-host',
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
      $getRoot().clear().splice(0, 0, nodes);
    },
    {discrete: true},
  );
}

function $rootCode(): CodeNode {
  const node = $getRoot().getFirstChild();
  assert($isCodeNode(node), 'expected CodeNode at root');
  return node;
}

describe('CodeImportExtension', () => {
  test('<pre> imports as CodeNode', () => {
    using editor = buildEditor();
    importInto(editor, '<pre>const x = 1;</pre>');
    editor.read(() => {
      const node = $rootCode();
      expect(node.getTextContent()).toContain('const x = 1;');
    });
  });

  test('<pre data-language="ts"> sets the language', () => {
    using editor = buildEditor();
    importInto(editor, '<pre data-language="ts">x</pre>');
    editor.read(() => {
      const node = $rootCode();
      expect(node.getLanguage()).toBe('ts');
    });
  });

  test('<pre data-theme="poimandres"> restores the theme', () => {
    using editor = buildEditor();
    importInto(
      editor,
      '<pre data-language="ts" data-theme="poimandres">x</pre>',
    );
    editor.read(() => {
      const node = $rootCode();
      expect(node.getLanguage()).toBe('ts');
      expect(node.getTheme()).toBe('poimandres');
    });
  });

  test('multi-line <code data-theme> restores the theme', () => {
    using editor = buildEditor();
    importInto(
      editor,
      '<code data-language="ts" data-theme="poimandres">a\nb</code>',
    );
    editor.read(() => {
      const node = $rootCode();
      expect(node.getLanguage()).toBe('ts');
      expect(node.getTheme()).toBe('poimandres');
    });
  });

  test('multi-line <code> imports as CodeNode (not inline)', () => {
    using editor = buildEditor();
    importInto(editor, '<code>line1\nline2</code>');
    editor.read(() => {
      const node = $rootCode();
      expect(node.getTextContent()).toContain('line1');
      expect(node.getTextContent()).toContain('line2');
    });
  });

  test('single-line <code> defers to inline-format (no CodeNode)', () => {
    using editor = buildEditor();
    importInto(editor, '<p><code>inline</code></p>');
    editor.read(() => {
      const para = $getRoot().getFirstChild();
      assert($isParagraphNode(para), 'expected paragraph');
      const text = para.getAllTextNodes()[0];
      assert(text !== undefined, 'expected text node');
      expect(text.getTextContent()).toBe('inline');
      expect(text.hasFormat('code')).toBe(true);
    });
  });

  test('<div style="font-family: monospace"> imports as CodeNode', () => {
    using editor = buildEditor();
    importInto(editor, '<div style="font-family: Menlo, monospace">a\nb</div>');
    editor.read(() => {
      const node = $rootCode();
      expect(node.getTextContent()).toContain('a');
      expect(node.getTextContent()).toContain('b');
    });
  });

  test('GitHub raw-file-view table imports as CodeNode', () => {
    using editor = buildEditor();
    importInto(
      editor,
      [
        '<table class="js-file-line-container">',
        '<tr><td class="js-file-line">line 1</td></tr>',
        '<tr><td class="js-file-line">line 2</td></tr>',
        '</table>',
      ].join(''),
    );
    editor.read(() => {
      const node = $rootCode();
      const text = node.getTextContent();
      expect(text).toContain('line 1');
      expect(text).toContain('line 2');
    });
  });

  test('GitHub raw-file-view table still wins when TableExtension is present', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        // Table listed before Code, like a typical app config: rules
        // merge in dependency order, so CodeExtension's class-restricted
        // <table> rule out-prioritizes TableExtension's generic one.
        dependencies: [TableExtension, CodeExtension],
        name: 'table-code-host',
        theme: {tableScrollableWrapper: ''},
      }),
    );
    importInto(
      editor,
      [
        '<table class="js-file-line-container">',
        '<tr><td class="js-file-line">line 1</td></tr>',
        '</table>',
        '<table><tr><td>plain</td></tr></table>',
      ].join(''),
    );
    editor.read(() => {
      const [code, table] = $getRoot().getChildren();
      assert($isCodeNode(code), 'expected CodeNode for the GitHub table');
      expect(code.getTextContent()).toContain('line 1');
      assert($isTableNode(table), 'expected TableNode for the plain table');
      expect(table.getTextContent()).toContain('plain');
    });
  });

  test('plain <table> falls through (no CodeNode)', () => {
    using editor = buildEditor();
    importInto(editor, '<table><tr><td>a</td></tr></table>');
    editor.read(() => {
      const root = $getRoot();
      assert(
        !$isCodeNode(root.getFirstChild()),
        'plain table should not become a CodeNode',
      );
    });
  });

  test('deprecated CodeImportExtension alias still imports <pre>', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [CodeImportExtension],
        name: 'code-alias-host',
      }),
    );
    importInto(editor, '<pre data-language="ts">const x = 1;</pre>');
    editor.read(() => {
      const node = $getRoot().getFirstChild();
      assert($isCodeNode(node), 'expected CodeNode');
      expect(node.getLanguage()).toBe('ts');
    });
  });
});

// ----------------------------------------------------------------------------
// VS Code → browser paste fixtures
//
// Both Chrome and Safari produce the same on-screen result when you paste a
// code block copied out of VS Code, but the underlying `text/html` differs:
//
//   - Chrome wraps every line in a single outer
//     `<div style="font-family: …monospace…; white-space: pre">…</div>`
//     with the per-line `<div>`s (and `<br>`s for blank lines) inside.
//   - Safari emits flat sibling `<div>` and `<br>` elements at the
//     document root, each carrying the same `font-family: …monospace…;
//     white-space: pre` inline style — no wrapping monospace ancestor.
//
// The legacy `CodeNode.importDOM` produces multiple CodeNodes for the
// Safari case (one per `<div>`); the goal of `MonospacePreRunRule` is
// to collapse the flat run into a single CodeNode so the result
// matches the Chrome case.
// ----------------------------------------------------------------------------

const VSCODE_EXPECTED = `## 📱 iOS alpha four

Biggest alpha update!

- Animate on sending message and delete
- Set online/offline
- Show all users when @ is typed

[Get it from TestFlight.](https://testflight.apple.com/join/yKKmzbhD)

## Smaller improvements`;

const VSCODE_CHROME_HTML = `<meta charset='utf-8'><div style="color: #cccccc;background-color: #1f1f1f;font-family: Menlo, Monaco, 'Courier New', monospace;font-weight: normal;font-size: 12px;line-height: 18px;white-space: pre;"><div><span style="color: #569cd6;font-weight: bold;">## 📱 iOS alpha four</span></div><br><div><span style="color: #cccccc;">Biggest alpha update!</span></div><br><div><span style="color: #6796e6;">-</span><span style="color: #cccccc;"> Animate on sending message and delete</span></div><div><span style="color: #6796e6;">-</span><span style="color: #cccccc;"> Set online/offline</span></div><div><span style="color: #6796e6;">-</span><span style="color: #cccccc;"> Show all users when @ is typed</span></div><br><div><span style="color: #cccccc;">[</span><span style="color: #ce9178;">Get it from TestFlight.</span><span style="color: #cccccc;">](</span><span style="color: #cccccc;text-decoration: underline;">https://testflight.apple.com/join/yKKmzbhD</span><span style="color: #cccccc;">)</span></div><br><div><span style="color: #569cd6;font-weight: bold;">## Smaller improvements</span></div></div>`;

// Trimmed Safari payload (same structure as Safari's real output but
// with only the inline styles MonospacePreRunRule reads on, so the
// fixture stays readable).
const SAFARI_LINE_STYLE =
  'font-family: Menlo, Monaco, "Courier New", monospace; white-space: pre;';
const VSCODE_SAFARI_HTML = [
  `<div style='${SAFARI_LINE_STYLE}'><span style="color: rgb(86, 156, 214); font-weight: bold;">## 📱 iOS alpha four</span></div>`,
  `<br style='${SAFARI_LINE_STYLE}'>`,
  `<div style='${SAFARI_LINE_STYLE}'><span style="color: rgb(204, 204, 204);">Biggest alpha update!</span></div>`,
  `<br style='${SAFARI_LINE_STYLE}'>`,
  `<div style='${SAFARI_LINE_STYLE}'><span>-</span><span> Animate on sending message and delete</span></div>`,
  `<div style='${SAFARI_LINE_STYLE}'><span>-</span><span> Set online/offline</span></div>`,
  `<div style='${SAFARI_LINE_STYLE}'><span>-</span><span> Show all users when @ is typed</span></div>`,
  `<br style='${SAFARI_LINE_STYLE}'>`,
  `<div style='${SAFARI_LINE_STYLE}'><span>[</span><span>Get it from TestFlight.</span><span>](</span><span style="text-decoration: underline;">https://testflight.apple.com/join/yKKmzbhD</span><span>)</span></div>`,
  `<br style='${SAFARI_LINE_STYLE}'>`,
  `<div style='${SAFARI_LINE_STYLE}'><span style="color: rgb(86, 156, 214); font-weight: bold;">## Smaller improvements</span></div>`,
].join('');

describe('CodeImportExtension — VS Code paste', () => {
  test('Chrome (single outer monospace wrapper) → one CodeNode', () => {
    using editor = buildEditor();
    importInto(editor, VSCODE_CHROME_HTML);
    editor.read(() => {
      const root = $getRoot();
      const codeNodes = root.getChildren().filter($isCodeNode);
      expect(codeNodes).toHaveLength(1);
      expect(codeNodes[0].getTextContent()).toBe(VSCODE_EXPECTED);
    });
  });

  test('Safari (flat sibling monospace divs / brs) → one CodeNode', () => {
    using editor = buildEditor();
    importInto(editor, VSCODE_SAFARI_HTML);
    editor.read(() => {
      const root = $getRoot();
      const codeNodes = root.getChildren().filter($isCodeNode);
      // The whole point of MonospacePreRunRule: the run collapses into
      // a single CodeNode rather than one per div as the legacy
      // importDOM produces.
      expect(codeNodes).toHaveLength(1);
      expect(codeNodes[0].getTextContent()).toBe(VSCODE_EXPECTED);
    });
  });

  test('paste without the VS Code structural signal does not install the overlay', () => {
    // A single bare monospace+pre `<div>` with only inline content
    // doesn't match either "wrapper" (no block children) or "sibling
    // run" (no monospace+pre siblings). The conditional overlay must
    // NOT be installed, so the input falls through to the existing
    // DivRule which produces a one-line CodeNode.
    using editor = buildEditor();
    importInto(
      editor,
      `<div style="font-family: monospace; white-space: pre;">just one line</div>`,
    );
    editor.read(() => {
      const codeNodes = $getRoot().getChildren().filter($isCodeNode);
      expect(codeNodes).toHaveLength(1);
      expect(codeNodes[0].getTextContent()).toBe('just one line');
    });
  });
});
