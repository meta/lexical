/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type BaseSelection,
  getDOMSelection,
  getDOMSelectionPoints,
  IS_APPLE,
  isHTMLElement,
  type LexicalEditor,
  registerEventListeners,
} from 'lexical';
import * as React from 'react';
import {
  type JSX,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

const copy = (text: string | null) => {
  const textArea = document.createElement('textarea');
  textArea.value = text || '';
  textArea.style.position = 'absolute';
  textArea.style.opacity = '0';
  document.body?.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    const result = document.execCommand('copy');
    // eslint-disable-next-line no-console
    console.log(result);
  } catch (error) {
    console.error(error);
  }
  document.body?.removeChild(textArea);
};

const download = (filename: string, text: string | null) => {
  const a = document.createElement('a');
  a.setAttribute(
    'href',
    'data:text/plain;charset=utf-8,' + encodeURIComponent(text || ''),
  );
  a.setAttribute('download', filename);
  a.style.display = 'none';
  document.body?.appendChild(a);
  a.click();
  document.body?.removeChild(a);
};

const formatStep = (step: Step) => {
  const formatOneStep = (name: string, value: Step['value']) => {
    switch (name) {
      case 'click': {
        return `      await page.mouse.click(${value.x}, ${value.y});`;
      }
      case 'press': {
        return `      await page.keyboard.press('${value}');`;
      }
      case 'keydown': {
        return `      await page.keyboard.keydown('${value}');`;
      }
      case 'keyup': {
        return `      await page.keyboard.keyup('${value}');`;
      }
      case 'type': {
        return `      await page.keyboard.type('${value}');`;
      }
      case 'selectAll': {
        return `      await selectAll(page);`;
      }
      case 'snapshot': {
        return `      await assertHTMLSnapshot(page);
      await assertSelection(page, {
        anchorPath: [${value.anchorPath.toString()}],
        anchorOffset: ${value.anchorOffset},
        focusPath: [${value.focusPath.toString()}],
        focusOffset: ${value.focusOffset},
      });
`;
      }
      default:
        return ``;
    }
  };
  const formattedStep = formatOneStep(step.name, step.value);
  switch (step.count) {
    case 1:
      return formattedStep;
    case 2:
      return [formattedStep, formattedStep].join(`\n`);
    default:
      return `      await repeat(${step.count}, async () => {
  ${formattedStep}
      );`;
  }
};

export function isSelectAll(event: KeyboardEvent): boolean {
  return (
    event.key.toLowerCase() === 'a' &&
    (IS_APPLE ? event.metaKey : event.ctrlKey)
  );
}

/**
 * How many of the zero-size anchors that the reconciler parks outside a
 * leading or trailing block decorator (#8922) are among the first `index`
 * children of `parent`. They take a DOM child slot but no Lexical one, so
 * paths and offsets leave them out, as assertSelection in the e2e utils does.
 * Keep these helpers in step with its copies in
 * `__tests__/utils/index.mjs`, which run inside the page.
 */
function boundaryAnchorsBefore(parent: Node, index: number): number {
  const children = parent.childNodes;
  let count = 0;
  for (let i = 0; i < index && i < children.length; i++) {
    const child = children[i];
    if (
      isHTMLElement(child) &&
      child.getAttribute('data-lexical-decorator-boundary') === 'true'
    ) {
      count++;
    }
  }
  return count;
}

/**
 * The selection offset in `node` as the e2e tests assert it.
 *
 * @internal Exposed for unit tests.
 */
export function fixOffset(node: Node, offset: number): number {
  if (!isHTMLElement(node)) {
    return offset;
  }
  // If the selection offset is at the br of a webkit img+br linebreak then
  // move the offset to the img so the tests are consistent across browsers.
  // Look the child up by the DOM offset: a leading anchor can precede it in
  // the same element.
  const child = offset > 0 ? node.childNodes[offset - 1] : null;
  const lexicalOffset = offset - boundaryAnchorsBefore(node, offset);
  if (
    isHTMLElement(child) &&
    child.nodeName === 'IMG' &&
    child.getAttribute('data-lexical-managed-linebreak') === 'true'
  ) {
    return lexicalOffset - 1;
  }
  return lexicalOffset;
}

/**
 * The path of child indexes from `rootElement` to `node`, as the e2e tests
 * assert it.
 *
 * @internal Exposed for unit tests.
 */
