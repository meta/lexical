/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A node transform registered while a user's edit is pending (in the same
// task, or inside the edit's own update): the edit commits and is written
// as the edit it is, and the update Lexical makes to run the transform over
// the document runs on its own, writing nothing.

import {
  buildEditorFromExtensions,
  effect,
  getExtensionDependencyFromEditor,
  WatchEditableExtension,
} from '@lexical/extension';
import {
  $createTableNodeWithDimensions,
  registerTablePlugin,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  configExtension,
  defineExtension,
  type ElementNode,
  type NodeKey,
  ParagraphNode,
  TextNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {expect, test, vi} from 'vitest';

import {createYDoc, YCollabExtension} from '../..';
import {$p, expectConverged, flush, freshReader, setup} from '../utils/harness';

for (const order of ['edit then register', 'register then edit']) {
  for (const what of [
    'paragraph transform',
    'text transform',
    'table plugin',
  ]) {
    test(`${order} in one task (${what}): the edit is written and kept`, async () => {
      const {a, b, sync} = await setup(() => {
        $getRoot().append($p('one'), $p('two'));
        if (what === 'table plugin') {
          $getRoot().append($createTableNodeWithDimensions(2, 2, false));
        }
      });
      const edit = () =>
        a.editor.update(() => {
          ($getRoot().getFirstChild() as ElementNode).append(
            $createTextNode(' typed'),
          );
        });
      const register = () =>
        what === 'paragraph transform'
          ? a.editor.registerNodeTransform(ParagraphNode, () => {})
          : what === 'text transform'
            ? a.editor.registerNodeTransform(TextNode, () => {})
            : registerTablePlugin(a.editor);
      let dispose: () => void;
      if (order === 'edit then register') {
        edit();
        dispose = register();
      } else {
        dispose = register();
        edit();
      }
      await flush();
      await sync();
      await flush();
      expect(a.describe()).toContain('one typed');
      expect(b.describe()).toBe(a.describe());
      await expectConverged([a, b]);
      dispose();
    });
  }
}

for (const what of ['delete a paragraph', 'bold a word']) {
  test(`edit then register in one task (${what}): the edit is written and kept`, async () => {
    const {a, b, sync} = await setup(() => {
      $getRoot().append($p('one'), $p('two'), $p('three'));
    });
    a.editor.update(() => {
      if (what === 'delete a paragraph') {
        ($getRoot().getChildAtIndex(1) as ElementNode).remove();
      } else {
        const t = ($getRoot().getFirstChild() as ElementNode).getFirstChild();
        if ($isTextNode(t)) {
          t.toggleFormat('bold');
        }
      }
    });
    const dispose = a.editor.registerNodeTransform(ParagraphNode, () => {});
    await flush();
    await sync();
    await flush();
    if (what === 'delete a paragraph') {
      expect(a.describe()).not.toContain('two');
    } else {
      expect(a.describe()).toContain('"one"{1}');
    }
    await expectConverged([a, b]);
    dispose();
  });
}

test('a transform registered inside a user update: the update is written and kept', async () => {
  const {a, b, sync} = await setup(() => {
    $getRoot().append($p('one'));
  });
  let dispose = () => {};
  a.update(() => {
    dispose = a.editor.registerNodeTransform(ParagraphNode, () => {});
    $assertNodeType(
      ($getRoot().getFirstChildOrThrow() as ElementNode).getFirstChildOrThrow(),
      $isTextNode,
    ).setTextContent('one edited');
  });
  await sync();
  await flush();
  expect(a.describe()).toContain('one edited');
  await expectConverged([a, b]);
  dispose();
});

// The update Lexical makes to run a transform registered inside an update
// over the document never commits with an edit queued after that update:
// one an update listener queues, or the update's own onUpdate.
for (const queuedBy of ['an update listener', "the update's onUpdate"]) {
  test(`a transform registered inside an update, then an edit ${queuedBy} queues: both edits are written and kept`, async () => {
    const {a, b, sync} = await setup(() => {
      $getRoot().append($p('one'), $p('two'));
    });
    const appEdit = () =>
      a.editor.update(() => {
        ($getRoot().getLastChildOrThrow() as ElementNode).append(
          $createTextNode(' app'),
        );
      });
    let armed = false;
    a.editor.registerUpdateListener(({tags, dirtyElements}) => {
      if (armed && !tags.has('collaboration') && dirtyElements.size > 0) {
        armed = false;
        appEdit();
      }
    });
    let dispose = () => {};
    armed = queuedBy === 'an update listener';
    a.editor.update(
      () => {
        dispose = a.editor.registerNodeTransform(ParagraphNode, () => {});
        ($getRoot().getFirstChildOrThrow() as ElementNode).append(
          $createTextNode(' typed'),
        );
      },
      {
        discrete: true,
        onUpdate: queuedBy === 'an update listener' ? undefined : appEdit,
      },
    );
    await flush();
    await sync();
    await flush();
    const expected = 'paragraph("one typed") / paragraph("two app")';
    expect(a.describe()).toBe(expected);
    expect(b.describe()).toBe(expected);
    expect((await freshReader(a)).describe()).toBe(expected);
    await expectConverged([a, b]);
    dispose();
  });
}

// Registration works from any context, as without the binding: it does not
// throw, returns a cleanup that removes the transform, and the transform
// still runs over the document (in an update of its own, writing nothing).
for (const where of [
  'an update listener',
  'an editable listener',
  'a text content listener',
  'a read inside an update listener',
  'a read outside any update',
  "an update's onUpdate",
]) {
  test(`a transform registered from ${where}: no throw, a working cleanup, and the transform runs over the document`, async () => {
    const {a, b, sync} = await setup(() => {
      $getRoot().append($p('one'), $p('two'));
    });
    const seen = new Set<NodeKey>();
    const transform = (node: ParagraphNode) => {
      seen.add(node.getKey());
    };
    let dispose: (() => void) | null = null;
    let thrown: unknown = null;
    let done = false;
    const register = () => {
      if (done) {
        return;
      }
      done = true;
      try {
        if (where.startsWith('a read')) {
          a.editor.getEditorState().read(() => {
            dispose = a.editor.registerNodeTransform(ParagraphNode, transform);
          });
        } else {
          dispose = a.editor.registerNodeTransform(ParagraphNode, transform);
        }
      } catch (e) {
        thrown = e;
      }
    };
    const type = () =>
      a.editor.update(
        () => {
          ($getRoot().getFirstChildOrThrow() as ElementNode).append(
            $createTextNode(' typed'),
          );
        },
        {onUpdate: where === "an update's onUpdate" ? register : undefined},
      );
    if (where === 'an editable listener') {
      a.editor.registerEditableListener(register);
      a.editor.setEditable(false);
      a.editor.setEditable(true);
    } else if (where === 'a text content listener') {
      a.editor.registerTextContentListener(register);
      type();
    } else if (where === 'a read outside any update') {
      register();
    } else if (where !== "an update's onUpdate") {
      a.editor.registerUpdateListener(register);
      type();
    } else {
      type();
    }
    await flush();
    expect(thrown).toBe(null);
    expect(typeof dispose).toBe('function');
    // Every paragraph, as the registration pass marks them all dirty.
    expect(seen.size).toBe(2);
    await sync();
    await flush();
    await expectConverged([a, b]);
    const info = a.editor._nodes.get('paragraph')!;
    expect(info.transforms.has(transform as never)).toBe(true);
    dispose!();
    expect(info.transforms.has(transform as never)).toBe(false);
  });
}

// An extension that registers a transform only while the editor is
// editable (WatchEditableExtension's signal): setEditable registers it from
// the editable listener.
const EditableOnlyTransform = defineExtension({
  dependencies: [WatchEditableExtension],
  name: '@lexical/y/test/EditableOnlyTransform',
  register: (editor, _config, state) => {
    const editable = state.getDependency(WatchEditableExtension).output;
    return effect(() =>
      editable.value
        ? editor.registerNodeTransform(ParagraphNode, () => {})
        : undefined,
    );
  },
});

test('an extension that registers a transform while editable: setEditable(true) does not throw', async () => {
  const doc = createYDoc();
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        EditableOnlyTransform,
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          selfCheck: false,
        }),
      ],
      name: '@lexical/y/test/EditableRegistration',
      onError: e => {
        throw e;
      },
    }),
  );
  editor.update(
    () => {
      $getRoot().append($createParagraphNode().append($createTextNode('one')));
    },
    {discrete: true},
  );
  getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output.binding.initialize();
  await flush();
  expect(() => {
    editor.setEditable(false);
    editor.setEditable(true);
  }).not.toThrow();
  await flush();
  expect(editor._updates.length).toBe(0);
  editor.dispose();
  doc.destroy();
});

