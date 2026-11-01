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
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setCompositionKey,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  type ElementNode,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_BACKSPACE_COMMAND,
  type LexicalEditor,
} from 'lexical';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import {RubyExtension} from '../../plugins/RubyExtension';
import {
  $createRubyNode,
  $isRubyNode,
  $toggleRuby,
} from '../../plugins/RubyExtension/RubyNode';

function $getFirstParagraph(): ElementNode {
  const first = $getRoot().getFirstChild();
  if (!$isElementNode(first)) {
    throw new Error('Expected ElementNode');
  }
  return first;
}

describe('RubyNode', () => {
  let container: HTMLDivElement;
  let editor: LexicalEditor;

  beforeEach(() => {
    container = document.createElement('div');
    container.setAttribute('data-lexical-editor', 'true');
    container.contentEditable = 'true';
    document.body.appendChild(container);
    editor = buildEditorFromExtensions({
      dependencies: [RichTextExtension, RubyExtension],
      name: 'ruby-node-test',
      onError: e => {
        throw e;
      },
    });
    editor.setRootElement(container);
  });

  afterEach(() => {
    editor.setRootElement(null);
    document.body.removeChild(container);
  });

  describe('$createRubyNode', () => {
    test('creates node with correct text and annotation', () => {
      editor.update(
        () => {
          const ruby = $createRubyNode('漢', 'かん');
          $getRoot().clear().append($createParagraphNode().append(ruby));
        },
        {discrete: true},
      );

      const result = editor.read(() => {
        const ruby = $getFirstParagraph().getChildAtIndex(0);
        if (!$isRubyNode(ruby)) {
          throw new Error('Expected RubyNode');
        }
        return {
          annotation: ruby.getAnnotation(),
          isToken: ruby.isToken(),
          text: ruby.getTextContent(),
          type: ruby.getType(),
        };
      });

      expect(result.type).toBe('ruby');
      expect(result.text).toBe('漢');
      expect(result.annotation).toBe('かん');
      expect(result.isToken).toBe(true);
    });
  });

  describe('$isRubyNode', () => {
    test('returns true for RubyNode', () => {
      editor.update(
        () => {
          const ruby = $createRubyNode('字', 'じ');
          $getRoot().clear().append($createParagraphNode().append(ruby));
        },
        {discrete: true},
      );
      const result = editor.read(() =>
        $isRubyNode($getFirstParagraph().getChildAtIndex(0)),
      );
      expect(result).toBe(true);
    });

    test('returns false for TextNode', () => {
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode('hello')));
        },
        {discrete: true},
      );
      const result = editor.read(() =>
        $isRubyNode($getFirstParagraph().getChildAtIndex(0)),
      );
      expect(result).toBe(false);
    });

    test('returns false for null/undefined', () => {
      expect($isRubyNode(null)).toBe(false);
      expect($isRubyNode(undefined)).toBe(false);
    });
  });

  describe('serialization', () => {
    test('importJSON/exportJSON round-trip preserves text and annotation', () => {
      editor.update(
        () => {
          const ruby = $createRubyNode('漢字', 'かんじ');
          $getRoot().clear().append($createParagraphNode().append(ruby));
        },
        {discrete: true},
      );

      const json = editor.getEditorState().toJSON();
      expect(json).toMatchObject({
        root: {
          children: [
            {
              children: [{annotation: 'かんじ', text: '漢字', type: 'ruby'}],
            },
          ],
        },
      });

      const editor2 = buildEditorFromExtensions({
        dependencies: [RubyExtension],
        name: 'ruby-parse-test',
        onError: e => {
          throw e;
        },
      });
      const state2 = editor2.parseEditorState(json);

      const result = state2.read(() => {
        const paragraph = $getFirstParagraph();
        const children = paragraph.getChildren();
        const ruby = children.find($isRubyNode);
        return ruby
          ? {annotation: ruby.getAnnotation(), text: ruby.getTextContent()}
          : null;
      });

      expect(result).toEqual({annotation: 'かんじ', text: '漢字'});
    });
  });

  describe('exportDOM', () => {
    test('produces <ruby>text<rp>(<rp><rt>annotation</rt><rp>)</rp></ruby>', () => {
      editor.update(
        () => {
          const ruby = $createRubyNode('漢字', 'かんじ');
          $getRoot().clear().append($createParagraphNode().append(ruby));
        },
        {discrete: true},
      );

      editor.read(() => {
        const paragraph = $getFirstParagraph();
        const ruby = paragraph.getChildren().find($isRubyNode)!;
        const {element} = ruby.exportDOM();

        expect(element).not.toBeNull();
        const el = element as HTMLElement;
        expect(el.outerHTML).toBe(
          '<ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>',
        );
        expect(el.tagName).toBe('RUBY');
        expect(el.childNodes.length).toBe(4);
        expect(el.childNodes[0].textContent).toBe('漢字');
        expect((el.childNodes[1] as HTMLElement).tagName).toBe('RP');
        expect(el.childNodes[1].textContent).toBe('(');
        expect((el.childNodes[2] as HTMLElement).tagName).toBe('RT');
        expect(el.childNodes[2].textContent).toBe('かんじ');
        expect((el.childNodes[3] as HTMLElement).tagName).toBe('RP');
        expect(el.childNodes[3].textContent).toBe(')');
      });
    });
  });

  describe('createDOM', () => {
    test('produces wrapper span > inner span with data-ruby-annotation', () => {
      editor.update(
        () => {
          const ruby = $createRubyNode('漢', 'かん');
          $getRoot().clear().append($createParagraphNode().append(ruby));
        },
        {discrete: true},
      );

      editor.read(() => {
        const paragraph = $getFirstParagraph();
        const ruby = paragraph.getChildren().find($isRubyNode)!;
        const key = ruby.getKey();
        const dom = editor.getElementByKey(key)!;

        expect(dom.tagName).toBe('SPAN');
        const inner = dom.firstElementChild as HTMLElement;
        expect(inner).not.toBeNull();
        expect(inner.tagName).toBe('SPAN');
        expect(inner.dataset.rubyAnnotation).toBe('かん');
      });
    });
  });

  describe('getDOMSlot', () => {
    test('returns slot pointing to inner element', () => {
      editor.update(
        () => {
          const ruby = $createRubyNode('漢', 'かん');
          $getRoot().clear().append($createParagraphNode().append(ruby));
        },
        {discrete: true},
      );

      editor.read(() => {
        const paragraph = $getFirstParagraph();
        const ruby = paragraph.getChildren().find($isRubyNode)!;
        const key = ruby.getKey();
        const dom = editor.getElementByKey(key)!;
        const slot = ruby.getDOMSlot(dom);
        const inner = dom.firstElementChild as HTMLElement;
        expect(slot.element).toBe(inner);
      });
    });
  });

  describe('$toggleRuby', () => {
    test('with annotation on selection creates RubyNode', () => {
      editor.update(
        () => {
          const text = $createTextNode('漢字');
          const paragraph = $createParagraphNode().append(text);
          $getRoot().clear().append(paragraph);

          text.select(0, 2);

          $toggleRuby('かんじ');
        },
        {discrete: true},
      );

      const result = editor.read(() => {
        const paragraph = $getFirstParagraph();
        const children = paragraph.getChildren();
        const ruby = children.find($isRubyNode);
        if (!ruby) {
          return null;
        }
        return {
          annotation: ruby.getAnnotation(),
          text: ruby.getTextContent(),
        };
      });

      expect(result).toEqual({annotation: 'かんじ', text: '漢字'});
    });

    test('with null unwraps RubyNode back to TextNode', () => {
      editor.update(
        () => {
          const ruby = $createRubyNode('漢字', 'かんじ');
          const paragraph = $createParagraphNode().append(ruby);
          $getRoot().clear().append(paragraph);

          ruby.select(0, 2);

          $toggleRuby(null);
        },
        {discrete: true},
      );

      const result = editor.read(() => {
        const paragraph = $getFirstParagraph();
        const children = paragraph.getChildren();
        const hasRuby = children.some($isRubyNode);
        const hasText = children.some(
          c =>
            $isTextNode(c) && !$isRubyNode(c) && c.getTextContent() === '漢字',
        );
        return {hasRuby, hasText};
      });

      expect(result.hasRuby).toBe(false);
      expect(result.hasText).toBe(true);
    });

    test('on collapsed selection is no-op', () => {
      editor.update(
        () => {
          const text = $createTextNode('漢字');
          const paragraph = $createParagraphNode().append(text);
          $getRoot().clear().append(paragraph);

          text.select(1, 1);

          $toggleRuby('かんじ');
        },
        {discrete: true},
      );

      const result = editor.read(() => {
        const paragraph = $getFirstParagraph();
        const children = paragraph.getChildren();
        return {
          hasRuby: children.some($isRubyNode),
          textContent: paragraph.getTextContent(),
        };
      });

      expect(result.hasRuby).toBe(false);
      expect(result.textContent).toBe('漢字');
    });

    test('preserves format and style from source text', () => {
      editor.update(
        () => {
          const text = $createTextNode('漢字');
          text.toggleFormat('bold');
          text.setStyle('color: red');
          const paragraph = $createParagraphNode().append(text);
          $getRoot().clear().append(paragraph);
          text.select(0, 2);
          $toggleRuby('かんじ');
        },
        {discrete: true},
      );

      const result = editor.read(() => {
        const ruby = $getFirstParagraph().getChildren().find($isRubyNode);
        if (!ruby) {
          return null;
        }
        return {
          isBold: ruby.hasFormat('bold'),
          style: ruby.getStyle(),
        };
      });

      expect(result).toEqual({isBold: true, style: 'color: red'});
    });

    test('unwrap preserves format and style on resulting TextNode', () => {
      editor.update(
        () => {
          const ruby = $createRubyNode('漢字', 'かんじ');
          ruby.toggleFormat('bold');
          ruby.setStyle('color: red');
          const paragraph = $createParagraphNode().append(ruby);
          $getRoot().clear().append(paragraph);
          ruby.select(0, 2);
          $toggleRuby(null);
        },
        {discrete: true},
      );

      const result = editor.read(() => {
        const child = $getFirstParagraph().getFirstChild();
        if (!$isTextNode(child) || $isRubyNode(child)) {
          return null;
        }
        return {
          isBold: child.hasFormat('bold'),
          style: child.getStyle(),
        };
      });

      expect(result).toEqual({isBold: true, style: 'color: red'});
    });
  });

  describe('$unwrapRubiesInSelection', () => {
    let extensionCleanup: () => void;

    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extensionCleanup = (RubyExtension as any).register(editor);
    });

    afterEach(() => {
      extensionCleanup();
    });

    test('typing over selection that includes rubies unwraps them', () => {
      let rubyKey = '';
      let postKey = '';

      editor.update(
        () => {
          const pre = $createTextNode('前');
          const ruby = $createRubyNode('漢字', 'かんじ');
          const post = $createTextNode('後');
          const paragraph = $createParagraphNode().append(pre, ruby, post);
          $getRoot().clear().append(paragraph);
          rubyKey = ruby.getKey();
          postKey = post.getKey();
        },
        {discrete: true},
      );

      // Select the ruby + part of post text
      editor.update(
        () => {
          const rubyNode = $getNodeByKey(rubyKey);
          if (!$isRubyNode(rubyNode)) {
            throw new Error('Expected RubyNode');
          }
          const sel = rubyNode.select(0, 0);
          sel.focus.set(postKey, 1, 'text');
        },
        {discrete: true},
      );

      // Dispatch CONTROLLED_TEXT_INSERTION_COMMAND (simulates typing)
      editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, 'X');

      // After the command, rubies in selection should be unwrapped
      const result = editor.read(() => {
        const paragraph = $getFirstParagraph();
        const children = paragraph.getChildren();
        return {
          hasRuby: children.some($isRubyNode),
          textContent: paragraph.getTextContent(),
        };
      });

      expect(result.hasRuby).toBe(false);
    });

    test('collapsed selection does not unwrap rubies', () => {
      editor.update(
        () => {
          const pre = $createTextNode('前');
          const ruby = $createRubyNode('漢字', 'かんじ');
          const post = $createTextNode('後');
          const paragraph = $createParagraphNode().append(pre, ruby, post);
          $getRoot().clear().append(paragraph);
        },
        {discrete: true},
      );

      let rubyKey = '';
      editor.read(() => {
        const paragraph = $getFirstParagraph();
        const ruby = paragraph.getChildren().find($isRubyNode)!;
        rubyKey = ruby.getKey();
      });

      editor.update(
        () => {
          const rubyNode = $getNodeByKey(rubyKey);
          if (!$isRubyNode(rubyNode)) {
            throw new Error('Expected RubyNode');
          }
          rubyNode.select(0, 0);
        },
        {discrete: true},
      );

      editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, 'X');

      const hasRuby = editor.read(() => {
        const paragraph = $getFirstParagraph();
        return paragraph.getChildren().some($isRubyNode);
      });

      expect(hasRuby).toBe(true);
    });
  });

  describe('token mode', () => {
    test('canInsertTextBefore returns false', () => {
      editor.update(
        () => {
          const ruby = $createRubyNode('漢', 'かん');
          $getRoot().clear().append($createParagraphNode().append(ruby));
        },
        {discrete: true},
      );
      const result = editor.read(() => {
        const ruby = $getFirstParagraph().getChildAtIndex(0)!;
        return $isTextNode(ruby) ? ruby.canInsertTextBefore() : null;
      });
      expect(result).toBe(false);
    });

    test('canInsertTextAfter returns false', () => {
      editor.update(
        () => {
          const ruby = $createRubyNode('漢', 'かん');
          $getRoot().clear().append($createParagraphNode().append(ruby));
        },
        {discrete: true},
      );
      const result = editor.read(() => {
        const ruby = $getFirstParagraph().getChildAtIndex(0)!;
        return $isTextNode(ruby) ? ruby.canInsertTextAfter() : null;
      });
      expect(result).toBe(false);
    });
  });
});

