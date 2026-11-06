/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $createCodeHighlightNode,
  $createCodeNode,
  $isCodeHighlightNode,
  CodeHighlightNode,
} from '@lexical/code-core';
import {
  CodeShikiExtension,
  loadCodeLanguage,
  loadCodeTheme,
} from '@lexical/code-shiki';
import {buildEditorFromExtensions} from '@lexical/extension';
import {$createQuoteNode, RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $isElementNode,
  $setState,
  createState,
  defineExtension,
  type LexicalEditor,
  type StateConfig,
  TextNode,
} from 'lexical';
import {beforeAll, describe, expect, test} from 'vitest';

// Text inside a code block can carry NodeState of its own (comment ids, a
// suggestion: collaboration stores them on the text). When the highlighter
// tokenizes the block again, the new tokens keep it: a token is split where
// the state changes, and each part has the state of the text it came from.

const noteState = createState('note', {
  parse: (value: unknown) => (typeof value === 'string' ? value : ''),
});
/** A set-valued state, as a suggestion's or a comment's members are. */
const membersState = createState('members', {
  parse: (value: unknown) =>
    Array.isArray(value) ? (value as string[]) : ([] as string[]),
});

function editorWithCode(): LexicalEditor & Disposable {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [RichTextExtension, CodeShikiExtension],
      name: 'retokenize-keeps-state',
      onError: (error: Error) => {
        throw error;
      },
    }),
  );
}

/** Whether every child of the first block is a code highlight node. */
const allTokens = (editor: LexicalEditor) =>
  editor.read(() => {
    const block = $getRoot().getFirstChildOrThrow();
    return (
      $isElementNode(block) && block.getChildren().every($isCodeHighlightNode)
    );
  });

/** Each text node of the first block: text, then its states if any. */
const show = (editor: LexicalEditor) =>
  editor.read(() => {
    const block = $getRoot().getFirstChildOrThrow();
    return ($isElementNode(block) ? block.getChildren() : []).map(node => {
      const note = $getState(node, noteState);
      const members = $getState(node, membersState);
      return (
        node.getTextContent() +
        (note === '' ? '' : `[note=${note}]`) +
        (members.length === 0 ? '' : `[members=${members.join(',')}]`)
      );
    });
  });

describe('a code block tokenized again keeps the NodeState of its text', () => {
  // Shiki loads grammars and themes asynchronously; loaded, it highlights in
  // the update that changes the block.
  beforeAll(async () => {
    await loadCodeLanguage('javascript');
    await loadCodeTheme('one-light');
  });

  test('a text node with NodeState inside a code block, tokenized again by an insert next to the block', () => {
    using editor = editorWithCode();
    // As a collaborator's change is read: with no transforms, so the text
    // node stays one node of its own inside the block.
    editor.update(
      () => {
        const word = $createTextNode('t78z');
        $setState(word, noteState, 'kept');
        $setState(word, membersState, ['s1']);
        $getRoot().append(
          $createCodeNode('javascript').append(
            $createCodeHighlightNode('fetch( '),
            word,
            $createCodeHighlightNode(' t51z'),
          ),
          $createParagraphNode().append($createTextNode('after')),
        );
      },
      {discrete: true, skipTransforms: true},
    );
    // A paragraph inserted right after the block makes the highlighter
    // tokenize it again.
    editor.update(
      () => {
        $getRoot()
          .getFirstChildOrThrow()
          .insertAfter($createParagraphNode().append($createTextNode('x')));
      },
      {discrete: true},
    );
    // Known by its StateConfig on the new token, as on the text it came from
    // (checked before anything reads it there): collaboration stores a known
    // set-valued state one entry per member, an unknown one whole.
    expect(
      editor.read(() =>
        $getRoot()
          .getAllTextNodes()
          .filter(node => node.getTextContent() === 't78z')
          .map(node => node.__state!.getInternalState()[1].has(membersState)),
      ),
    ).toEqual([true]);
    const nodes = show(editor);
    expect(nodes.join('')).toBe('fetch( t78z[note=kept][members=s1] t51z');
    expect(nodes).toContain('t78z[note=kept][members=s1]');
    expect(allTokens(editor)).toBe(true);
  });

  test('a quote merged into a code block keeps the NodeState of its text', () => {
    using editor = editorWithCode();
    editor.update(
      () => {
        const word = $createTextNode('t50z');
        $setState(word, membersState, ['s1']);
        $getRoot().append(
          $createCodeNode('javascript').append(
            $createCodeHighlightNode('const a = 1;'),
          ),
          $createQuoteNode().append(word),
        );
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const [code, quote] = $getRoot().getChildren();
        if ($isElementNode(code) && $isElementNode(quote)) {
          code.append(...quote.getChildren());
          quote.remove();
        }
      },
      {discrete: true},
    );
    expect(show(editor).join('')).toBe('const a = 1;t50z[members=s1]');
    expect(allTokens(editor)).toBe(true);
  });

  test('without NodeState, the block is tokenized as before', () => {
    using editor = editorWithCode();
    editor.update(
      () => {
        $getRoot().append(
          $createCodeNode('javascript').append(
            $createCodeHighlightNode('fetch( '),
            $createTextNode('t78z'),
            $createCodeHighlightNode(' t51z'),
          ),
        );
      },
      {discrete: true},
    );
    const withoutState = show(editor);
    using plain = editorWithCode();
    plain.update(
      () => {
        $getRoot().append(
          $createCodeNode('javascript').append(
            $createCodeHighlightNode('fetch( t78z t51z'),
          ),
        );
      },
      {discrete: true},
    );
    expect(withoutState).toEqual(show(plain));
  });
});

