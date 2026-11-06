/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {
  $createMarkNode,
  $isMarkNode,
  $unwrapMarkNode,
  MarkExtension,
} from '@lexical/mark';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  type LexicalEditor,
  REDO_COMMAND,
  UNDO_COMMAND,
} from 'lexical';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import {
  $pruneStaleMarkNodeIDs,
  registerCommentMarkHistorySync,
} from '../../commentMarkHistorySync';
import {CommentStore, createComment, createThread} from '../../index';

describe('$pruneStaleMarkNodeIDs', () => {
  let container: HTMLDivElement;
  let editor: LexicalEditor;

  beforeEach(() => {
    container = document.createElement('div');
    container.contentEditable = 'true';
    document.body.appendChild(container);
    editor = buildEditorFromExtensions({
      dependencies: [RichTextExtension, MarkExtension],
      name: 'prune-stale-marks-test',
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

  test('removes only the ids the predicate rejects', () => {
    let markKey = '';
    editor.update(
      () => {
        const mark = $createMarkNode(['valid', 'stale']);
        mark.append($createTextNode('hello'));
        $getRoot().clear().append($createParagraphNode().append(mark));
        markKey = mark.getKey();
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const mark = $getNodeByKey(markKey);
        if (!$isMarkNode(mark)) {
          throw new Error('Expected MarkNode');
        }
        $pruneStaleMarkNodeIDs(mark, id => id === 'valid');
      },
      {discrete: true},
    );

    const result = editor.read(() => {
      const mark = $getNodeByKey(markKey);
      return $isMarkNode(mark) ? mark.getIDs() : null;
    });

    expect(result).toEqual(['valid']);
  });

  test('unwraps the mark once no valid ids remain', () => {
    let markKey = '';
    editor.update(
      () => {
        const mark = $createMarkNode(['stale']);
        mark.append($createTextNode('hello'));
        $getRoot().clear().append($createParagraphNode().append(mark));
        markKey = mark.getKey();
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const mark = $getNodeByKey(markKey);
        if (!$isMarkNode(mark)) {
          throw new Error('Expected MarkNode');
        }
        $pruneStaleMarkNodeIDs(mark, () => false);
      },
      {discrete: true},
    );

    const result = editor.read(() => {
      const node = $getNodeByKey(markKey);
      return {
        stillMark: $isMarkNode(node),
        text: $getRoot().getTextContent(),
      };
    });

    expect(result).toEqual({stillMark: false, text: 'hello'});
  });

  test('is a no-op when every id is still valid', () => {
    let markKey = '';
    editor.update(
      () => {
        const mark = $createMarkNode(['valid']);
        mark.append($createTextNode('hello'));
        $getRoot().clear().append($createParagraphNode().append(mark));
        markKey = mark.getKey();
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const mark = $getNodeByKey(markKey);
        if (!$isMarkNode(mark)) {
          throw new Error('Expected MarkNode');
        }
        $pruneStaleMarkNodeIDs(mark, () => true);
      },
      {discrete: true},
    );

    const result = editor.read(() => {
      const mark = $getNodeByKey(markKey);
      return $isMarkNode(mark) ? mark.getIDs() : null;
    });

    expect(result).toEqual(['valid']);
  });
});

describe('CommentStore thread tombstones', () => {
  test('hasThread is true for a thread that exists', () => {
    const commentStore = new CommentStore({} as LexicalEditor);
    const thread = createThread('quote', [createComment('hi', 'author')]);
    commentStore.addComment(thread);

    expect(commentStore.hasThread(thread.id)).toBe(true);
  });

  test('hasThread is false once the thread has been deleted', () => {
    const commentStore = new CommentStore({} as LexicalEditor);
    const thread = createThread('quote', [createComment('hi', 'author')]);
    commentStore.addComment(thread);
    commentStore.deleteCommentOrThread(thread);

    expect(commentStore.hasThread(thread.id)).toBe(false);
  });

  test('hasThread is false for an id that never existed', () => {
    const commentStore = new CommentStore({} as LexicalEditor);

    expect(commentStore.hasThread('does-not-exist')).toBe(false);
  });

  test('hasThread is false for a reply comment id nested inside a thread', () => {
    const commentStore = new CommentStore({} as LexicalEditor);
    const reply = createComment('hi', 'author');
    const thread = createThread('quote', [reply]);
    commentStore.addComment(thread);

    expect(commentStore.hasThread(reply.id)).toBe(false);
  });

  test('restoreThread brings a deleted thread back at its original position', () => {
    const commentStore = new CommentStore({} as LexicalEditor);
    const first = createThread('first', [createComment('a', 'author')]);
    const second = createThread('second', [createComment('b', 'author')]);
    commentStore.addComment(first);
    commentStore.addComment(second);

    commentStore.deleteCommentOrThread(first);
    expect(commentStore.getComments()).toEqual([second]);

    const restored = commentStore.restoreThread(first.id);

    expect(restored).toBe(true);
    expect(commentStore.getComments()).toEqual([first, second]);
  });

  test('restoreThread returns false when there is no tombstone', () => {
    const commentStore = new CommentStore({} as LexicalEditor);

    expect(commentStore.restoreThread('never-deleted')).toBe(false);
  });

  test('restoreThread is one-shot: a second call finds no tombstone', () => {
    const commentStore = new CommentStore({} as LexicalEditor);
    const thread = createThread('quote', [createComment('hi', 'author')]);
    commentStore.addComment(thread);
    commentStore.deleteCommentOrThread(thread);

    expect(commentStore.restoreThread(thread.id)).toBe(true);
    expect(commentStore.restoreThread(thread.id)).toBe(false);
  });

  test('retireThread deletes a live thread and re-tombstones it', () => {
    const commentStore = new CommentStore({} as LexicalEditor);
    const thread = createThread('quote', [createComment('hi', 'author')]);
    commentStore.addComment(thread);

    commentStore.retireThread(thread.id);
    expect(commentStore.hasThread(thread.id)).toBe(false);

    expect(commentStore.restoreThread(thread.id)).toBe(true);
    expect(commentStore.hasThread(thread.id)).toBe(true);
  });

  test('retireThread on an id with no live thread is a no-op', () => {
    const commentStore = new CommentStore({} as LexicalEditor);

    expect(() => commentStore.retireThread('does-not-exist')).not.toThrow();
  });
});

describe('registerCommentMarkHistorySync', () => {
  let container: HTMLDivElement;
  let editor: LexicalEditor;
  let commentStore: CommentStore;
  let cleanup: () => void;

  beforeEach(() => {
    container = document.createElement('div');
    container.contentEditable = 'true';
    document.body.appendChild(container);
    editor = buildEditorFromExtensions({
      dependencies: [RichTextExtension, MarkExtension, HistoryExtension],
      name: 'comment-mark-history-sync-test',
      onError: e => {
        throw e;
      },
    });
    editor.setRootElement(container);
    commentStore = new CommentStore(editor);
    cleanup = registerCommentMarkHistorySync(editor, commentStore);
  });

  afterEach(() => {
    cleanup();
    editor.setRootElement(null);
    document.body.removeChild(container);
  });

  function $textContent(): string {
    return $getRoot().getTextContent();
  }

  function $markState(markKey: string, threadId: string) {
    const node = $getNodeByKey(markKey);
    return $isMarkNode(node) && node.getIDs().includes(threadId);
  }

  function deleteThreadAndMark(markKey: string, threadId: string) {
    commentStore.deleteCommentOrThread(
      commentStore
        .getComments()
        .find(c => c.type === 'thread' && c.id === threadId)!,
    );
    editor.update(
      () => {
        const mark = $getNodeByKey(markKey);
        if ($isMarkNode(mark)) {
          mark.deleteID(threadId);
          if (mark.getIDs().length === 0) {
            $unwrapMarkNode(mark);
          }
        }
      },
      {discrete: true},
    );
  }

  test('undo after deleting a thread restores both the mark and the comment', () => {
    const thread = createThread('quote', [createComment('hi', 'author')]);
    commentStore.addComment(thread);

    let markKey = '';
    editor.update(
      () => {
        const mark = $createMarkNode([thread.id]);
        mark.append($createTextNode('hello'));
        $getRoot().clear().append($createParagraphNode().append(mark));
        markKey = mark.getKey();
      },
      {discrete: true},
    );

    deleteThreadAndMark(markKey, thread.id);

    expect(editor.read($textContent)).toBe('hello');
    expect(editor.read(() => $markState(markKey, thread.id))).toBe(false);
    expect(commentStore.hasThread(thread.id)).toBe(false);

    editor.dispatchCommand(UNDO_COMMAND, undefined);

    expect(editor.read($textContent)).toBe('hello');
    expect(editor.read(() => $markState(markKey, thread.id))).toBe(true);
    expect(commentStore.hasThread(thread.id)).toBe(true);
    expect(commentStore.getComments()).toEqual([thread]);
  });

  test('redo after that undo deletes both the mark and the comment again', () => {
    const thread = createThread('quote', [createComment('hi', 'author')]);
    commentStore.addComment(thread);

    let markKey = '';
    editor.update(
      () => {
        const mark = $createMarkNode([thread.id]);
        mark.append($createTextNode('hello'));
        $getRoot().clear().append($createParagraphNode().append(mark));
        markKey = mark.getKey();
      },
      {discrete: true},
    );

    deleteThreadAndMark(markKey, thread.id);
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    editor.dispatchCommand(REDO_COMMAND, undefined);

    expect(editor.read(() => $markState(markKey, thread.id))).toBe(false);
    expect(commentStore.hasThread(thread.id)).toBe(false);
  });

  test('the mark and comment stay in sync across repeated undo/redo cycles', () => {
    const thread = createThread('quote', [createComment('hi', 'author')]);
    commentStore.addComment(thread);

    let markKey = '';
    editor.update(
      () => {
        const mark = $createMarkNode([thread.id]);
        mark.append($createTextNode('hello'));
        $getRoot().clear().append($createParagraphNode().append(mark));
        markKey = mark.getKey();
      },
      {discrete: true},
    );

    deleteThreadAndMark(markKey, thread.id);

    for (let cycle = 0; cycle < 3; cycle++) {
      editor.dispatchCommand(UNDO_COMMAND, undefined);
      expect(editor.read(() => $markState(markKey, thread.id))).toBe(true);
      expect(commentStore.hasThread(thread.id)).toBe(true);

      editor.dispatchCommand(REDO_COMMAND, undefined);
      expect(editor.read(() => $markState(markKey, thread.id))).toBe(false);
      expect(commentStore.hasThread(thread.id)).toBe(false);
    }
  });

  test('a dangling id with no tombstone is pruned instead of restored', () => {
    let markKey = '';
    editor.update(
      () => {
        const mark = $createMarkNode(['untracked-id']);
        mark.append($createTextNode('hello'));
        $getRoot().clear().append($createParagraphNode().append(mark));
        markKey = mark.getKey();
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const mark = $getNodeByKey(markKey);
        if ($isMarkNode(mark)) {
          $unwrapMarkNode(mark);
        }
      },
      {discrete: true},
    );

    editor.dispatchCommand(UNDO_COMMAND, undefined);
    // flush the prune update queued by the update listener
    editor.read(() => {});

    const result = editor.read(() => {
      const node = $getNodeByKey(markKey);
      return {stillMark: $isMarkNode(node), text: $textContent()};
    });
    expect(result).toEqual({stillMark: false, text: 'hello'});
  });

  test('undo of an unrelated edit leaves a live thread mark intact', () => {
    const thread = createThread('quote', [createComment('hi', 'author')]);
    commentStore.addComment(thread);

    let markKey = '';
    let paragraphKey = '';
    editor.update(
      () => {
        const mark = $createMarkNode([thread.id]);
        mark.append($createTextNode('hello'));
        const paragraph = $createParagraphNode().append(mark);
        $getRoot().clear().append(paragraph);
        markKey = mark.getKey();
        paragraphKey = paragraph.getKey();
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const paragraph = $getNodeByKey(paragraphKey);
        if (!$isElementNode(paragraph)) {
          throw new Error('Expected ElementNode');
        }
        paragraph.append($createTextNode(' world'));
      },
      {discrete: true},
    );

    editor.dispatchCommand(UNDO_COMMAND, undefined);

    const result = editor.read(() => ({
      idsIntact: $markState(markKey, thread.id),
      text: $textContent(),
    }));

    expect(result).toEqual({idsIntact: true, text: 'hello'});
    expect(commentStore.hasThread(thread.id)).toBe(true);
  });
});
