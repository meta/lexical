/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {type Provider, TOGGLE_CONNECT_COMMAND} from '@lexical/yjs';
import {COMMAND_PRIORITY_LOW, type LexicalEditor} from 'lexical';
import {useEffect, useState} from 'react';
import {
  Array as YArray,
  Map as YMap,
  type Transaction,
  YArrayEvent,
  type YEvent,
} from 'yjs';

export type Comment = {
  author: string;
  content: string;
  deleted: boolean;
  id: string;
  timeStamp: number;
  type: 'comment';
};

export type Thread = {
  comments: Comment[];
  id: string;
  quote: string;
  type: 'thread';
};

export type Comments = (Thread | Comment)[];

function createUID(): string {
  return Math.random()
    .toString(36)
    .replace(/[^a-z]+/g, '')
    .substring(0, 5);
}

export function createComment(
  content: string,
  author: string,
  id?: string,
  timeStamp?: number,
  deleted?: boolean,
): Comment {
  return {
    author,
    content,
    deleted: deleted === undefined ? false : deleted,
    id: id === undefined ? createUID() : id,
    timeStamp:
      timeStamp === undefined
        ? performance.timeOrigin + performance.now()
        : timeStamp,
    type: 'comment',
  };
}

export function createThread(
  quote: string,
  comments: Comment[],
  id?: string,
): Thread {
  return {
    comments,
    id: id === undefined ? createUID() : id,
    quote,
    type: 'thread',
  };
}

function cloneThread(thread: Thread): Thread {
  return {
    comments: Array.from(thread.comments),
    id: thread.id,
    quote: thread.quote,
    type: 'thread',
  };
}

function markDeleted(comment: Comment): Comment {
  return {
    author: comment.author,
    content: '[Deleted Comment]',
    deleted: true,
    id: comment.id,
    timeStamp: comment.timeStamp,
    type: 'comment',
  };
}

function triggerOnChange(commentStore: CommentStore): void {
  const listeners = commentStore._changeListeners;
  for (const listener of listeners) {
    listener();
  }
}

export class CommentStore {
  _editor: LexicalEditor;
  _comments: Comments;
  _changeListeners: Set<() => void>;
  _collabProvider: null | Provider;
  _deletedThreads: Map<string, {index: number; thread: Thread}>;

  constructor(editor: LexicalEditor) {
    this._comments = [];
    this._editor = editor;
    this._collabProvider = null;
    this._changeListeners = new Set();
    this._deletedThreads = new Map();
  }

  isCollaborative(): boolean {
    return this._collabProvider !== null;
  }

  getComments(): Comments {
    return this._comments;
  }

  _findThread(id: string): Thread | undefined {
    return this._comments.find(
      (commentOrThread): commentOrThread is Thread =>
        commentOrThread.type === 'thread' && commentOrThread.id === id,
    );
  }

  hasThread(id: string): boolean {
    return this._findThread(id) !== undefined;
  }

  restoreThread(id: string): boolean {
    const tombstone = this._deletedThreads.get(id);
    if (tombstone === undefined) {
      return false;
    }
    this._deletedThreads.delete(id);
    this.addComment(tombstone.thread, undefined, tombstone.index);
    return true;
  }

  retireThread(id: string): void {
    const thread = this._findThread(id);
    if (thread !== undefined) {
      this.deleteCommentOrThread(thread);
    }
  }

  addComment(
    commentOrThread: Comment | Thread,
    thread?: Thread,
    offset?: number,
  ): void {
    const nextComments = Array.from(this._comments);
    // The YJS types explicitly use `any` as well.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sharedCommentsArray: YArray<any> | null = this._getCollabComments();

    if (thread !== undefined && commentOrThread.type === 'comment') {
      for (let i = 0; i < nextComments.length; i++) {
        const comment = nextComments[i];
        if (comment.type === 'thread' && comment.id === thread.id) {
          const newThread = cloneThread(comment);
          nextComments.splice(i, 1, newThread);
          const insertOffset =
            offset !== undefined ? offset : newThread.comments.length;
          if (this.isCollaborative() && sharedCommentsArray !== null) {
            const parentSharedArray = sharedCommentsArray
              .get(i)
              .get('comments');
            this._withRemoteTransaction(() => {
              const sharedMap = this._createCollabSharedMap(commentOrThread);
              parentSharedArray.insert(insertOffset, [sharedMap]);
            });
          }
          newThread.comments.splice(insertOffset, 0, commentOrThread);
          break;
        }
      }
    } else {
      const insertOffset = offset !== undefined ? offset : nextComments.length;
      if (this.isCollaborative() && sharedCommentsArray !== null) {
        this._withRemoteTransaction(() => {
          const sharedMap = this._createCollabSharedMap(commentOrThread);
          sharedCommentsArray.insert(insertOffset, [sharedMap]);
        });
      }
      nextComments.splice(insertOffset, 0, commentOrThread);
    }
    this._comments = nextComments;
    triggerOnChange(this);
  }

