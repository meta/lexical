/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {objectKlassEquals} from '@lexical/utils';
import {initializeUnitTest} from 'lexical/src/__tests__/utils';
import {describe, expect, it} from 'vitest';

class MyEvent extends Event {}

class MyEvent2 extends Event {}

// eslint-disable-next-line no-shadow
const MyEventShadow = (() => class MyEvent extends Event {})();

describe('LexicalUtilsKlassEqual tests', () => {
  initializeUnitTest(testEnv => {
    it('objectKlassEquals', async () => {
      const eventInstance = new MyEvent('');
      expect(eventInstance instanceof MyEvent).toBeTruthy();
      expect(objectKlassEquals(eventInstance, MyEvent)).toBeTruthy();
      expect(eventInstance instanceof MyEvent2).toBeFalsy();
      expect(objectKlassEquals(eventInstance, MyEvent2)).toBeFalsy();
      expect(eventInstance instanceof MyEventShadow).toBeFalsy();
      expect(objectKlassEquals(eventInstance, MyEventShadow)).toBeTruthy();
    });
    it('objectKlassEquals with a nullish or prototype-less value', async () => {
      // The parameter is typed `unknown`, and the existing `!== null` guard
      // shows nullish input is expected to be answered, not thrown on.
      expect(objectKlassEquals(null, MyEvent)).toBe(false);
      expect(objectKlassEquals(undefined, MyEvent)).toBe(false);
      // Object.getPrototypeOf() returns null for these, so reading
      // .constructor off it throws.
      expect(objectKlassEquals(Object.create(null), MyEvent)).toBe(false);
    });
  });
});
