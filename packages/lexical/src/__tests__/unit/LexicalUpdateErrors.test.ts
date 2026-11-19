/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  COLLABORATION_TAG,
  COMMAND_PRIORITY_EDITOR,
  createEditor,
  type EditorState,
  type LexicalEditor,
  type LexicalNode,
  type ParagraphNode,
  SELECTION_CHANGE_COMMAND,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

// An update whose callback, nested update, transform or selection listener
// throws is discarded whether onError rethrows the error or only reports it:
// nothing of it stays pending, so the next update starts from the committed
// state and commits only its own changes, with only its own tags.

type Mode = 'rethrows' | 'reports';
const MODES: Mode[] = ['rethrows', 'reports'];

interface Commit {
  tags: string[];
  prev: string;
  next: string;
  dirtyText: string[];
}

const $text = () => $getRoot().getTextContent();
const $p = (text: string) =>
  $createParagraphNode().append($createTextNode(text));
const textOf = (state: EditorState) => state.read($text);
/** The text node of a paragraph. */
const $textOf = (paragraph: LexicalNode) =>
  (paragraph as ParagraphNode).getFirstChildOrThrow() as TextNode;
const $first = () => $textOf($getRoot().getFirstChildOrThrow());
const $last = () => $textOf($getRoot().getLastChildOrThrow());

function setUp(mode: Mode, configure?: (editor: LexicalEditor) => void) {
  const errors: Error[] = [];
  const editor = createEditor({
    onError: error => {
      errors.push(error);
      if (mode === 'rethrows') {
        throw error;
      }
    },
  });
  configure?.(editor);
  editor.update(
    () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('one')),
        $createParagraphNode().append($createTextNode('two')),
      );
    },
    {discrete: true},
  );
  const commits: Commit[] = [];
  editor.registerUpdateListener(
    ({tags, prevEditorState, editorState, dirtyLeaves}) => {
      commits.push({
        dirtyText: editorState.read(() =>
          [...dirtyLeaves].map(key => {
            const node = editorState._nodeMap.get(key);
            return node instanceof TextNode ? node.getTextContent() : key;
          }),
        ),
        next: textOf(editorState),
        prev: textOf(prevEditorState),
        tags: [...tags].sort(),
      });
    },
  );
  return {commits, editor, errors};
}

/** Runs an update that fails; the app catches what onError rethrows. */
function fail(mode: Mode, run: () => void) {
  if (mode === 'rethrows') {
    expect(run).toThrow('app bug');
  } else {
    run();
  }
}

/** The next update commits alone: its own change, with its own tag. */
function expectNextUpdateAlone(
  editor: LexicalEditor,
  commits: Commit[],
  before: string,
) {
  commits.length = 0;
  editor.update(() => void $last().setTextContent('two!'), {
    discrete: true,
    tag: 'next',
  });
  expect(commits).toEqual([
    {
      dirtyText: ['two!'],
      next: before.replace(/two$/, 'two!'),
      prev: before,
      tags: ['next'],
    },
  ]);
}