test('a listener that registers a transform after every commit does not make updates forever', async () => {
  const {a} = await setup(() => {
    $getRoot().append($p('one'));
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const disposers: (() => void)[] = [];
  const unregister = a.editor.registerUpdateListener(() => {
    disposers.push(a.editor.registerNodeTransform(ParagraphNode, () => {}));
  });
  try {
    a.editor.update(
      () => {
        ($getRoot().getFirstChildOrThrow() as ElementNode).append(
          $createTextNode(' typed'),
        );
      },
      {discrete: true},
    );
    await flush();
    unregister();
    await flush();
    expect(
      warn.mock.calls.some(c =>
        String(c[0]).includes(
          'updates for registered transforms ran before the event loop turned',
        ),
      ),
    ).toBe(true);
    expect(a.describe()).toBe('paragraph("one typed")');
  } finally {
    unregister();
    disposers.forEach(d => d());
    warn.mockRestore();
  }
});

test('transforms registered in a loop all run over the document, in one update', async () => {
  const {a} = await setup(() => {
    $getRoot().append($p('one'), $p('two'));
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const ran = new Set<number>();
  const disposers: (() => void)[] = [];
  let commits = 0;
  const unregister = a.editor.registerUpdateListener(() => {
    commits++;
  });
  try {
    // More than the cap on updates for registered transforms in a row (a
    // plugin host enabling plugins in a loop); before, the passes after the
    // 100th were dropped, and those transforms never ran.
    for (let i = 0; i < 150; i++) {
      disposers.push(
        a.editor.registerNodeTransform(ParagraphNode, () => {
          ran.add(i);
        }),
      );
    }
    await flush();
    expect(ran.size).toBe(150);
    expect(commits).toBeLessThanOrEqual(2);
    expect(warn).not.toHaveBeenCalled();
    expect(a.describe()).toBe('paragraph("one") / paragraph("two")');
  } finally {
    unregister();
    disposers.forEach(d => d());
    warn.mockRestore();
  }
});
