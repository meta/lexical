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
  CodePrismExtension,
  PrismTokenizer,
  type Tokenizer,
} from '@lexical/code-prism';
import {buildEditorFromExtensions} from '@lexical/extension';
import {$createQuoteNode, RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTabNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getState,
  $isElementNode,
  $isRangeSelection,
  $setSelection,
  $setState,
  configExtension,
  createState,
  defineExtension,
  type LexicalEditor,
  nodeSchema,
  type StateConfig,
  stringValue,
  TextNode,
  withField,
} from 'lexical';
import {describe, expect, test} from 'vitest';

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
      dependencies: [RichTextExtension, CodePrismExtension],
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

  test('a tab and a line break with NodeState inside a code block keep it, as the text around them does', () => {
    using editor = editorWithCode();
    // As a collaborator's change is read: with no transforms.
    editor.update(
      () => {
        const nodes = [
          $createTextNode('foo'),
          $createTabNode(),
          $createTextNode('bar'),
          $createLineBreakNode(),
          $createTextNode('baz'),
        ];
        for (const node of nodes) {
          $setState(node, noteState, 'kept');
        }
        $getRoot().append(
          $createCodeNode('javascript').append(...nodes),
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
    expect(
      editor.read(() => {
        const block = $getRoot().getFirstChildOrThrow();
        return ($isElementNode(block) ? block.getChildren() : []).map(node => [
          node.getType(),
          $getState(node, noteState),
        ]);
      }),
    ).toEqual([
      ['code-highlight', 'kept'],
      ['tab', 'kept'],
      ['code-highlight', 'kept'],
      ['linebreak', 'kept'],
      ['code-highlight', 'kept'],
    ]);
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
      dependencies: [RichTextExtension, CodePrismExtension],
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
      dependencies: [RichTextExtension, CodePrismExtension],
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

  test('an untouched token keeps the value an app set for a state its class sets when it is made, where a new token gets another', () => {
    using editor = editorWithCreatedHighlight();
    editor.update(
      () => {
        $getRoot().append(
          $createCodeNode('javascript').append($createTextNode('let x = 1;')),
        );
      },
      {discrete: true},
    );
    // The app sets that state on the token for `let` to a value of its own.
    editor.update(
      () => {
        const token = $getRoot()
          .getAllTextNodes()
          .find(node => node.getTextContent() === 'let');
        if (token !== undefined) {
          $setState(token, createdState, 'C');
        }
      },
      {discrete: true},
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
    expect(
      editor.read(() =>
        $getRoot()
          .getAllTextNodes()
          .filter(node => node.getTextContent() === 'let')
          .map(node => [
            $isCodeHighlightNode(node),
            $getState(node, createdState),
          ]),
      ),
    ).toEqual([[true, 'C']]);
  });
});

// An app's own highlight class, with a field of its own and a NodeState key
// it declares flat (at the top level of its JSON, where the stock highlight
// node nests it): an untouched token of that class is kept, with its class,
// its field and its NodeState; and where a token an app's tokenizer makes of
// that class is split at the boundary of a node with NodeState, each part is
// of that class, with its field.

const appHighlightSchema = nodeSchema<AppHighlightNode>()({
  app: withField(stringValue(), {field: '__app'}),
});

/** An app's highlight class, with a field and a flat NodeState key. */
class AppHighlightNode extends CodeHighlightNode {
  __app: string = '';
  $config() {
    return this.config('test-retokenize-app-highlight', {
      extends: CodeHighlightNode,
      json: appHighlightSchema,
      stateConfigs: [{flat: true, stateConfig: noteState}],
    });
  }
  getApp(): string {
    return this.getLatest().__app;
  }
  setApp(value: string): this {
    const self = this.getWritable();
    self.__app = value;
    return self;
  }
}

/** A copy of `token` made of the app's class, with its field set. */
function $appToken(token: CodeHighlightNode): AppHighlightNode {
  return $create(AppHighlightNode)
    .setTextContent(token.getTextContent())
    .setHighlightType(token.getHighlightType())
    .setStyle(token.getStyle())
    .setApp('app');
}

/**
 * The Prism tokenizer, making each token of the app's class (an app's
 * tokenizer, through the public Tokenizer API).
 */
const appTokenizer: Tokenizer = {
  ...PrismTokenizer,
  $tokenize(code, language) {
    return PrismTokenizer.$tokenize(code, language).map(node =>
      $isCodeHighlightNode(node) ? $appToken(node) : node,
    );
  },
};

function editorWithAppHighlight(
  tokenizer?: Tokenizer,
): LexicalEditor & Disposable {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        tokenizer === undefined
          ? CodePrismExtension
          : configExtension(CodePrismExtension, {tokenizer}),
      ],
      name: 'retokenize-keeps-state-app-highlight',
      nodes: () => [AppHighlightNode],
      onError: (error: Error) => {
        throw error;
      },
    }),
  );
}

