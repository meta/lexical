/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// quiesce()'s edges, from API reviews rounds 9 and 10:
//
// - A warning handler that calls quiesce() again while the first call's
//   warnings are delivered (a refusal's) gets the first call's result: the
//   first call keeps its result before any warning or status notification
//   goes out.
// - The draft is the editor state's JSON, kept as text: every call, the
//   first included, parses it again. A node serializer that reuses its
//   output objects cannot change the kept draft; a Date NodeState value is
//   its ISO string in every result; an own `__proto__` key is kept; a state
//   JSON cannot hold (a BigInt) makes quiesce() throw a TypeError before it
//   changes anything.

import {buildEditorFromExtensions} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $getRoot,
  $setCompositionKey,
  $setState,
  createState,
  defineExtension,
  type ElementNode,
  type SerializedEditorState,
  type SerializedTextNode,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  createYDoc,
  LAYOUT_VERSION,
  UNSUPPORTED_EDIT_WARNING,
  YBinding,
  type YQuiescedState,
} from '../../..';
import {catalogAppExtension} from '../../catalog/bind';
import {rawDoc, SEED} from '../../utils/migrateSteps';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const value = createState('quiesce-edges-value', {parse: v => v});

/** A text node whose exportJSON reuses its output object, by node key. */
const serializedByKey = new Map<string, SerializedTextNode>();
class ReusingText extends TextNode {
  $config() {
    return this.config('quiesce_edges_reusing_text', {extends: TextNode});
  }
  exportJSON(): SerializedTextNode {
    const json = super.exportJSON();
    const reused = serializedByKey.get(this.getKey());
    if (reused !== undefined) {
      Object.assign(reused, json);
      return reused;
    }
    serializedByKey.set(this.getKey(), json);
    return json;
  }
}

/** A text node whose exportJSON throws while `throwing` is set. */
let throwing = false;
const exportError = new Error('ThrowingText cannot be exported');
class ThrowingText extends TextNode {
  $config() {
    return this.config('quiesce_edges_throwing_text', {extends: TextNode});
  }
  exportJSON(): SerializedTextNode {
    if (throwing) {
      throw exportError;
    }
    return super.exportJSON();
  }
}

function bind(gc: boolean, onWarn?: (w: Error) => void) {
  const doc = createYDoc(rawDoc(SEED), {gc});
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension({blockIds: 'absent'})],
      name: 'quiesce-edges',
      nodes: [ReusingText, ThrowingText],
      onError: e => {
        throw e;
      },
      onWarn: w => {
        onWarn?.(w);
      },
    }),
  );
  const binding = new YBinding(editor, doc, {
    captureTimeout: 0,
    schemaVersion: 1,
  });
  binding.start();
  binding.initialize();
  const host = document.createElement('div');
  document.body.append(host);
  editor.setRootElement(host);
  const dispose = () => {
    editor.setRootElement(null);
    binding.dispose();
    editor.dispose();
    host.remove();
    doc.destroy();
  };
  const $text = () =>
    (
      $getRoot().getFirstChildOrThrow() as ElementNode
    ).getFirstChildOrThrow() as TextNode;
  const set = (v: unknown) =>
    editor.update(() => $setState($getRoot(), value, v), {discrete: true});
  return {$text, binding, dispose, doc, editor, set};
}

const stateOf = (json: SerializedEditorState): unknown =>
  (json.root as unknown as {$: Record<string, unknown>}).$[
    'quiesce-edges-value'
  ];