describe('RubyExtension Shift+arrow skip', () => {
  let container: HTMLDivElement;
  let extEditor: LexicalEditor;

  beforeEach(() => {
    container = document.createElement('div');
    container.setAttribute('data-lexical-editor', 'true');
    container.contentEditable = 'true';
    document.body.appendChild(container);
    extEditor = buildEditorFromExtensions({
      dependencies: [RichTextExtension, RubyExtension],
      name: 'ruby-shift-arrow-test',
      onError: e => {
        throw e;
      },
    });
    extEditor.setRootElement(container);
  });

  afterEach(() => {
    extEditor.setRootElement(null);
    document.body.removeChild(container);
  });

  function $setupParagraph() {
    const p = $createParagraphNode();
    const hello = $createTextNode('hello');
    const ruby = $createRubyNode('漢', 'かん');
    const world = $createTextNode('world');
    p.append(hello, ruby, world);
    $getRoot().clear().append(p);
    return {hello, ruby, world};
  }

  test('Shift+Right from collapsed cursor at text end jumps past ruby', () => {
    extEditor.update(
      () => {
        const {hello} = $setupParagraph();
        hello.select(5, 5);
      },
      {discrete: true},
    );

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      shiftKey: true,
    });
    const handled = extEditor.dispatchCommand(KEY_ARROW_RIGHT_COMMAND, event);

    const result = extEditor.read(() => {
      const sel = $getSelection();
      if ($isRangeSelection(sel)) {
        return {
          anchorKey: sel.anchor.getNode().getTextContent(),
          anchorOffset: sel.anchor.offset,
          focusKey: sel.focus.getNode().getTextContent(),
          focusOffset: sel.focus.offset,
        };
      }
      return null;
    });

    expect(handled).toBe(true);
    expect(result!.anchorKey).toBe('hello');
    expect(result!.anchorOffset).toBe(5);
    expect(result!.focusKey).toBe('world');
    expect(result!.focusOffset).toBe(0);
  });

  test('Shift+Left from collapsed cursor at text start jumps past ruby', () => {
    extEditor.update(
      () => {
        const {world} = $setupParagraph();
        world.select(0, 0);
      },
      {discrete: true},
    );

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      shiftKey: true,
    });
    const handled = extEditor.dispatchCommand(KEY_ARROW_LEFT_COMMAND, event);

    const result = extEditor.read(() => {
      const sel = $getSelection();
      if ($isRangeSelection(sel)) {
        return {
          focusKey: sel.focus.getNode().getTextContent(),
          focusOffset: sel.focus.offset,
        };
      }
      return null;
    });

    expect(handled).toBe(true);
    expect(result!.focusKey).toBe('hello');
    expect(result!.focusOffset).toBe(5);
  });

  test('Shift+Right extends existing selection past ruby', () => {
    extEditor.update(
      () => {
        const {hello} = $setupParagraph();
        hello.select(3, 5);
      },
      {discrete: true},
    );

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      shiftKey: true,
    });
    extEditor.dispatchCommand(KEY_ARROW_RIGHT_COMMAND, event);

    const result = extEditor.read(() => {
      const sel = $getSelection();
      if ($isRangeSelection(sel)) {
        return {
          focusKey: sel.focus.getNode().getTextContent(),
          focusOffset: sel.focus.offset,
        };
      }
      return null;
    });

    expect(result!.focusKey).toBe('world');
    expect(result!.focusOffset).toBe(0);
  });
});

