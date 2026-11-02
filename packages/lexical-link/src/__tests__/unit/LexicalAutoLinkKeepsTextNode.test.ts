/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {
  $createAutoLinkNode,
  $isAutoLinkNode,
  AutoLinkExtension,
  autoLinkUrlMatcher,
} from '@lexical/link';
import {$addMarkID, $getNodeMarkIDs, MarkStateExtension} from '@lexical/mark';
import {RichTextExtension} from '@lexical/rich-text';
import {registerLexicalTextEntity} from '@lexical/text';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getState,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  $setState,
  configExtension,
  createState,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

const tagState = createState('autolink-test-tag', {
  parse: value => (typeof value === 'string' ? value : ''),
});

// The style and detail of each leaf, in the order `read` visits them
const styles: string[] = [];

const AutoLink = configExtension(AutoLinkExtension, {
  matchers: [autoLinkUrlMatcher],
});

/** Each leaf of the first paragraph: [parent path, type, text, format, mark ids, tag] */
function read(editor: LexicalEditor) {
  return editor.read(() => {
    const out: [string, string, string, number, string[], string][] = [];
    styles.length = 0;
    const walk = (node: LexicalNode, path: string) => {
      if ($isElementNode(node)) {
        for (const child of node.getChildren()) {
          walk(
            child,
            path === '' ? node.getType() : `${path}>${node.getType()}`,
          );
        }
      } else if ($isTextNode(node)) {
        styles.push(`${node.getStyle()}|${node.getDetail()}`);
        out.push([
          path,
          node.getType(),
          node.getTextContent(),
          node.getFormat(),
          $getNodeMarkIDs(node),
          $getState(node, tagState),
        ]);
      }
    };
    walk($getRoot().getFirstChildOrThrow(), '');
    return out;
  });
}

function type(editor: LexicalEditor, text: string): void {
  for (const char of text) {
    editor.update(
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText(char);
        }
      },
      {discrete: true},
    );
  }
}

describe('AutoLinkExtension moves the text it links into the link', () => {
  test('the text keeps its NodeState (comment ids) when it becomes a link, and the caret stays', () => {
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        dependencies: [RichTextExtension, MarkStateExtension, AutoLink],
        name: '[root]',
      }),
    );
    editor.update(
      () => {
        const text = $setState(
          $createTextNode('see https://a.co').setStyle('color: red;'),
          tagState,
          'x',
        );
        $getRoot().clear().append($createParagraphNode().append(text));
        const selection = $createRangeSelection();
        selection.anchor.set(text.getKey(), 0, 'text');
        selection.focus.set(text.getKey(), text.getTextContentSize(), 'text');
        $setSelection(selection);
        $addMarkID('c1', selection);
        text.select(16, 16);
      },
      {discrete: true},
    );
    type(editor, ' ');
    expect(read(editor)).toEqual([
      ['paragraph', 'text', 'see ', 0, ['c1'], 'x'],
      ['paragraph>autolink', 'text', 'https://a.co', 0, ['c1'], 'x'],
      // MarkStateExtension keeps text typed at a comment's edge out of it
      ['paragraph', 'text', ' ', 0, [], ''],
    ]);
    // The style stays too
    expect(styles.slice(0, 2)).toEqual(['color: red;|0', 'color: red;|0']);
    // The caret is after the space typed
    expect(
      editor.read(() => {
        const selection = $getSelection();
        return $isRangeSelection(selection)
          ? [
              selection.anchor.getNode().getTextContent(),
              selection.anchor.offset,
            ]
          : null;
      }),
    ).toEqual([' ', 1]);
  });

  test('a URL in several text nodes: the first one keeps its NodeState too', () => {
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        dependencies: [RichTextExtension, AutoLink],
        name: '[root]',
      }),
    );
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $setState($createTextNode('https://a'), tagState, 'first'),
              $setState($createTextNode('.co'), tagState, 'second'),
              $createTextNode(' x'),
            ),
          );
      },
      {discrete: true},
    );
    expect(read(editor)).toEqual([
      ['paragraph>autolink', 'text', 'https://a', 0, [], 'first'],
      ['paragraph>autolink', 'text', '.co', 0, [], 'second'],
      ['paragraph', 'text', ' x', 0, [], ''],
    ]);
  });
});