describe.each([false, true])('quiesce() edges, gc %s', gc => {
  test("a warning handler's quiesce() during the first call's warnings gets the first call's draft", async () => {
    let armed = false;
    let nested: YQuiescedState | null = null;
    let nestedError: unknown = null;
    const t = bind(gc, w => {
      if (
        armed &&
        nested === null &&
        (w as {code?: string}).code === UNSUPPORTED_EDIT_WARNING
      ) {
        try {
          nested = t.binding.quiesce();
        } catch (e) {
          nestedError = e;
        }
      }
    });
    try {
      t.editor.update(() => $setCompositionKey(t.$text().getKey()), {
        discrete: true,
      });
      await flush();
      t.doc.get('lexical-y').setAttr(`lexical-y:${LAYOUT_VERSION + 1}`, true);
      await flush();
      expect(t.binding.status).toBe('readonly');
      // Batched: still pending when quiesce() runs, refused by it.
      t.editor.update(() => t.$text().setTextContent('abcIME'), {
        skipTransforms: true,
      });
      expect(t.editor._pendingEditorState).not.toBeNull();
      armed = true;
      const first = t.binding.quiesce();
      await flush();
      expect(first.draft.differs).toBe(true);
      expect(JSON.stringify(first.draft.json)).toContain('abcIME');
      expect(nestedError).toBeNull();
      const retried = nested as YQuiescedState | null;
      expect(retried).not.toBeNull();
      expect(retried!.draft.differs).toBe(true);
      expect(JSON.stringify(retried!.draft.json)).toContain('abcIME');
      expect(retried).toEqual(first);
      expect(t.binding.quiesce()).toEqual(first);
    } finally {
      t.dispose();
    }
  });

  test('a serializer that reuses its output objects: a later update does not change the kept draft', () => {
    const t = bind(gc);
    try {
      t.binding.dispose();
      t.editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $create(ReusingText).setTextContent('before'),
              ),
            ),
        {discrete: true},
      );
      const first = t.binding.quiesce();
      expect(JSON.stringify(first.draft.json)).toContain('before');
      t.editor.update(() => t.$text().setTextContent('after'), {
        discrete: true,
      });
      // The serializer rewrites the object it returned before.
      t.editor.getEditorState().toJSON();
      const again = t.binding.quiesce();
      expect(JSON.stringify(again.draft.json)).toContain('before');
      expect(JSON.stringify(again.draft.json)).not.toContain('after');
      expect(again).toStrictEqual(first);
    } finally {
      t.dispose();
    }
  });

  test('a Date NodeState: its ISO string, the same in the first and a repeated draft', () => {
    const t = bind(gc);
    try {
      t.set(new Date(0));
      const first = t.binding.quiesce();
      expect(stateOf(first.draft.json)).toBe('1970-01-01T00:00:00.000Z');
      const again = t.binding.quiesce();
      expect(again.draft.json).toStrictEqual(first.draft.json);
      // Each its own copy.
      first.draft.json.root.children.length = 0;
      first.state.fill(0);
      expect(t.binding.quiesce()).toStrictEqual(again);
    } finally {
      t.dispose();
    }
  });

  test('an own __proto__ key in a NodeState value is kept, in every result', () => {
    const t = bind(gc);
    try {
      t.binding.dispose();
      t.set(JSON.parse('{"__proto__": {"x": 1}, "y": 2}'));
      for (const result of [t.binding.quiesce(), t.binding.quiesce()]) {
        const v = stateOf(result.draft.json) as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(v, '__proto__')).toBe(true);
        expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
        expect(JSON.stringify(v)).toBe('{"__proto__":{"x":1},"y":2}');
      }
    } finally {
      t.dispose();
    }
  });

  test('a BigInt NodeState: a TypeError before anything changes (status, editability, the document), then a JSON state hands off', () => {
    const t = bind(gc);
    try {
      t.set(BigInt(1));
      expect(t.binding.status).toBe('active');
      // Batched, so a drain would have something to commit.
      t.editor.update(() => t.$text().setTextContent('typed'), {
        skipTransforms: true,
      });
      const before = Y.encodeStateAsUpdate(t.doc);
      expect(() => t.binding.quiesce()).toThrow(TypeError);
      expect(t.binding.status).toBe('active');
      expect(t.editor.isEditable()).toBe(true);
      expect(Buffer.from(Y.encodeStateAsUpdate(t.doc))).toEqual(
        Buffer.from(before),
      );
      expect(t.editor._pendingEditorState).not.toBeNull();
      // Nothing was kept: once the state is JSON, quiesce() hands off.
      t.set(1);
      const result = t.binding.quiesce();
      expect(stateOf(result.draft.json)).toBe(1);
      expect(t.binding.status).toBe('readonly');
    } finally {
      t.dispose();
    }
  });
  test.each(['held', 'shown', 'getter', 'cycle'] as const)(
    'a preflight failure (%s): a TypeError that says nothing changed; the document, pending work, composition, status and editability are as they were',
    bad => {
      const t = bind(gc);
      try {
        if (bad === 'shown') {
          t.set(BigInt(1));
        }
        t.editor.update(() => $setCompositionKey(t.$text().getKey()), {
          discrete: true,
        });
        // 'shown': nothing pending, so the shown state is the draft.
        if (bad !== 'shown') {
          t.editor.update(
            () => {
              t.$text().setTextContent('pending');
              if (bad === 'held') {
                $setState($getRoot(), value, BigInt(1));
              } else if (bad === 'getter') {
                $setState($getRoot(), value, {
                  get n() {
                    throw new Error('getter');
                  },
                });
              } else {
                const cycle: Record<string, unknown> = {};
                cycle.self = cycle;
                $setState($getRoot(), value, cycle);
              }
            },
            {skipTransforms: true},
          );
        }
        const before = Buffer.from(Y.encodeStateAsUpdate(t.doc));
        const pending = t.editor._pendingEditorState;
        const composition = t.editor._compositionKey;
        let error: unknown = null;
        try {
          t.binding.quiesce();
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(TypeError);
        expect(String(error)).toMatch(/Nothing was changed/);
        expect(Buffer.from(Y.encodeStateAsUpdate(t.doc))).toEqual(before);
        expect(t.editor._pendingEditorState).toBe(pending);
        expect(t.editor._compositionKey).toBe(composition);
        expect(t.binding.status).toBe('active');
        expect(t.editor.isEditable()).toBe(true);
        const internal = t.binding as unknown as {
          quiesced: boolean;
          quiescedState: unknown;
        };
        expect(internal.quiesced).toBe(false);
        expect(internal.quiescedState).toBeNull();
      } finally {
        t.dispose();
      }
    },
  );

  test('a shown BigInt that the pending update replaces is no reason to refuse: quiesce() hands off', () => {
    const t = bind(gc);
    try {
      t.set(BigInt(1));
      t.editor.update(() => $setCompositionKey(t.$text().getKey()), {
        discrete: true,
      });
      t.editor.update(
        () => {
          t.$text().setTextContent('pending');
          $setState($getRoot(), value, 1);
        },
        {skipTransforms: true},
      );
      expect(t.editor._pendingEditorState).not.toBeNull();
      const result = t.binding.quiesce();
      expect(stateOf(result.draft.json)).toBe(1);
      expect(JSON.stringify(result.draft.json)).toContain('pending');
      expect(t.doc.get('lexical-y').toString()).toContain('pending');
      expect(t.binding.status).toBe('readonly');
      expect(t.binding.quiesce()).toStrictEqual(result);
    } finally {
      t.dispose();
    }
  });

  test('the draft is canonical JSON: NaN is null, a Map and a Set are {}, an undefined array entry is null', () => {
    const t = bind(gc);
    try {
      t.binding.dispose();
      t.set({
        list: [1, undefined, 2],
        map: new Map([['k', 1]]),
        nan: Number.NaN,
        set: new Set([1]),
      });
      for (const result of [t.binding.quiesce(), t.binding.quiesce()]) {
        expect(stateOf(result.draft.json)).toStrictEqual({
          list: [1, null, 2],
          map: {},
          nan: null,
          set: {},
        });
      }
    } finally {
      t.dispose();
    }
  });

  test('an update listener makes the state unserializable during the drain: the drained-state TypeError, the text stored, nothing cached; a retry hands off', () => {
    const t = bind(gc);
    let armed = false;
    let done = false;
    const stop = t.editor.registerUpdateListener(() => {
      if (armed && !done) {
        done = true;
        t.editor.update(() => $setState($getRoot(), value, BigInt(1)));
      }
    });
    try {
      t.editor.update(() => $setCompositionKey(t.$text().getKey()), {
        discrete: true,
      });
      t.editor.update(() => t.$text().setTextContent('drained'), {
        skipTransforms: true,
      });
      armed = true;
      let error: unknown = null;
      try {
        t.binding.quiesce();
      } catch (e) {
        error = e;
      }
      expect(done).toBe(true);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(
        '@lexical/y: quiesce() could not serialize the drained editor state. Local updates may already have been written; no handoff result was cached. Store serializable state and retry quiesce().',
      );
      expect((error as Error).cause).toBeInstanceOf(Error);
      // The drain wrote: the text is stored and the composition ended.
      expect(t.doc.get('lexical-y').toString()).toContain('drained');
      expect(t.editor._compositionKey).toBeNull();
      const internal = t.binding as unknown as {
        quiesced: boolean;
        quiescedState: unknown;
      };
      expect(internal.quiesced).toBe(false);
      expect(internal.quiescedState).toBeNull();
      // With serializable state, a retry hands off.
      t.set(1);
      const result = t.binding.quiesce();
      expect(stateOf(result.draft.json)).toBe(1);
      expect(JSON.stringify(result.draft.json)).toContain('drained');
      expect(t.binding.status).toBe('readonly');
      expect(t.binding.quiesce()).toStrictEqual(result);
    } finally {
      stop();
      t.dispose();
    }
  });
  test("a node's exportJSON throws at the preflight: a TypeError naming its error, the cause kept, nothing changed", () => {
    const t = bind(gc);
    try {
      t.editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $create(ThrowingText).setTextContent('kept'),
              ),
            ),
        {discrete: true},
      );
      t.editor.update(() => t.$text().setTextContent('pending'), {
        skipTransforms: true,
      });
      const before = Buffer.from(Y.encodeStateAsUpdate(t.doc));
      const pending = t.editor._pendingEditorState;
      throwing = true;
      let error: unknown = null;
      try {
        t.binding.quiesce();
      } catch (e) {
        error = e;
      } finally {
        throwing = false;
      }
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toContain(
        'could not serialize the editor state as JSON: ThrowingText cannot be exported',
      );
      expect((error as Error).message).toMatch(/Nothing was changed/);
      expect((error as Error).cause).toBe(exportError);
      expect(Buffer.from(Y.encodeStateAsUpdate(t.doc))).toEqual(before);
      expect(t.editor._pendingEditorState).toBe(pending);
      expect(t.binding.status).toBe('active');
      expect(t.editor.isEditable()).toBe(true);
      // Once it exports, quiesce() hands off.
      const result = t.binding.quiesce();
      expect(JSON.stringify(result.draft.json)).toContain('pending');
      expect(t.binding.status).toBe('readonly');
    } finally {
      t.dispose();
    }
  });
});
