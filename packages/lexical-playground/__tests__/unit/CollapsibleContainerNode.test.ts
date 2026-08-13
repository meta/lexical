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
  $createTextNode,
  $getRoot,
  $insertNodes,
  $isDecoratorNode,
  $isParagraphNode,
  defineExtension,
} from 'lexical';
import {
  $createTestDecoratorNode,
  TestDecoratorNode,
} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, it} from 'vitest';

import {PlaygroundImportExtension} from '../../src/nodes/PlaygroundImportExtension';
import {CollapsibleExtension} from '../../src/plugins/CollapsibleExtension';
import {
  $createCollapsibleContainerNode,
  $isCollapsibleContainerNode,
} from '../../src/plugins/CollapsibleExtension/CollapsibleContainerNode';
import {
  $createCollapsibleContentNode,
  $isCollapsibleContentNode,
} from '../../src/plugins/CollapsibleExtension/CollapsibleContentNode';
import {
  $createCollapsibleTitleNode,
  $isCollapsibleTitleNode,
} from '../../src/plugins/CollapsibleExtension/CollapsibleTitleNode';

const CollapsibleImportTestExtension = defineExtension({
  $initialEditorState: null,
  dependencies: [CollapsibleExtension, PlaygroundImportExtension],
  name: '[test-collapsible-import]',
});

function $importHtml(html: string): void {
  const parser = new DOMParser();
  const dom = parser.parseFromString(html, 'text/html');
  $insertNodes($generateNodesFromDOMViaExtension(dom));
}