describe('RubyExtension Shift+arrow — consecutive rubies', () => {
  let container: HTMLDivElement;
  let extEditor: LexicalEditor;

  beforeEach(() => {
    container = document.createElement('div');
    container.setAttribute('data-lexical-editor', 'true');
    container.contentEditable = 'true';
    document.body.appendChild(container);
    extEditor = buildEditorFromExtensions({
      dependencies: [RichTextExtension, RubyExtension],
      name: 'ruby-consecutive-test',
      onError: e => {
        throw e;
      },
    });
    extEditor.setRootElement(container);
  });

  afterEach(() => {
    extEditor.setRootElement(null);
    document.body.removeChild(container);
  });

  function $setupConsecutiveRubies() {
    const p = $createParagraphNode();
    const pre = $createTextNode('前');
    const ruby1 = $createRubyNode('漢', 'かん');
    const ruby2 = $createRubyNode('字', 'じ');
    const post = $createTextNode('後');
    p.append(pre, ruby1, ruby2, post);
    $getRoot().clear().append(p);
    return {post, pre, ruby1, ruby2};
  }

  test('Shift+Right from text end skips consecutive rubies to next text', () => {
    extEditor.update(
      () => {
        const {pre} = $setupConsecutiveRubies();
        pre.select(1, 1);
      },
      {discrete: true},
    );

    extEditor.dispatchCommand(
      KEY_ARROW_RIGHT_COMMAND,
      new KeyboardEvent('keydown', {key: 'ArrowRight', shiftKey: true}),
    );

    const result = extEditor.read(() => {
      const sel = $getSelection();
      return $isRangeSelection(sel)
        ? {key: sel.focus.getNode().getTextContent(), offset: sel.focus.offset}
        : null;
    });

    expect(result!.key).toBe('後');
    expect(result!.offset).toBe(0);
  });

  test('Shift+Left from text start skips consecutive rubies to prev text', () => {
    extEditor.update(
      () => {
        const {post} = $setupConsecutiveRubies();
        post.select(0, 0);
      },
      {discrete: true},
    );

    extEditor.dispatchCommand(
      KEY_ARROW_LEFT_COMMAND,
      new KeyboardEvent('keydown', {key: 'ArrowLeft', shiftKey: true}),
    );

    const result = extEditor.read(() => {
      const sel = $getSelection();
      return $isRangeSelection(sel)
        ? {key: sel.focus.getNode().getTextContent(), offset: sel.focus.offset}
        : null;
    });

    expect(result!.key).toBe('前');
    expect(result!.offset).toBe(1);
  });

  test('Shift+Right extends existing forward selection past consecutive rubies', () => {
    extEditor.update(
      () => {
        const {pre} = $setupConsecutiveRubies();
        pre.select(0, 1);
      },
      {discrete: true},
    );

    extEditor.dispatchCommand(
      KEY_ARROW_RIGHT_COMMAND,
      new KeyboardEvent('keydown', {key: 'ArrowRight', shiftKey: true}),
    );

    const result = extEditor.read(() => {
      const sel = $getSelection();
      return $isRangeSelection(sel)
        ? {key: sel.focus.getNode().getTextContent(), offset: sel.focus.offset}
        : null;
    });

    expect(result!.key).toBe('後');
    expect(result!.offset).toBe(0);
  });

  test('Shift+Left extends existing backward selection past consecutive rubies', () => {
    extEditor.update(
      () => {
        const {post} = $setupConsecutiveRubies();
        post.select(1, 0);
      },
      {discrete: true},
    );

    extEditor.dispatchCommand(
      KEY_ARROW_LEFT_COMMAND,
      new KeyboardEvent('keydown', {key: 'ArrowLeft', shiftKey: true}),
    );

    const result = extEditor.read(() => {
      const sel = $getSelection();
      return $isRangeSelection(sel)
        ? {key: sel.focus.getNode().getTextContent(), offset: sel.focus.offset}
        : null;
    });

    expect(result!.key).toBe('前');
    expect(result!.offset).toBe(1);
  });
});