  deleteCommentOrThread(
    commentOrThread: Comment | Thread,
    thread?: Thread,
  ): {markedComment: Comment; index: number} | null {
    const nextComments = Array.from(this._comments);
    // The YJS types explicitly use `any` as well.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sharedCommentsArray: YArray<any> | null = this._getCollabComments();
    let commentIndex: number | null = null;

    if (thread !== undefined) {
      for (let i = 0; i < nextComments.length; i++) {
        const nextComment = nextComments[i];
        if (nextComment.type === 'thread' && nextComment.id === thread.id) {
          const newThread = cloneThread(nextComment);
          nextComments.splice(i, 1, newThread);
          const threadComments = newThread.comments;
          commentIndex = threadComments.indexOf(commentOrThread as Comment);
          if (this.isCollaborative() && sharedCommentsArray !== null) {
            const parentSharedArray = sharedCommentsArray
              .get(i)
              .get('comments');
            this._withRemoteTransaction(() => {
              parentSharedArray.delete(commentIndex);
            });
          }
          threadComments.splice(commentIndex, 1);
          break;
        }
      }
    } else {
      commentIndex = nextComments.indexOf(commentOrThread);
      if (this.isCollaborative() && sharedCommentsArray !== null) {
        this._withRemoteTransaction(() => {
          sharedCommentsArray.delete(commentIndex as number);
        });
      }
      nextComments.splice(commentIndex, 1);
      if (commentOrThread.type === 'thread') {
        this._deletedThreads.set(commentOrThread.id, {
          index: commentIndex,
          thread: commentOrThread,
        });
      }
    }
    this._comments = nextComments;
    triggerOnChange(this);

    if (commentOrThread.type === 'comment') {
      return {
        index: commentIndex as number,
        markedComment: markDeleted(commentOrThread),
      };
    }

    return null;
  }

  registerOnChange(onChange: () => void): () => void {
    const changeListeners = this._changeListeners;
    changeListeners.add(onChange);
    return () => {
      changeListeners.delete(onChange);
    };
  }

  _withRemoteTransaction(fn: () => void): void {
    const provider = this._collabProvider;
    if (provider !== null) {
      // @ts-expect-error doc does exist
      const doc = provider.doc;
      doc.transact(fn, this);
    }
  }