// The copies of NodeState (onto the new tokens, and onto text that leaves a
// code block) keep what the copy has of its own, as the copy of the JSON
// does: where the old node has a state at its default value (which its JSON
// leaves out), the value the copy's class sets when it is made; and where the
// copy's class has a StateConfig of its own for a key, the value read with
// that one.

const parseString = (value: unknown) =>
  typeof value === 'string' ? value : '';
/** A state the replacement classes below set when they are made. */
const createdState = createState('created', {parse: parseString});
/** A key the replacement classes below have a StateConfig of their own for. */
const ownedState = createState('owned', {parse: parseString});
/** Another StateConfig for the same key, as another module could make. */
const otherOwnedState = createState('owned', {parse: parseString});

/** A TextNode replacement that sets a state of its own when it is made. */
class CreatedTextNode extends TextNode {
  $config() {
    return this.config('test-retokenize-created-text', {
      extends: TextNode,
      stateConfigs: [createdState, ownedState],
    });
  }
}

/** A code highlight node replacement that sets a state of its own too. */
class CreatedHighlightNode extends CodeHighlightNode {
  $config() {
    return this.config('test-retokenize-created-highlight', {
      extends: CodeHighlightNode,
      stateConfigs: [createdState, ownedState],
    });
  }
}

function editorWithCreatedText(): LexicalEditor & Disposable {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [RichTextExtension, CodeShikiExtension],
      name: 'retokenize-keeps-state-created-text',
      nodes: () => [
        CreatedTextNode,
        {
          replace: TextNode,
          with: (node: TextNode) =>
            $setState(
              $create(CreatedTextNode).setTextContent(node.getTextContent()),
              createdState,
              'initialized',
            ),
          withKlass: CreatedTextNode,
        },
      ],
      onError: (error: Error) => {
        throw error;
      },
    }),
  );
}

function editorWithCreatedHighlight(): LexicalEditor & Disposable {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [RichTextExtension, CodeShikiExtension],
      name: 'retokenize-keeps-state-created-highlight',
      nodes: () => [
        CreatedHighlightNode,
        {
          replace: CodeHighlightNode,
          with: (node: CodeHighlightNode) =>
            $setState(
              $create(CreatedHighlightNode).setTextContent(
                node.getTextContent(),
              ),
              createdState,
              'initialized',
            ),
          withKlass: CreatedHighlightNode,
        },
      ],
      onError: (error: Error) => {
        throw error;
      },
    }),
  );
}

