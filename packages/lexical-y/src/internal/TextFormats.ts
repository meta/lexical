/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {type LexicalEditor, TextNode} from 'lexical';

// Text classes that keep no format bits. CodeHighlightNode declares it can
// have no format (canHaveFormat() is false) and its setFormat ignores every
// bit, so a bit stored over part of one (a format written while the token
// was plain text, or a write from outside the editor) is shown nowhere: a
// reader does not set its nodes apart by it (see Reader#$pieces), and the
// self-check does not expect it (see $checkWrite).

const formatless = new WeakMap<object, boolean>();

/** The prototype in `proto`'s chain that defines `name` itself. */
function ownerOf(proto: object | null, name: string): object | null {
  for (let p = proto; p !== null; p = Object.getPrototypeOf(p)) {
    if (Object.prototype.hasOwnProperty.call(p, name)) {
      return p;
    }
  }
  return null;
}

/**
 * Whether text of stored type `type` (absent: `text`) keeps no format bits:
 * the class its nodes are built as declares canHaveFormat() false, and its
 * setFormat comes from that declaring class or one it extends (a subclass
 * that brings back a setter of its own keeps what that setter keeps). A type
 * the editor does not register, or replaces without naming the class it
 * builds (`withKlass`), keeps every bit.
 */
export function keepsNoTextFormats(
  editor: LexicalEditor,
  type: unknown,
): boolean {
  const info = editor._nodes.get(typeof type === 'string' ? type : 'text');
  if (info === undefined || (info.replace !== null && !info.replaceWithKlass)) {
    return false;
  }
  const klass = info.replaceWithKlass || info.klass;
  let keepsNone = formatless.get(klass);
  if (keepsNone === undefined) {
    keepsNone = false;
    const proto = klass.prototype as unknown;
    if (proto instanceof TextNode) {
      const declares = ownerOf(proto, 'canHaveFormat');
      const setter = ownerOf(proto, 'setFormat');
      try {
        keepsNone =
          declares !== null &&
          declares !== TextNode.prototype &&
          setter !== null &&
          setter !== TextNode.prototype &&
          (setter === declares ||
            Object.prototype.isPrototypeOf.call(setter, declares)) &&
          proto.canHaveFormat() === false;
      } catch (_e) {
        keepsNone = false;
      }
    }
    formatless.set(klass, keepsNone);
  }
  return keepsNone;
}