describe.each(MODES)('an update that throws, onError %s', mode => {
  for (const discrete of [true, false]) {
    test(`a callback that changes text, then throws (discrete: ${discrete})`, () => {
      const {editor, errors, commits} = setUp(mode);
      fail(mode, () =>
        editor.update(
          () => {
            $first().setTextContent('CHANGED');
            throw new Error('app bug');
          },
          discrete ? {discrete, tag: 'failed'} : {tag: 'failed'},
        ),
      );
      expect(errors.map(e => e.message)).toEqual(['app bug']);
      expect(textOf(editor.getEditorState())).toBe('one\n\ntwo');
      expectNextUpdateAlone(editor, commits, 'one\n\ntwo');
    });
  }

  test('a callback that throws before any change, then an update that changes nothing', async () => {
    // As a collaboration binding's read of a remote change that changes
    // nothing here: an update that reused the failed update's pending state
    // would leave its tag to the next commit.
    const {editor, commits} = setUp(mode);
    fail(mode, () =>
      editor.update(
        () => {
          throw new Error('app bug');
        },
        {discrete: true},
      ),
    );
    editor.update(() => {}, {discrete: true, tag: COLLABORATION_TAG});
    expectNextUpdateAlone(editor, commits, 'one\n\ntwo');
    expect(editor._pendingEditorState).toBe(null);
  });

  test('a transform that throws', () => {
    const {editor, commits} = setUp(mode, e =>
      e.registerNodeTransform(TextNode, node => {
        if (node.getTextContent() === 'boom') {
          throw new Error('app bug');
        }
      }),
    );
    fail(mode, () =>
      editor.update(() => void $first().setTextContent('boom'), {
        discrete: true,
      }),
    );
    expect(textOf(editor.getEditorState())).toBe('one\n\ntwo');
    expectNextUpdateAlone(editor, commits, 'one\n\ntwo');
  });

  test('a nested update that throws discards the update it is part of', () => {
    const {editor, commits} = setUp(mode);
    fail(mode, () =>
      editor.update(
        () => {
          $first().setTextContent('ONE');
          editor.update(() => {
            $last().setTextContent('TWO');
            throw new Error('app bug');
          });
        },
        {discrete: true},
      ),
    );
    expect(textOf(editor.getEditorState())).toBe('one\n\ntwo');
    expectNextUpdateAlone(editor, commits, 'one\n\ntwo');
  });

  test('an update batched after another one discards both', async () => {
    const {editor, commits} = setUp(mode);
    editor.update(() => void $first().setTextContent('ONE'));
    fail(mode, () =>
      editor.update(() => {
        $last().setTextContent('TWO');
        throw new Error('app bug');
      }),
    );
    // The commit the first update scheduled finds nothing to commit.
    await Promise.resolve();
    expect(textOf(editor.getEditorState())).toBe('one\n\ntwo');
    expectNextUpdateAlone(editor, commits, 'one\n\ntwo');
  });

  test('a selection change listener that throws', () => {
    const {editor, commits} = setUp(mode, e =>
      e.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          $first().setTextContent('CHANGED');
          throw new Error('app bug');
        },
        COMMAND_PRIORITY_EDITOR,
      ),
    );
    fail(mode, () =>
      editor.update(
        () => {
          // A NodeSelection notifies its listeners in a headless editor too.
          const selection = $createNodeSelection();
          selection.add($last().getKey());
          $setSelection(selection);
        },
        {discrete: true},
      ),
    );
    expect(textOf(editor.getEditorState())).toBe('one\n\ntwo');
    expect(editor.getEditorState()._selection).toBe(null);
    expectNextUpdateAlone(editor, commits, 'one\n\ntwo');
  });

  test('what the failed update committed before it threw stays', () => {
    const {editor, commits} = setUp(mode);
    const other = editor.parseEditorState(editor.getEditorState().toJSON());
    fail(mode, () =>
      editor.update(
        () => {
          $first().setTextContent('ONE');
          // Commits what this update changed so far; the state it sets is
          // pending.
          editor.setEditorState(other);
          throw new Error('app bug');
        },
        {discrete: true},
      ),
    );
    // Its listeners saw 'ONE' committed.
    expect(commits.map(c => c.next)).toContain('ONE\n\ntwo');
    expect(textOf(editor.getEditorState())).toBe('ONE\n\ntwo');
    expectNextUpdateAlone(editor, commits, 'ONE\n\ntwo');
  });
});