// Safari normalizes cursor positions at text boundaries onto the preceding
// sibling, so focus can land on a RubyNode.
describe('RubyExtension Shift+arrow — focus on RubyNode (Safari)', () => {
  let container: HTMLDivElement;
  let extEditor: LexicalEditor;

  beforeEach(() => {
    container = document.createElement('div');
    container.setAttribute('data-lexical-editor', 'true');
    container.contentEditable = 'true';
    document.body.appendChild(container);
    extEditor = buildEditorFromExtensions({
      dependencies: [RichTextExtension, RubyExtension],
      name: 'ruby-safari-test',
      onError: e => {
        throw e;
      },
    });
    extEditor.setRootElement(container);
  });

  afterEach(() => {
    extEditor.setRootElement(null);
    document.body.removeChild(container);
  });

  function $setupConsecutiveRubies() {
    const p = $createParagraphNode();
    const pre = $createTextNode('前');
    const ruby1 = $createRubyNode('漢', 'かん');
    const ruby2 = $createRubyNode('字', 'じ');
    const post = $createTextNode('後');
    p.append(pre, ruby1, ruby2, post);
    $getRoot().clear().append(p);
    return {post, pre, ruby1, ruby2};
  }

  test('Shift+Right with focus on first ruby walks forward past all rubies', () => {
    extEditor.update(
      () => {
        const {pre, ruby1} = $setupConsecutiveRubies();
        const sel = pre.select(0, 0);
        sel.focus.set(ruby1.getKey(), 0, 'text');
      },
      {discrete: true},
    );

    extEditor.dispatchCommand(
      KEY_ARROW_RIGHT_COMMAND,
      new KeyboardEvent('keydown', {key: 'ArrowRight', shiftKey: true}),
    );

    const result = extEditor.read(() => {
      const sel = $getSelection();
      return $isRangeSelection(sel)
        ? {key: sel.focus.getNode().getTextContent(), offset: sel.focus.offset}
        : null;
    });

    expect(result!.key).toBe('後');
    expect(result!.offset).toBeGreaterThanOrEqual(0);
    expect(result!.offset).toBeLessThanOrEqual(1);
  });

  test('Shift+Left with focus on last ruby walks backward past all rubies', () => {
    extEditor.update(
      () => {
        const {ruby2, post} = $setupConsecutiveRubies();
        const sel = post.select(1, 1);
        sel.focus.set(ruby2.getKey(), 1, 'text');
      },
      {discrete: true},
    );

    extEditor.dispatchCommand(
      KEY_ARROW_LEFT_COMMAND,
      new KeyboardEvent('keydown', {key: 'ArrowLeft', shiftKey: true}),
    );

    const result = extEditor.read(() => {
      const sel = $getSelection();
      return $isRangeSelection(sel)
        ? {key: sel.focus.getNode().getTextContent(), offset: sel.focus.offset}
        : null;
    });

    expect(result!.key).toBe('前');
    expect(result!.offset).toBe(1);
  });

  test('Shift+Right from ruby uses safe offset (≥1) to avoid normalization bounce', () => {
    extEditor.update(
      () => {
        const {pre, ruby1} = $setupConsecutiveRubies();
        const sel = pre.select(0, 0);
        sel.focus.set(ruby1.getKey(), 1, 'text');
      },
      {discrete: true},
    );

    extEditor.dispatchCommand(
      KEY_ARROW_RIGHT_COMMAND,
      new KeyboardEvent('keydown', {key: 'ArrowRight', shiftKey: true}),
    );

    const focusOffset = extEditor.read(() => {
      const sel = $getSelection();
      return $isRangeSelection(sel) ? sel.focus.offset : -1;
    });

    expect(focusOffset).toBeGreaterThanOrEqual(0);
    expect(focusOffset).toBeLessThanOrEqual(1);
  });

  test('composing ruby is skipped — Shift+arrow returns false', () => {
    extEditor.update(
      () => {
        const {pre, ruby1} = $setupConsecutiveRubies();
        const sel = pre.select(0, 0);
        sel.focus.set(ruby1.getKey(), 0, 'text');
        $setCompositionKey(ruby1.getKey());
      },
      {discrete: true},
    );

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      shiftKey: true,
    });
    const handled = extEditor.dispatchCommand(KEY_ARROW_RIGHT_COMMAND, event);

    expect(handled).toBe(false);
  });
});