/** Each text node with one of `texts`: text, of the app's class, field, note. */
const showApp = (editor: LexicalEditor, ...texts: string[]) =>
  editor.read(() =>
    $getRoot()
      .getAllTextNodes()
      .filter(node => texts.includes(node.getTextContent()))
      .map(node => [
        node.getTextContent(),
        node instanceof AppHighlightNode,
        node instanceof AppHighlightNode ? node.getApp() : '',
        $getState(node, noteState),
      ]),
  );

describe("an app's own highlight class keeps its class and fields", () => {
  test("an untouched token of an app's highlight class, with a field and a NodeState key it declares flat, keeps its class, its field and its value", () => {
    using editor = editorWithAppHighlight();
    editor.update(
      () => {
        $getRoot().append(
          $createCodeNode('javascript').append(
            $createTextNode('let t78z = 1;'),
          ),
        );
      },
      {discrete: true},
    );
    // The highlighter's token for `let`, made of the app's class, with its
    // field and a note (as an app's own code could make it).
    editor.update(
      () => {
        const token = $getRoot()
          .getAllTextNodes()
          .find(node => node.getTextContent() === 'let');
        if ($isCodeHighlightNode(token)) {
          token.replace($setState($appToken(token), noteState, 'kept'));
        }
      },
      {discrete: true, skipTransforms: true},
    );
    expect(showApp(editor, 'let')).toEqual([['let', true, 'app', 'kept']]);
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
    expect(showApp(editor, 'let')).toEqual([['let', true, 'app', 'kept']]);
  });

  test("a part of a token an app's tokenizer makes of its own class, split at the boundary of a node with NodeState, is of that class, with its field", () => {
    using editor = editorWithAppHighlight(appTokenizer);
    // As a collaborator's change is read: `le` and `t`, with different notes,
    // which the highlighter makes one token of (`let`).
    editor.update(
      () => {
        $getRoot().append(
          $createCodeNode('javascript').append(
            $setState($createTextNode('le'), noteState, 'a'),
            $setState($createTextNode('t'), noteState, 'b'),
            $createTextNode(' t78z = 1;'),
          ),
        );
      },
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
    expect(showApp(editor, 'le', 't')).toEqual([
      ['le', true, 'app', 'a'],
      ['t', true, 'app', 'b'],
    ]);
  });
});

// A NodeState value an app's tokenizer sets on each token, derived from the
// token (here its highlight type and style), is the tokenizer's after an
// edit: the old text's value is copied only for keys the token does not
// hold.

/** The value the tokenizer below derives from a token. */
const kindOf = (node: CodeHighlightNode) =>
  `${node.getHighlightType() ?? ''}|${node.getStyle()}`;
const kindState = createState('kind', {parse: parseString});

/** The Prism tokenizer, setting `kind` on each token it makes. */
const kindTokenizer: Tokenizer = {
  ...PrismTokenizer,
  $tokenize(code, language) {
    return PrismTokenizer.$tokenize(code, language).map(node =>
      $isCodeHighlightNode(node)
        ? $setState(node, kindState, kindOf(node))
        : node,
    );
  },
};

describe("a NodeState value an app's tokenizer sets", () => {
  test("a NodeState value an app's tokenizer sets on each token, from the token, is the tokenizer's after an edit, not the old token's", () => {
    using editor = editorWithAppHighlight(kindTokenizer);
    editor.update(
      () => {
        $getRoot().append(
          $createCodeNode('javascript').append($createTextNode('let x = 1;')),
        );
      },
      {discrete: true},
    );
    // `let` (a keyword) becomes `lets` (a plain word).
    editor.update(
      () => {
        const token = $getRoot()
          .getAllTextNodes()
          .find(node => node.getTextContent() === 'let');
        if ($isCodeHighlightNode(token)) {
          token.select(3, 3);
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText('s');
          }
        }
      },
      {discrete: true},
    );
    expect(editor.read(() => $getRoot().getTextContent())).toBe('lets x = 1;');
    // Every token, `lets` included (in one token or, split at the boundary
    // of the old `let`, in two), has the value the tokenizer derives from it.
    expect(
      editor.read(() =>
        $getRoot()
          .getAllTextNodes()
          .filter(
            node =>
              $isCodeHighlightNode(node) &&
              $getState(node, kindState) !== kindOf(node),
          )
          .map(node => node.getTextContent()),
      ),
    ).toEqual([]);
  });
});

