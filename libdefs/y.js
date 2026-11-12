/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

// The parts of @y/y (Yjs 14) that @lexical/y's public API names.
declare module '@y/y' {
  declare export class Doc {
    clientID: number;
    constructor(options?: {gc?: boolean, guid?: string, ...}): void;
    get(name?: string, nodeName?: string | null): Node;
    transact(fn: (tr: unknown) => void, origin?: unknown): void;
    destroy(): void;
  }
  declare export class Node {
    constructor(name?: string | null): void;
    readonly name: string | null;
    readonly length: number;
    getAttr(key: string): unknown;
    setAttr(key: string, value: unknown): unknown;
  }
  declare export class UndoManager {
    undo(): unknown;
    redo(): unknown;
    canUndo(): boolean;
    canRedo(): boolean;
    stopCapturing(): void;
    clear(clearUndoStack?: boolean, clearRedoStack?: boolean): void;
    destroy(): void;
  }
}
