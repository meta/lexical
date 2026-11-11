/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

export type MathTypeCustomEditors = {
  disable: () => void;
  enable: (name: string) => void;
};

export type MathTypeIntegrationInstance = {
  core: {
    editionProperties: {
      dbclick?: boolean;
      isNewElement?: boolean;
      temporalImage?: HTMLImageElement | null;
    };
    getCustomEditors: () => MathTypeCustomEditors;
  };
  destroy: () => void;
  init: () => void;
  insertFormula: (
    focusElement: HTMLElement | Window,
    windowTarget: Window,
    mathML: null | string,
    wirisProperties: null | object,
  ) => object;
  listeners: {
    fire: (eventName: string, payload: object) => void;
  };
  openExistingFormulaEditor: () => void;
  openNewFormulaEditor: () => void;
  toolbar: HTMLElement | null;
};

export type MathTypeIntegrationProperties = {
  integrationParameters?: {
    editorParameters?: {
      language?: string;
    };
    serviceProviderProperties?: {
      server?: string;
      URI?: string;
    };
  };
  target: HTMLElement;
  toolbar: HTMLElement;
};

/** A `Listeners` entry, as built by `Listeners.newListener`. */
export type MathTypeListener = {
  callback: (event: object) => void;
  eventName: string;
};

export type WirisPluginGlobal = {
  Configuration?: {
    get: (key: string) => false | string;
  };
  Core: {
    /**
     * Fires `onModalClose` every time the MathType dialog closes, whichever
     * button or key closed it. `Listeners` has no `remove`, so unsubscribing
     * means splicing this array.
     */
    globalListeners: {
      add: (listener: MathTypeListener) => void;
      listeners: MathTypeListener[];
    };
  };
  Listeners: {
    newListener: (
      eventName: string,
      callback: (event: object) => void,
    ) => MathTypeListener;
  };
  currentInstance?: MathTypeIntegrationInstance | null;
  GenericIntegration: new (
    properties: MathTypeIntegrationProperties,
  ) => MathTypeIntegrationInstance;
  MathML: {
    safeXmlDecode: (mathML: string) => string;
    safeXmlEncode: (mathML: string) => string;
  };
  Parser: {
    endParse: (html: string) => string;
    initParse: (html: string, language?: string) => string;
    /**
     * Returns null when the `showimage` service rejects the MathML as
     * malformed, so every call site has to handle a missing image.
     */
    mathmlToImgObject: (
      document: Document,
      mathML: string,
      wirisProperties: null | object,
      language?: string,
    ) => HTMLImageElement | null;
  };
};

declare global {
  interface Window {
    WirisPlugin?: WirisPluginGlobal;
  }
}

/**
 * The MathType generic integration installs itself as a `window.WirisPlugin`
 * singleton when `@wiris/mathtype-generic` is imported. `MathTypeExtension`
 * imports it eagerly at module scope so that every consumer of this
 * accessor - including {@link MathTypeNode.decorate}, which can render a
 * formula on the first paint - always finds it loaded.
 */
export function getWirisPlugin(): WirisPluginGlobal {
  const {WirisPlugin} = window;
  if (WirisPlugin === undefined) {
    throw new Error('MathType generic integration did not initialize.');
  }
  return WirisPlugin;
}