// A token an app's tokenizer makes, over old tokens that have NodeState of
// their own (comment ids, as a collaborator's change is read): the
// highlighter writes the tokenizer's token, with the NodeState of the text
// it came from, where it adds to the old token (its own class, or NodeState
// the tokenizer set) and loses nothing of it; it keeps an old token that has
// something the new one does not (a NodeState value of its own, here), as it
// keeps any token whose text and type did not change.

/** The Prism tokenizer, making each token of the app's class, with `kind`. */
const appKindTokenizer: Tokenizer = {
  ...PrismTokenizer,
  $tokenize(code, language) {
    return PrismTokenizer.$tokenize(code, language).map(node =>
      $isCodeHighlightNode(node)
        ? $setState($appToken(node), kindState, kindOf(node))
        : node,
    );
  },
};

/** A NodeState value named as the app class's field. */
const fieldNamedState = createState('app', {parse: parseString});

/** The same, with no style (an app's tokenizer that colors nothing). */
const appPlainTokenizer: Tokenizer = {
  ...PrismTokenizer,
  $tokenize(code, language) {
    return appKindTokenizer
      .$tokenize(code, language)
      .map(node => ($isCodeHighlightNode(node) ? node.setStyle('') : node));
  },
};

/**
 * A code block of `texts`, old tokens with members `c1`, `c2`, ... (and
 * `kind` set to `kind`, where given), read as a collaborator's change is (no
 * transforms), then tokenized again by a paragraph inserted right after it.
 */
