/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  createRenderState,
  domOverride,
  type DOMOverrideOptions,
  DOMRenderExtension,
} from '@lexical/html';
import {
  configExtension,
  defineExtension,
  isHTMLElement,
  ParagraphNode,
} from 'lexical';

export const RenderContextTerse = createRenderState('isTerse', Boolean);

/**
 * Install these overrides only for export sessions where terse output was
 * requested (`RenderContextTerse` is set). Non-terse exports never enter the
 * terse middleware at all, rather than running it and bailing per node.
 */
const terseOnly: DOMOverrideOptions = {
  disabledForSession: ctx => !ctx.get(RenderContextTerse),
};

export const TerseExportExtension = defineExtension({
  dependencies: [
    configExtension(DOMRenderExtension, {
      overrides: [
        domOverride(
          '*',
          {
            $exportDOM: (node, $next) => {
              const rval = $next();
              const {element} = rval;
              if (isHTMLElement(element)) {
                // Strip all theme classes
                for (const className of Array.from(element.classList)) {
                  if (className.startsWith('PlaygroundEditorTheme__')) {
                    element.classList.remove(className);
                  }
                }
                // Strip white-space: pre-wrap when not necessary
                if (
                  element.style.getPropertyValue('white-space') ===
                    'pre-wrap' &&
                  !/^\s|\s$|\s\s/.test(element.textContent)
                ) {
                  element.style.setProperty('white-space', null);
                }
                if (element.classList.length === 0) {
                  element.removeAttribute('class');
                }
                if (element.style.length === 0) {
                  // For some reason this getAttribute prevents style=""
                  element.getAttribute('style');
                  element.removeAttribute('style');
                }
              }
              return rval;
            },
          },
          terseOnly,
        ),
        domOverride(
          [ParagraphNode],
          {
            $exportDOM: (node, $next) => {
              const rval = $next();
              const {element} = rval;
              if (isHTMLElement(element)) {
                // clear any empty br
                if (node.isEmpty()) {
                  for (const el of element.querySelectorAll(':scope > br')) {
                    el.remove();
                  }
                }
              }
              return rval;
            },
          },
          terseOnly,
        ),
      ],
    }),
  ],
  name: '@lexical/playground/TerseExport',
});