// Without parent-boundary fallback, cursor gets stuck at ruby with no adjacent text.
describe('RubyExtension arrow — line boundary', () => {
  let container: HTMLDivElement;
  let extEditor: LexicalEditor;

  beforeEach(() => {
    container = document.createElement('div');
    container.setAttribute('data-lexical-editor', 'true');
    container.contentEditable = 'true';
    document.body.appendChild(container);
    extEditor = buildEditorFromExtensions({
      dependencies: [RichTextExtension, RubyExtension],
      name: 'ruby-boundary-test',
      onError: e => {
        throw e;
      },
    });
    extEditor.setRootElement(container);
  });

  afterEach(() => {
    extEditor.setRootElement(null);
    document.body.removeChild(container);
  });

  test('Left from text:0 when ruby is first child moves to parent element', () => {
    extEditor.update(
      () => {
        const p = $createParagraphNode();
        const ruby = $createRubyNode('漢', 'かん');
        const post = $createTextNode('後');
        p.append(ruby, post);
        $getRoot().clear().append(p);
        post.select(0, 0);
      },
      {discrete: true},
    );

    const handled = extEditor.dispatchCommand(
      KEY_ARROW_LEFT_COMMAND,
      new KeyboardEvent('keydown', {key: 'ArrowLeft'}),
    );

    const result = extEditor.read(() => {
      const sel = $getSelection();
      return $isRangeSelection(sel)
        ? {offset: sel.anchor.offset, type: sel.anchor.type}
        : null;
    });

    expect(handled).toBe(true);
    expect(result!.type).toBe('element');
    expect(result!.offset).toBe(0);
  });

  test('Right from text end when ruby is last child moves to parent element', () => {
    extEditor.update(
      () => {
        const p = $createParagraphNode();
        const pre = $createTextNode('前');
        const ruby = $createRubyNode('漢', 'かん');
        p.append(pre, ruby);
        $getRoot().clear().append(p);
        pre.select(1, 1);
      },
      {discrete: true},
    );

    const handled = extEditor.dispatchCommand(
      KEY_ARROW_RIGHT_COMMAND,
      new KeyboardEvent('keydown', {key: 'ArrowRight'}),
    );

    const anchorType = extEditor.read(() => {
      const sel = $getSelection();
      return $isRangeSelection(sel) ? sel.anchor.type : '';
    });

    expect(handled).toBe(true);
    expect(anchorType).toBe('element');
  });

  test('Shift+Left at paragraph start (ruby first) moves focus to parent:0', () => {
    extEditor.update(
      () => {
        const p = $createParagraphNode();
        const ruby = $createRubyNode('漢', 'かん');
        const post = $createTextNode('後');
        p.append(ruby, post);
        $getRoot().clear().append(p);
        post.select(0, 0);
      },
      {discrete: true},
    );

    const handled = extEditor.dispatchCommand(
      KEY_ARROW_LEFT_COMMAND,
      new KeyboardEvent('keydown', {key: 'ArrowLeft', shiftKey: true}),
    );

    const result = extEditor.read(() => {
      const sel = $getSelection();
      return $isRangeSelection(sel)
        ? {offset: sel.focus.offset, type: sel.focus.type}
        : null;
    });

    expect(handled).toBe(true);
    expect(result!.type).toBe('element');
    expect(result!.offset).toBe(0);
  });

  test('Shift+Right at paragraph end (ruby last) moves focus to parent:childrenSize', () => {
    extEditor.update(
      () => {
        const p = $createParagraphNode();
        const pre = $createTextNode('前');
        const ruby = $createRubyNode('漢', 'かん');
        p.append(pre, ruby);
        $getRoot().clear().append(p);
        pre.select(1, 1);
      },
      {discrete: true},
    );

    const handled = extEditor.dispatchCommand(
      KEY_ARROW_RIGHT_COMMAND,
      new KeyboardEvent('keydown', {key: 'ArrowRight', shiftKey: true}),
    );

    const focusType = extEditor.read(() => {
      const sel = $getSelection();
      return $isRangeSelection(sel) ? sel.focus.type : '';
    });

    expect(handled).toBe(true);
    expect(focusType).toBe('element');
  });

  test('Shift+Right when focus is on ruby and ruby is last child goes to parent', () => {
    extEditor.update(
      () => {
        const p = $createParagraphNode();
        const pre = $createTextNode('前');
        const ruby = $createRubyNode('漢', 'かん');
        p.append(pre, ruby);
        $getRoot().clear().append(p);
        const sel = pre.select(0, 0);
        sel.focus.set(ruby.getKey(), 0, 'text');
      },
      {discrete: true},
    );

    const handled = extEditor.dispatchCommand(
      KEY_ARROW_RIGHT_COMMAND,
      new KeyboardEvent('keydown', {key: 'ArrowRight', shiftKey: true}),
    );

    const focusType = extEditor.read(() => {
      const sel = $getSelection();
      return $isRangeSelection(sel) ? sel.focus.type : '';
    });

    expect(handled).toBe(true);
    expect(focusType).toBe('element');
  });

  test('Shift+Left when focus is on ruby and ruby is first child goes to parent:0', () => {
    extEditor.update(
      () => {
        const p = $createParagraphNode();
        const ruby = $createRubyNode('漢', 'かん');
        const post = $createTextNode('後');
        p.append(ruby, post);
        $getRoot().clear().append(p);
        const sel = post.select(1, 1);
        sel.focus.set(ruby.getKey(), 1, 'text');
      },
      {discrete: true},
    );

    const handled = extEditor.dispatchCommand(
      KEY_ARROW_LEFT_COMMAND,
      new KeyboardEvent('keydown', {key: 'ArrowLeft', shiftKey: true}),
    );

    const result = extEditor.read(() => {
      const sel = $getSelection();
      return $isRangeSelection(sel)
        ? {offset: sel.focus.offset, type: sel.focus.type}
        : null;
    });

    expect(handled).toBe(true);
    expect(result!.type).toBe('element');
    expect(result!.offset).toBe(0);
  });
});

