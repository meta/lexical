/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  buildEditorFromExtensions,
  configExtension,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  CoreImportExtension,
  createImportState,
  defineImportRule,
  DOMImportExtension,
  type DOMPreprocessFn,
  sel,
} from '@lexical/html';
import {JSDOM} from 'jsdom';
import {
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
  $isParagraphNode,
  type AnyLexicalExtension,
  defineExtension,
  isHTMLElement,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

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

describe('DOMImportExtension preprocess', () => {
  test('default $inlineStylesFromStyleSheets resolves <style> rules to inline styles', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [CoreImportExtension],
        name: 'host',
      }),
    );
    // Excel-style HTML: classes carry the styles via a <style> block.
    // The default preprocess inlines those styles, then the span import
    // rule sees `style="font-weight: 700"` and produces a bold TextNode.
    importInto(
      editor,
      '<style>.xl1 { font-weight: 700; }</style><p><span class="xl1">bold</span></p>',
    );
    editor.read(() => {
      const text = $getRoot().getAllTextNodes()[0];
      expect(text.hasFormat('bold')).toBe(true);
    });
  });

  test('app preprocess can mutate the DOM before walking', () => {
    const $stripScripts: DOMPreprocessFn = (dom, _ctx, $next) => {
      const root = 'body' in dom ? dom.body : (dom as ParentNode);
      for (const el of Array.from(root.querySelectorAll('script'))) {
        el.remove();
      }
      $next();
    };
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          CoreImportExtension,
          configExtension(DOMImportExtension, {preprocess: [$stripScripts]}),
        ],
        name: 'host',
      }),
    );
    importInto(editor, '<p>before<script>alert(1)</script>after</p>');
    editor.read(() => {
      const para = $getRoot().getFirstChild();
      assert($isParagraphNode(para), 'expected paragraph');
      // <script> is gone (the framework would already skip it via the
      // IgnoreScriptStyleRule, but this test demonstrates a real DOM
      // mutation took effect — text content is "beforeafter", no gap).
      expect(para.getTextContent()).toBe('beforeafter');
    });
  });

  test('preprocess can write to the session for the rest of the import', () => {
    // Demo: read a <meta name="lexical-source"> tag and install a
    // typed context value the importer rules can branch on.
    const SourceState = createImportState<string>(
      'test/import-source',
      () => 'unknown',
    );
    const $readSourceMeta: DOMPreprocessFn = (dom, ctx, $next) => {
      const root = 'body' in dom ? dom.body : (dom as ParentNode);
      const meta = root.querySelector('meta[name="lexical-source"]');
      if (meta && isHTMLElement(meta)) {
        const content = meta.getAttribute('content');
        if (content) {
          ctx.session.set(SourceState, content);
        }
      }
      $next();
    };
    const SourceAwareDivRule = defineImportRule({
      $import: (ctx, _el) => {
        const p = $createParagraphNode();
        p.append($createTextNode(`[${ctx.get(SourceState)}]`));
        return [p];
      },
      match: sel.tag('div'),
      name: 'test/source-aware-div',
    });
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          CoreImportExtension,
          configExtension(DOMImportExtension, {
            preprocess: [$readSourceMeta],
            rules: [SourceAwareDivRule],
          }),
        ],
        name: 'host',
      }),
    );
    importInto(
      editor,
      '<meta name="lexical-source" content="paste"><div>x</div>',
    );
    editor.read(() => {
      const para = $getRoot().getFirstChild();
      assert($isParagraphNode(para), 'expected paragraph');
      expect(para.getTextContent()).toBe('[paste]');
    });
  });

  test('preprocess can write to the import session (shared with rules)', () => {
    // Collect every <style> tag's text into a session value during
    // preprocess, then have a rule read it during the walk.
    const Stylesheets = createImportState<string[]>(
      'test/stylesheets',
      () => [],
    );
    const $collectStyleSheets: DOMPreprocessFn = (dom, ctx, $next) => {
      const root = 'body' in dom ? dom.body : (dom as ParentNode);
      for (const el of Array.from(root.querySelectorAll('style'))) {
        ctx.session.update(Stylesheets, prev => [
          ...prev,
          el.textContent || '',
        ]);
      }
      $next();
    };
    const ArticleRule = defineImportRule({
      $import: (ctx, _el) => {
        const sheets = ctx.session.get(Stylesheets);
        const p = $createParagraphNode();
        p.append($createTextNode(`[saw ${sheets.length} sheets]`));
        return [p];
      },
      match: sel.tag('article'),
      name: 'test/article',
    });
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          CoreImportExtension,
          configExtension(DOMImportExtension, {
            preprocess: [$collectStyleSheets],
            rules: [ArticleRule],
          }),
        ],
        name: 'host',
      }),
    );
    importInto(
      editor,
      '<style>.a{}</style><style>.b{}</style><article>body</article>',
    );
    editor.read(() => {
      const para = $getRoot().getFirstChild();
      assert($isParagraphNode(para), 'expected paragraph');
      expect(para.getTextContent()).toBe('[saw 2 sheets]');
    });
  });

  test('middleware chain: a wrapper preprocess can defer to a lower one via $next()', () => {
    const log: string[] = [];
    const $innerPreprocess: DOMPreprocessFn = (_dom, _ctx, $next) => {
      log.push('inner-before');
      $next();
      log.push('inner-after');
    };
    const $wrapperPreprocess: DOMPreprocessFn = (_dom, _ctx, $next) => {
      log.push('wrapper-before');
      $next();
      log.push('wrapper-after');
    };
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          CoreImportExtension,
          configExtension(DOMImportExtension, {
            preprocess: [$innerPreprocess, $wrapperPreprocess],
          }),
        ],
        name: 'host',
      }),
    );
    importInto(editor, '<p>x</p>');
    // Top of stack runs first: wrapper (last in array) wraps inner
    // (registered earlier).
    expect(log).toEqual([
      'wrapper-before',
      'inner-before',
      'inner-after',
      'wrapper-after',
    ]);
  });

  test('per-call preprocess runs in addition to config-level ones', () => {
    const log: string[] = [];
    const $configPreprocess: DOMPreprocessFn = (_dom, _ctx, $next) => {
      log.push('config');
      $next();
    };
    const $perCallPreprocess: DOMPreprocessFn = (_dom, _ctx, $next) => {
      log.push('per-call');
      $next();
    };
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          CoreImportExtension,
          configExtension(DOMImportExtension, {
            preprocess: [$configPreprocess],
          }),
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
        const dom = new JSDOM(
          `<!doctype html><html><body><p>x</p></body></html>`,
        );
        const nodes = dep.output.$generateNodesFromDOM(dom.window.document, {
          preprocess: [$perCallPreprocess],
        });
        $getRoot().clear().splice(0, 0, nodes);
      },
      {discrete: true},
    );
    // Per-call appends to the stack (highest index = runs first).
    expect(log).toEqual(['per-call', 'config']);
  });

  test('preprocessors contributed by dependents run before their dependencies', () => {
    const log: string[] = [];
    const trace =
      (name: string): DOMPreprocessFn =>
      (_dom, _ctx, $next) => {
        log.push(name);
        $next();
      };
    const makeExtension = (
      name: string,
      dependencies: AnyLexicalExtension[] = [],
    ) =>
      defineExtension({
        dependencies: [
          ...dependencies,
          configExtension(DOMImportExtension, {
            preprocess: [trace(`${name}-a`), trace(`${name}-b`)],
          }),
        ],
        name: `preprocess-${name}`,
      });
    const leaf = makeExtension('leaf');
    const mid = makeExtension('mid', [leaf]);
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [CoreImportExtension, mid],
        name: 'preprocess-root',
      }),
    );
    importInto(editor, '<p>x</p>');
    // The stack is run from its end, so the LAST entry of a contribution
    // runs first, and a dependent extension's whole contribution runs
    // before its dependency's.
    expect(log).toEqual(['mid-b', 'mid-a', 'leaf-b', 'leaf-a']);
  });
});
