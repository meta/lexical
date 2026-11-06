/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {$getRoot} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

import {$createImageNode, ImageNode} from '../../src/nodes/ImageNode';

describe('ImageNode serialization', () => {
  test('an unsized image round-trips through its 0 sentinel', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[image-serialization]',
        nodes: [ImageNode],
      }),
    );
    let json: ReturnType<ImageNode['exportJSON']> | undefined;
    editor.update(
      () => {
        // No width/height given, so both are the 'inherit' sentinel.
        const image = $createImageNode({altText: 'alt', src: 'x.png'});
        $getRoot().append(image);
        json = image.exportJSON();
      },
      {discrete: true},
    );
    // 'inherit' has always serialized as 0 ...
    expect(json).toMatchObject({
      altText: 'alt',
      height: 0,
      src: 'x.png',
      width: 0,
    });

    editor.update(
      () => {
        // ... and parsing 0 (or an absent property) restores the sentinel,
        // rather than sizing the image to zero pixels.
        const restored = ImageNode.importJSON(json!) as ImageNode;
        expect(restored.__width).toBe('inherit');
        expect(restored.__height).toBe('inherit');
        const fromLegacy = ImageNode.importJSON({
          altText: 'alt',
          src: 'x.png',
          type: 'image',
          version: 1,
        } as unknown as Parameters<
          typeof ImageNode.importJSON
        >[0]) as ImageNode;
        expect(fromLegacy.__width).toBe('inherit');
        expect(fromLegacy.__height).toBe('inherit');
      },
      {discrete: true},
    );

    editor.update(
      () => {
        // A real size still round-trips unchanged.
        const sized = $createImageNode({
          altText: 'alt',
          height: 24,
          src: 'x.png',
          width: 42,
        });
        const restored = ImageNode.importJSON(sized.exportJSON()) as ImageNode;
        expect(restored.__width).toBe(42);
        expect(restored.__height).toBe(24);
      },
      {discrete: true},
    );
  });

  test('an absent maxWidth keeps the constructor default', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[image-max-width]',
        nodes: [ImageNode],
      }),
    );
    editor.update(
      () => {
        // `maxWidth` is read straight off the field but applied through
        // setMaxWidth, which treats `undefined` as "keep what you have" — a
        // direct field write would store `undefined` over the default.
        const restored = ImageNode.importJSON({
          altText: 'alt',
          src: 'x.png',
          type: 'image',
        });
        assert(restored instanceof ImageNode);
        expect(restored.__maxWidth).toBe(500);
        expect(restored.exportJSON()).toMatchObject({maxWidth: 500});
      },
      {discrete: true},
    );
  });

  test('showCaption applies as a direct field write', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[image-show-caption]',
        nodes: [ImageNode],
      }),
    );
    editor.update(
      () => {
        // withField declares showCaption to *be* __showCaption, so parsing
        // assigns it with no setter call and exporting reads it back.
        const restored = ImageNode.importJSON({
          altText: 'alt',
          showCaption: true,
          src: 'x.png',
          type: 'image',
        });
        assert(restored instanceof ImageNode);
        expect(restored.__showCaption).toBe(true);
        expect(restored.exportJSON()).toMatchObject({showCaption: true});
        // absent parses to the schema default rather than leaking undefined
        const bare = ImageNode.importJSON({
          altText: 'a',
          src: 'y.png',
          type: 'image',
        });
        assert(bare instanceof ImageNode);
        expect(bare.__showCaption).toBe(false);
      },
      {discrete: true},
    );
  });
});