/** A code block whose text node `t78z` has the given states. */
function $appendBlockWithState(
  ...states: [StateConfig<string, string>, string][]
): void {
  const word = $createTextNode('t78z');
  for (const [stateConfig, value] of states) {
    $setState(word, stateConfig, value);
  }
  $getRoot().append(
    $createCodeNode('javascript').append(
      $createCodeHighlightNode('fetch( '),
      word,
      $createCodeHighlightNode(' t51z'),
    ),
  );
}

/** A code block of one token with the given states. */
function $appendTokenWithState(
  ...states: [StateConfig<string, string>, string][]
): void {
  const token = $createCodeHighlightNode('plain');
  for (const [stateConfig, value] of states) {
    $setState(token, stateConfig, value);
  }
  $getRoot().append($createCodeNode().append(token));
}

describe('the NodeState copies keep what the copy has of its own', () => {
  beforeAll(async () => {
    await loadCodeLanguage('javascript');
    await loadCodeTheme('one-light');
  });

  test('text leaving a code block keeps the state its class sets, where the token has that state at its default', () => {
    using editor = editorWithCreatedText();
    // The note makes the token's state JSON not empty.
    editor.update(
      () =>
        $appendTokenWithState(
          [noteState, 'kept'],
          [createdState, createdState.defaultValue],
        ),
      {discrete: true, skipTransforms: true},
    );
    editor.update(
      () => {
        $getRoot().getFirstChildOrThrow().replace($createParagraphNode(), true);
      },
      {discrete: true},
    );
    expect(
      editor.read(() =>
        $getRoot()
          .getAllTextNodes()
          .map(node => [
            $isCodeHighlightNode(node),
            $getState(node, noteState),
            $getState(node, createdState),
          ]),
      ),
    ).toEqual([[false, 'kept', 'initialized']]);
  });

  test('text leaving a code block is read with the StateConfig its class has for a key', () => {
    using editor = editorWithCreatedText();
    editor.update(() => $appendTokenWithState([otherOwnedState, 'kept']), {
      discrete: true,
      skipTransforms: true,
    });
    editor.update(
      () => {
        $getRoot().getFirstChildOrThrow().replace($createParagraphNode(), true);
      },
      {discrete: true},
    );
    expect(
      editor.read(() =>
        $getRoot()
          .getAllTextNodes()
          .map(node => [
            $isCodeHighlightNode(node),
            $getState(node, ownedState),
          ]),
      ),
    ).toEqual([[false, 'kept']]);
  });

  test('a new token keeps the state its class sets, where the text it comes from has that state at its default', () => {
    using editor = editorWithCreatedHighlight();
    editor.update(
      () =>
        $appendBlockWithState(
          [noteState, 'kept'],
          [createdState, createdState.defaultValue],
        ),
      {discrete: true, skipTransforms: true},
    );
    editor.update(
      () => {
        $getRoot()
          .getFirstChildOrThrow()
          .insertAfter($createParagraphNode().append($createTextNode('x')));
      },
      {discrete: true},
    );
    expect(
      editor.read(() =>
        $getRoot()
          .getAllTextNodes()
          .filter(node => node.getTextContent() === 't78z')
          .map(node => [
            $isCodeHighlightNode(node),
            $getState(node, noteState),
            $getState(node, createdState),
          ]),
      ),
    ).toEqual([[true, 'kept', 'initialized']]);
  });

  test('a new token is read with the StateConfig its class has for a key', () => {
    using editor = editorWithCreatedHighlight();
    editor.update(() => $appendBlockWithState([otherOwnedState, 'kept']), {
      discrete: true,
      skipTransforms: true,
    });
    editor.update(
      () => {
        $getRoot()
          .getFirstChildOrThrow()
          .insertAfter($createParagraphNode().append($createTextNode('x')));
      },
      {discrete: true},
    );
    expect(
      editor.read(() =>
        $getRoot()
          .getAllTextNodes()
          .filter(node => node.getTextContent() === 't78z')
          .map(node => [
            $isCodeHighlightNode(node),
            $getState(node, ownedState),
          ]),
      ),
    ).toEqual([[true, 'kept']]);
  });
});