describe('CollapsibleContainerNode HTML import (issue #8407)', () => {
  describe('importDOM', () => {
    it('imports <details> with loose text body without crashing', () => {
      using editor = buildEditorFromExtensions(CollapsibleImportTestExtension);

      editor.update(
        () => {
          $getRoot().clear().select();
          $importHtml(
            '<details>\n' +
              '  <summary>Details</summary>\n' +
              '  Something small enough to escape casual notice.\n' +
              '</details>',
          );
          const container = $getRoot()
            .getChildren()
            .find($isCollapsibleContainerNode);
          assert(
            container != null,
            'CollapsibleContainerNode must be a child of RootNode',
          );
          const children = container.getChildren();
          expect(children.length).toBe(2);
          assert(
            $isCollapsibleTitleNode(children[0]),
            'First child must be CollapsibleTitleNode',
          );
          assert(
            $isCollapsibleContentNode(children[1]),
            'Second child must be CollapsibleContentNode',
          );
          expect(children[0].getTextContent()).toBe('Details');
          expect(children[1].getTextContent().trim()).toBe(
            'Something small enough to escape casual notice.',
          );
          // No `open` attribute on the source element should map to closed.
          expect(container.getOpen()).toBe(false);
        },
        {discrete: true},
      );
    });

    it('preserves the open attribute on import', () => {
      using editor = buildEditorFromExtensions(CollapsibleImportTestExtension);

      editor.update(
        () => {
          $getRoot().clear().select();
          $importHtml('<details open><summary>S</summary>body</details>');
          const container = $getRoot()
            .getChildren()
            .find($isCollapsibleContainerNode)!;
          expect(container.getOpen()).toBe(true);
        },
        {discrete: true},
      );
    });

    it('handles <summary> appearing after body content', () => {
      using editor = buildEditorFromExtensions(CollapsibleImportTestExtension);

      editor.update(
        () => {
          $getRoot().clear().select();
          $importHtml(
            '<details><p>Body before</p><summary>Title</summary></details>',
          );
          const container = $getRoot()
            .getChildren()
            .find($isCollapsibleContainerNode)!;
          const children = container.getChildren();
          expect(children.length).toBe(2);
          assert(
            $isCollapsibleTitleNode(children[0]),
            'First child must be CollapsibleTitleNode',
          );
          assert(
            $isCollapsibleContentNode(children[1]),
            'Second child must be CollapsibleContentNode',
          );
          expect(children[0].getTextContent()).toBe('Title');
          expect(children[1].getTextContent().trim()).toBe('Body before');
        },
        {discrete: true},
      );
    });

    it('imports <details> with no <summary> without crashing', () => {
      using editor = buildEditorFromExtensions(CollapsibleImportTestExtension);

      editor.update(
        () => {
          $getRoot().clear().select();
          $importHtml('<details>Just some loose text</details>');
          const container = $getRoot()
            .getChildren()
            .find($isCollapsibleContainerNode)!;
          // The importer always emits [Title, Content]; even when the
          // <summary> is missing, the synthesized empty Title still sits
          // here pre-transform. The crucial invariant is that no raw
          // TextNode sits directly under the shadow root.
          const children = container.getChildren();
          expect(children.length).toBe(2);
          assert(
            $isCollapsibleTitleNode(children[0]),
            'First child must be CollapsibleTitleNode',
          );
          assert(
            $isCollapsibleContentNode(children[1]),
            'Second child must be CollapsibleContentNode',
          );
          expect(children[0].isEmpty()).toBe(true);
          expect(children[1].getTextContent().trim()).toBe(
            'Just some loose text',
          );
        },
        {discrete: true},
      );
    });

    it('imports <details> with summary and block body siblings', () => {
      using editor = buildEditorFromExtensions(CollapsibleImportTestExtension);

      editor.update(
        () => {
          $getRoot().clear().select();
          $importHtml(
            '<details><summary>Title</summary><p>Para one.</p><p>Para two.</p></details>',
          );
          const container = $getRoot()
            .getChildren()
            .find($isCollapsibleContainerNode)!;
          const children = container.getChildren();
          expect(children.length).toBe(2);
          assert(
            $isCollapsibleTitleNode(children[0]),
            'First child must be CollapsibleTitleNode',
          );
          assert(
            $isCollapsibleContentNode(children[1]),
            'Second child must be CollapsibleContentNode',
          );
          expect(children[1].getChildren().length).toBe(2);
        },
        {discrete: true},
      );
    });

    it('imports <details> with element body (round-trip shape)', () => {
      using editor = buildEditorFromExtensions(CollapsibleImportTestExtension);

      editor.update(
        () => {
          $getRoot().clear().select();
          $importHtml(
            '<details open="true" class="Collapsible__container">' +
              '<summary class="Collapsible__title">Title</summary>' +
              '<div class="Collapsible__content" data-lexical-collapsible-content="true">' +
              '<p>Body</p>' +
              '</div>' +
              '</details>',
          );
          const container = $getRoot()
            .getChildren()
            .find($isCollapsibleContainerNode)!;
          const children = container.getChildren();
          expect(children.length).toBe(2);
          assert(
            $isCollapsibleTitleNode(children[0]),
            'First child must be CollapsibleTitleNode',
          );
          assert(
            $isCollapsibleContentNode(children[1]),
            'Second child must be CollapsibleContentNode',
          );
        },
        {discrete: true},
      );
    });
  });

  describe('importDOM + transforms', () => {
    it('well-formed <details> survives transforms intact', () => {
      using editor = buildEditorFromExtensions(CollapsibleImportTestExtension);

      editor.update(
        () => {
          $getRoot().clear().select();
          $importHtml(
            '<details open><summary>Title</summary><p>Body</p></details>',
          );
        },
        {discrete: true},
      );

      editor.read(() => {
        const container = $getRoot().getFirstChildOrThrow();
        assert($isCollapsibleContainerNode(container));
        expect(container.getOpen()).toBe(true);
        const [title, content] = container.getChildren();
        assert($isCollapsibleTitleNode(title));
        assert($isCollapsibleContentNode(content));
        expect(title.getTextContent()).toBe('Title');
        expect(content.getTextContent()).toBe('Body');
      });
    });

    it('missing <summary> unwraps to bare paragraphs after transforms', () => {
      using editor = buildEditorFromExtensions(CollapsibleImportTestExtension);

      editor.update(
        () => {
          $getRoot().clear().select();
          $importHtml('<details>Just some loose text</details>');
        },
        {discrete: true},
      );

      // After transforms: the empty Title is removed by its $transform,
      // then the resulting 1-child Container is unwrapped by
      // CollapsibleExtension, and the orphaned Content is unwrapped
      // again because its parent is no longer a Container — leaving the
      // body paragraph at the root.
      editor.read(() => {
        const root = $getRoot();
        expect(root.getChildren().some($isCollapsibleContainerNode)).toBe(
          false,
        );
        expect(root.getTextContent().trim()).toBe('Just some loose text');
        const first = root.getFirstChildOrThrow();
        assert($isParagraphNode(first));
      });
    });
  });
});

