/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Next.js prerenders client components with `cacheComponents` and fails the
// build when one reads `Math.random()` outside a Suspense boundary
// (meta/lexical#9318). Rendering a composer on the server must therefore
// not read it from Lexical code, at import or during render.
describe('server render without Math.random', () => {
  let lexicalCalls: string[];

  beforeEach(() => {
    vi.resetModules();
    lexicalCalls = [];
    const random = Math.random;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      const stack = new Error().stack || '';
      if (/\/packages\/lexical[^/]*\/src\//.test(stack)) {
        lexicalCalls.push(stack);
      }
      return random();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('LexicalComposer without a namespace', async () => {
    const [
      {LexicalComposer},
      {renderToString},
      {$createParagraphNode, $getRoot},
    ] = await Promise.all([
      import('@lexical/react/LexicalComposer'),
      import('react-dom/server'),
      import('lexical'),
    ]);
    const html = renderToString(
      <LexicalComposer
        initialConfig={{
          editorState: () => {
            $getRoot().append($createParagraphNode());
          },
          // An empty namespace makes createEditor generate one
          namespace: '',
          onError: (error: Error) => {
            throw error;
          },
        }}>
        <div>composer</div>
      </LexicalComposer>,
    );
    expect(html).toContain('composer');
    expect(lexicalCalls).toEqual([]);
  });

  it('LexicalExtensionComposer without a namespace', async () => {
    const [
      {LexicalExtensionComposer},
      {RichTextExtension},
      {HistoryExtension},
      {renderToString},
      {$createParagraphNode, $createTextNode, $getRoot, defineExtension},
    ] = await Promise.all([
      import('@lexical/react/LexicalExtensionComposer'),
      import('@lexical/rich-text'),
      import('@lexical/history'),
      import('react-dom/server'),
      import('lexical'),
    ]);
    const extension = defineExtension({
      $initialEditorState: () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('hello')),
        );
      },
      dependencies: [RichTextExtension, HistoryExtension],
      name: '[root]',
    });
    const html = renderToString(
      <LexicalExtensionComposer extension={extension} contentEditable={null}>
        <div>composer</div>
      </LexicalExtensionComposer>,
    );
    expect(html).toContain('composer');
    expect(lexicalCalls).toEqual([]);
  });

  it('LexicalCollaboration', async () => {
    const [{LexicalCollaboration, useCollaborationContext}, {renderToString}] =
      await Promise.all([
        import('@lexical/react/LexicalCollaborationContext'),
        import('react-dom/server'),
      ]);
    function ShowName() {
      const {name, color} = useCollaborationContext();
      return (
        <span>
          {name} {color}
        </span>
      );
    }
    const html = renderToString(
      <LexicalCollaboration>
        <ShowName />
      </LexicalCollaboration>,
    );
    expect(html).toContain('<span>');
    expect(lexicalCalls).toEqual([]);
  });

  it('gives each editor a distinct key and namespace', async () => {
    const {createEditor} = await import('lexical');
    const editors = Array.from({length: 3}, () => createEditor());
    expect(new Set(editors.map(e => e.getKey())).size).toBe(3);
    expect(new Set(editors.map(e => e._config.namespace)).size).toBe(3);
    expect(lexicalCalls).toEqual([]);
  });
});