// Omits RichTextExtension: RichText's deleteCharacter calls domSelection.modify
// which is unavailable in jsdom.
describe('RubyExtension backspace', () => {
  let container: HTMLDivElement;
  let editor: LexicalEditor;

  beforeEach(() => {
    container = document.createElement('div');
    container.setAttribute('data-lexical-editor', 'true');
    container.contentEditable = 'true';
    document.body.appendChild(container);
    editor = buildEditorFromExtensions({
      dependencies: [RubyExtension],
      name: 'ruby-backspace-test',
      onError: e => {
        throw e;
      },
    });
    editor.setRootElement(container);
  });

  afterEach(() => {
    editor.setRootElement(null);
    document.body.removeChild(container);
  });

  test('Backspace at text:0 with preceding ruby removes the ruby', () => {
    let handled = false;

    editor.update(
      () => {
        const p = $createParagraphNode();
        const pre = $createTextNode('前');
        const ruby = $createRubyNode('漢', 'かん');
        const post = $createTextNode('後');
        p.append(pre, ruby, post);
        $getRoot().clear().append(p);

        post.select(0, 0);

        const event = new KeyboardEvent('keydown', {key: 'Backspace'});
        handled = editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event);
      },
      {discrete: true},
    );

    const result = editor.read(() => {
      const first = $getRoot().getFirstChild();
      if (!$isElementNode(first)) {
        return {hasRuby: false, text: ''};
      }
      return {
        hasRuby: first.getChildren().some($isRubyNode),
        text: first.getTextContent(),
      };
    });

    expect(handled).toBe(true);
    expect(result.hasRuby).toBe(false);
    expect(result.text).toBe('前後');
  });

  test('Backspace at text offset > 0 does not remove ruby', () => {
    let handled = false;

    editor.update(
      () => {
        const p = $createParagraphNode();
        const ruby = $createRubyNode('漢', 'かん');
        const post = $createTextNode('後');
        p.append(ruby, post);
        $getRoot().clear().append(p);

        post.select(1, 1);

        const event = new KeyboardEvent('keydown', {key: 'Backspace'});
        handled = editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event);
      },
      {discrete: true},
    );

    expect(handled).toBe(false);
  });

  test('Backspace with non-collapsed selection is not handled by ruby', () => {
    let handled = false;

    editor.update(
      () => {
        const p = $createParagraphNode();
        const ruby = $createRubyNode('漢', 'かん');
        const post = $createTextNode('後の');
        p.append(ruby, post);
        $getRoot().clear().append(p);

        post.select(0, 1);

        const event = new KeyboardEvent('keydown', {key: 'Backspace'});
        handled = editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event);
      },
      {discrete: true},
    );

    expect(handled).toBe(false);
  });

  test('Backspace at text:0 when prev is not ruby is not handled', () => {
    let handled = false;

    editor.update(
      () => {
        const p = $createParagraphNode();
        const pre = $createTextNode('前');
        const post = $createTextNode('後');
        p.append(pre, post);
        $getRoot().clear().append(p);

        post.select(0, 0);

        const event = new KeyboardEvent('keydown', {key: 'Backspace'});
        handled = editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event);
      },
      {discrete: true},
    );

    expect(handled).toBe(false);
  });

  test('Backspace at parent-end element point removes the preceding ruby', () => {
    let handled = false;

    editor.update(
      () => {
        const p = $createParagraphNode();
        const pre = $createTextNode('前');
        const ruby = $createRubyNode('漢', 'かん');
        p.append(pre, ruby);
        $getRoot().clear().append(p);

        // The parent-boundary element point that arrow navigation itself
        // creates when the ruby is the last child.
        const sel = pre.select(0, 0);
        sel.anchor.set(p.getKey(), 2, 'element');
        sel.focus.set(p.getKey(), 2, 'element');

        const event = new KeyboardEvent('keydown', {key: 'Backspace'});
        handled = editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event);
      },
      {discrete: true},
    );

    const result = editor.read(() => {
      const first = $getRoot().getFirstChild();
      if (!$isElementNode(first)) {
        return {hasRuby: false, text: ''};
      }
      return {
        hasRuby: first.getChildren().some($isRubyNode),
        text: first.getTextContent(),
      };
    });

    expect(handled).toBe(true);
    expect(result.hasRuby).toBe(false);
    expect(result.text).toBe('前');
  });

  test('Backspace at element point whose previous child is not a ruby is not handled', () => {
    let handled = false;

    editor.update(
      () => {
        const p = $createParagraphNode();
        const pre = $createTextNode('前');
        const post = $createTextNode('後');
        p.append(pre, post);
        $getRoot().clear().append(p);

        const sel = pre.select(0, 0);
        sel.anchor.set(p.getKey(), 1, 'element');
        sel.focus.set(p.getKey(), 1, 'element');

        const event = new KeyboardEvent('keydown', {key: 'Backspace'});
        handled = editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event);
      },
      {discrete: true},
    );

    expect(handled).toBe(false);
  });
});

