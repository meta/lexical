/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  buildEditorFromExtensions,
  defineExtension,
  getExtensionDependencyFromEditor,
  signal,
} from '@lexical/extension';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {LexicalExtensionEditorComposer} from '@lexical/react/LexicalExtensionEditorComposer';
import {ReactPluginHostExtension} from '@lexical/react/ReactPluginHostExtension';
import {
  useExtensionSignalValue,
  useSignalValue,
} from '@lexical/react/useExtensionSignalValue';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

describe('useSignalValue', () => {
  let container: HTMLDivElement | null = null;
  let reactRoot: Root;

  beforeEach(() => {
    container = document.createElement('div');
    reactRoot = createRoot(container);
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container!);
    container = null;
  });

  test('subscribes to signal and returns current value', async () => {
    const testSignal = signal(42);
    let renderedValue: number | null = null;

    function TestComponent() {
      const value = useSignalValue(testSignal);
      renderedValue = value;
      return <div>{value}</div>;
    }

    await act(async () => {
      reactRoot.render(<TestComponent />);
    });

    expect(renderedValue).toBe(42);
    expect(container?.textContent).toBe('42');
  });

  test('re-renders when signal value changes', async () => {
    const testSignal = signal(0);
    const renderCounts: number[] = [];

    function TestComponent() {
      const value = useSignalValue(testSignal);
      renderCounts.push(value);
      return <div>{value}</div>;
    }

    await act(async () => {
      reactRoot.render(<TestComponent />);
    });

    expect(renderCounts).toEqual([0]);
    expect(container?.textContent).toBe('0');

    await act(async () => {
      testSignal.value = 1;
    });

    expect(renderCounts).toEqual([0, 1]);
    expect(container?.textContent).toBe('1');

    await act(async () => {
      testSignal.value = 2;
    });

    expect(renderCounts).toEqual([0, 1, 2]);
    expect(container?.textContent).toBe('2');
  });

  test('works with different value types', async () => {
    const stringSignal = signal('hello');
    const booleanSignal = signal(true);
    const objectSignal = signal({count: 5});

    function TestComponent() {
      const str = useSignalValue(stringSignal);
      const bool = useSignalValue(booleanSignal);
      const obj = useSignalValue(objectSignal);
      return (
        <div>
          {str}-{bool.toString()}-{obj.count}
        </div>
      );
    }

    await act(async () => {
      reactRoot.render(<TestComponent />);
    });

    expect(container?.textContent).toBe('hello-true-5');
  });

  test('maintains stable subscription across re-renders', async () => {
    const testSignal = signal(1);
    let subscriptionCount = 0;

    // Override subscribe to count calls
    const originalSubscribe = testSignal.subscribe.bind(testSignal);
    testSignal.subscribe = (callback: (value: number) => void) => {
      subscriptionCount++;
      return originalSubscribe(callback);
    };

    function TestComponent({dummy}: {dummy: number}) {
      const value = useSignalValue(testSignal);
      return (
        <div>
          {value}-{dummy}
        </div>
      );
    }

    await act(async () => {
      reactRoot.render(<TestComponent dummy={1} />);
    });

    const initialSubscriptionCount = subscriptionCount;
    expect(initialSubscriptionCount).toBeGreaterThan(0);

    // Re-render with different prop (but same signal)
    await act(async () => {
      reactRoot.render(<TestComponent dummy={2} />);
    });

    // Should not create new subscription
    expect(subscriptionCount).toBe(initialSubscriptionCount);
  });
});

