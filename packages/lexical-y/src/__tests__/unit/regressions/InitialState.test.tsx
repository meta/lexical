/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// S7-23: an editor whose initial state (`$initialEditorState`) is a template,
// bound to a document that already has content (a remount on the same doc,
// a doc loaded from a cache, `synced: true`). The binding starts once the
// editor has its initial state, so on such a document the editor shows the
// document and writes nothing. Only `initialize()` writes the initial state,
// into an empty document, where clients with the same initial state write it
// once. jsdom: one case renders the editor with React.

import {
  BlockIdExtension,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
  HMRExtension,
  type HotContext,
} from '@lexical/extension';
import {ListExtension} from '@lexical/list';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {RichTextExtension} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  type AnyLexicalExtensionArgument,
  CAN_UNDO_COMMAND,
  COLLABORATION_TAG,
  COMMAND_PRIORITY_CRITICAL,
  configExtension,
  createEditor,
  defineExtension,
  type InitialEditorStateType,
  type LexicalEditor,
  type LexicalEditorWithDispose,
} from 'lexical';
import {act, StrictMode, useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {describe, expect, onTestFinished, test} from 'vitest';

import {
  createYDoc,
  isYWarning,
  UNSUPPORTED_CONFIG_WARNING,
  YBinding,
  YCollabExtension,
  type YDoc,
} from '../../..';
import {seedYState} from '../../../headless';
import {$p, describeNode, flush} from '../../utils/harness';

/** The origin of updates that arrive from elsewhere (a provider, a cache). */
const REMOTE = 'remote';
const TEMPLATE = 'paragraph("Untitled")';
const CONTENT = 'paragraph("real content")';

const KINDS = [
  'a function that appends',
  'a function that replaces',
  'JSON',
  'an EditorState',
] as const;
type Kind = (typeof KINDS)[number];

const $appendTemplate = () => {
  $getRoot().append($p('Untitled'));
};

function templateState() {
  const source = createEditor({
    onError: error => {
      throw error;
    },
  });
  source.update($appendTemplate, {discrete: true});
  return source.getEditorState();
}

function template(kind: Kind): InitialEditorStateType {
  switch (kind) {
    case 'a function that appends':
      return $appendTemplate;
    case 'a function that replaces':
      return () => {
        $getRoot().clear();
        $appendTemplate();
      };
    case 'JSON':
      return JSON.stringify(templateState().toJSON());
    case 'an EditorState':
      return templateState();
  }
}

function open(
  doc: YDoc,
  initial: InitialEditorStateType,
  options: {
    synced?: boolean;
    /** Extensions (and configurations) listed before the app's own. */
    before?: AnyLexicalExtensionArgument[];
    dependencies?: AnyLexicalExtensionArgument[];
    register?: (
      editor: LexicalEditor,
      binding: YBinding,
    ) => void | (() => void);
  } = {},
) {
  const warnings: string[] = [];
  const editor = buildEditorFromExtensions(
    ...(options.before ?? []),
    defineExtension({
      $initialEditorState: initial,
      dependencies: [
        RichTextExtension,
        ListExtension,
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          selfCheck: true,
          synced: options.synced ?? false,
        }),
        ...(options.dependencies ?? []),
      ],
      name: '@lexical/y/test/initial-state',
      namespace: 'initial-state',
      onError: error => {
        throw error;
      },
      onWarn: warning => {
        warnings.push(isYWarning(warning) ? warning.code : warning.message);
      },
      register: (ed, _config, state) =>
        (options.register &&
          options.register(
            ed,
            state.getDependency(YCollabExtension).output.binding,
          )) ||
        (() => {}),
    }),
  );
  onTestFinished(() => editor.dispose());
  const {binding} = getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output;
  return {binding, editor, warnings};
}

function shows(editor: LexicalEditor): string {
  return editor.read(() =>
    $getRoot().getChildren().map(describeNode).join(' / '),
  );
}