describe('RubyExtension arrow — guard conditions', () => {
  let container: HTMLDivElement;
  let extEditor: LexicalEditor;

  beforeEach(() => {
    container = document.createElement('div');
    container.setAttribute('data-lexical-editor', 'true');
    container.contentEditable = 'true';
    document.body.appendChild(container);
    extEditor = buildEditorFromExtensions({
      dependencies: [RichTextExtension, RubyExtension],
      name: 'ruby-guard-test',
      onError: e => {
        throw e;
      },
    });
    extEditor.setRootElement(container);
  });

  afterEach(() => {
    extEditor.setRootElement(null);
    document.body.removeChild(container);
  });

  function setupAtRubyBoundary() {
    extEditor.update(
      () => {
        const p = $createParagraphNode();
        const pre = $createTextNode('前');
        const ruby = $createRubyNode('漢', 'かん');
        const post = $createTextNode('後');
        p.append(pre, ruby, post);
        $getRoot().clear().append(p);

        post.select(0, 0);
      },
      {discrete: true},
    );
  }

  test.for([
    {label: 'Meta', modifier: {metaKey: true}},
    {label: 'Ctrl', modifier: {ctrlKey: true}},
    {label: 'Alt', modifier: {altKey: true}},
  ])('Arrow+$label does not skip ruby', ({modifier}) => {
    setupAtRubyBoundary();
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      ...modifier,
    });
    const handled = extEditor.dispatchCommand(KEY_ARROW_LEFT_COMMAND, event);
    expect(handled).toBe(false);
  });

  test('Non-collapsed selection without shift — arrow does not skip ruby', () => {
    extEditor.update(
      () => {
        const p = $createParagraphNode();
        const pre = $createTextNode('前');
        const ruby = $createRubyNode('漢', 'かん');
        const post = $createTextNode('後');
        p.append(pre, ruby, post);
        $getRoot().clear().append(p);

        pre.select(0, 1);
      },
      {discrete: true},
    );

    const event = new KeyboardEvent('keydown', {key: 'ArrowRight'});
    const handled = extEditor.dispatchCommand(KEY_ARROW_RIGHT_COMMAND, event);
    expect(handled).toBe(false);
  });

  test('Arrow at text middle (not at boundary) does not skip ruby', () => {
    extEditor.update(
      () => {
        const p = $createParagraphNode();
        const pre = $createTextNode('前後');
        const ruby = $createRubyNode('漢', 'かん');
        p.append(pre, ruby);
        $getRoot().clear().append(p);

        pre.select(1, 1);
      },
      {discrete: true},
    );

    const event = new KeyboardEvent('keydown', {key: 'ArrowRight'});
    const handled = extEditor.dispatchCommand(KEY_ARROW_RIGHT_COMMAND, event);
    expect(handled).toBe(false);
  });
});

