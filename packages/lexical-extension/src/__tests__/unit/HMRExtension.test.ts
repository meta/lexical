/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {HMRHistoryState} from '../../HMRExtension';

import {
  buildEditorFromExtensions,
  configExtension,
  getExtensionDependencyFromEditor,
  HMRExtension,
  type HotContext,
} from '@lexical/extension';
import {
  createEmptyHistoryState,
  HistoryExtension,
  type HistoryState,
  type HistoryStateEntry,
  SharedHistoryExtension,
} from '@lexical/history';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getState,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $setSelection,
  $setState,
  createEditor as createPlainEditor,
  createState,
  defineExtension,
  type EditorState,
  HISTORY_PUSH_TAG,
  type LexicalEditor,
  REDO_COMMAND,
  TextNode,
  UNDO_COMMAND,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, onTestFinished, test, vi} from 'vitest';

import {serializeEditorStateFamily} from '../../editorStateFamily';

const markerState = createState('hmr-test-marker', {
  parse: (value: unknown) => (typeof value === 'string' ? value : ''),
});

function createMockHotContext(): HotContext {
  return {data: {}};
}

function $setupContent(text: string) {
  $getRoot()
    .clear()
    .append($createParagraphNode().append($createTextNode(text)));
}

function $setupParagraphs(...texts: string[]) {
  $getRoot()
    .clear()
    .append(
      ...texts.map(text =>
        $createParagraphNode().append($createTextNode(text)),
      ),
    );
}

/** Reads the caret/selection as `[anchorPath, anchorOffset, focusPath, focusOffset]`. */
function $readRangeSelection() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return null;
  }
  const describePoint = (point: {
    getNode: () => {getTextContent: () => string};
    offset: number;
  }) => [point.getNode().getTextContent(), point.offset] as const;
  return [describePoint(selection.anchor), describePoint(selection.focus)];
}

/**
 * Builds an EditorState detached from any live editor, standing in for the
 * state that a previous module instance would have stashed in `hot.data`.
 */
function createDetachedEditorState(): EditorState {
  using editor = buildEditorFromExtensions(
    defineExtension({name: 'detached-editor-state-source'}),
  );
  return editor.getEditorState();
}

// Stable namespace shared by all test helpers so HMR keys are consistent
// across createEditor / createEditorNoHistory / createEditorNoInitialState.
const TEST_NAMESPACE = 'hmr-test';
// Must match `lexicalHMR:${TEST_NAMESPACE}` produced by getHMRKey in HMRExtension.ts
const TEST_HMR_KEY = `lexicalHMR:${TEST_NAMESPACE}`;

function createEditor(hot: HotContext | null, id?: string) {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => $setupContent('initial'),
      dependencies: [
        HistoryExtension,
        configExtension(HMRExtension, {hot, id}),
      ],
      name: 'hmr-test',
      namespace: TEST_NAMESPACE,
    }),
  );
}

function createEditorNoHistory(hot: HotContext) {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => $setupContent('initial'),
      dependencies: [configExtension(HMRExtension, {hot})],
      name: 'hmr-no-history-test',
      namespace: TEST_NAMESPACE,
    }),
  );
}

function createEditorWithNamespace(hot: HotContext, namespace: string) {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => $setupContent('initial'),
      dependencies: [configExtension(HMRExtension, {hot})],
      name: `editor-${namespace}`,
      namespace,
    }),
  );
}

/** The plain-data payload the previous module instance hands over. */
interface SavedPayload {
  family: {
    nodes: {json: {type: string}}[];
    states: {nodes: number[]}[];
  };
  history: {current: number | null; redoStack: number[]; undoStack: number[]};
}

/** An editor whose document is large enough for sharing to be measurable. */
function createSeededEditor(hot: HotContext | null, namespace: string) {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => {
        const root = $getRoot().clear();
        for (let index = 0; index < 20; index++) {
          root.append(
            $createParagraphNode().append(
              $createTextNode(`paragraph ${index}`),
            ),
          );
        }
      },
      dependencies: [
        HistoryExtension,
        ...(hot === null ? [] : [configExtension(HMRExtension, {hot})]),
      ],
      name: `seeded-${namespace}`,
      namespace,
    }),
  );
}

function entriesOf(historyState: {
  current: null | HistoryStateEntry;
  redoStack: HistoryStateEntry[];
  undoStack: HistoryStateEntry[];
}): HistoryStateEntry[] {
  return [
    ...(historyState.current ? [historyState.current] : []),
    ...historyState.undoStack,
    ...historyState.redoStack,
  ];
}

function restoreCountOf(editor: LexicalEditor) {
  return getExtensionDependencyFromEditor(
    editor,
    HMRExtension,
  ).output.restoreCount.peek();
}

function historyStateOf(editor: LexicalEditor) {
  return getExtensionDependencyFromEditor(
    editor,
    HistoryExtension,
  ).output.historyState.peek();
}

/** The payload shape a snapshot of a single, historyless state produces. */
function serializeEmptyState(editorState: EditorState) {
  return {family: serializeEditorStateFamily([editorState]), history: null};
}

function savedSnapshot(hot: HotContext, key = TEST_HMR_KEY) {
  return hot.data[key] as {
    editorState: EditorState;
    serialize: () => SavedPayload;
  };
}

/** Replaces `serialize` with one that mangles the payload it produced. */
function corruptPayload(
  hot: HotContext,
  corrupt: (payload: SavedPayload) => void,
) {
  const saved = savedSnapshot(hot);
  const {serialize} = saved;
  saved.serialize = () => {
    const payload = serialize();
    corrupt(payload);
    return payload;
  };
}