// A token or segmented text entity next to AutoLinkExtension: the autolink
// wraps a URL's text in a link and unwraps it again when the link holds
// something other than simple text, such as the entity. registerLexicalTextEntity
// keeps a token or segmented entity once it was turned back into text twice in
// one update, telling the entity by the node before it, which the link used to
// replace with a copy each time it wrapped the text: the transforms looped
// ("One or more transforms are endlessly triggering additional transforms").

class TagNode extends TextNode {
  $config() {
    return this.config('autolink-test-entity', {extends: TextNode});
  }
  isTextEntity(): true {
    return true;
  }
  canInsertTextBefore(): boolean {
    return false;
  }
  canInsertTextAfter(): boolean {
    return false;
  }
}

const tagMatch = (text: string) => {
  const match = /%[a-z]+/.exec(text);
  return match === null
    ? null
    : {end: match.index + match[0].length, start: match.index};
};

function buildWithEntity(
  mode: 'normal' | 'segmented' | 'token',
  initial: string | (() => void),
): {editor: LexicalEditor; errors: string[]} {
  const errors: string[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: initial,
      dependencies: [RichTextExtension, AutoLink],
      name: '[root]',
      nodes: [TagNode],
      onError: (error: Error) => {
        errors.push(error.message);
      },
      register: e => {
        const unregister = registerLexicalTextEntity(
          e,
          tagMatch,
          TagNode,
          node =>
            $create(TagNode)
              .setTextContent(node.getTextContent())
              .setMode(mode),
        );
        return () => unregister.forEach(f => f());
      },
    }),
  );
  return {editor, errors};
}

describe('a token or segmented text entity next to AutoLinkExtension', () => {
  for (const mode of ['token', 'segmented', 'normal'] as const) {
    test(`${mode}: typing a match inside an autolink whose text has two formats settles`, () => {
      const {editor, errors} = buildWithEntity(mode, () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createAutoLinkNode('https://a.coC').append(
              $createTextNode('https://a.co').toggleFormat('underline'),
              $createTextNode('C'),
            ),
          ),
        );
      });
      editor.update(
        () => {
          const link = (
            $getRoot().getFirstChildOrThrow() as ElementNode
          ).getFirstChildOrThrow();
          if ($isAutoLinkNode(link)) {
            (link.getFirstChildOrThrow() as TextNode).select(9, 9);
          }
        },
        {discrete: true},
      );
      type(editor, '%ab');
      // Every character typed is kept; the link holds an entity, which
      // AutoLinkExtension unwraps, as for an entity in normal mode.
      expect({
        errors,
        nodes: read(editor).map(([path, nodeType, text, format]) => [
          path,
          nodeType,
          text,
          format,
        ]),
      }).toEqual({
        errors: [],
        nodes: [
          ['paragraph', 'text', 'https://a', 8],
          ['paragraph', 'autolink-test-entity', '%ab', 0],
          ['paragraph', 'text', '.co', 8],
          ['paragraph', 'text', 'C', 0],
        ],
      });
    });

    test(`${mode}: a stored entity that no longer matches its text, after URL text in another format, settles on load`, () => {
      const textNode = (
        text: string,
        nodeType: string,
        nodeMode: string,
        format = 0,
      ) => ({
        detail: 0,
        format,
        mode: nodeMode,
        style: '',
        text,
        type: nodeType,
        version: 1,
      });
      const {editor, errors} = buildWithEntity(
        mode,
        JSON.stringify({
          root: {
            children: [
              {
                children: [
                  textNode('https://a.codog#', 'text', 'normal', 4),
                  textNode('%a b', 'autolink-test-entity', mode),
                  textNode('cdog', 'text', 'normal'),
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
            type: 'root',
            version: 1,
          },
        }),
      );
      expect({
        errors,
        text: editor.read(() => $getRoot().getTextContent()),
      }).toEqual({errors: [], text: 'https://a.codog#%a bcdog'});
    });
  }
});