describe.each(MODES)(
  'error handling of an update that throws, onError %s',
  mode => {
    test('a read in onError sees the committed state and commits nothing of the failed update', () => {
      const reads: string[] = [];
      const errors: Error[] = [];
      const editor = createEditor({
        onError: error => {
          errors.push(error);
          reads.push(editor.read($text));
          if (mode === 'rethrows') {
            throw error;
          }
        },
      });
      editor.update(() => void $getRoot().append($p('one'), $p('two')), {
        discrete: true,
      });
      fail(mode, () =>
        editor.update(
          () => {
            $first().setTextContent('FAILED');
            throw new Error('app bug');
          },
          {discrete: true},
        ),
      );
      expect(reads).toEqual(['one\n\ntwo']);
      expect(textOf(editor.getEditorState())).toBe('one\n\ntwo');
    });

    test('the updates it queued are dropped with it', async () => {
      const {editor, commits} = setUp(mode);
      fail(mode, () =>
        editor.update(
          () => {
            $first().setTextContent('ONE');
            editor.update(() => void $last().setTextContent('TWO'));
            throw new Error('app bug');
          },
          {discrete: true},
        ),
      );
      await Promise.resolve();
      expect(textOf(editor.getEditorState())).toBe('one\n\ntwo');
      expectNextUpdateAlone(editor, commits, 'one\n\ntwo');
    });

    test('the updates queued before it still run', async () => {
      const {editor} = setUp(mode);
      editor.registerUpdateListener(({tags}) => {
        if (tags.has('queue')) {
          editor.update(() => {
            throw new Error('app bug');
          });
          editor.update(() => void $last().setTextContent('TWO'));
        }
      });
      fail(mode, () =>
        editor.update(() => void $first().setTextContent('ONE'), {
          discrete: true,
          tag: 'queue',
        }),
      );
      await Promise.resolve();
      expect(textOf(editor.getEditorState())).toBe('ONE\n\nTWO');
    });

    test('an error thrown while the editor is restored is reported too', () => {
      const {editor, errors} = setUp(mode);
      let armed = true;
      editor.registerUpdateListener(() => {
        if (armed) {
          armed = false;
          throw new Error('listener bug');
        }
      });
      const run = () =>
        editor.update(
          () => {
            $first().setTextContent('FAILED');
            throw new Error('app bug');
          },
          {discrete: true},
        );
      if (mode === 'rethrows') {
        // The caller gets the error onError rethrew.
        expect(run).toThrow('app bug');
        expect(errors.map(e => e.message)).toEqual(['app bug', 'listener bug']);
      } else {
        expect(run).toThrow('listener bug');
        expect(errors.map(e => e.message)).toEqual(['app bug']);
      }
      expect(textOf(editor.getEditorState())).toBe('one\n\ntwo');
    });

    test('an update onError queues runs, also when restoring the editor throws', async () => {
      const errors: Error[] = [];
      const editor = createEditor({
        onError: error => {
          errors.push(error);
          if (error.message === 'app bug') {
            editor.update(() => void $first().setTextContent('repaired'), {
              discrete: true,
            });
          }
          if (mode === 'rethrows') {
            throw error;
          }
        },
      });
      editor.update(() => void $getRoot().append($p('one'), $p('two')), {
        discrete: true,
      });
      let armed = true;
      editor.registerUpdateListener(() => {
        if (armed) {
          armed = false;
          throw new Error('listener bug');
        }
      });
      expect(() =>
        editor.update(
          () => {
            $first().setTextContent('FAILED');
            throw new Error('app bug');
          },
          {discrete: true},
        ),
      ).toThrow(mode === 'rethrows' ? 'app bug' : 'listener bug');
      await Promise.resolve();
      expect(textOf(editor.getEditorState())).toBe('repaired\n\ntwo');
    });

    test('a nested update sharing its pending state: reported once, discarded as a whole', () => {
      const {editor, errors, commits} = setUp(mode, e =>
        e.registerCommand(
          SELECTION_CHANGE_COMMAND,
          () => {
            throw new Error('app bug');
          },
          COMMAND_PRIORITY_EDITOR,
        ),
      );
      const other = createEditor({onError: e => void errors.push(e)});
      other.update(() => void $getRoot().append($p('other')), {discrete: true});
      const otherState = editor.parseEditorState(
        other.getEditorState().toJSON(),
      );
      fail(mode, () =>
        editor.update(
          () => {
            $first().setTextContent('ONE');
            const selection = $createNodeSelection();
            selection.add($last().getKey());
            $setSelection(selection);
            // Commits this update so far: its selection change notifies the
            // listener, which throws.
            editor.setEditorState(otherState);
          },
          {discrete: true},
        ),
      );
      expect(errors.map(e => e.message)).toEqual(['app bug']);
      expect(textOf(editor.getEditorState())).toBe('one\n\ntwo');
      expectNextUpdateAlone(editor, commits, 'one\n\ntwo');
    });
  },
);

describe('an update listener that throws', () => {
  test('does not undo the commit, whatever onError does', () => {
    for (const mode of MODES) {
      const {editor, errors} = setUp(mode);
      const remove = editor.registerUpdateListener(() => {
        throw new Error('listener bug');
      });
      expect(() =>
        editor.update(() => void $first().setTextContent('ONE'), {
          discrete: true,
        }),
      ).toThrow('listener bug');
      remove();
      // Not an error of the update: onError is not called.
      expect(errors).toEqual([]);
      expect(editor._pendingEditorState).toBe(null);
      expect(textOf(editor.getEditorState())).toBe('ONE\n\ntwo');
    }
  });
});
