/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {$createHeadingNode, RichTextExtension} from '@lexical/rich-text';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $selectAll,
  $setSelection,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

import {
  $assertNodeType,
  $createTestDecoratorNode,
  $createTestShadowRootNode,
  TestDecoratorNode,
  TestShadowRootNode,
} from '../utils';

const ext = defineExtension({
  dependencies: [RichTextExtension],
  name: '[8745]',
  nodes: [TestDecoratorNode, TestShadowRootNode],
});

describe('Select-all + delete with trailing shadow root (#8745)', () => {
  test('leaves one empty paragraph when document ends with a shadow root', () => {
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const p = $createParagraphNode();
        p.append($createTextNode('hello'));
        const shadow = $createTestShadowRootNode();
        const innerP = $createParagraphNode();
        innerP.append($createTextNode('shadow content'));
        shadow.append(innerP);
        $getRoot().clear().append(p, shadow);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $selectAll();
        selection.removeText();
      },
      {discrete: true},
    );

    editor.read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(1);
      expect(root.getFirstChild()?.getTextContent()).toBe('');
    });
  });

  test('leaves one empty paragraph with nested shadow roots', () => {
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const p = $createParagraphNode();
        p.append($createTextNode('hello'));
        const outer = $createTestShadowRootNode();
        const inner = $createTestShadowRootNode();
        const innerP = $createParagraphNode();
        innerP.append($createTextNode('nested content'));
        inner.append(innerP);
        outer.append(inner);
        $getRoot().clear().append(p, outer);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $selectAll();
        selection.removeText();
      },
      {discrete: true},
    );

    editor.read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(1);
      expect(root.getFirstChild()?.getTextContent()).toBe('');
    });
  });

  test('leaves one empty paragraph with multi-child shadow root (columns)', () => {
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const p = $createParagraphNode();
        p.append($createTextNode('hello'));
        const columns = $createTestShadowRootNode();
        const col1 = $createTestShadowRootNode();
        const col1P = $createParagraphNode();
        col1P.append($createTextNode('column 1'));
        col1.append(col1P);
        const col2 = $createTestShadowRootNode();
        const col2P = $createParagraphNode();
        col2P.append($createTextNode('column 2'));
        col2.append(col2P);
        columns.append(col1, col2);
        $getRoot().clear().append(p, columns);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $selectAll();
        selection.removeText();
      },
      {discrete: true},
    );

    editor.read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(1);
      expect(root.getFirstChild()?.getTextContent()).toBe('');
    });
  });

  test('preserves content after shadow root when shadow root is in the middle', () => {
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const p1 = $createParagraphNode();
        p1.append($createTextNode('before'));
        const shadow = $createTestShadowRootNode();
        const innerP = $createParagraphNode();
        innerP.append($createTextNode('shadow'));
        shadow.append(innerP);
        const p2 = $createParagraphNode();
        p2.append($createTextNode('after'));
        $getRoot().clear().append(p1, shadow, p2);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $selectAll();
        selection.removeText();
      },
      {discrete: true},
    );

    editor.read(() => {
      const root = $getRoot();
      // Shadow root is between two paragraphs — merge should work normally
      // because anchor and focus are both direct children of root
      expect(root.getChildrenSize()).toBe(1);
    });
  });

  test('deleteCharacter with select-all cleans up trailing shadow root', () => {
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const p = $createParagraphNode();
        p.append($createTextNode('hello'));
        const shadow = $createTestShadowRootNode();
        const innerP = $createParagraphNode();
        innerP.append($createTextNode('shadow content'));
        shadow.append(innerP);
        $getRoot().clear().append(p, shadow);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $selectAll();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.deleteCharacter(false);
      },
      {discrete: true},
    );

    editor.read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(1);
      expect(root.getFirstChild()?.getTextContent()).toBe('');
    });
  });

  test('heading first child + backward deleteCharacter: reproduces issue author scenario', () => {
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const h1 = $createHeadingNode('h1');
        h1.append($createTextNode('Welcome'));
        const p = $createParagraphNode();
        p.append($createTextNode('some text'));
        const shadow = $createTestShadowRootNode();
        const innerP = $createParagraphNode();
        innerP.append($createTextNode('shadow content'));
        shadow.append(innerP);
        $getRoot().clear().append(h1, p, shadow);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $selectAll();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.deleteCharacter(true);
      },
      {discrete: true},
    );

    editor.read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(1);
      expect(root.getFirstChild()?.getTextContent()).toBe('');
    });
  });

  test('paragraph first child + backward deleteCharacter: simple case', () => {
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const p = $createParagraphNode();
        p.append($createTextNode('hello'));
        const shadow = $createTestShadowRootNode();
        const innerP = $createParagraphNode();
        innerP.append($createTextNode('shadow content'));
        shadow.append(innerP);
        $getRoot().clear().append(p, shadow);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $selectAll();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.deleteCharacter(true);
      },
      {discrete: true},
    );

    editor.read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(1);
      expect(root.getFirstChild()?.getTextContent()).toBe('');
    });
  });

  test('HR + collapsible only: select-all delete leaves at least one child', () => {
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const hr = $createTestDecoratorNode().setIsInline(false);
        const container = $createTestShadowRootNode();
        const title = $createTestShadowRootNode();
        const titleP = $createParagraphNode();
        titleP.append($createTextNode('Title'));
        title.append(titleP);
        const content = $createTestShadowRootNode();
        const contentP = $createParagraphNode();
        contentP.append($createTextNode('Content'));
        content.append(contentP);
        container.append(title, content);
        $getRoot().clear().append(hr, container);
      },
      {discrete: true},
    );

    // Try both paths: RangeSelection and NodeSelection
    // Path 1: RangeSelection (Cmd+A produces this via $selectAll)
    editor.update(
      () => {
        const root = $getRoot();
        // Simulate what the browser does: element selection spanning all root children
        const selection = root.select(0, root.getChildrenSize());
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.deleteCharacter(true);
      },
      {discrete: true},
    );

    editor.read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBeGreaterThanOrEqual(1);
    });
  });

  test('select-all + forward deleteCharacter leaves at least one child', () => {
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const p = $createParagraphNode();
        p.append($createTextNode('hello'));
        const shadow = $createTestShadowRootNode();
        const innerP = $createParagraphNode();
        innerP.append($createTextNode('shadow'));
        shadow.append(innerP);
        $getRoot().clear().append(p, shadow);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $selectAll();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.deleteCharacter(false);
      },
      {discrete: true},
    );

    editor.read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBeGreaterThanOrEqual(1);
    });
  });

  test('select-all + removeText leaves at least one child', () => {
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const p = $createParagraphNode();
        p.append($createTextNode('hello'));
        const shadow = $createTestShadowRootNode();
        const innerP = $createParagraphNode();
        innerP.append($createTextNode('shadow'));
        shadow.append(innerP);
        $getRoot().clear().append(p, shadow);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $selectAll();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.removeText();
      },
      {discrete: true},
    );

    editor.read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBeGreaterThanOrEqual(1);
    });
  });

  test('NodeSelection.deleteNodes leaves at least one root child', () => {
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const hr = $createTestDecoratorNode().setIsInline(false);
        const shadow = $createTestShadowRootNode();
        const innerP = $createParagraphNode();
        innerP.append($createTextNode('shadow'));
        shadow.append(innerP);
        $getRoot().clear().append(hr, shadow);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const root = $getRoot();
        const selection = $createNodeSelection();
        for (const child of root.getChildren()) {
          selection.add(child.getKey());
        }
        $setSelection(selection);
        selection.deleteNodes();
      },
      {discrete: true},
    );

    editor.read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBeGreaterThanOrEqual(1);
    });
  });

  test('partial deletion within shadow root preserves structure', () => {
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const p = $createParagraphNode();
        p.append($createTextNode('before'));
        const container = $createTestShadowRootNode();
        const titleP = $createParagraphNode();
        titleP.append($createTextNode('title text'));
        const content = $createTestShadowRootNode();
        const contentP = $createParagraphNode();
        contentP.append($createTextNode('content text'));
        content.append(contentP);
        container.append(titleP, content);
        $getRoot().clear().append(p, container);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const root = $getRoot();
        const container = $assertNodeType(root.getLastChild(), $isElementNode);
        const titleP = $assertNodeType(
          container.getFirstChild(),
          $isElementNode,
        );
        const content = $assertNodeType(
          container.getLastChild(),
          $isElementNode,
        );
        const contentP = $assertNodeType(
          content.getFirstChild(),
          $isElementNode,
        );
        const titleText = $assertNodeType(titleP.getFirstChild(), $isTextNode);
        const contentText = $assertNodeType(
          contentP.getFirstChild(),
          $isTextNode,
        );
        const selection = titleText.select(5, 5);
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.setTextNodeRange(titleText, 5, contentText, 7);
        selection.removeText();
      },
      {discrete: true},
    );

    editor.read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(2);
      const container = $assertNodeType(root.getLastChild(), $isElementNode);
      expect(container.getChildrenSize()).toBe(2);
    });
  });

  test('shadow root only (no paragraph): select-all + removeText leaves at least one child', () => {
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const shadow = $createTestShadowRootNode();
        const innerP = $createParagraphNode();
        innerP.append($createTextNode('only shadow'));
        shadow.append(innerP);
        $getRoot().clear().append(shadow);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $selectAll();
        selection.removeText();
      },
      {discrete: true},
    );

    editor.read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBeGreaterThanOrEqual(1);
    });
  });

  test('shadow root only (no paragraph): select-all + backward deleteCharacter leaves at least one child', () => {
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const shadow = $createTestShadowRootNode();
        const innerP = $createParagraphNode();
        innerP.append($createTextNode('only shadow'));
        shadow.append(innerP);
        $getRoot().clear().append(shadow);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $selectAll();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.deleteCharacter(true);
      },
      {discrete: true},
    );

    editor.read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBeGreaterThanOrEqual(1);
    });
  });
});