  _withLocalTransaction(fn: () => void): void {
    const collabProvider = this._collabProvider;
    try {
      this._collabProvider = null;
      fn();
    } finally {
      this._collabProvider = collabProvider;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _getCollabComments(): null | YArray<any> {
    const provider = this._collabProvider;
    if (provider !== null) {
      // @ts-expect-error doc does exist
      const doc = provider.doc;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return doc.get('comments', YArray) as YArray<any>;
    }
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _createCollabSharedMap(commentOrThread: Comment | Thread): YMap<any> {
    const sharedMap = new YMap();
    const type = commentOrThread.type;
    const id = commentOrThread.id;
    sharedMap.set('type', type);
    sharedMap.set('id', id);
    if (type === 'comment') {
      sharedMap.set('author', commentOrThread.author);
      sharedMap.set('content', commentOrThread.content);
      sharedMap.set('deleted', commentOrThread.deleted);
      sharedMap.set('timeStamp', commentOrThread.timeStamp);
    } else {
      sharedMap.set('quote', commentOrThread.quote);
      const commentsArray = new YArray();
      commentOrThread.comments.forEach((comment, i) => {
        const sharedChildComment = this._createCollabSharedMap(comment);
        commentsArray.insert(i, [sharedChildComment]);
      });
      sharedMap.set('comments', commentsArray);
    }
    return sharedMap;
  }

  registerCollaboration(provider: Provider): () => void {
    this._collabProvider = provider;
    const sharedCommentsArray = this._getCollabComments();

    const connect = () => {
      provider.connect();
    };

    const disconnect = () => {
      try {
        provider.disconnect();
      } catch (_e) {
        // Do nothing
      }
    };

    const unsubscribe = this._editor.registerCommand(
      TOGGLE_CONNECT_COMMAND,
      payload => {
        if (connect !== undefined && disconnect !== undefined) {
          const shouldConnect = payload;

          if (shouldConnect) {
            // eslint-disable-next-line no-console
            console.log('Comments connected!');
            connect();
          } else {
            // eslint-disable-next-line no-console
            console.log('Comments disconnected!');
            disconnect();
          }
        }

        return false;
      },
      COMMAND_PRIORITY_LOW,
    );

    const onSharedCommentChanges = (
      // The YJS types explicitly use `any` as well.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      events: YEvent<any>[],
      transaction: Transaction,
    ) => {
      if (transaction.origin !== this) {
        for (let i = 0; i < events.length; i++) {
          const event = events[i];

          if (event instanceof YArrayEvent) {
            const target = event.target;
            const deltas = event.delta;
            let offset = 0;

            for (let s = 0; s < deltas.length; s++) {
              const delta = deltas[s];
              const insert = delta.insert;
              const retain = delta.retain;
              const del = delta.delete;
              const parent = target.parent;
              const parentThread =
                target === sharedCommentsArray
                  ? undefined
                  : parent instanceof YMap &&
                    (this._comments.find(t => t.id === parent.get('id')) as
                      | Thread
                      | undefined);

              if (Array.isArray(insert)) {
                insert
                  .slice()
                  .reverse()
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  .forEach((map: YMap<any>) => {
                    const id = map.get('id');
                    const type = map.get('type');

                    const commentOrThread =
                      type === 'thread'
                        ? createThread(
                            map.get('quote'),
                            map
                              .get('comments')
                              .toArray()
                              .map(
                                (
                                  innerComment: Map<
                                    string,
                                    string | number | boolean
                                  >,
                                ) =>
                                  createComment(
                                    innerComment.get('content') as string,
                                    innerComment.get('author') as string,
                                    innerComment.get('id') as string,
                                    innerComment.get('timeStamp') as number,
                                    innerComment.get('deleted') as boolean,
                                  ),
                              ),
                            id,
                          )
                        : createComment(
                            map.get('content'),
                            map.get('author'),
                            id,
                            map.get('timeStamp'),
                            map.get('deleted'),
                          );
                    this._withLocalTransaction(() => {
                      this.addComment(
                        commentOrThread,
                        parentThread as Thread,
                        offset,
                      );
                    });
                  });
              } else if (typeof retain === 'number') {
                offset += retain;
              } else if (typeof del === 'number') {
                for (let d = 0; d < del; d++) {
                  const commentOrThread =
                    parentThread === undefined || parentThread === false
                      ? this._comments[offset]
                      : parentThread.comments[offset];
                  this._withLocalTransaction(() => {
                    this.deleteCommentOrThread(
                      commentOrThread,
                      parentThread as Thread,
                    );
                  });
                  offset++;
                }
              }
            }
          }
        }
      }
    };

    if (sharedCommentsArray === null) {
      return () => null;
    }

    sharedCommentsArray.observeDeep(onSharedCommentChanges);

    connect();

    return () => {
      sharedCommentsArray.unobserveDeep(onSharedCommentChanges);
      unsubscribe();
      this._collabProvider = null;
    };
  }
}

export {registerCommentMarkHistorySync} from './commentMarkHistorySync';

export function useCommentStore(commentStore: CommentStore): Comments {
  const [comments, setComments] = useState<Comments>(
    commentStore.getComments(),
  );

  useEffect(() => {
    return commentStore.registerOnChange(() => {
      setComments(commentStore.getComments());
    });
  }, [commentStore]);

  return comments;
}
