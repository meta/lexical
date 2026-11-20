/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $generateHtmlFromNodes,
  $generateNodesFromDOMViaExtension,
} from '@lexical/html';
import {
  $createParagraphNode,
  $getRoot,
  $insertNodes,
  $isElementNode,
  type AnyLexicalExtension,
  defineExtension,
  type LexicalNode,
} from 'lexical';
import {assert, describe, expect, it} from 'vitest';

import {
  $createDateTimeNode,
  $isDateTimeNode,
} from '../../src/nodes/DateTimeNode/DateTimeNode';
import {
  $createEquationNode,
  $isEquationNode,
} from '../../src/nodes/EquationNode';
import {$createImageNode, $isImageNode} from '../../src/nodes/ImageNode';
import {$createMentionNode, $isMentionNode} from '../../src/nodes/MentionNode';
import {
  $createPageBreakNode,
  $isPageBreakNode,
} from '../../src/nodes/PageBreakNode';
import {PlaygroundImportExtension} from '../../src/nodes/PlaygroundImportExtension';
import {
  $createPollNode,
  $isPollNode,
  createPollOption,
} from '../../src/nodes/PollNode';
import {$createTweetNode, $isTweetNode} from '../../src/nodes/TweetNode';
import {$createYouTubeNode, $isYouTubeNode} from '../../src/nodes/YouTubeNode';
import {DateTimeExtension} from '../../src/plugins/DateTimeExtension';
import {EquationsExtension} from '../../src/plugins/EquationsExtension';
import {ImagesExtension} from '../../src/plugins/ImagesExtension';
import {MentionsExtension} from '../../src/plugins/MentionsExtension';
import {PageBreakExtension} from '../../src/plugins/PageBreakExtension';
import {PollExtension} from '../../src/plugins/PollExtension';
import {TwitterExtension} from '../../src/plugins/TwitterExtension';
import {YouTubeExtension} from '../../src/plugins/YouTubeExtension';

// Compose each feature extension with the real playground import pipeline
// (`PlaygroundImportExtension` brings `CoreImportExtension` + every
// per-package importer + the playground style overlay). This mirrors how
// `App.tsx` wires things so the rule-dispatch ordering matches production —
// in particular the per-node `<span>` rules must out-prioritize the core
// inline-format `<span>` rule.
function testExtension(feature: AnyLexicalExtension): AnyLexicalExtension {
  return defineExtension({
    $initialEditorState: null,
    dependencies: [PlaygroundImportExtension, feature],
    name: '[test-importer]',
  });
}

function $findFirst(
  predicate: (node: LexicalNode) => boolean,
): LexicalNode | null {
  const stack: LexicalNode[] = [...$getRoot().getChildren()];
  while (stack.length > 0) {
    const node = stack.shift()!;
    if (predicate(node)) {
      return node;
    }
    if ($isElementNode(node)) {
      stack.push(...node.getChildren());
    }
  }
  return null;
}

/**
 * Build a playground editor, insert `makeNode()`, serialize the whole
 * document to HTML, then re-import that HTML through the
 * {@link DOMImportExtension} pipeline and run `$assert` on the result. This
 * exercises the importer end-to-end against the node's own `exportDOM`,
 * covering the `static importDOM` behavior that was migrated to a
 * `defineImportRule`.
 */
function expectRoundTrip(
  feature: AnyLexicalExtension,
  makeNode: () => LexicalNode,
  $assert: () => void,
): void {
  using editor = buildEditorFromExtensions(testExtension(feature));
  editor.update(
    () => {
      $getRoot().clear();
      const paragraph = $createParagraphNode();
      $getRoot().append(paragraph);
      paragraph.selectStart();
      $insertNodes([makeNode()]);
    },
    {discrete: true},
  );
  const htmlString = editor.read(() => $generateHtmlFromNodes(editor, null));
  editor.update(
    () => {
      $getRoot().clear().select();
      const dom = new DOMParser().parseFromString(htmlString, 'text/html');
      $insertNodes($generateNodesFromDOMViaExtension(dom));
    },
    {discrete: true},
  );
  editor.read($assert);
}