/** What a fresh reader of `doc` shows. */
function stored(doc: Y.Doc): string {
  const copy = createYDoc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  const editor = createEditor({
    onError: error => {
      throw error;
    },
  });
  const binding = new YBinding(editor, copy, {schemaVersion: 1});
  const stop = binding.start();
  try {
    binding.initialize();
    return shows(editor);
  } finally {
    stop();
    copy.destroy();
  }
}

/** Counts the updates this client writes to `doc` from now on. */
function countWrites(doc: Y.Doc): {count: number} {
  const writes = {count: 0};
  doc.on('update', (_update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) {
      writes.count++;
    }
  });
  return writes;
}

function copyOf(doc: Y.Doc): YDoc {
  const copy = createYDoc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc), REMOTE);
  return copy;
}

/** A document opened with `initial`, whose content a user then replaced. */
async function documentWithContent(
  initial: InitialEditorStateType,
): Promise<YDoc> {
  const doc = createYDoc();
  const {binding, editor} = open(doc, initial);
  binding.initialize();
  await flush();
  expect(shows(editor)).toBe(TEMPLATE);
  editor.update(() => $getRoot().clear().append($p('real content')), {
    discrete: true,
  });
  await flush();
  editor.dispose();
  expect(stored(doc)).toBe(CONTENT);
  return doc;
}

/** The configuration of the seeds, as the clients' extensions. */
const SEED_CONFIG = {
  extensions: [RichTextExtension, ListExtension],
  schemaVersion: 1,
};

const WAYS = [
  'remount on the same document',
  'a document loaded from a cache before the editor',
  'a loaded document with synced: true',
  'two editors on the same document at once',
] as const;

