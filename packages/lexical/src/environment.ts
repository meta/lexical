/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Each probe below is a call to a function declared side-effect free, so that
// the build annotates the call and a bundler can drop the constant when it is
// unused. Written inline at module scope, the property reads
// (`navigator.userAgent`, `window.document`, an `in` test) count as side
// effects to esbuild and webpack, and every retained probe is one more
// statement pinning this module — and everything it is bundled with — into
// bundles that use none of it.

/** @__NO_SIDE_EFFECTS__ */
function canUseDOM(): boolean {
  return (
    typeof window !== 'undefined' &&
    // eslint-disable-next-line no-restricted-syntax
    typeof window.document !== 'undefined' &&
    // eslint-disable-next-line no-restricted-syntax
    typeof window.document.createElement !== 'undefined'
  );
}

/** Whether a browser DOM environment is available. */
export const CAN_USE_DOM: boolean = canUseDOM();

declare global {
  interface Document {
    documentMode?: unknown;
  }

  interface Window {
    MSStream?: unknown;
  }
}

/** @__NO_SIDE_EFFECTS__ */
function getDocumentMode(): unknown {
  return CAN_USE_DOM && 'documentMode' in document
    ? // eslint-disable-next-line no-restricted-syntax
      document.documentMode
    : null;
}

const documentMode = getDocumentMode();

/** @__NO_SIDE_EFFECTS__ */
function testPlatform(regExp: RegExp): boolean {
  return CAN_USE_DOM && regExp.test(navigator.platform);
}

/** @__NO_SIDE_EFFECTS__ */
function testUserAgent(regExp: RegExp): boolean {
  return CAN_USE_DOM && regExp.test(navigator.userAgent);
}

/** Whether the current platform is Apple (macOS, iOS, iPadOS, iPod). */
export const IS_APPLE: boolean = testPlatform(/Mac|iPod|iPhone|iPad/);

/** Whether the current browser is Firefox (excludes SeaMonkey). */
export const IS_FIREFOX: boolean = testUserAgent(
  /^(?!.*Seamonkey)(?=.*Firefox).*/i,
);

/** @__NO_SIDE_EFFECTS__ */
function canUseBeforeInput(): boolean {
  return CAN_USE_DOM && 'InputEvent' in window && !documentMode
    ? // eslint-disable-next-line no-restricted-syntax
      'getTargetRanges' in new window.InputEvent('input')
    : false;
}

/** Whether the browser supports the `beforeinput` event via `InputEvent.getTargetRanges()`. */
export const CAN_USE_BEFORE_INPUT: boolean = canUseBeforeInput();

/** @__NO_SIDE_EFFECTS__ */
function isIOS(): boolean {
  return (
    CAN_USE_DOM &&
    // eslint-disable-next-line no-restricted-syntax
    !window.MSStream &&
    (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
      // iPadOS may report a desktop-class Macintosh user agent.
      // Real Macs don't support multi-touch, so maxTouchPoints distinguishes them.
      (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1))
  );
}

/** Whether the current platform is iOS or iPadOS (iPhone, iPad, iPod). */
export const IS_IOS: boolean = isIOS();

/** Whether the current platform is Android. */
export const IS_ANDROID: boolean = testUserAgent(/Android/);

/** Whether the current browser is Safari (excludes Android WebView which has a similar UA string). */
export const IS_SAFARI: boolean =
  testUserAgent(/Version\/[\d.]+.*Safari/) && !IS_ANDROID;

// Keep these in case we need to use them in the future.
// export const IS_WINDOWS: boolean = testPlatform(/Win/);
/** Whether the current browser is Chrome (or Chromium-based). */
export const IS_CHROME: boolean = testUserAgent(/^(?=.*Chrome).*/i);
// export const canUseTextInputEvent: boolean = CAN_USE_DOM && 'TextEvent' in window && !documentMode;

/** Whether the current browser is Chrome on Android. */
export const IS_ANDROID_CHROME: boolean =
  CAN_USE_DOM && IS_ANDROID && IS_CHROME;

/** Whether the current browser is Apple WebKit (Safari on macOS/iOS, excludes Chrome). */
export const IS_APPLE_WEBKIT =
  testUserAgent(/AppleWebKit\/[\d.]+/) && IS_APPLE && !IS_CHROME;