function $retokenizeOldTokens(
  editor: LexicalEditor,
  texts: string[],
  kind?: string,
): void {
  editor.update(
    () => {
      const tokens = texts.map((text, i) => {
        const token = $setState($createCodeHighlightNode(text), membersState, [
          `c${i + 1}`,
        ]);
        return kind === undefined ? token : $setState(token, kindState, kind);
      });
      $getRoot().append($createCodeNode('javascript').append(...tokens));
    },
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
}

/**
 * The first block: each distinct kind of token (of the app's class, its
 * field, whether its `kind` is the tokenizer's, else its `kind`), and each
 * character with its members.
 */
const tokensOf = (editor: LexicalEditor) =>
  editor.read(() => {
    const block = $getRoot().getFirstChildOrThrow();
    const nodes = $isElementNode(block) ? block.getChildren() : [];
    return {
      chars: nodes
        .flatMap(node =>
          [...node.getTextContent()].map(
            ch => `${ch}:${$getState(node, membersState).join(',')}`,
          ),
        )
        .join(' '),
      kinds: [
        ...new Set(
          nodes.map(node =>
            JSON.stringify([
              node instanceof AppHighlightNode,
              node instanceof AppHighlightNode ? node.getApp() : '',
              $isCodeHighlightNode(node) &&
              $getState(node, kindState) === kindOf(node)
                ? 'tokenizer'
                : $getState(node, kindState),
            ]),
          ),
        ),
      ],
    };
  });

describe("a token an app's tokenizer makes, over old tokens with NodeState", () => {
  test("each part of a token an app's tokenizer makes of its own class is of that class, with its field and the tokenizer's NodeState, and has the NodeState of its own text", () => {
    using editor = editorWithAppHighlight(appKindTokenizer);
    $retokenizeOldTokens(editor, ['alpha ', 'beta']);
    expect(tokensOf(editor)).toEqual({
      chars: 'a:c1 l:c1 p:c1 h:c1 a:c1  :c1 b:c2 e:c2 t:c2 a:c2',
      kinds: [JSON.stringify([true, 'app', 'tokenizer'])],
    });
  });

  test("a NodeState value an app's tokenizer sets is on each token, beside the NodeState of its own text", () => {
    using editor = editorWithAppHighlight(kindTokenizer);
    $retokenizeOldTokens(editor, ['alpha ', 'beta']);
    expect(tokensOf(editor)).toEqual({
      chars: 'a:c1 l:c1 p:c1 h:c1 a:c1  :c1 b:c2 e:c2 t:c2 a:c2',
      kinds: [JSON.stringify([false, '', 'tokenizer'])],
    });
  });

  test('an old token with a NodeState value the new one has another value for is kept as it is', () => {
    using editor = editorWithAppHighlight(appPlainTokenizer);
    $retokenizeOldTokens(editor, ['alpha'], 'set by the app');
    expect(tokensOf(editor)).toEqual({
      chars: 'a:c1 l:c1 p:c1 h:c1 a:c1',
      kinds: [JSON.stringify([false, '', 'set by the app'])],
    });
  });

  test('among old tokens as the stock tokenizer makes them, each with a comment, the ones a new token adds to are replaced, one for one, and one with a value the app set is kept, on every pass', () => {
    using editor = editorWithAppHighlight(appKindTokenizer);
    // As a collaborator's change is read: the stock tokenizer's tokens of
    // `let x = 1;`, each with a comment of its own, and the third with a
    // value of `kind` the app set.
    const protectedAt = 2;
    editor.update(
      () => {
        const code = $createCodeNode('javascript').append(
          $createTextNode('let x = 1;'),
        );
        $getRoot().append(code);
        const tokens = PrismTokenizer.$tokenize(code, 'javascript');
        code.clear();
        tokens.forEach((token, i) => {
          if ($isCodeHighlightNode(token)) {
            $setState(token, membersState, [`c${i + 1}`]);
            if (i === protectedAt) {
              $setState(token, kindState, 'set by the app');
            }
          }
        });
        code.append(...tokens);
      },
      {discrete: true, skipTransforms: true},
    );
    const pass = () =>
      editor.update(
        () => {
          $getRoot()
            .getFirstChildOrThrow()
            .insertAfter($createParagraphNode().append($createTextNode('x')));
        },
        {discrete: true},
      );
    const rows = () =>
      editor.read(() => {
        const block = $getRoot().getFirstChildOrThrow();
        return ($isElementNode(block) ? block.getChildren() : []).map(node => ({
          key: node.getKey(),
          row: [
            node instanceof AppHighlightNode,
            node instanceof AppHighlightNode ? node.getApp() : '',
            $isCodeHighlightNode(node) &&
            $getState(node, kindState) === kindOf(node)
              ? 'tokenizer'
              : $getState(node, kindState),
            $getState(node, membersState).join(','),
          ],
        }));
      });
    pass();
    const first = rows();
    expect(first.length).toBeGreaterThan(protectedAt + 1);
    expect(first.map(r => r.row)).toEqual(
      first.map((_, i) =>
        i === protectedAt
          ? [false, '', 'set by the app', `c${i + 1}`]
          : [true, 'app', 'tokenizer', `c${i + 1}`],
      ),
    );
    // Another pass replaces nothing.
    pass();
    expect(rows()).toEqual(first);
  });

  test("an old token of the app's class with a field value of its own is kept, where the new token of that class has another, also with a NodeState value of the field's name", () => {
    // The app's tokenizer, also setting a NodeState value named as the
    // class's field.
    const tokenizer: Tokenizer = {
      ...PrismTokenizer,
      $tokenize(code, language) {
        return appKindTokenizer
          .$tokenize(code, language)
          .map(node =>
            $isCodeHighlightNode(node)
              ? $setState(node, fieldNamedState, 'from the tokenizer')
              : node,
          );
      },
    };
    using editor = editorWithAppHighlight(tokenizer);
    editor.update(
      () => {
        const code = $createCodeNode('javascript').append(
          $createTextNode('let x = 1;'),
        );
        $getRoot().append(code);
        const tokens = PrismTokenizer.$tokenize(code, 'javascript').map(
          (token, i) =>
            $isCodeHighlightNode(token)
              ? $setState(
                  $appToken(token).setApp('set by the app'),
                  membersState,
                  [`c${i + 1}`],
                )
              : token,
        );
        code.clear();
        code.append(...tokens);
      },
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
    const rows = editor.read(() => {
      const block = $getRoot().getFirstChildOrThrow();
      return ($isElementNode(block) ? block.getChildren() : []).map(node => [
        node instanceof AppHighlightNode ? node.getApp() : '',
        $getState(node, fieldNamedState),
      ]);
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toEqual(rows.map(() => ['set by the app', '']));
  });

  test('replacing old tokens a new token adds to keeps the selection where it was: a caret, a range forward and backward, and a range from outside the block', () => {
    // [anchor token, offset, focus token, offset], token -1: the paragraph
    // after the block.
    const cases: [number, number, number, number][] = [
      [1, 1, 1, 1],
      [0, 1, 3, 1],
      [3, 1, 0, 1],
      [-1, 2, 1, 1],
    ];
    for (const [anchorAt, anchorOffset, focusAt, focusOffset] of cases) {
      using editor = editorWithAppHighlight(appKindTokenizer);
      editor.update(
        () => {
          const code = $createCodeNode('javascript').append(
            $createTextNode('let x = 1;'),
          );
          $getRoot().append(
            code,
            $createParagraphNode().append($createTextNode('after')),
          );
          const tokens = PrismTokenizer.$tokenize(code, 'javascript');
          code.clear();
          tokens.forEach((token, i) => {
            if ($isCodeHighlightNode(token)) {
              $setState(token, membersState, [`c${i + 1}`]);
            }
          });
          code.append(...tokens);
          const after = $getRoot().getLastChildOrThrow();
          const at = (i: number) =>
            i < 0
              ? $isElementNode(after)
                ? after.getFirstChildOrThrow()
                : after
              : code.getChildAtIndex(i)!;
          const selection = $createRangeSelection();
          selection.anchor.set(at(anchorAt).getKey(), anchorOffset, 'text');
          selection.focus.set(at(focusAt).getKey(), focusOffset, 'text');
          $setSelection(selection);
        },
        {discrete: true, skipTransforms: true},
      );
      const where = () =>
        editor.read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            return null;
          }
          return [selection.anchor, selection.focus].map(point => {
            const node = point.getNode();
            const block = node.getTopLevelElementOrThrow();
            return [
              block.getIndexWithinParent(),
              node
                .getPreviousSiblings()
                .reduce((n, sibling) => n + sibling.getTextContentSize(), 0) +
                point.offset,
            ];
          });
        });
      const before = where();
      editor.update(
        () => {
          $getRoot()
            .getFirstChildOrThrow()
            .insertAfter($createParagraphNode().append($createTextNode('x')));
        },
        {discrete: true},
      );
      // The tokens were replaced (of the app's class now), and the selection
      // is where it was: the paragraph after the block is now the third
      // block.
      expect(
        editor.read(() => {
          const block = $getRoot().getFirstChildOrThrow();
          return (
            $isElementNode(block) &&
            block.getChildren().every(node => node instanceof AppHighlightNode)
          );
        }),
      ).toBe(true);
      expect(where()).toEqual(
        before!.map(([block, offset]) => [block === 0 ? 0 : 2, offset]),
      );
    }
  });

  test('with a change inside the line that the highlighter replaces, the old tokens a new token adds to before and after it are replaced too, one for one', () => {
    using editor = editorWithAppHighlight(appKindTokenizer);
    editor.update(
      () => {
        const code = $createCodeNode('javascript').append(
          $createTextNode('let x = 1;'),
        );
        $getRoot().append(code);
        const tokens = PrismTokenizer.$tokenize(code, 'javascript');
        code.clear();
        tokens.forEach((token, i) => {
          if ($isCodeHighlightNode(token)) {
            $setState(token, membersState, [`c${i + 1}`]);
          }
        });
        code.append(...tokens);
      },
      {discrete: true, skipTransforms: true},
    );
    const $childrenOf = () => {
      const block = $getRoot().getFirstChildOrThrow();
      return $isElementNode(block) ? block.getChildren() : [];
    };
    const tokensBefore = editor.read(() => $childrenOf().length);
    // `1` becomes `1+2`, three tokens: the highlighter replaces it, and the
    // tokens before and after it, which the comparison keeps, are added to.
    editor.update(
      () => {
        const one = $getRoot()
          .getAllTextNodes()
          .find(node => node.getTextContent() === '1');
        if (one !== undefined) {
          one.setTextContent('1+2');
        }
      },
      {discrete: true},
    );
    const rows = editor.read(() =>
      $childrenOf().map(node => [
        node.getTextContent(),
        node instanceof AppHighlightNode,
        $isCodeHighlightNode(node) &&
          $getState(node, kindState) === kindOf(node),
        $getState(node, membersState).length,
      ]),
    );
    expect(rows.map(r => r[0]).join('')).toBe('let x = 1+2;');
    expect(rows.length).toBeGreaterThan(tokensBefore);
    expect(
      rows.every(([, app, kind, members]) => app && kind && members === 1),
    ).toBe(true);
    // The first and the last tokens were kept by the comparison.
    expect(rows[0][0]).toBe('let');
    expect(rows[rows.length - 1][0]).toBe(';');
  });
});
