/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$isCodeNode, CodeHighlightNode, CodeNode} from '@lexical/code-core';
import {buildEditorFromExtensions} from '@lexical/extension';
import {$generateNodesFromDOM} from '@lexical/html';
import {RichTextExtension} from '@lexical/rich-text';
import {$isElementNode, defineExtension, type LexicalEditor} from 'lexical';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, onTestFinished, test, vi} from 'vitest';

// The legacy `importDOM` path ($generateNodesFromDOM without
// DOMImportExtension) for code copied from VS Code (#5569).

// Inline style VS Code puts on every element it writes to the clipboard,
// shortened from the Safari payload in the issue.
const STYLE =
  'caret-color: rgb(204, 204, 204); color: rgb(204, 204, 204); font-family: Menlo, Monaco, &quot;Courier New&quot;, monospace; font-size: 12px; white-space: pre; background-color: rgb(31, 31, 31);';

// Safari: a flat run of sibling line <div>s and <br>s, each with the style.
const SAFARI = `<div style="${STYLE}"><span style="color: rgb(86, 156, 214); font-weight: bold"><br class="Apple-interchange-newline">## 📱 iOS alpha four</span></div><br style="${STYLE}"><div style="${STYLE}"><span style="color: rgb(204, 204, 204)">Biggest alpha update!</span></div>`;

// Chrome: one monospace wrapper around the lines.
const CHROME = `<div style="color: #cccccc; background-color: #1f1f1f; font-family: Menlo, Monaco, &quot;Courier New&quot;, monospace; font-weight: normal; font-size: 12px; line-height: 18px; white-space: pre;"><br><div><span style="color: #569cd6; font-weight: bold">## 📱 iOS alpha four</span></div><br><div><span style="color: #cccccc">Biggest alpha update!</span></div></div>`;

function buildEditor(): LexicalEditor {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [RichTextExtension],
      name: '[legacy-vscode-paste]',
      nodes: [CodeNode, CodeHighlightNode],
    }),
  );
  onTestFinished(() => editor.dispose());
  return editor;
}

function importHTML(html: string): [string, string][] {
  const editor = buildEditor();
  let result: [string, string][] = [];
  editor.update(
    () => {
      const dom = new DOMParser().parseFromString(html, 'text/html');
      result = $generateNodesFromDOM(editor, dom).map(node => {
        if ($isCodeNode(node)) {
          // A code block is flat: its lines are never nested CodeNodes
          expect(node.getChildren().filter($isElementNode)).toEqual([]);
        }
        return [
          $isCodeNode(node) ? 'code' : node.getType(),
          node.getTextContent(),
        ];
      });
    },
    {discrete: true},
  );
  return result;
}

describe('legacy HTML import of code copied from VS Code (#5569)', () => {
  test('Safari: the sibling line divs become one code block', () => {
    const nodes = importHTML(SAFARI);
    expect(nodes.map(([type]) => type)).toEqual(['code']);
    expect(nodes[0][1]).toContain('## 📱 iOS alpha four\n');
    expect(nodes[0][1]).toMatch(/\nBiggest alpha update!$/);
  });

  test('Safari gives the same code block as Chrome, apart from the leading newline', () => {
    const [[, safari]] = importHTML(SAFARI);
    const [[, chrome]] = importHTML(CHROME);
    expect(safari.replace(/^\n+/, '')).toBe(chrome.replace(/^\n+/, ''));
  });

  test('Chrome: the wrapper still becomes one code block, unchanged', () => {
    expect(importHTML(CHROME)).toEqual([
      ['code', '\n\n## 📱 iOS alpha four\n\n\nBiggest alpha update!'],
    ]);
  });

  test('two runs separated by other content stay two code blocks', () => {
    const run = `<div style="${STYLE}">a</div><div style="${STYLE}">b</div>`;
    expect(importHTML(`${run}<p>between</p>${run}`)).toEqual([
      ['code', 'a\nb'],
      ['paragraph', 'between'],
      ['code', 'a\nb'],
    ]);
  });

  test('works where Node is not a global, as in headless import', () => {
    vi.stubGlobal('Node', undefined);
    try {
      expect(
        importHTML(
          `<div style="${STYLE}">a</div> <div style="${STYLE}">b</div>`,
        ),
      ).toEqual([['code', 'a\nb']]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a single monospace div is not wrapped', () => {
    expect(importHTML(`<div style="${STYLE}">one line</div>`)).toEqual([
      ['code', 'one line'],
    ]);
  });

  test('a run of only <br>s is not wrapped', () => {
    expect(
      importHTML(`<p>x</p><br style="${STYLE}"><br style="${STYLE}">`).map(
        ([type]) => type,
      ),
    ).not.toContain('code');
  });

  test('a line containing a tab keeps the tab inside the one code block', () => {
    const nodes = importHTML(
      `<div style="${STYLE}"><span>function f() {</span></div><div style="${STYLE}"><span>\treturn 1;</span></div><div style="${STYLE}"><span>}</span></div>`,
    );
    expect(nodes.map(([type]) => type)).toEqual(['code']);
    expect(nodes[0][1]).toContain('\treturn 1;');
    expect(nodes[0][1]).toMatch(/^function f\(\) \{\n+\treturn 1;\n+\}$/);
  });

  test('the unprettified Safari clipboard fixture becomes one code block', () => {
    const html = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../../../dev-examples/dom-import/src/fixtures/vscode-safari.html',
      ),
      'utf8',
    );
    const nodes = importHTML(html);
    // The trailing body-level `<br class="Apple-interchange-newline">` is
    // outside any block, so the legacy LineBreakNode filter keeps it; that
    // is unrelated to this fix.
    expect(nodes.map(([type]) => type)).toEqual(['code', 'linebreak']);
    expect(nodes[0][1]).toContain('## 📱 iOS alpha four');
  });
});