describe('Playground node importers (DOMImportExtension round-trip)', () => {
  it('ImageNode', () => {
    expectRoundTrip(
      ImagesExtension,
      () => $createImageNode({altText: 'a flower', src: '/test/flower.jpg'}),
      () => {
        const node = $findFirst($isImageNode);
        assert($isImageNode(node), 'expected an ImageNode');
        expect(node.getSrc()).toBe('/test/flower.jpg');
      },
    );
  });

  it('PollNode', () => {
    expectRoundTrip(
      PollExtension,
      () => $createPollNode('Favorite color?', [createPollOption('Red')]),
      () => {
        const node = $findFirst($isPollNode);
        assert($isPollNode(node), 'expected a PollNode');
        expect(node.getQuestion()).toBe('Favorite color?');
      },
    );
  });

  it('EquationNode (inline)', () => {
    expectRoundTrip(
      EquationsExtension,
      () => $createEquationNode('x^2', true),
      () => {
        const node = $findFirst($isEquationNode);
        assert($isEquationNode(node), 'expected an EquationNode');
        expect(node.getEquation()).toBe('x^2');
      },
    );
  });

  it('MentionNode', () => {
    expectRoundTrip(
      MentionsExtension,
      () => $createMentionNode('Luke'),
      () => {
        const node = $findFirst($isMentionNode);
        assert($isMentionNode(node), 'expected a MentionNode');
        expect(node.getTextContent()).toBe('Luke');
      },
    );
  });

  it('DateTimeNode', () => {
    const dateTime = new Date('2026-05-29T12:34:56.789Z');
    expectRoundTrip(
      DateTimeExtension,
      () => $createDateTimeNode(dateTime),
      () => {
        const node = $findFirst($isDateTimeNode);
        assert($isDateTimeNode(node), 'expected a DateTimeNode');
        expect(node.getDateTime().getTime()).toBe(dateTime.getTime());
      },
    );
  });

  it('PageBreakNode', () => {
    expectRoundTrip(
      PageBreakExtension,
      () => $createPageBreakNode(),
      () => {
        const node = $findFirst($isPageBreakNode);
        assert($isPageBreakNode(node), 'expected a PageBreakNode');
      },
    );
  });

  // Older playground exports rendered the page break as
  // `<figure type="page-break">`. ImagesExtension's generic `<figure>`
  // rule would otherwise swallow the empty figure on import, so the
  // legacy matcher in PageBreakExtension has to win — verify with
  // ImagesExtension present in the same test pipeline.
  it('PageBreakNode legacy <figure type="page-break"> import', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        dependencies: [
          PlaygroundImportExtension,
          ImagesExtension,
          PageBreakExtension,
        ],
        name: '[test-legacy-page-break]',
      }),
    );
    editor.update(
      () => {
        $getRoot().clear().select();
        const dom = new DOMParser().parseFromString(
          '<figure type="page-break"></figure>',
          'text/html',
        );
        $insertNodes($generateNodesFromDOMViaExtension(dom));
      },
      {discrete: true},
    );
    editor.read(() => {
      const node = $findFirst($isPageBreakNode);
      assert(
        $isPageBreakNode(node),
        'expected a PageBreakNode from legacy <figure type="page-break">',
      );
    });
  });

  it('TweetNode', () => {
    expectRoundTrip(
      TwitterExtension,
      () => $createTweetNode('1234567890'),
      () => {
        const node = $findFirst($isTweetNode);
        assert($isTweetNode(node), 'expected a TweetNode');
        expect(node.getId()).toBe('1234567890');
      },
    );
  });

  it('YouTubeNode', () => {
    expectRoundTrip(
      YouTubeExtension,
      () => $createYouTubeNode('dQw4w9WgXcQ'),
      () => {
        const node = $findFirst($isYouTubeNode);
        assert($isYouTubeNode(node), 'expected a YouTubeNode');
        expect(node.getId()).toBe('dQw4w9WgXcQ');
      },
    );
  });

  // NOTE: ExcalidrawNode's importer is exercised by the e2e suite. It can't
  // be unit-tested here because importing ExcalidrawExtension pulls in the
  // `@excalidraw/excalidraw` UI bundle, which doesn't resolve under jsdom.
});
