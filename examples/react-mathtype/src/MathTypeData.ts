/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {getWirisPlugin} from './MathTypeGlobals';

export const WIRIS_FORMULA_CLASS = 'Wirisformula';
export const WIRIS_MATHML_ATTRIBUTE = 'data-mathml';
export const WIRIS_CUSTOM_EDITOR_ATTRIBUTE = 'data-custom-editor';

export type MathTypeFormula = {
  altText: string;
  customEditor: null | string;
  height: null | number;
  mathML: string;
  src: string;
  width: null | number;
};

/**
 * True for the `img` elements MathType uses to represent a formula, either
 * because they carry MathType's class or because they carry the encoded
 * MathML. Checks `nodeName` rather than `instanceof HTMLImageElement` so it
 * still works for a node from another realm (an iframe or a clipboard
 * document).
 */
export function isWirisFormulaImage(
  domNode: HTMLElement,
): domNode is HTMLImageElement {
  return (
    domNode.nodeName === 'IMG' &&
    (domNode.classList.contains(WIRIS_FORMULA_CLASS) ||
      domNode.hasAttribute(WIRIS_MATHML_ATTRIBUTE))
  );
}

export function parseOptionalNumber(value: string | null): null | number {
  if (value === null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function encodeMathML(mathML: string): string {
  return getWirisPlugin().MathML.safeXmlEncode(mathML);
}

export function decodeMathML(encodedMathML: string): string {
  return getWirisPlugin().MathML.safeXmlDecode(encodedMathML);
}

export function createFormulaFromImage(
  image: HTMLImageElement,
  fallbackMathML?: string,
): MathTypeFormula {
  const encodedMathML = image.getAttribute(WIRIS_MATHML_ATTRIBUTE);
  const mathML =
    fallbackMathML ??
    (encodedMathML === null ? '' : decodeMathML(encodedMathML));
  return {
    altText: image.getAttribute('alt') ?? '',
    customEditor: image.getAttribute(WIRIS_CUSTOM_EDITOR_ATTRIBUTE),
    height: parseOptionalNumber(image.getAttribute('height')),
    mathML,
    src: image.getAttribute('src') ?? '',
    width: parseOptionalNumber(image.getAttribute('width')),
  };
}

/**
 * Builds the `img.Wirisformula` shape MathType's parser expects. The owning
 * `Document` is always passed in rather than read from the `document` global
 * so the element is created in the editor's realm (see the Shadow DOM and
 * iframe notes in the repository AGENTS.md).
 */
export function createImageFromFormula(
  formula: MathTypeFormula,
  ownerDocument: Document,
): HTMLImageElement {
  const image = ownerDocument.createElement('img');
  image.align = 'middle';
  image.className = WIRIS_FORMULA_CLASS;
  image.src = formula.src;
  image.alt = formula.altText;
  image.setAttribute('role', 'math');
  image.setAttribute(WIRIS_MATHML_ATTRIBUTE, encodeMathML(formula.mathML));
  if (formula.customEditor !== null) {
    image.setAttribute(WIRIS_CUSTOM_EDITOR_ATTRIBUTE, formula.customEditor);
  }
  if (formula.width !== null) {
    image.setAttribute('width', String(formula.width));
  }
  if (formula.height !== null) {
    image.setAttribute('height', String(formula.height));
  }
  image.style.maxWidth = 'none';
  return image;
}
