/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/** Whether a browser DOM environment is available. */
export const CAN_USE_DOM: boolean =
  typeof window !== 'undefined' &&
  // eslint-disable-next-line no-restricted-syntax
  typeof window.document !== 'undefined' &&
  // eslint-disable-next-line no-restricted-syntax
  typeof window.document.createElement !== 'undefined';

declare global {
  interface Document {
    documentMode?: unknown;
  }

  interface Window {
    MSStream?: unknown;
  }
}

const documentMode =
  // eslint-disable-next-line no-restricted-syntax
  CAN_USE_DOM && 'documentMode' in document ? document.documentMode : null;

/** Whether the current platform is Apple (macOS, iOS, iPadOS, iPod). */
export const IS_APPLE: boolean =
  CAN_USE_DOM && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

/** Whether the current browser is Firefox (excludes SeaMonkey). */
export const IS_FIREFOX: boolean =
  CAN_USE_DOM && /^(?!.*Seamonkey)(?=.*Firefox).*/i.test(navigator.userAgent);

/** Whether the browser supports the `beforeinput` event via `InputEvent.getTargetRanges()`. */
export const CAN_USE_BEFORE_INPUT: boolean =
  CAN_USE_DOM && 'InputEvent' in window && !documentMode
    ? // eslint-disable-next-line no-restricted-syntax
      'getTargetRanges' in new window.InputEvent('input')
    : false;

/** Whether the current platform is iOS or iPadOS (iPhone, iPad, iPod). */
export const IS_IOS: boolean =
  CAN_USE_DOM &&
  // eslint-disable-next-line no-restricted-syntax
  !window.MSStream &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS may report a desktop-class Macintosh user agent.
    // Real Macs don't support multi-touch, so maxTouchPoints distinguishes them.
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

/** Whether the current platform is Android. */
export const IS_ANDROID: boolean =
  CAN_USE_DOM && /Android/.test(navigator.userAgent);

/** Whether the current browser is Safari (excludes Android WebView which has a similar UA string). */
export const IS_SAFARI: boolean =
  CAN_USE_DOM &&
  /Version\/[\d.]+.*Safari/.test(navigator.userAgent) &&
  !IS_ANDROID;

// Keep these in case we need to use them in the future.
// export const IS_WINDOWS: boolean = CAN_USE_DOM && /Win/.test(navigator.platform);
/** Whether the current browser is Chrome (or Chromium-based). */
export const IS_CHROME: boolean =
  CAN_USE_DOM && /^(?=.*Chrome).*/i.test(navigator.userAgent);
// export const canUseTextInputEvent: boolean = CAN_USE_DOM && 'TextEvent' in window && !documentMode;

/** Whether the current browser is Chrome on Android. */
export const IS_ANDROID_CHROME: boolean =
  CAN_USE_DOM && IS_ANDROID && IS_CHROME;

/** Whether the current browser is Apple WebKit (Safari on macOS/iOS, excludes Chrome). */
export const IS_APPLE_WEBKIT =
  CAN_USE_DOM &&
  /AppleWebKit\/[\d.]+/.test(navigator.userAgent) &&
  IS_APPLE &&
  !IS_CHROME;