/** An editor is only "in use" once it has a root element. */
function mount(editor: {setRootElement: (el: HTMLElement) => void}) {
  editor.setRootElement(document.createElement('div'));
}

function createEditorNoInitialState(hot: HotContext) {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [configExtension(HMRExtension, {hot})],
      name: 'hmr-no-initial-state-test',
      namespace: TEST_NAMESPACE,
    }),
  );
}

describe('HMRExtension', () => {
  test('preserves editor content through HMR cycle', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      editor.update(() => $setupContent('hello HMR'), {discrete: true});
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('hello HMR');
      });
    }

    {
      using editor = createEditor(hot);
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('hello HMR');
      });
    }
  });

  test('preserves editable flag through HMR cycle', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      editor.setEditable(false);
    }

    {
      using editor = createEditor(hot);
      expect(editor.isEditable()).toBe(false);
    }
  });

  test('preserves undo and redo history through HMR cycle', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      editor.update(() => $setupContent('first'), {discrete: true});
      editor.update(() => $setupContent('second'), {
        discrete: true,
        tag: HISTORY_PUSH_TAG,
      });
    }

    {
      using editor = createEditor(hot);
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('second');
      });
      editor.dispatchCommand(UNDO_COMMAND, undefined);
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('first');
      });
      editor.dispatchCommand(REDO_COMMAND, undefined);
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('second');
      });
    }
  });

  test('preserves state through multiple HMR cycles', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      editor.update(() => $setupContent('cycle-1'), {discrete: true});
    }

    {
      using editor = createEditor(hot);
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('cycle-1');
      });
      editor.update(() => $setupContent('cycle-2'), {discrete: true});
    }

    {
      using editor = createEditor(hot);
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('cycle-2');
      });
    }
  });

  test('does nothing when hot is null', () => {
    using editor = createEditor(null);
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('initial');
    });
  });

  test('starts fresh when saved state is corrupted', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      editor.update(() => $setupContent('lost'), {discrete: true});
    }

    // A node of the document is now of a type the editor does not register
    corruptPayload(hot, payload => {
      for (const node of payload.family.nodes) {
        if (node.json.type === 'paragraph') {
          node.json.type = '__hmr_corrupt_node__';
        }
      }
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    using editor = createEditor(hot);
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('initial');
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not restore previous editor state'),
    );
  });

  test('starts fresh when saved state has invalid shape', () => {
    const hot = createMockHotContext();
    // An older extension format, whose `editorState` is not an EditorState.
    // editable: false proves the entire payload is rejected — not just the wrong fields
    hot.data[TEST_HMR_KEY] = {
      editable: false,
      editorState: {_nodeMap: new Map()},
      editorStateJSON: {root: {children: []}},
      historyStateJSON: null,
    };

    using editor = createEditor(hot);
    // isEditable() must be true (default) since the invalid-shape payload was rejected
    expect(editor.isEditable()).toBe(true);
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('initial');
    });
  });

  test('uses initial state when saved editorState is empty', () => {
    const hot = createMockHotContext();

    const empty = createDetachedEditorState();
    hot.data[TEST_HMR_KEY] = {
      editable: false,
      editorState: empty,
      serialize: () => serializeEmptyState(empty),
    };

    using editor = createEditor(hot);
    expect(editor.isEditable()).toBe(false);
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('initial');
    });
  });

  test('preserves independent state for multiple editors sharing one HotContext', () => {
    const hot = createMockHotContext();

    {
      using editor1 = createEditor(hot, 'a');
      using editor2 = createEditor(hot, 'b');
      // Write b first so that a broken shared-key impl would leave 'content-b' for both
      editor2.update(() => $setupContent('content-b'), {discrete: true});
      editor1.update(() => $setupContent('content-a'), {discrete: true});
    }

    {
      using editor1 = createEditor(hot, 'a');
      using editor2 = createEditor(hot, 'b');
      editor1.read(() => {
        const text = $getRoot().getTextContent();
        expect(text).toBe('content-a');
        expect(text).not.toBe('content-b');
      });
      editor2.read(() => {
        const text = $getRoot().getTextContent();
        expect(text).toBe('content-b');
        expect(text).not.toBe('content-a');
      });
    }

    // Underlying hot.data keys must be distinct and include namespace
    expect(hot.data[`lexicalHMR:${TEST_NAMESPACE}:a`]).toBeDefined();
    expect(hot.data[`lexicalHMR:${TEST_NAMESPACE}:b`]).toBeDefined();
    expect(hot.data[`lexicalHMR:${TEST_NAMESPACE}:a`]).not.toBe(
      hot.data[`lexicalHMR:${TEST_NAMESPACE}:b`],
    );
  });

  test('preserves independent undo/redo history for multiple editors sharing one HotContext', () => {
    const hot = createMockHotContext();

    {
      using editor1 = createEditor(hot, 'a');
      using editor2 = createEditor(hot, 'b');
      editor1.update(() => $setupContent('a1'), {discrete: true});
      editor1.update(() => $setupContent('a2'), {
        discrete: true,
        tag: HISTORY_PUSH_TAG,
      });
      editor2.update(() => $setupContent('b1'), {discrete: true});
      editor2.update(() => $setupContent('b2'), {
        discrete: true,
        tag: HISTORY_PUSH_TAG,
      });
    }

    {
      using editor1 = createEditor(hot, 'a');
      using editor2 = createEditor(hot, 'b');
      editor1.dispatchCommand(UNDO_COMMAND, undefined);
      editor2.dispatchCommand(UNDO_COMMAND, undefined);
      editor1.read(() => {
        expect($getRoot().getTextContent()).toBe('a1');
      });
      editor2.read(() => {
        expect($getRoot().getTextContent()).toBe('b1');
      });
    }
  });

  test('drops only the history entry that cannot be restored', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      editor.update(() => $setupContent('first'), {discrete: true});
      editor.update(() => $setupContent('second'), {
        discrete: true,
        tag: HISTORY_PUSH_TAG,
      });
      editor.update(() => $setupContent('third'), {
        discrete: true,
        tag: HISTORY_PUSH_TAG,
      });
    }

    // Corrupt a node version that only the oldest undo entry uses, leaving
    // the document and the newer entry intact
    corruptPayload(hot, payload => {
      expect(payload.history.undoStack.length).toBeGreaterThan(1);
      const shared = new Set(payload.family.states[0].nodes);
      const oldest = payload.family.states[payload.history.undoStack[0]];
      const own = oldest.nodes.filter(id => !shared.has(id));
      expect(own.length).toBeGreaterThan(0);
      payload.family.nodes[own[0]].json.type = '__hmr_corrupt_node__';
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    using editor = createEditor(hot);
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('third');
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Dropped 1 undo/redo entry'),
    );
    // The surviving entry is still there — one bad entry does not cost the
    // whole history
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('second');
    });
  });

  test('warns when two mounted editors share an HMR key', () => {
    const hot = createMockHotContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());

    using editor1 = createEditorWithNamespace(hot, 'shared-key-ns');
    using editor2 = createEditorWithNamespace(hot, 'shared-key-ns');
    mount(editor1);
    mount(editor2);
    editor1.update(() => $setupContent('one'), {discrete: true});
    editor2.update(() => $setupContent('two'), {discrete: true});
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Two mounted editors are sharing the HMR key "lexicalHMR:shared-key-ns"',
      ),
    );
  });

  test('does not warn when a replacement editor overlaps the one it replaces', () => {
    const hot = createMockHotContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());

    // The shape LexicalExtensionComposer produces on an HMR cycle: the
    // replacement is built (during render) while the old editor is still
    // mounted, and the old one is disposed afterwards (effect cleanup).
    const previous = createEditorWithNamespace(hot, 'swap-ns');
    mount(previous);
    previous.update(() => $setupContent('typed'), {discrete: true});

    using next = createEditorWithNamespace(hot, 'swap-ns');
    previous.dispose();
    mount(next);
    next.update(() => $setupContent('typed again'), {discrete: true});

    next.read(() => {
      expect($getRoot().getTextContent()).toBe('typed again');
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test('does not warn for an editor that was built but never mounted', () => {
    const hot = createMockHotContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());

    // React StrictMode renders twice, so the first editor of a pair is
    // discarded without ever being mounted (or disposed).
    using _discarded = createEditorWithNamespace(hot, 'discarded-ns');
    using kept = createEditorWithNamespace(hot, 'discarded-ns');
    mount(kept);
    kept.update(() => $setupContent('kept'), {discrete: true});
    expect(warn).not.toHaveBeenCalled();
  });

  test('does not warn for a single editor without id', () => {
    const hot = createMockHotContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());

    using _editor = createEditor(hot);
    expect(warn).not.toHaveBeenCalled();
  });

  test('does not warn when multiple editors provide distinct ids', () => {
    const hot = createMockHotContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());

    using _e1 = createEditor(hot, 'a');
    using _e2 = createEditor(hot, 'b');
    expect(warn).not.toHaveBeenCalled();
  });

  test('isolates two editors by namespace without requiring id', () => {
    const hot = createMockHotContext();

    {
      using main = createEditorWithNamespace(hot, 'main-ns');
      using sidebar = createEditorWithNamespace(hot, 'sidebar-ns');
      main.update(() => $setupContent('main-content'), {discrete: true});
      sidebar.update(() => $setupContent('sidebar-content'), {discrete: true});
    }

    {
      using main = createEditorWithNamespace(hot, 'main-ns');
      using sidebar = createEditorWithNamespace(hot, 'sidebar-ns');
      main.read(() => {
        expect($getRoot().getTextContent()).toBe('main-content');
      });
      sidebar.read(() => {
        expect($getRoot().getTextContent()).toBe('sidebar-content');
      });
    }

    // Distinct namespace-based keys, no id needed
    expect(hot.data['lexicalHMR:main-ns']).toBeDefined();
    expect(hot.data['lexicalHMR:sidebar-ns']).toBeDefined();
  });

  test('does not warn when multiple editors have distinct namespaces and no id', () => {
    const hot = createMockHotContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());

    using _e1 = buildEditorFromExtensions(
      defineExtension({
        dependencies: [configExtension(HMRExtension, {hot})],
        name: 'ns-a-editor',
        namespace: 'ns-a',
      }),
    );
    using _e2 = buildEditorFromExtensions(
      defineExtension({
        dependencies: [configExtension(HMRExtension, {hot})],
        name: 'ns-b-editor',
        namespace: 'ns-b',
      }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  test('warns in dev when id is an empty string', () => {
    const hot = createMockHotContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());

    using editor = createEditor(hot, '');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('`id` must not be an empty string'),
    );
    // Editor still initializes despite the warning
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('initial');
    });
  });

  test('does not warn on sequential HMR cycles without id', () => {
    const hot = createMockHotContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());

    createEditor(hot).dispose();
    createEditor(hot).dispose();
    createEditor(hot).dispose();
    expect(warn).not.toHaveBeenCalled();
  });

  test('preserves editable flag even when saved state fails to parse', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      editor.setEditable(false);
      editor.update(() => $setupContent('lost'), {discrete: true});
    }

    corruptPayload(hot, payload => {
      for (const node of payload.family.nodes) {
        if (node.json.type === 'paragraph') {
          node.json.type = '__hmr_corrupt_node__';
        }
      }
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    using editor = createEditor(hot);
    // setEditable runs before the content is rebuilt, so it is preserved
    // even though the content could not be
    expect(editor.isEditable()).toBe(false);
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('initial');
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not restore previous editor state'),
    );
  });

  test('silently skips history when saved historyState has invalid shape', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      editor.update(() => $setupContent('valid'), {
        discrete: true,
        tag: HISTORY_PUSH_TAG,
      });
    }

    // Corrupt only undoStack shape — isValidHistoryState returns false,
    // history block is skipped silently (no warning, no createEmptyHistoryState call)
    const saved = hot.data[TEST_HMR_KEY] as {historyState: unknown};
    saved.historyState = {
      current: null,
      redoStack: [],
      undoStack: 'not-an-array',
    };

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    using editor = createEditor(hot);
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('valid');
    });
    // Invalid shape is treated as no saved history — no warning expected
    expect(warn).not.toHaveBeenCalled();
    // Undo is a no-op since history was not restored
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('valid');
    });
  });

  test('warns when saved history exists but HistoryExtension is no longer present', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot); // includes HistoryExtension
      editor.update(() => $setupContent('with-history'), {discrete: true});
    }
    // Saved state now has a non-null historyState from HistoryExtension

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    using editor = createEditorNoHistory(hot);
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('with-history');
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Saved undo/redo history discarded'),
    );
  });

  test('works without HistoryExtension', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditorNoHistory(hot);
      editor.update(() => $setupContent('no history'), {discrete: true});
    }

    {
      using editor = createEditorNoHistory(hot);
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('no history');
      });
    }
  });

  test('preserves state for an editor with no configured namespace', () => {
    const hot = createMockHotContext();
    const createUnnamespaced = () =>
      buildEditorFromExtensions(
        defineExtension({
          $initialEditorState: () => $setupContent('initial'),
          dependencies: [configExtension(HMRExtension, {hot})],
          name: 'no-namespace-editor',
        }),
      );

    {
      using editor = createUnnamespaced();
      editor.update(() => $setupContent('no namespace'), {discrete: true});
    }

    {
      using editor = createUnnamespaced();
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('no namespace');
      });
    }

    // createEditor generates a fresh random namespace for each of these
    // editors, so the key must not be built from it: one stable key, rather
    // than an orphaned entry pinning an EditorState for every cycle
    expect(Object.keys(hot.data)).toEqual(['lexicalHMR:']);
  });

  test('preserves the caret of an undo history entry', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      editor.update(
        () => {
          $setupParagraphs('alpha');
          $getRoot().getLastDescendant()!.selectEnd();
        },
        {discrete: true},
      );
      editor.update(() => $setupParagraphs('bravo'), {
        discrete: true,
        tag: HISTORY_PUSH_TAG,
      });
    }

    {
      using editor = createEditor(hot);
      editor.dispatchCommand(UNDO_COMMAND, undefined);
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('alpha');
        expect($readRangeSelection()).toEqual([
          ['alpha', 5],
          ['alpha', 5],
        ]);
      });
    }
  });

  test('preserves a collapsed caret through an HMR cycle', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      editor.update(
        () => {
          $setupParagraphs('first paragraph', 'second paragraph');
          $getRoot().getLastDescendant()!.selectStart();
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.anchor.offset = 6;
            selection.focus.offset = 6;
          }
        },
        {discrete: true},
      );
    }

    {
      using editor = createEditor(hot);
      editor.read(() => {
        expect($readRangeSelection()).toEqual([
          ['second paragraph', 6],
          ['second paragraph', 6],
        ]);
      });
    }
  });

  test('preserves a selection spanning two paragraphs through an HMR cycle', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      editor.update(
        () => {
          $setupParagraphs('alpha', 'beta');
          const root = $getRoot();
          root
            .getFirstDescendant()!
            .selectStart()
            .focus.set(root.getLastDescendant()!.getKey(), 4, 'text');
        },
        {discrete: true},
      );
    }

    {
      using editor = createEditor(hot);
      editor.read(() => {
        expect($readRangeSelection()).toEqual([
          ['alpha', 0],
          ['beta', 4],
        ]);
      });
    }
  });

  test('preserves a node selection through an HMR cycle', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      editor.update(
        () => {
          $setupParagraphs('one', 'two');
          const selection = $createNodeSelection();
          selection.add($getRoot().getChildAtIndex(1)!.getKey());
          $setSelection(selection);
        },
        {discrete: true},
      );
    }

    {
      using editor = createEditor(hot);
      editor.read(() => {
        const selection = $getSelection();
        expect($isNodeSelection(selection)).toBe(true);
        expect(
          selection!.getNodes().map(node => node.getTextContent()),
        ).toEqual(['two']);
      });
    }
  });

  test('restores the content when the saved selection no longer resolves', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      editor.update(() => $setupParagraphs('kept'), {discrete: true});
    }

    // A path into a child that the restored document does not have
    const saved = hot.data[TEST_HMR_KEY] as {captureSelection: () => unknown};
    saved.captureSelection = () => ({
      anchor: {offset: 0, path: [7, 0], type: 'text'},
      focus: {offset: 0, path: [7, 0], type: 'text'},
      format: 0,
      style: '',
      type: 'range',
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    using editor = createEditor(hot);
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('kept');
      expect($getSelection()).toBe(null);
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test('starts fresh when serializing the previous states throws', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      editor.update(() => $setupParagraphs('lost'), {discrete: true});
    }

    savedSnapshot(hot).serialize = () => {
      throw new Error('no active editor state');
    };

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    using editor = createEditor(hot);
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('initial');
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not restore previous editor state'),
      expect.anything(),
    );
  });

  test('does not serialize anything until the state is restored', () => {
    const hot = createMockHotContext();

    using editor = createEditor(hot);
    editor.update(() => $setupParagraphs('typed'), {discrete: true});

    const saved = savedSnapshot(hot);
    // Still the live state and a closure over it — nothing has been copied
    expect(saved.editorState).toBe(editor.getEditorState());
    expect(typeof saved.serialize).toBe('function');
  });

  test('stores a reference to the live editor state instead of a serialized copy', () => {
    const hot = createMockHotContext();

    using editor = createEditor(hot);
    editor.update(() => $setupContent('live'), {discrete: true});

    const saved = hot.data[TEST_HMR_KEY] as {editorState: EditorState};
    expect(saved.editorState).toBe(editor.getEditorState());
  });

  test('serialization work does not grow with the number of editor updates', () => {
    // Counts how many nodes are serialized over a full HMR cycle (edits,
    // reload, restore). HistoryExtension is left out so that the undo stack —
    // the only other thing that is serialized — stays empty and the number of
    // updates is the sole variable.
    const countSerializedNodesForCycle = (updates: number): number => {
      const hot = createMockHotContext();
      const exportJSON = vi.spyOn(TextNode.prototype, 'exportJSON');
      try {
        {
          using editor = createEditorNoHistory(hot);
          for (let i = 0; i < updates; i++) {
            editor.update(() => $setupContent(`update-${i}`), {
              discrete: true,
            });
          }
          expect(exportJSON).not.toHaveBeenCalled();
        }
        {
          using editor = createEditorNoHistory(hot);
          editor.read(() => {
            expect($getRoot().getTextContent()).toBe(`update-${updates - 1}`);
          });
        }
        return exportJSON.mock.calls.length;
      } finally {
        exportJSON.mockRestore();
      }
    };

    // The one text node of the document, once, no matter how much editing
    // happened before the reload
    expect(countSerializedNodesForCycle(2)).toBe(1);
    expect(countSerializedNodesForCycle(50)).toBe(1);
  });

  test('does not re-run transforms over the document on every undo', () => {
    const hot = createMockHotContext();
    let transforms = 0;
    const createCounting = (hotContext: HotContext | null) => {
      const editor = createSeededEditor(hotContext, 'transform-ns');
      editor.registerNodeTransform(TextNode, () => {
        transforms++;
      });
      return editor;
    };
    const $edit = (index: number) => {
      $assertNodeType($getRoot().getChildAtIndex(index), $isElementNode).append(
        $createTextNode(` edit ${index}`),
      );
    };
    const undoTransforms = (editor: LexicalEditor): number => {
      transforms = 0;
      editor.dispatchCommand(UNDO_COMMAND, undefined);
      return transforms;
    };
    const $editTwice = (editor: LexicalEditor) => {
      for (const index of [0, 1]) {
        editor.update(() => $edit(index), {
          discrete: true,
          tag: HISTORY_PUSH_TAG,
        });
      }
    };

    // What an undo costs with no HMR in the picture at all
    let baseline = -1;
    {
      using editor = createCounting(null);
      $editTwice(editor);
      baseline = undoTransforms(editor);
    }

    {
      using editor = createCounting(hot);
      $editTwice(editor);
    }

    {
      using editor = createCounting(hot);
      // A restored history entry is a reproduction of a state that was once
      // live, not a freshly parsed document: undoing into it must not mark
      // every node dirty and re-run every transform, and must not keep doing
      // so on every undo after that
      expect(undoTransforms(editor)).toBe(baseline);
      expect(undoTransforms(editor)).toBe(baseline);
    }
  });

  test('preserves state for an editor whose namespace is an empty string', () => {
    const hot = createMockHotContext();
    // createEditor generates a namespace for any falsy value, so '' is not a
    // choice of namespace — it is the same random string per reload that no
    // namespace at all would be
    const createEmptyNamespaced = () =>
      buildEditorFromExtensions(
        defineExtension({
          $initialEditorState: () => $setupContent('initial'),
          dependencies: [configExtension(HMRExtension, {hot})],
          name: 'empty-namespace-editor',
          namespace: '',
        }),
      );

    {
      using editor = createEmptyNamespaced();
      expect(editor._config.namespace).not.toBe('');
      editor.update(() => $setupContent('typed'), {discrete: true});
    }

    {
      using editor = createEmptyNamespaced();
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('typed');
      });
    }

    expect(Object.keys(hot.data)).toEqual(['lexicalHMR:']);
  });

  test('keys a namespace containing the separator apart from a namespace and id', () => {
    const hot = createMockHotContext();
    const createColonEditor = (
      namespace: string,
      id: string | undefined,
      text: string,
    ) =>
      buildEditorFromExtensions(
        defineExtension({
          $initialEditorState: () => $setupContent(text),
          dependencies: [configExtension(HMRExtension, {hot, id})],
          name: `colon-${namespace}-${id}`,
          namespace,
        }),
      );

    {
      using joined = createColonEditor('app:sidebar', undefined, 'joined');
      using split = createColonEditor('app', 'sidebar', 'split');
      joined.update(() => $setupContent('joined content'), {discrete: true});
      split.update(() => $setupContent('split content'), {discrete: true});
      // Two editors, two keys — not one key that each overwrites in turn
      expect(Object.keys(hot.data)).toHaveLength(2);
    }

    {
      using joined = createColonEditor('app:sidebar', undefined, 'joined');
      using split = createColonEditor('app', 'sidebar', 'split');
      joined.read(() => {
        expect($getRoot().getTextContent()).toBe('joined content');
      });
      split.read(() => {
        expect($getRoot().getTextContent()).toBe('split content');
      });
    }
  });

  test('preserves state for a nested editor under a plain unnamespaced parent', () => {
    const hot = createMockHotContext();
    const createNested = () => {
      // A parent built by createEditor rather than from extensions: nothing
      // records whether the namespace it is using was chosen or generated, and
      // this one was generated
      const parent = createPlainEditor();
      const nested = buildEditorFromExtensions(
        defineExtension({
          $initialEditorState: () => $setupContent('initial'),
          dependencies: [configExtension(HMRExtension, {hot})],
          name: 'plain-parent-nested',
          parentEditor: parent,
        }),
      );
      expect(nested._config.namespace).toBe(parent._config.namespace);
      return nested;
    };

    {
      const nested = createNested();
      nested.update(() => $setupContent('nested content'), {discrete: true});
      nested.dispose();
    }

    {
      const nested = createNested();
      nested.read(() => {
        expect($getRoot().getTextContent()).toBe('nested content');
      });
      nested.dispose();
    }

    // One key, not one per reload each pinning an EditorState
    expect(Object.keys(hot.data)).toEqual(['lexicalHMR:']);
  });

  test('warns when a nested editor shares its parent HMR key', () => {
    const hot = createMockHotContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());

    using parent = buildEditorFromExtensions(
      defineExtension({
        dependencies: [configExtension(HMRExtension, {hot})],
        name: 'nesting-parent',
        namespace: 'nesting-ns',
      }),
    );
    using nested = buildEditorFromExtensions(
      defineExtension({
        dependencies: [configExtension(HMRExtension, {hot})],
        name: 'nesting-child',
        parentEditor: parent,
      }),
    );
    // The nested editor inherited the namespace, so `namespace` alone does
    // not tell the two apart the way it does for independent editors
    expect(nested._config.namespace).toBe(parent._config.namespace);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('nested inside another and inherits'),
    );
  });

  test('does not warn when a nested editor is given an id', () => {
    const hot = createMockHotContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());

    using parent = buildEditorFromExtensions(
      defineExtension({
        dependencies: [configExtension(HMRExtension, {hot})],
        name: 'id-parent',
        namespace: 'id-ns',
      }),
    );
    using _nested = buildEditorFromExtensions(
      defineExtension({
        dependencies: [configExtension(HMRExtension, {hot, id: 'nested'})],
        name: 'id-child',
        parentEditor: parent,
      }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  test('preserves NodeState on the root through an HMR cycle', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      editor.update(
        () => {
          $setState($getRoot(), markerState, 'root-value');
          $setState($getRoot().getFirstChild()!, markerState, 'child-value');
        },
        {discrete: true},
      );
    }

    {
      using editor = createEditor(hot);
      editor.read(() => {
        // The root's own state is as easy to lose as any node's: every version
        // of the root is built from the one the active state holds
        expect($getState($getRoot(), markerState)).toBe('root-value');
        expect($getState($getRoot().getFirstChild()!, markerState)).toBe(
          'child-value',
        );
      });
    }
  });

  test('keeps a nested editor sharing its parent history through a cycle', () => {
    const hot = createMockHotContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const build = () => {
      const parent = buildEditorFromExtensions(
        defineExtension({
          $initialEditorState: () => $setupContent('parent'),
          dependencies: [
            HistoryExtension,
            configExtension(HMRExtension, {hot, id: 'parent'}),
          ],
          name: 'shared-parent',
          namespace: 'shared-history-ns',
        }),
      );
      const nested = buildEditorFromExtensions(
        defineExtension({
          $initialEditorState: () => $setupContent('nested'),
          dependencies: [
            SharedHistoryExtension,
            configExtension(HMRExtension, {hot, id: 'nested'}),
          ],
          name: 'shared-nested',
          namespace: 'shared-history-ns',
          parentEditor: parent,
        }),
      );
      return {nested, parent};
    };

    {
      const {nested, parent} = build();
      expect(historyStateOf(nested)).toBe(historyStateOf(parent));
      parent.update(() => $setupContent('parent typed'), {discrete: true});
      // An edit the nested editor records itself, so that its own snapshot
      // carries history for the restore to rebuild
      nested.update(() => $setupContent('nested typed'), {
        discrete: true,
        tag: HISTORY_PUSH_TAG,
      });
      expect(
        entriesOf(historyStateOf(nested)).some(
          entry => entry.editor === nested,
        ),
      ).toBe(true);
      nested.dispose();
      parent.dispose();
    }
    expect(warn).not.toHaveBeenCalled();

    {
      expect(warn).not.toHaveBeenCalled();
      const {nested, parent} = build();
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        'HMR: Left behind 1 undo/redo entry recorded by another editor sharing this history. They can only be applied to the editor that recorded them, which this reload replaced.',
      );
      // Restoring hands each editor a rebuilt HistoryState; the nested editor
      // has to end up back on its parent's, not on one of its own
      expect(historyStateOf(nested)).toBe(historyStateOf(parent));
      nested.dispose();
      parent.dispose();
    }
  });

  test('describes the history shapes @lexical/history really has', () => {
    // HMRExtension declares them itself rather than importing them, so that
    // @lexical/extension does not depend on @lexical/history — which depends
    // on it. Assigning each to the other fails to compile if they drift.
    const fromHistory: HistoryState = createEmptyHistoryState();
    const asDeclaredByHMR: HMRHistoryState = fromHistory;
    const backAgain: HistoryState = asDeclaredByHMR;
    expect(backAgain).toBe(fromHistory);
  });

  test('restores a payload whose states carry no selection', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      editor.update(() => $setupContent('typed'), {discrete: true});
    }

    // What a build that did not record selections would leave behind
    corruptPayload(hot, payload => {
      for (const state of payload.family.states) {
        delete (state as {selection?: unknown}).selection;
      }
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    using editor = createEditor(hot);
    editor.read(() => {
      // A caret this build cannot read is worth losing; the document is not
      expect($getRoot().getTextContent()).toBe('typed');
      expect($getSelection()).toBe(null);
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test('rejects a payload whose states describe no document', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      editor.update(() => $setupContent('typed'), {discrete: true});
    }

    corruptPayload(hot, payload => {
      payload.family.states[0].nodes = [];
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    using editor = createEditor(hot);
    // A state with no root rebuilds into an editor `$getRoot()` cannot read
    // from, so it has to be turned away rather than handed over
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('initial');
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not restore previous editor state'),
    );
  });

  test('announces a restore only when one happened', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      expect(restoreCountOf(editor)).toBe(0);
      editor.update(() => $setupContent('typed'), {discrete: true});
    }

    {
      using editor = createEditor(hot);
      expect(restoreCountOf(editor)).toBe(1);
    }
  });

  test('rejects a payload whose node versions are shaped differently', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      editor.update(() => $setupContent('typed'), {discrete: true});
    }

    corruptPayload(hot, payload => {
      (payload.family.nodes[0] as {slots?: unknown}).slots = 'not-a-slot-list';
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    using editor = createEditor(hot);
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('initial');
    });
    // Found out up front, rather than partway through rebuilding
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('saved state could not be read'),
    );
  });

  test('restores a payload whose history is absent rather than null', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      editor.update(() => $setupContent('typed'), {discrete: true});
    }

    // What a build that did not record history at all would leave behind
    corruptPayload(hot, payload => {
      delete (payload as {history?: unknown}).history;
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    using editor = createEditor(hot);
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('typed');
    });
    // Restored, so nothing to warn about — the misleading pairing was a
    // restored document plus "Starting fresh"
    expect(warn).not.toHaveBeenCalled();
  });

  test('does not overwrite the replacement snapshot when the old editor is disposed', () => {
    const hot = createMockHotContext();
    const key = `lexicalHMR:${TEST_NAMESPACE}`;

    const previous = createEditor(hot);
    mount(previous);
    previous.update(() => $setupContent('typed'), {discrete: true});

    // The overlap a reload produces: the replacement is built while the
    // editor it replaces is still mounted, and disposed afterwards
    using next = createEditor(hot);
    expect(savedSnapshot(hot, key)).toHaveProperty('owner', next);
    previous.dispose();
    // Disposing clears the root element, which must not put the torn-down
    // editor's snapshot back over the replacement's
    expect(savedSnapshot(hot, key)).toHaveProperty('owner', next);
    expect(savedSnapshot(hot, key).editorState).toBe(next.getEditorState());
  });

  test('leaves behind history entries recorded by another editor', () => {
    const hot = createMockHotContext();
    // Two editors sharing one HistoryState, the way SharedHistoryExtension
    // hands a nested editor its parent's
    const historyState = createEmptyHistoryState();
    const createSharing = (namespace: string, id: string) =>
      buildEditorFromExtensions(
        defineExtension({
          $initialEditorState: () => $setupContent(`initial ${id}`),
          dependencies: [
            configExtension(HistoryExtension, {
              createInitialHistoryState: () => historyState,
            }),
            configExtension(HMRExtension, {hot, id}),
          ],
          name: `sharing-${id}`,
          namespace,
        }),
      );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    {
      using owner = createSharing('shared-history-ns', 'owner');
      using other = createSharing('shared-history-ns', 'other');
      owner.update(() => $setupContent('owner one'), {discrete: true});
      owner.update(() => $setupContent('owner two'), {
        discrete: true,
        tag: HISTORY_PUSH_TAG,
      });
      other.update(() => $setupContent('other one'), {
        discrete: true,
        tag: HISTORY_PUSH_TAG,
      });
      // The shared history holds entries recorded by both editors, each
      // naming the editor undoing it would apply the state to
      expect(new Set(entriesOf(historyState).map(e => e.editor)).size).toBe(2);
    }

    {
      using owner = createSharing('shared-history-ns', 'owner');
      const restored = entriesOf(historyStateOf(owner));
      // Only the owner's entries came back: another editor's state can only
      // be applied to that editor, and it did not survive the reload
      expect(restored).not.toHaveLength(0);
      expect(restored.every(entry => entry.editor === owner)).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Left behind 1 undo/redo entry'),
      );
      owner.dispatchCommand(UNDO_COMMAND, undefined);
      owner.read(() => {
        expect($getRoot().getTextContent()).toBe('owner one');
      });
    }
  });

  test('preserves state for a nested editor whose parent has no namespace', () => {
    const hot = createMockHotContext();
    const createNested = () => {
      // The parent configures no namespace, so createEditor generates a random
      // one — and the nested editor inherits it
      const parent = buildEditorFromExtensions(
        defineExtension({name: 'unnamespaced-parent'}),
      );
      const nested = buildEditorFromExtensions(
        defineExtension({
          $initialEditorState: () => $setupContent('initial'),
          dependencies: [configExtension(HMRExtension, {hot})],
          name: 'nested-editor',
          parentEditor: parent,
        }),
      );
      expect(nested._parentEditor).toBe(parent);
      expect(nested._config.namespace).toBe(parent._config.namespace);
      return {nested, parent};
    };

    {
      const {nested, parent} = createNested();
      nested.update(() => $setupContent('nested content'), {discrete: true});
      nested.dispose();
      parent.dispose();
    }

    {
      const {nested, parent} = createNested();
      nested.read(() => {
        expect($getRoot().getTextContent()).toBe('nested content');
      });
      nested.dispose();
      parent.dispose();
    }

    // Keyed without the inherited random namespace, so the key is the same on
    // every reload rather than orphaning an entry each time
    expect(Object.keys(hot.data)).toEqual(['lexicalHMR:']);
  });

  test('warns when the saved state was written by another build', () => {
    const hot = createMockHotContext();

    {
      using editor = createEditor(hot);
      editor.update(() => $setupContent('unreadable'), {discrete: true});
    }

    // The shape another build of the extension might have left behind
    delete (hot.data[TEST_HMR_KEY] as {serialize?: unknown}).serialize;

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    using editor = createEditor(hot);
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('initial');
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('saved state could not be read'),
    );
  });

  test('restored history entries keep the structural sharing they had', () => {
    const hot = createMockHotContext();
    const EDITS = 5;

    const createSeeded = () => createSeededEditor(hot, 'sharing-ns');

    const keysOf = (state: EditorState) => new Set(state._nodeMap.keys());
    const nodesOf = (state: EditorState) => new Set(state._nodeMap.values());
    const shared = (a: Set<unknown>, b: Set<unknown>) =>
      [...a].filter(value => b.has(value)).length;

    let before = {entries: 0, keys: 0, nodes: 0, size: 0};
    {
      using editor = createSeeded();
      for (let index = 0; index < EDITS; index++) {
        editor.update(
          () => {
            $assertNodeType(
              $getRoot().getChildAtIndex(index),
              $isElementNode,
            ).append($createTextNode(` edit ${index}`));
          },
          {discrete: true, tag: HISTORY_PUSH_TAG},
        );
      }
      const stack = historyStateOf(editor).undoStack;
      expect(stack.length).toBeGreaterThan(1);
      before = {
        entries: stack.length,
        keys: shared(
          keysOf(stack[0].editorState),
          keysOf(stack[1].editorState),
        ),
        nodes: shared(
          nodesOf(stack[0].editorState),
          nodesOf(stack[1].editorState),
        ),
        size: stack[0].editorState._nodeMap.size,
      };
      // Adjacent versions of the document share all but the nodes an edit
      // actually touched
      expect(before.nodes).toBeGreaterThan(before.size - 5);
    }

    {
      using editor = createSeeded();
      const stack = historyStateOf(editor).undoStack;
      expect(stack).toHaveLength(before.entries);
      const first = stack[0].editorState;
      const second = stack[1].editorState;
      expect(first._nodeMap.size).toBe(before.size);
      // Restored the same way: shared node objects, and one key space, so
      // undoing to an entry is a diff rather than a rebuild
      expect(shared(nodesOf(first), nodesOf(second))).toBe(before.nodes);
      expect(shared(keysOf(first), keysOf(second))).toBe(before.keys);
      expect(
        shared(keysOf(first), keysOf(editor.getEditorState())),
      ).toBeGreaterThan(before.size - 5);
    }
  });

  test('serializes each shared node once rather than once per state', () => {
    const hot = createMockHotContext();

    {
      using editor = createSeededEditor(hot, 'payload-ns');
      // Each edit touches one paragraph, so consecutive versions of the
      // document differ by a handful of nodes
      for (let index = 0; index < 5; index++) {
        editor.update(
          () => {
            $assertNodeType(
              $getRoot().getChildAtIndex(index),
              $isElementNode,
            ).append($createTextNode(` edit ${index}`));
          },
          {discrete: true, tag: HISTORY_PUSH_TAG},
        );
      }
    }

    const payload = savedSnapshot(hot, 'lexicalHMR:payload-ns').serialize();
    const referenced = payload.family.states.reduce(
      (total, state) => total + state.nodes.length,
      0,
    );
    expect(payload.family.states.length).toBeGreaterThan(5);
    // Every state is described in full, but the table holds one entry per
    // distinct node version rather than one per node per state
    expect(payload.family.nodes.length).toBeLessThan(referenced / 4);
  });

  test('does not overwrite valid saved state with empty editor state on first-mount effect run (validPrev path)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const hot = createMockHotContext();

    // Build an empty editorState that passes isValidHMRSavedState but isEmpty() === true.
    // This causes the restore block to skip setEditorState, so the effect fires while
    // the editor is still empty — exercising the validPrev branch.
    // historyState with a non-null value serves as the sentinel:
    // if validPrev fires, hot.data retains this value;
    // if the effect overwrites without validPrev, historyPeer is absent so it becomes null.
    hot.data[TEST_HMR_KEY] = {
      editable: true,
      editorState: createDetachedEditorState(),
      historyState: {redoStack: [], undoStack: []},
    };

    using _editor = createEditorNoInitialState(hot);

    const saved = hot.data[TEST_HMR_KEY] as {historyState: unknown};
    expect(saved.historyState).toEqual({redoStack: [], undoStack: []});
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'HMR: The saved state could not be read — it was written by a different build of HMRExtension. Starting fresh.',
    );
  });
});