describe('S7-23: the initial state on a document that has content', () => {
  for (const kind of KINDS) {
    for (const way of WAYS) {
      test(`${kind}, ${way}: the editor shows the document and writes nothing`, async () => {
        const source = await documentWithContent(template(kind));
        const doc = way.startsWith('remount') ? source : copyOf(source);
        const writes = countWrites(doc);
        const opened = [
          open(doc, template(kind), {synced: way.includes('synced')}),
        ];
        if (way.startsWith('two editors')) {
          opened.push(open(doc, template(kind)));
        }
        for (const {binding} of opened) {
          binding.initialize();
        }
        await flush();
        for (const {binding, editor, warnings} of opened) {
          expect(binding.status).toBe('active');
          expect(shows(editor)).toBe(CONTENT);
          expect(warnings).toEqual([]);
        }
        expect(writes.count).toBe(0);
        expect(stored(doc)).toBe(CONTENT);
        for (const {editor} of opened) {
          editor.dispose();
        }
      });
    }
  }

  test('the document synced after the editor is built: the editor shows it and writes nothing', async () => {
    const source = await documentWithContent($appendTemplate);
    const doc = createYDoc();
    const writes = countWrites(doc);
    const {binding, editor, warnings} = open(doc, $appendTemplate);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(source), REMOTE);
    binding.initialize();
    await flush();
    expect(shows(editor)).toBe(CONTENT);
    expect(warnings).toEqual([]);
    expect(writes.count).toBe(0);
    editor.dispose();
  });

  test('initialize() called while extensions register (a provider that has synced): the editor shows the document and writes nothing', async () => {
    const doc = copyOf(await documentWithContent($appendTemplate));
    const writes = countWrites(doc);
    const {binding, editor, warnings} = open(doc, $appendTemplate, {
      register: (_editor, early) => early.initialize(),
    });
    await flush();
    expect(binding.status).toBe('active');
    expect(shows(editor)).toBe(CONTENT);
    expect(warnings).toEqual([]);
    expect(writes.count).toBe(0);
    editor.dispose();
  });

  test('a remote change applied while initialize() commits a pending update is read, not written', async () => {
    const source = await documentWithContent($appendTemplate);
    const doc = createYDoc();
    const editor = createEditor({
      onError: error => {
        throw error;
      },
    });
    const binding = new YBinding(editor, doc, {schemaVersion: 1});
    const stop = binding.start();
    // A provider whose first sync lands in a listener of the next commit.
    let synced = false;
    const unregister = editor.registerUpdateListener(() => {
      if (!synced) {
        synced = true;
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(source), REMOTE);
      }
    });
    const writes = countWrites(doc);
    editor.update($appendTemplate);
    binding.initialize();
    await flush();
    expect(binding.status).toBe('active');
    expect(shows(editor)).toBe(CONTENT);
    expect(writes.count).toBe(0);
    expect(stored(doc)).toBe(CONTENT);
    unregister();
    stop();
  });

  test('content of an older layout root that arrives while initialize() commits a pending update is refused, not written next to', async () => {
    const doc = createYDoc();
    const warned: string[] = [];
    const editor = createEditor({
      onError: error => {
        throw error;
      },
      onWarn: warning => {
        warned.push(isYWarning(warning) ? warning.code : warning.message);
      },
    });
    const binding = new YBinding(editor, doc, {schemaVersion: 1});
    const stop = binding.start();
    let synced = false;
    const unregister = editor.registerUpdateListener(() => {
      if (!synced) {
        synced = true;
        doc.transact(
          () => doc.get('root-v2').insert(0, [new Y.Node('paragraph')]),
          REMOTE,
        );
      }
    });
    const writes = countWrites(doc);
    editor.update($appendTemplate);
    binding.initialize();
    await flush();
    expect(binding.status).toBe('readonly');
    expect(warned).toEqual(['@lexical/y/unsupported-layout']);
    expect(writes.count).toBe(0);
    unregister();
    stop();
  });

  test('content an extension writes while it registers is initial state too', async () => {
    const doc = await documentWithContent($appendTemplate);
    const writes = countWrites(doc);
    const {binding, editor} = open(doc, null, {
      register: ed => {
        ed.update(() => {
          $getRoot().append($p('written while registering'));
        });
      },
    });
    binding.initialize();
    await flush();
    expect(shows(editor)).toBe(CONTENT);
    expect(writes.count).toBe(0);
    expect(stored(doc)).toBe(CONTENT);
    editor.dispose();
  });

  test('a state HMRExtension restores is initial state too, wherever it is listed', async () => {
    const hot: HotContext = {data: {}};
    const hmr = configExtension(HMRExtension, {hot});
    const doc = createYDoc();
    const first = open(doc, $appendTemplate, {dependencies: [hmr]});
    first.binding.initialize();
    await flush();
    first.editor.update(() => $getRoot().clear().append($p('real content')), {
      discrete: true,
    });
    await flush();
    first.editor.dispose();
    // A collaborator's edit arrives before the editor is built again.
    const peerDoc = copyOf(doc);
    const peer = open(peerDoc, null);
    peer.editor.update(() => $getRoot().append($p('peer')), {discrete: true});
    await flush();
    Y.applyUpdate(
      doc,
      Y.encodeStateAsUpdate(peerDoc, Y.encodeStateVector(doc)),
      REMOTE,
    );
    peer.editor.dispose();
    const writes = countWrites(doc);
    const second = open(doc, $appendTemplate, {dependencies: [hmr]});
    second.binding.initialize();
    await flush();
    expect(shows(second.editor)).toBe(`${CONTENT} / paragraph("peer")`);
    expect(writes.count).toBe(0);
    expect(stored(doc)).toBe(`${CONTENT} / paragraph("peer")`);
    second.editor.dispose();
  });

  test('remounted five times: nothing is duplicated or lost, and edits made in between are written', async () => {
    const doc = await documentWithContent($appendTemplate);
    let expected = CONTENT;
    for (let i = 0; i < 5; i++) {
      const {binding, editor, warnings} = open(doc, $appendTemplate);
      binding.initialize();
      await flush();
      expect(shows(editor)).toBe(expected);
      editor.update(() => $getRoot().append($p('edit ' + i)), {
        discrete: true,
      });
      await flush();
      expected += ` / paragraph("edit ${i}")`;
      expect(stored(doc)).toBe(expected);
      expect(warnings).toEqual([]);
      editor.dispose();
    }
  });

  test('React StrictMode: LexicalExtensionComposer mounted five times on a loaded document', async () => {
    const doc = await documentWithContent($appendTemplate);
    const writes = countWrites(doc);
    // StrictMode builds a second editor that the composer never disposes:
    // each one is kept, bound to the document, until the test ends.
    const built: LexicalEditor[] = [];
    onTestFinished(() => {
      for (const editor of built) {
        (editor as LexicalEditorWithDispose).dispose();
      }
      doc.destroy();
    });
    const extension = defineExtension({
      $initialEditorState: $appendTemplate,
      dependencies: [
        RichTextExtension,
        ListExtension,
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          selfCheck: true,
          synced: true,
        }),
      ],
      name: '@lexical/y/test/initial-state-react',
      onError: error => {
        throw error;
      },
      register: editor => {
        built.push(editor);
        return () => {};
      },
    });
    const seen: string[] = [];
    function Probe() {
      const [editor] = useLexicalComposerContext();
      useEffect(() => {
        seen.push(shows(editor));
      }, [editor]);
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    onTestFinished(() => container.remove());
    for (let i = 0; i < 5; i++) {
      const reactRoot = createRoot(container);
      try {
        await act(async () => {
          reactRoot.render(
            <StrictMode>
              <LexicalExtensionComposer
                extension={extension}
                contentEditable={null}>
                <Probe />
              </LexicalExtensionComposer>
            </StrictMode>,
          );
        });
        await act(flush);
      } finally {
        await act(async () => reactRoot.unmount());
      }
    }
    expect(built.length).toBeGreaterThanOrEqual(5);
    expect(new Set(seen)).toEqual(new Set([CONTENT]));
    expect(new Set(built.map(shows))).toEqual(new Set([CONTENT]));
    expect(writes.count).toBe(0);
    expect(stored(doc)).toBe(CONTENT);
  });

  for (const when of ['before', 'after'] as const) {
    test(`a document seeded with seedYState, synced ${when} the editor is built: the editor shows the seed and writes nothing`, async () => {
      const seed = seedYState(SEED_CONFIG, () => {
        $getRoot().append($p('seeded'));
      });
      const doc = createYDoc();
      if (when === 'before') {
        Y.applyUpdate(doc, seed, REMOTE);
      }
      const writes = countWrites(doc);
      const {binding, editor} = open(doc, $appendTemplate);
      if (when === 'after') {
        Y.applyUpdate(doc, seed, REMOTE);
      }
      binding.initialize();
      await flush();
      expect(shows(editor)).toBe('paragraph("seeded")');
      expect(writes.count).toBe(0);
      expect(stored(doc)).toBe('paragraph("seeded")');
      editor.dispose();
    });
  }

  test('a document whose root is empty: the editor shows it empty and writes nothing until an edit', async () => {
    const doc = createYDoc();
    Y.applyUpdate(
      doc,
      seedYState(SEED_CONFIG, () => {}),
      REMOTE,
    );
    const writes = countWrites(doc);
    const {binding, editor} = open(doc, $appendTemplate);
    binding.initialize();
    await flush();
    expect(shows(editor)).toBe('');
    expect(writes.count).toBe(0);
    editor.update(() => $getRoot().selectEnd(), {discrete: true});
    editor.update(
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText('typed');
        }
      },
      {discrete: true},
    );
    await flush();
    expect(stored(doc)).toBe('paragraph("typed")');
    editor.dispose();
  });
});

