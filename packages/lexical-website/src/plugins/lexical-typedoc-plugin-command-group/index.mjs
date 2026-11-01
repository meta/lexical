/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @ts-check
import * as typedoc from 'typedoc';

const GROUP_NAME = 'Commands';

/**
 * Put every exported `LexicalCommand` constant in a "Commands" group, so each
 * module's API page lists its commands together instead of mixing them into
 * "Variables". A declaration that already has a `@group` tag keeps it.
 */
export function load(/** @type {import('typedoc').Application} */ app) {
  app.converter.on(
    typedoc.Converter.EVENT_RESOLVE_BEGIN,
    (/** @type {import('typedoc').Context} */ context) => {
      for (const reflection of context.project.getReflectionsByKind(
        typedoc.ReflectionKind.Variable,
      )) {
        const type =
          reflection instanceof typedoc.DeclarationReflection
            ? reflection.type
            : undefined;
        if (
          !(type instanceof typedoc.ReferenceType) ||
          type.name !== 'LexicalCommand'
        ) {
          continue;
        }
        if (!reflection.comment) {
          reflection.comment = new typedoc.Comment();
        }
        const comment = reflection.comment;
        if (!comment.getTag('@group')) {
          comment.blockTags.push(
            new typedoc.CommentTag('@group', [
              {kind: 'text', text: GROUP_NAME},
            ]),
          );
        }
      }
    },
  );
}