describe('CollapsibleExtension transforms', () => {
  const TestDecoratorExtension = defineExtension({
    name: 'TestDecorator',
    nodes: [TestDecoratorNode],
  });

  it('wraps inline content children in paragraphs', () => {
    using editor = buildEditorFromExtensions(CollapsibleExtension);

    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createCollapsibleContainerNode(true).append(
              $createCollapsibleTitleNode().append(
                $createParagraphNode().append($createTextNode('Title')),
              ),
              $createCollapsibleContentNode().append($createTextNode('Body')),
            ),
          );
      },
      {discrete: true},
    );

    editor.read(() => {
      const container = $getRoot().getFirstChildOrThrow();
      assert($isCollapsibleContainerNode(container));
      const content = container.getLastChildOrThrow();
      assert($isCollapsibleContentNode(content));
      const child = content.getFirstChildOrThrow();
      assert($isParagraphNode(child));
      expect(child.getTextContent()).toBe('Body');
    });
  });

  it('adds a paragraph to empty content loaded from serialized state', () => {
    using editor = buildEditorFromExtensions(CollapsibleExtension);

    const state = editor.parseEditorState(
      JSON.stringify({
        root: {
          children: [
            {
              children: [
                {
                  children: [
                    {
                      children: [
                        {
                          detail: 0,
                          format: 0,
                          mode: 'normal',
                          style: '',
                          text: 'Title',
                          type: 'text',
                          version: 1,
                        },
                      ],
                      direction: null,
                      format: '',
                      indent: 0,
                      textFormat: 0,
                      textStyle: '',
                      type: 'paragraph',
                      version: 1,
                    },
                  ],
                  direction: null,
                  format: '',
                  indent: 0,
                  type: 'collapsible-title',
                  version: 1,
                },
                {
                  children: [],
                  direction: null,
                  format: '',
                  indent: 0,
                  type: 'collapsible-content',
                  version: 1,
                },
              ],
              direction: null,
              format: '',
              indent: 0,
              open: true,
              type: 'collapsible-container',
              version: 1,
            },
          ],
          direction: null,
          format: '',
          indent: 0,
          type: 'root',
          version: 1,
        },
      }),
    );

    editor.setEditorState(state);
    editor.update(
      () => {
        const container = $getRoot().getFirstChildOrThrow();
        assert($isCollapsibleContainerNode(container));
        const content = container.getLastChildOrThrow();
        assert($isCollapsibleContentNode(content));
        content.markDirty();
      },
      {discrete: true},
    );

    editor.read(() => {
      const container = $getRoot().getFirstChildOrThrow();
      assert($isCollapsibleContainerNode(container));
      const content = container.getLastChildOrThrow();
      assert($isCollapsibleContentNode(content));
      expect($isParagraphNode(content.getFirstChild())).toBe(true);
    });
  });

  it('leaves block decorator content children unwrapped', () => {
    using editor = buildEditorFromExtensions(
      CollapsibleExtension,
      TestDecoratorExtension,
    );

    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createCollapsibleContainerNode(true).append(
              $createCollapsibleTitleNode().append(
                $createParagraphNode().append($createTextNode('Title')),
              ),
              $createCollapsibleContentNode().append(
                $createTextNode('Before'),
                $createTestDecoratorNode().setIsInline(false),
                $createTestDecoratorNode(),
              ),
            ),
          );
      },
      {discrete: true},
    );

    editor.read(() => {
      const container = $getRoot().getFirstChildOrThrow();
      assert($isCollapsibleContainerNode(container));
      const content = container.getLastChildOrThrow();
      assert($isCollapsibleContentNode(content));
      const children = content.getChildren();

      expect($isParagraphNode(children[0])).toBe(true);
      expect($isDecoratorNode(children[1]) && !children[1].isInline()).toBe(
        true,
      );
      expect($isParagraphNode(children[2])).toBe(true);
    });
  });
});

describe('CollapsibleContainerNode open round trip', () => {
  function buildEditor() {
    return buildEditorFromExtensions(CollapsibleImportTestExtension);
  }

  function $seed(open: boolean): void {
    $getRoot()
      .clear()
      .append(
        $createCollapsibleContainerNode(open).append(
          $createCollapsibleTitleNode().append($createTextNode('Title')),
          $createCollapsibleContentNode().append(
            $createParagraphNode().append($createTextNode('Body')),
          ),
        ),
      );
  }

  function $getContainerOpen(): boolean {
    const container = $getRoot().getFirstChild();
    assert($isCollapsibleContainerNode(container), 'expected a container');
    return container.getOpen();
  }

  it.each([true, false])('round-trips open=%s through HTML', open => {
    using editor = buildEditor();
    editor.update(() => $seed(open), {discrete: true});

    const html = editor.read(() => $generateHtmlFromNodes(editor, null));

    using target = buildEditor();
    target.update(
      () => {
        $getRoot().clear().select();
        $importHtml(html);
      },
      {discrete: true},
    );

    expect(target.read($getContainerOpen)).toBe(open);
  });

  it('does not write a value for the boolean open attribute', () => {
    using editor = buildEditor();
    editor.update(() => $seed(false), {discrete: true});

    const html = editor.read(() => $generateHtmlFromNodes(editor, null));
    // `open` is an HTML boolean attribute: any value, including "false",
    // means open. A closed container must omit it entirely.
    expect(html).not.toContain('open=');
  });
});