describe('useExtensionSignalValue', () => {
  let container: HTMLDivElement | null = null;
  let reactRoot: Root;

  beforeEach(() => {
    container = document.createElement('div');
    reactRoot = createRoot(container);
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container!);
    container = null;
  });

  test('subscribes to extension signal property', async () => {
    const TestExtension = defineExtension({
      build: () => ({count: signal(10)}),
      name: 'test',
    });

    function TestComponent() {
      const count = useExtensionSignalValue(TestExtension, 'count');
      return <div>Count: {count}</div>;
    }

    await act(async () => {
      reactRoot.render(
        <LexicalExtensionComposer extension={TestExtension}>
          <TestComponent />
        </LexicalExtensionComposer>,
      );
    });

    expect(container?.textContent).toBe('Count: 10');
  });

  test('re-renders when extension signal changes', async () => {
    const TestExtension = defineExtension({
      build: () => ({value: signal('initial')}),
      name: 'test',
    });

    using editor = buildEditorFromExtensions({
      dependencies: [ReactPluginHostExtension, TestExtension],
      name: '[root]',
    });

    const dep = getExtensionDependencyFromEditor(editor, TestExtension);

    function TestComponent() {
      const value = useExtensionSignalValue(TestExtension, 'value');
      return <div>{value}</div>;
    }

    await act(async () => {
      reactRoot.render(
        <LexicalExtensionEditorComposer initialEditor={editor}>
          <TestComponent />
        </LexicalExtensionEditorComposer>,
      );
    });

    expect(container?.textContent).toBe('initial');

    await act(async () => {
      dep.output.value.value = 'updated';
    });

    expect(container?.textContent).toBe('updated');

    // Unmount before `using` disposes the editor so the disposal does not
    // update the still-mounted EditorComponent outside of act().
    await act(async () => {
      reactRoot.unmount();
    });
  });

  test('works with multiple signal properties', async () => {
    const TestExtension = defineExtension({
      build: () => ({
        count: signal(0),
        enabled: signal(true),
        name: signal('test'),
      }),
      name: 'test',
    });

    function TestComponent() {
      const count = useExtensionSignalValue(TestExtension, 'count');
      const name = useExtensionSignalValue(TestExtension, 'name');
      const enabled = useExtensionSignalValue(TestExtension, 'enabled');
      return (
        <div>
          {name}: {count} ({enabled ? 'enabled' : 'disabled'})
        </div>
      );
    }

    await act(async () => {
      reactRoot.render(
        <LexicalExtensionComposer extension={TestExtension}>
          <TestComponent />
        </LexicalExtensionComposer>,
      );
    });

    expect(container?.textContent).toBe('test: 0 (enabled)');
  });

  test('works with mixed signal and non-signal outputs', async () => {
    const TestExtension = defineExtension({
      build: () => ({
        count: signal(5),
        staticValue: 'static',
      }),
      name: 'test',
    });

    function TestComponent() {
      const count = useExtensionSignalValue(TestExtension, 'count');
      return <div>Count: {count}</div>;
    }

    await act(async () => {
      reactRoot.render(
        <LexicalExtensionComposer extension={TestExtension}>
          <TestComponent />
        </LexicalExtensionComposer>,
      );
    });

    expect(container?.textContent).toBe('Count: 5');
  });

  test('each component independently subscribes to signals', async () => {
    const TestExtension = defineExtension({
      build: () => ({count: signal(1)}),
      name: 'test',
    });

    using editor = buildEditorFromExtensions({
      dependencies: [ReactPluginHostExtension, TestExtension],
      name: '[root]',
    });

    const dep = getExtensionDependencyFromEditor(editor, TestExtension);

    function ComponentA() {
      const count = useExtensionSignalValue(TestExtension, 'count');
      return <div>A: {count}</div>;
    }

    function ComponentB() {
      const count = useExtensionSignalValue(TestExtension, 'count');
      return <div>B: {count}</div>;
    }

    await act(async () => {
      reactRoot.render(
        <LexicalExtensionEditorComposer initialEditor={editor}>
          <ComponentA />
          <ComponentB />
        </LexicalExtensionEditorComposer>,
      );
    });

    expect(container?.textContent).toBe('A: 1B: 1');

    await act(async () => {
      dep.output.count.value = 5;
    });

    expect(container?.textContent).toBe('A: 5B: 5');

    // Unmount before `using` disposes the editor so the disposal does not
    // update the still-mounted EditorComponent outside of act().
    await act(async () => {
      reactRoot.unmount();
    });
  });

  test('works with complex object signals', async () => {
    interface User {
      email: string;
      id: number;
      name: string;
    }

    const TestExtension = defineExtension({
      build: () => ({
        user: signal<User>({
          email: 'john@example.com',
          id: 1,
          name: 'John Doe',
        }),
      }),
      name: 'test',
    });

    using editor = buildEditorFromExtensions({
      dependencies: [ReactPluginHostExtension, TestExtension],
      name: '[root]',
    });

    const dep = getExtensionDependencyFromEditor(editor, TestExtension);

    function TestComponent() {
      const user = useExtensionSignalValue(TestExtension, 'user');
      return (
        <div>
          {user.name} ({user.email})
        </div>
      );
    }

    await act(async () => {
      reactRoot.render(
        <LexicalExtensionEditorComposer initialEditor={editor}>
          <TestComponent />
        </LexicalExtensionEditorComposer>,
      );
    });

    expect(container?.textContent).toBe('John Doe (john@example.com)');

    await act(async () => {
      dep.output.user.value = {
        email: 'jane@example.com',
        id: 2,
        name: 'Jane Smith',
      };
    });

    expect(container?.textContent).toBe('Jane Smith (jane@example.com)');

    // Unmount before `using` disposes the editor so the disposal does not
    // update the still-mounted EditorComponent outside of act().
    await act(async () => {
      reactRoot.unmount();
    });
  });

  test('updates correctly with rapid signal changes', async () => {
    const TestExtension = defineExtension({
      build: () => ({count: signal(0)}),
      name: 'test',
    });

    using editor = buildEditorFromExtensions({
      dependencies: [ReactPluginHostExtension, TestExtension],
      name: '[root]',
    });

    const dep = getExtensionDependencyFromEditor(editor, TestExtension);

    function TestComponent() {
      const count = useExtensionSignalValue(TestExtension, 'count');
      return <div>{count}</div>;
    }

    await act(async () => {
      reactRoot.render(
        <LexicalExtensionEditorComposer initialEditor={editor}>
          <TestComponent />
        </LexicalExtensionEditorComposer>,
      );
    });

    expect(container?.textContent).toBe('0');

    // Make rapid updates
    await act(async () => {
      for (let i = 1; i <= 10; i++) {
        dep.output.count.value = i;
      }
    });

    expect(container?.textContent).toBe('10');

    // Unmount before `using` disposes the editor so the disposal does not
    // update the still-mounted EditorComponent outside of act().
    await act(async () => {
      reactRoot.unmount();
    });
  });
});