// Element points arise from the extension's own parent-boundary landings
// (and from clicks in empty areas). Arrow handling must skip a chain the
// point faces, and must NOT consume the keypress when the chain is behind
// the point — otherwise the caret can never leave the paragraph.
describe('RubyExtension arrow — element points', () => {
  let container: HTMLDivElement;
  let extEditor: LexicalEditor;

  beforeEach(() => {
    container = document.createElement('div');
    container.setAttribute('data-lexical-editor', 'true');
    container.contentEditable = 'true';
    document.body.appendChild(container);
    extEditor = buildEditorFromExtensions({
      dependencies: [RichTextExtension, RubyExtension],
      name: 'ruby-element-point-test',
      onError: e => {
        throw e;
      },
    });
    extEditor.setRootElement(container);
  });

  afterEach(() => {
    extEditor.setRootElement(null);
    document.body.removeChild(container);
  });

  function $selectElementPoint(p: ElementNode, offset: number) {
    const first = p.getFirstDescendant();
    if (!$isTextNode(first)) {
      throw new Error('Expected a leading TextNode');
    }
    const sel = first.select(0, 0);
    sel.anchor.set(p.getKey(), offset, 'element');
    sel.focus.set(p.getKey(), offset, 'element');
  }

  test('Arrow right at parent-end element point (ruby last) is not handled', () => {
    let handled = true;
    // Dispatch inside the update: a committed element point can be
    // re-resolved onto the adjacent text node by the DOM selection
    // round-trip (jsdom always; Safari at boundaries), which would test
    // the on-ruby path instead of the element-point path.
    extEditor.update(
      () => {
        const p = $createParagraphNode();
        p.append($createTextNode('前'), $createRubyNode('漢', 'かん'));
        $getRoot().clear().append(p);
        $selectElementPoint(p, 2);
        handled = extEditor.dispatchCommand(
          KEY_ARROW_RIGHT_COMMAND,
          new KeyboardEvent('keydown', {key: 'ArrowRight'}),
        );
      },
      {discrete: true},
    );

    // The ruby is behind the point; the keypress must fall through to the
    // browser so the caret can leave the paragraph.
    expect(handled).toBe(false);
  });

  test('Arrow left at parent-start element point (ruby first) is not handled', () => {
    let handled = true;
    extEditor.update(
      () => {
        const p = $createParagraphNode();
        const ruby = $createRubyNode('漢', 'かん');
        const post = $createTextNode('後');
        p.append(ruby, post);
        $getRoot().clear().append(p);
        const sel = post.select(0, 0);
        sel.anchor.set(p.getKey(), 0, 'element');
        sel.focus.set(p.getKey(), 0, 'element');
        handled = extEditor.dispatchCommand(
          KEY_ARROW_LEFT_COMMAND,
          new KeyboardEvent('keydown', {key: 'ArrowLeft'}),
        );
      },
      {discrete: true},
    );

    expect(handled).toBe(false);
  });

  test('Arrow left from parent-end element point skips back over the ruby', () => {
    let handled = false;
    extEditor.update(
      () => {
        const p = $createParagraphNode();
        p.append($createTextNode('前'), $createRubyNode('漢', 'かん'));
        $getRoot().clear().append(p);
        $selectElementPoint(p, 2);
        handled = extEditor.dispatchCommand(
          KEY_ARROW_LEFT_COMMAND,
          new KeyboardEvent('keydown', {key: 'ArrowLeft'}),
        );
      },
      {discrete: true},
    );

    const result = extEditor.read(() => {
      const sel = $getSelection();
      return $isRangeSelection(sel)
        ? {
            isCollapsed: sel.isCollapsed(),
            offset: sel.anchor.offset,
            text: sel.anchor.getNode().getTextContent(),
            type: sel.anchor.type,
          }
        : null;
    });

    expect(handled).toBe(true);
    expect(result).toEqual({
      isCollapsed: true,
      offset: 1,
      text: '前',
      type: 'text',
    });
  });

  test('Shift+Right from element point before consecutive rubies extends past the chain', () => {
    let handled = false;
    extEditor.update(
      () => {
        const p = $createParagraphNode();
        const ruby1 = $createRubyNode('漢', 'かん');
        const ruby2 = $createRubyNode('字', 'じ');
        const post = $createTextNode('後');
        p.append(ruby1, ruby2, post);
        $getRoot().clear().append(p);
        const sel = post.select(0, 0);
        sel.anchor.set(p.getKey(), 0, 'element');
        sel.focus.set(p.getKey(), 0, 'element');
        handled = extEditor.dispatchCommand(
          KEY_ARROW_RIGHT_COMMAND,
          new KeyboardEvent('keydown', {key: 'ArrowRight', shiftKey: true}),
        );
      },
      {discrete: true},
    );

    const result = extEditor.read(() => {
      const sel = $getSelection();
      return $isRangeSelection(sel)
        ? {
            anchorOffset: sel.anchor.offset,
            anchorType: sel.anchor.type,
            focusOffset: sel.focus.offset,
            focusText: sel.focus.getNode().getTextContent(),
          }
        : null;
    });

    expect(handled).toBe(true);
    expect(result).toEqual({
      anchorOffset: 0,
      anchorType: 'element',
      focusOffset: 0,
      focusText: '後',
    });
  });
});

describe('RubyImportRule — HTML <ruby> import', () => {
  function importAndRead(html: string) {
    const editor = buildEditorFromExtensions({
      dependencies: [RichTextExtension, RubyExtension],
      name: 'ruby-import-test',
      onError: (e: Error) => {
        throw e;
      },
    });

    const container = document.createElement('div');
    container.contentEditable = 'true';
    document.body.appendChild(container);
    editor.setRootElement(container);

    editor.update(
      () => {
        const dep = getExtensionDependencyFromEditor(
          editor,
          DOMImportExtension,
        );
        const dom = new DOMParser().parseFromString(
          `<!doctype html><html><body>${html}</body></html>`,
          'text/html',
        );
        const nodes = dep.output.$generateNodesFromDOM(dom);
        $getRoot().clear().splice(0, 0, nodes);
      },
      {discrete: true},
    );

    const result = editor.read(() => {
      const paragraph = $getRoot().getFirstChild();
      if (!$isElementNode(paragraph)) {
        return {children: []};
      }
      return {
        children: paragraph.getChildren().map(child => {
          if ($isRubyNode(child)) {
            return {
              annotation: child.getAnnotation(),
              text: child.getTextContent(),
              type: 'ruby',
            };
          }
          return {
            text: child.getTextContent(),
            type: child.getType(),
          };
        }),
      };
    });

    editor.setRootElement(null);
    document.body.removeChild(container);
    return result;
  }

  test('basic <ruby> with <rt>', () => {
    const result = importAndRead('<ruby>漢<rt>かん</rt></ruby>');
    expect(result.children).toEqual([
      {annotation: 'かん', text: '漢', type: 'ruby'},
    ]);
  });

  test('<ruby> with <rp> tags (graceful skip)', () => {
    const result = importAndRead(
      '<ruby>漢<rp>(</rp><rt>かん</rt><rp>)</rp></ruby>',
    );
    expect(result.children).toEqual([
      {annotation: 'かん', text: '漢', type: 'ruby'},
    ]);
  });

  test('multi-segment ruby', () => {
    const result = importAndRead('<ruby>漢<rt>かん</rt>字<rt>じ</rt></ruby>');
    expect(result.children).toEqual([
      {annotation: 'かん', text: '漢', type: 'ruby'},
      {annotation: 'じ', text: '字', type: 'ruby'},
    ]);
  });

  test('trailing text without <rt> becomes TextNode', () => {
    const result = importAndRead('<ruby>漢<rt>かん</rt>余り</ruby>');
    expect(result.children).toEqual([
      {annotation: 'かん', text: '漢', type: 'ruby'},
      {text: '余り', type: 'text'},
    ]);
  });

  test('empty <rt> produces empty annotation', () => {
    const result = importAndRead('<ruby>漢<rt></rt></ruby>');
    expect(result.children).toEqual([
      {annotation: '', text: '漢', type: 'ruby'},
    ]);
  });
});