describe('S7-23: the initial state on an empty document', () => {
  for (const kind of KINDS) {
    for (const synced of [false, true]) {
      test(`${kind}, synced: ${synced}: two clients that open an empty document at once write it once`, async () => {
        const docs = [createYDoc(), createYDoc()];
        const clients = docs.map(doc => open(doc, template(kind), {synced}));
        if (!synced) {
          for (const {binding} of clients) {
            binding.initialize();
          }
        }
        await flush();
        const [a, b] = docs;
        Y.applyUpdate(a, Y.encodeStateAsUpdate(b), REMOTE);
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a), REMOTE);
        await flush();
        for (const {binding, editor, warnings} of clients) {
          expect(binding.status).toBe('active');
          expect(shows(editor)).toBe(TEMPLATE);
          expect(warnings).toEqual([]);
        }
        expect(stored(a)).toBe(TEMPLATE);
        expect(stored(b)).toBe(TEMPLATE);
        // The initial content is not part of the undo history.
        expect(clients[0].binding.undoManager!.canUndo()).toBe(false);
        for (const {editor} of clients) {
          editor.dispose();
        }
      });
    }
  }

  const EARLY: Record<
    string,
    (editor: LexicalEditor, binding: YBinding) => void | (() => void)
  > = {
    'from an editable listener while the binding starts': (editor, binding) => {
      let called = false;
      return editor.registerEditableListener(editable => {
        if (!editable && !called) {
          called = true;
          binding.initialize();
        }
      });
    },
    'while extensions register': (_editor, binding) => binding.initialize(),
  };

  for (const [when, register] of Object.entries(EARLY)) {
    for (const synced of [false, true]) {
      test(`initialize() called ${when} (a provider that syncs at once), synced: ${synced}: the initial state is written once, as a seed`, async () => {
        const docs = [createYDoc(), createYDoc()];
        const clients = docs.map(doc =>
          open(doc, $appendTemplate, {register, synced}),
        );
        await flush();
        for (const {binding, editor} of clients) {
          expect(binding.status).toBe('active');
          expect(shows(editor)).toBe(TEMPLATE);
          expect(binding.undoManager!.canUndo()).toBe(false);
        }
        const [a, b] = docs;
        Y.applyUpdate(a, Y.encodeStateAsUpdate(b), REMOTE);
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a), REMOTE);
        await flush();
        expect(stored(a)).toBe(TEMPLATE);
        for (const {editor, warnings} of clients) {
          expect(shows(editor)).toBe(TEMPLATE);
          expect(warnings).toEqual([]);
        }
      });
    }
  }

  test('an edit a listener makes in reply to the initialization is announced to CAN_UNDO_COMMAND listeners', async () => {
    const doc = createYDoc();
    const canUndo: boolean[] = [];
    const {binding, editor} = open(doc, $appendTemplate, {
      before: [
        defineExtension({
          name: '@lexical/y/test/can-undo-observer',
          register: ed =>
            ed.registerCommand(
              CAN_UNDO_COMMAND,
              value => {
                canUndo.push(value);
                return false;
              },
              COMMAND_PRIORITY_CRITICAL,
            ),
        }),
      ],
      register: (ed, early) => {
        let replied = false;
        const unregister = ed.registerUpdateListener(({tags}) => {
          if (!replied && tags.has(COLLABORATION_TAG)) {
            replied = true;
            ed.update(() => $getRoot().append($p('reply')), {discrete: true});
          }
        });
        early.initialize();
        return unregister;
      },
    });
    await flush();
    expect(shows(editor)).toBe(`${TEMPLATE} / paragraph("reply")`);
    expect(binding.undoManager!.canUndo()).toBe(true);
    expect(canUndo).toEqual([false, true]);
  });

  test('initialize() called while extensions register, with an option the binding cannot write with: read only, nothing written', async () => {
    const doc = createYDoc();
    const writes = countWrites(doc);
    const {binding, editor, warnings} = open(doc, $appendTemplate, {
      before: [configExtension(BlockIdExtension, {repairTransforms: true})],
      register: (_editor, early) => early.initialize(),
    });
    await flush();
    expect(binding.status).toBe('readonly');
    expect(warnings).toContain(UNSUPPORTED_CONFIG_WARNING);
    expect(writes.count).toBe(0);
    editor.dispose();
  });

  for (const synced of [false, true]) {
    test(`synced: ${synced}: a client that initializes an empty document with its template, and a seedYState seed of that template, merge into one copy`, async () => {
      const doc = createYDoc();
      const {binding, editor} = open(doc, $appendTemplate, {synced});
      if (!synced) {
        binding.initialize();
      }
      await flush();
      Y.applyUpdate(doc, seedYState(SEED_CONFIG, $appendTemplate), REMOTE);
      await flush();
      expect(shows(editor)).toBe(TEMPLATE);
      expect(stored(doc)).toBe(TEMPLATE);
      editor.dispose();
    });
  }
});