export function getPathFromNodeToEditor(
  node: Node,
  rootElement: HTMLElement | null,
): number[] {
  const path = [];
  if (node === rootElement) {
    return [];
  }
  while (node !== null) {
    const parent = node.parentNode;
    if (parent === null || node === rootElement) {
      break;
    }
    const index = Array.from(parent.childNodes).indexOf(node as ChildNode);
    path.push(index - boundaryAnchorsBefore(parent, index));
    node = parent;
  }
  return path.reverse();
}

const keyPresses = new Set([
  'Enter',
  'Backspace',
  'Delete',
  'Escape',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
]);

type Step = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
  count: number;
  name: string;
};

type Steps = Step[];

function useTestRecorder(
  editor: LexicalEditor,
): [JSX.Element, JSX.Element | null] {
  const [steps, setSteps] = useState<Steps>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [, setCurrentInnerHTML] = useState('');
  const [templatedTest, setTemplatedTest] = useState('');
  const previousSelectionRef = useRef<BaseSelection | null>(null);
  const skipNextSelectionChangeRef = useRef(false);
  const preRef = useRef<HTMLPreElement>(null);

  const getCurrentEditor = useCallback(() => {
    return editor;
  }, [editor]);

  const generateTestContent = useCallback(() => {
    const rootElement = editor.getRootElement();
    const browserSelection = getDOMSelection(editor._window);
    const browserPoints =
      browserSelection !== null
        ? getDOMSelectionPoints(browserSelection, rootElement)
        : null;

    if (
      rootElement == null ||
      browserSelection == null ||
      browserPoints == null ||
      browserPoints.anchorNode == null ||
      browserPoints.focusNode == null ||
      !rootElement.contains(browserPoints.anchorNode) ||
      !rootElement.contains(browserPoints.focusNode)
    ) {
      return null;
    }

    return `
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  initializeE2E,
  assertHTMLSnapshot,
  assertSelection,
  repeat,
} from '../utils';
import {selectAll} from '../keyboardShortcuts';
import { RangeSelection } from 'lexical';
import { NodeSelection } from 'lexical';

describe('Test case', () => {
  initializeE2E((e2e) => {
    it('Should pass this test', async () => {
      const {page} = e2e;

      await page.focus('div[contenteditable="true"]');
${steps.map(formatStep).join(`\n`)}
    });
});
    `;
  }, [editor, steps]);

  // just a wrapper around inserting new actions so that we can
  // coalesce some actions like insertText/moveNativeSelection
  const pushStep = useCallback(
    (name: string, value: Step['value']) => {
      setSteps(currentSteps => {
        // trying to group steps
        const currentIndex = steps.length - 1;
        const lastStep = steps[currentIndex];
        if (lastStep) {
          if (lastStep.name === name) {
            if (name === 'type') {
              // for typing events we just append the text
              return [
                ...steps.slice(0, currentIndex),
                {...lastStep, value: lastStep.value + value},
              ];
            } else {
              // for other events we bump the counter if their values are the same
              if (lastStep.value === value) {
                return [
                  ...steps.slice(0, currentIndex),
                  {...lastStep, count: lastStep.count + 1},
                ];
              }
            }
          }
        }
        // could not group, just append a new one
        return [...currentSteps, {count: 1, name, value}];
      });
    },
    [steps, setSteps],
  );

  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isRecording) {
        return;
      }
      const key = event.key;
      if (isSelectAll(event)) {
        pushStep('selectAll', '');
      } else if (keyPresses.has(key)) {
        pushStep('press', event.key);
      } else if ([...key].length > 1) {
        pushStep('keydown', event.key);
      } else {
        pushStep('type', event.key);
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!isRecording) {
        return;
      }
      const key = event.key;
      if (!keyPresses.has(key) && [...key].length > 1) {
        pushStep('keyup', event.key);
      }
    };

    return editor.registerRootListener(rootElement => {
      if (rootElement) {
        return registerEventListeners(rootElement, {
          keydown: onKeyDown,
          keyup: onKeyUp,
        });
      }
    });
  }, [editor, isRecording, pushStep]);

  useLayoutEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTo(0, preRef.current.scrollHeight);
    }
  }, [generateTestContent]);

  useEffect(() => {
    if (steps) {
      const testContent = generateTestContent();
      if (testContent !== null) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setTemplatedTest(testContent);
      }
      if (preRef.current) {
        preRef.current.scrollTo(0, preRef.current.scrollHeight);
      }
    }
  }, [generateTestContent, steps]);

  useEffect(() => {
    const removeUpdateListener = editor.registerUpdateListener(
      ({editorState, dirtyLeaves, dirtyElements}) => {
        if (!isRecording) {
          return;
        }
        const currentSelection = editorState._selection;
        const previousSelection = previousSelectionRef.current;
        const skipNextSelectionChange = skipNextSelectionChangeRef.current;
        if (previousSelection !== currentSelection) {
          if (
            dirtyLeaves.size === 0 &&
            dirtyElements.size === 0 &&
            !skipNextSelectionChange
          ) {
            const browserSelection = getDOMSelection(editor._window);
            const browserPoints =
              browserSelection &&
              getDOMSelectionPoints(browserSelection, editor.getRootElement());
            if (
              browserPoints &&
              (browserPoints.anchorNode == null ||
                browserPoints.focusNode == null)
            ) {
              return;
            }
          }
          previousSelectionRef.current = currentSelection;
        }
        skipNextSelectionChangeRef.current = false;
        const testContent = generateTestContent();
        if (testContent !== null) {
          setTemplatedTest(testContent);
        }
      },
    );
    return removeUpdateListener;
  }, [editor, generateTestContent, isRecording, pushStep]);

  // save innerHTML
  useEffect(() => {
    if (!isRecording) {
      return;
    }
    const removeUpdateListener = editor.registerUpdateListener(() => {
      const rootElement = editor.getRootElement();
      if (rootElement !== null) {
        setCurrentInnerHTML(rootElement?.innerHTML);
      }
    });
    return removeUpdateListener;
  }, [editor, isRecording]);

  // clear editor and start recording
  const toggleEditorSelection = useCallback(
    (currentEditor: LexicalEditor) => {
      if (!isRecording) {
        currentEditor.update(() => {
          const root = $getRoot();
          root.clear();
          const text = $createTextNode();
          root.append($createParagraphNode().append(text));
          text.select();
        });
        setSteps([]);
      }
      setIsRecording(currentIsRecording => !currentIsRecording);
    },
    [isRecording],
  );

  const onSnapshotClick = useCallback(() => {
    if (!isRecording) {
      return;
    }
    const browserSelection = getDOMSelection(getCurrentEditor()._window);
    const rootElement = getCurrentEditor().getRootElement();
    const browserPoints =
      browserSelection !== null
        ? getDOMSelectionPoints(browserSelection, rootElement)
        : null;
    if (
      browserPoints === null ||
      browserPoints.anchorNode == null ||
      browserPoints.focusNode == null
    ) {
      return;
    }
    const {anchorNode, anchorOffset, focusNode, focusOffset} = browserPoints;
    let anchorPath;
    if (anchorNode !== null) {
      anchorPath = getPathFromNodeToEditor(anchorNode, rootElement);
    }
    let focusPath;
    if (focusNode !== null) {
      focusPath = getPathFromNodeToEditor(focusNode, rootElement);
    }
    pushStep('snapshot', {
      anchorNode,
      anchorOffset: fixOffset(anchorNode, anchorOffset),
      anchorPath,
      focusNode,
      focusOffset: fixOffset(focusNode, focusOffset),
      focusPath,
    });
  }, [pushStep, isRecording, getCurrentEditor]);

  const onCopyClick = useCallback(() => {
    copy(generateTestContent());
  }, [generateTestContent]);

  const onDownloadClick = useCallback(() => {
    download('test.js', generateTestContent());
  }, [generateTestContent]);

  const button = (
    <button
      id="test-recorder-button"
      className={`editor-dev-button ${isRecording ? 'active' : ''}`}
      onClick={() => toggleEditorSelection(getCurrentEditor())}
      title={isRecording ? 'Disable test recorder' : 'Enable test recorder'}
    />
  );
  const output = isRecording ? (
    <div className="test-recorder-output">
      <div className="test-recorder-toolbar">
        <button
          className="test-recorder-button"
          id="test-recorder-button-snapshot"
          title="Insert snapshot"
          onClick={onSnapshotClick}
        />
        <button
          className="test-recorder-button"
          id="test-recorder-button-copy"
          title="Copy to clipboard"
          onClick={onCopyClick}
        />
        <button
          className="test-recorder-button"
          id="test-recorder-button-download"
          title="Download as a file"
          onClick={onDownloadClick}
        />
      </div>
      <pre id="test-recorder" ref={preRef}>
        {templatedTest}
      </pre>
    </div>
  ) : null;

  return [button, output];
}

export default function TestRecorderPlugin(): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [testRecorderButton, testRecorderOutput] = useTestRecorder(editor);

  return (
    <>
      {testRecorderButton}
      {testRecorderOutput}
    </>
  );
}
