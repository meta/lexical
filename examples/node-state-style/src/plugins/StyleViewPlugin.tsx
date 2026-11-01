/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import './StyleViewPlugin.css';

import {
  Combobox,
  createListCollection,
  useCombobox,
} from '@ark-ui/react/combobox';
import {Portal} from '@ark-ui/react/portal';
import {Splitter, useSplitter} from '@ark-ui/react/splitter';
import {
  createTreeCollection,
  type TreeCollection,
  TreeView,
  useTreeView,
  type UseTreeViewReturn,
} from '@ark-ui/react/tree-view';
import {EditorStateExtension} from '@lexical/extension';
import {PlainTextExtension} from '@lexical/plain-text';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {useExtensionDependency} from '@lexical/react/useExtensionComponent';
import {useSignalValue} from '@lexical/react/useExtensionSignalValue';
import {$getAdjacentCaret, mergeRegister} from '@lexical/utils';
import {
  $addUpdateTag,
  $createLineBreakNode,
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $getCaretRange,
  $getChildCaret,
  $getNodeByKey,
  $getPreviousSelection,
  $getRoot,
  $getSelection,
  $getSiblingCaret,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  $isRootNode,
  $isTabNode,
  $isTextNode,
  $normalizeCaret,
  $setSelection,
  $setSelectionFromCaretRange,
  BLUR_COMMAND,
  COMMAND_PRIORITY_LOW,
  defineExtension,
  type EditorState,
  type ElementNode,
  KEY_DOWN_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type NodeCaret,
  type NodeKey,
} from 'lexical';
import {
  ChevronRightIcon,
  CircleXIcon,
  CodeXmlIcon,
  CornerDownLeftIcon,
  FolderIcon,
  FolderRoot,
  TextIcon,
} from 'lucide-react';
import React, {
  createContext,
  Fragment,
  type JSX,
  type KeyboardEventHandler,
  use,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';

import {
  $removeStyleProperty,
  $setStyleProperty,
  getStyleObjectDirect,
  type StyleObject,
  styleObjectToArray,
} from '../styleState';

const SKIP_DOM_SELECTION_TAG = 'skip-dom-selection';
const SKIP_SCROLL_INTO_VIEW_TAG = 'skip-scroll-into-view';

function $preserveSelection(): void {
  const selection = $getSelection();
  if (!selection) {
    const prevSelection = $getPreviousSelection();
    if (prevSelection) {
      $setSelection(prevSelection.clone());
    }
  }
}

const EditorStateContext = createContext<undefined | EditorState>(undefined);
function useEditorState() {
  const editorState = use(EditorStateContext);
  if (editorState === undefined) {
    throw new Error('Missing EditorStateContext');
  }
  return editorState;
}

const NodeTreeViewContext = createContext<
  undefined | UseTreeViewReturn<NodeKey>
>(undefined);
function useNodeTreeViewContext() {
  const ctx = use(NodeTreeViewContext);
  if (ctx === undefined) {
    throw new Error('Missing NodeTreeViewContext');
  }
  return ctx;
}

export function StyleViewPlugin(): JSX.Element {
  const editorState = useSignalValue(
    useExtensionDependency(EditorStateExtension).output,
  );
  return (
    <EditorStateContext.Provider value={editorState}>
      <LexicalTreeView />
    </EditorStateContext.Provider>
  );
}

function NodeLabel({node}: {node: LexicalNode}) {
  const [editor] = useLexicalComposerContext();
  const key = node.getKey();
  const type = node.getType();
  const reactLabel = (
    <>
      <button
        className="style-view-node-button"
        title={`Select ${type} node`}
        onClick={event => {
          event.preventDefault();
          editor.update(() => {
            const caretRange = $isElementNode(node)
              ? $getCaretRange(
                  $getChildCaret(node, 'previous').getFlipped(),
                  $getChildCaret(node, 'next'),
                )
              : $getCaretRange(
                  $normalizeCaret(
                    $getSiblingCaret(node, 'previous').getFlipped(),
                  ),
                  $normalizeCaret($getSiblingCaret(node, 'next')),
                );
            $setSelectionFromCaretRange(caretRange);
          });
        }}>
        ({key})
      </button>{' '}
      {type}
    </>
  );
  if ($isTextNode(node)) {
    const text = node.__text;
    return (
      <>
        {reactLabel}{' '}
        <span className="style-view-node-text-contents" title={text}>
          {text}
        </span>
      </>
    );
  }
  return reactLabel;
}

function describeNode(node: LexicalNode): [string, React.ReactNode] {
  return [
    `(${node.getKey()}) ${node.getType()}`,
    <NodeLabel key={node.getKey()} node={node} />,
  ];
}

function LexicalNodeTreeViewItem(props: TreeView.NodeProviderProps<NodeKey>) {
  const id = props.node;
  const editorState = useEditorState();
  const node =
    typeof id === 'string'
      ? editorState.read(() => $getNodeByKey(id, editorState))
      : null;
  const indexPathString = JSON.stringify(props.indexPath);
  return useMemo(() => {
    if (!node) {
      return null;
    }
    const indexPath = JSON.parse(indexPathString);
    const [_ariaLabel, label] = describeNode(node);
    const nextNode = node.__next && (
      <LexicalNodeTreeViewItem
        node={node.__next}
        key={node.__next}
        indexPath={[...indexPath.slice(0, -1), (indexPath.at(-1) || 0) + 1]}
      />
    );
    const icon = $isRootNode(node) ? (
      <FolderRoot />
    ) : $isElementNode(node) ? (
      <FolderIcon />
    ) : $isTextNode(node) ? (
      <TextIcon />
    ) : $isDecoratorNode(node) ? (
      <CodeXmlIcon />
    ) : $isLineBreakNode(node) ? (
      <CornerDownLeftIcon />
    ) : null;
    let content: React.ReactNode;
    if ($isElementNode(node)) {
      content = (
        <TreeView.Branch>
          <TreeView.BranchControl>
            <TreeView.BranchText>
              {icon} {label}
            </TreeView.BranchText>
            <TreeView.BranchIndicator>
              {node.__first ? <ChevronRightIcon /> : null}
            </TreeView.BranchIndicator>
          </TreeView.BranchControl>
          <TreeView.BranchContent>
            <TreeView.BranchIndentGuide />
            {node.__first ? (
              <LexicalNodeTreeViewItem
                node={node.__first}
                key={node.__first}
                indexPath={[...indexPath, 0]}
              />
            ) : null}
          </TreeView.BranchContent>
        </TreeView.Branch>
      );
    } else {
      content = (
        <TreeView.Item>
          <TreeView.ItemText>
            {icon} {label}
          </TreeView.ItemText>
        </TreeView.Item>
      );
    }
    return (
      <Fragment>
        <TreeView.NodeProvider key={id} node={id} indexPath={indexPath}>
          {content}
        </TreeView.NodeProvider>
        {nextNode}
      </Fragment>
    );
  }, [id, node, indexPathString]);
}

function getSelectedNodeKey(
  api: UseTreeViewReturn<NodeKey>,
): undefined | NodeKey {
  return api.selectedValue.at(0);
}

interface SelectedNodeStateAction {
  panelNodeKey: undefined | NodeKey;
  editorState: EditorState;
}
interface SelectedNodeState extends SelectedNodeStateAction {
  panelNodeKey: NodeKey;
  selectionNodeKey: NodeKey | null;
  panelNode: LexicalNode | null;
  cached: React.ReactNode;
}
interface InitialSelectedNodeState extends SelectedNodeStateAction {
  selectionNodeKey?: undefined;
  panelNode?: undefined;
  cached?: undefined;
}

interface StyleValueEditorProps {
  ref?: React.Ref<LexicalEditor>;
  prop: keyof StyleObject;
  value: string;
  onChange: (prop: keyof StyleObject, value: string) => void;
}

type ParsedChunk = '\n' | '\r\n' | '\t' | string;

function parseRawText(text: string): ParsedChunk[] {
  return text.split(/(\r?\n|\t)/);
}

function $patchNodes<T extends ElementNode>(
  parent: T,
  nodes: LexicalNode[],
): T {
  const childrenSize = parent.getChildrenSize();
  if (
    childrenSize === nodes.length &&
    parent.getChildren().every((node, i) => node === nodes[i])
  ) {
    // no-op, do not mark as dirty
    return parent;
  }
  return $getChildCaret(parent, 'next').splice(childrenSize, nodes).origin;
}

function $patchParsedText<T extends ElementNode>(
  parent: T,
  chunks: readonly ParsedChunk[],
): T {
  let caret: null | NodeCaret<'next'> = $getChildCaret(parent, 'next');
  const nodes: LexicalNode[] = [];
  for (const chunk of chunks) {
    caret = $getAdjacentCaret(caret);
    const node = caret ? caret.origin : null;
    if (chunk === '\r\n' || chunk === '\n') {
      nodes.push($isLineBreakNode(node) ? node : $createLineBreakNode());
    } else if (chunk === '\t') {
      nodes.push($isTabNode(node) ? node : $createTabNode());
    } else if (chunk) {
      nodes.push(
        $isTextNode(node)
          ? node.getTextContent() === chunk
            ? node
            : node.setTextContent(chunk)
          : $createTextNode(chunk),
      );
    }
  }
  return $patchNodes(parent, nodes);
}

function $patchParsedTextAtRoot(chunks: readonly ParsedChunk[]): void {
  const root = $getRoot();
  const firstNode = root.getFirstChild();
  const p = $isParagraphNode(firstNode) ? firstNode : $createParagraphNode();
  $getChildCaret(root, 'next').splice(root.getChildrenSize(), [p]);
  $patchParsedText(p, chunks);
}

function StyleValuePlugin(props: StyleValueEditorProps) {
  const [editor] = useLexicalComposerContext();
  const {prop, onChange, ref} = props;
  const valueRef = useRef(props.value);
  useEffect(() => {
    const setRef =
      typeof ref === 'function'
        ? ref
        : ref
          ? (value: LexicalEditor | null) => {
              ref.current = value;
            }
          : () => {};
    setRef(editor);
    return () => {
      setRef(null);
    };
  }, [editor, ref]);
  useEffect(() => {
    valueRef.current = props.value;
  }, [props.value]);
  useEffect(() => {
    let timer: undefined | ReturnType<typeof setTimeout>;
    function clearTimer() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    }
    function handleInput() {
      clearTimer();
      setTimeout(handleFlush, 300);
    }
    function handleFlush() {
      clearTimer();
      const value = editor.read('latest', () => $getRoot().getTextContent());
      if (valueRef.current !== value) {
        onChange(prop, value);
      }
    }
    return mergeRegister(
      editor.registerUpdateListener(payload => {
        if (payload.editorState !== payload.prevEditorState) {
          handleInput();
        }
      }),
      editor.registerCommand(
        BLUR_COMMAND,
        () => {
          handleFlush();
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        KEY_DOWN_COMMAND,
        e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            editor.blur();
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
    );
  }, [editor, prop, onChange]);
  return null;
}

const STYLE_VALUE_CONTENT_EDITABLE = (
  <ContentEditable
    className="style-view-value"
    contentEditable="plaintext-only"
  />
);

function StyleValueEditor(props: StyleValueEditorProps) {
  // Each value gets its own small plain text editor. The extension only needs
  // the initial value, so it is created once per mounted editor.
  const [extension] = useState(() =>
    defineExtension({
      $initialEditorState: () => {
        $patchParsedTextAtRoot(parseRawText(props.value));
      },
      dependencies: [PlainTextExtension],
      name: '@lexical/examples/node-state-style/StyleValue',
      namespace: 'style-view-value',
    }),
  );
  return (
    <LexicalExtensionComposer
      extension={extension}
      contentEditable={STYLE_VALUE_CONTENT_EDITABLE}>
      <StyleValuePlugin {...props} />
    </LexicalExtensionComposer>
  );
}

function LexicalTextSelectionPaneContents({node}: {node: LexicalNode}) {
  const [editor] = useLexicalComposerContext();
  const [registeredNodes] = useState(
    () => new Map<keyof StyleObject, LexicalEditor>(),
  );
  const styles = getStyleObjectDirect(node);
  const focusPropertyRef = useRef('');

  const nodeRef = useRef(node);
  useEffect(() => {
    nodeRef.current = node;
  }, [node]);
  const {handleChange, handleAddProperty} = useMemo(() => {
    // eslint-disable-next-line no-shadow
    const handleAddProperty = (prop: keyof StyleObject) => {
      const reg = registeredNodes.get(prop);
      if (reg) {
        reg.focus();
      } else {
        focusPropertyRef.current = prop;
        editor.update(
          () => {
            $setStyleProperty(nodeRef.current, prop, '');
          },
          {tag: [SKIP_DOM_SELECTION_TAG, SKIP_SCROLL_INTO_VIEW_TAG]},
        );
      }
    };
    // eslint-disable-next-line no-shadow
    const handleChange = (
      prop: keyof StyleObject,
      textContent: string | null,
    ) => {
      editor.update(
        () => {
          $preserveSelection();
          $addUpdateTag(SKIP_DOM_SELECTION_TAG);
          $addUpdateTag(SKIP_SCROLL_INTO_VIEW_TAG);
          $setStyleProperty(nodeRef.current, prop, textContent || undefined);
        },
        {tag: [SKIP_DOM_SELECTION_TAG, SKIP_SCROLL_INTO_VIEW_TAG]},
      );
    };
    return {handleAddProperty, handleChange};
  }, [editor, registeredNodes]);

  const rows = useMemo(
    () =>
      styleObjectToArray(styles).map(([k, v]) => (
        <div key={k} className="style-view-entry">
          <button
            className="style-view-node-button style-view-node-button-delete"
            title={`Remove ${k} style`}
            onClick={e => {
              e.preventDefault();
              editor.update(
                () => {
                  $removeStyleProperty(nodeRef.current, k);
                },
                {tag: [SKIP_DOM_SELECTION_TAG, SKIP_SCROLL_INTO_VIEW_TAG]},
              );
            }}>
            <CircleXIcon />
          </button>
          <span className="style-view-key">{k}: </span>
          <StyleValueEditor
            prop={k}
            value={v || ''}
            onChange={handleChange}
            ref={el => {
              if (el === null) {
                registeredNodes.delete(k);
                return;
              }
              if (focusPropertyRef.current === k) {
                el.focus();
                focusPropertyRef.current = '';
              }
              registeredNodes.set(k, el);
            }}
          />
        </div>
      )),
    [editor, registeredNodes, styles, handleChange],
  );
  return (
    <div>
      <span>{describeNode(node)[1]}</span>
      <div>
        <div>
          <span className="style-view-style-heading">style</span> {'{'}
        </div>
        {rows}
        <div className="style-view-actions">
          <CSSPropertyComboBox onAddProperty={handleAddProperty} />
        </div>
        <div>{'}'}</div>
      </div>
    </div>
  );
}

function initTextSelectionPaneReducer(action: SelectedNodeStateAction) {
  return textSelectionPaneReducer(action, action);
}

function textSelectionPaneReducer(
  state: InitialSelectedNodeState | SelectedNodeState,
  action: SelectedNodeStateAction,
): SelectedNodeState {
  return action.editorState.read(() => {
    const selection = $getSelection();
    const selectionNodeKey = $isRangeSelection(selection)
      ? selection.focus.key
      : null;
    const {
      // selectionNodeKey: prevSelectionNodeKey = null,
      panelNode: prevPanelNode = null,
      cached: prevCached = null,
    } = state;
    let panelNodeKey =
      selectionNodeKey || action.panelNodeKey || state.panelNodeKey;
    if (selectionNodeKey) {
      panelNodeKey = selectionNodeKey;
    } else if (!panelNodeKey) {
      panelNodeKey = 'root';
    }
    const panelNode = $getNodeByKey(panelNodeKey);
    if (panelNode === prevPanelNode && state.cached) {
      return state;
    }
    const cached =
      panelNode === prevPanelNode && prevCached ? (
        prevCached
      ) : panelNode === null ? (
        <span>Node {panelNodeKey} no longer in the document</span>
      ) : (
        <LexicalTextSelectionPaneContents key={panelNodeKey} node={panelNode} />
      );
    return {...action, cached, panelNode, panelNodeKey, selectionNodeKey};
  });
}

function getSuggestedStyleKeys(): readonly (keyof StyleObject)[] {
  const keys = new Set<keyof StyleObject>();
  if (typeof document !== 'undefined') {
    const {style} = document.body;
    for (const k in style) {
      if (typeof style[k] === 'string') {
        const kebab = k
          .replace(/[A-Z]/g, s => '-' + s.toLowerCase())
          .replace(/^(webkit|moz|ms|o)-/, '-$1-')
          .replace(/^css-/, '');
        keys.add(kebab as keyof StyleObject);
      }
    }
  }
  return [...keys].sort();
}

function isNotVendorProperty(item: string): boolean {
  return !item.startsWith('-');
}

function useSuggestedStylesCombobox(props: CSSPropertyComboBoxProps) {
  const initialItems = useMemo(() => getSuggestedStyleKeys(), []);
  const [items, setItems] = useState(() =>
    initialItems.filter(isNotVendorProperty).join('\n'),
  );
  const collection = useMemo(
    () => createListCollection({items: items.split(/\n/g)}),
    [items],
  );
  const handleInputValueChange = (
    details: Combobox.InputValueChangeDetails,
  ) => {
    const search = details.inputValue.toLowerCase();
    setItems(
      initialItems
        .filter(
          search
            ? item => item.toLowerCase().startsWith(search)
            : isNotVendorProperty,
        )
        .join('\n'),
    );
  };
  const handleSelect = (details: Combobox.SelectionDetails) => {
    props.onAddProperty(details.itemValue as keyof StyleObject);
    combobox.setInputValue('');
  };

  const combobox = useCombobox({
    allowCustomValue: true,
    collection: collection,
    inputBehavior: 'autocomplete',
    onInputValueChange: handleInputValueChange,
    onSelect: handleSelect,
    placeholder: 'Add CSS Property',
    positioning: {
      placement: 'bottom-start',
      sameWidth: false,
    },
  });
  return combobox;
}

interface CSSPropertyComboBoxProps {
  onAddProperty: (property: keyof StyleObject) => void;
}

const CSSPropertyComboBox = (props: CSSPropertyComboBoxProps) => {
  const {onAddProperty} = props;
  const combobox = useSuggestedStylesCombobox(props);
  const handleKeydown = useCallback<KeyboardEventHandler<HTMLInputElement>>(
    event => {
      const {inputValue} = combobox;
      if (event.key === 'Enter') {
        event.preventDefault();
        if (inputValue) {
          onAddProperty(inputValue as keyof StyleObject);
          combobox.setInputValue('');
        }
      } else if (event.key === 'Tab') {
        event.preventDefault();
        if (inputValue) {
          const [autocomplete] = combobox.collection.items;
          if (autocomplete) {
            onAddProperty(autocomplete as keyof StyleObject);
            combobox.setInputValue('');
          }
        }
      }
    },
    [combobox, onAddProperty],
  );

  return (
    <Combobox.RootProvider value={combobox} lazyMount={true}>
      <Combobox.Control>
        <Combobox.Input onKeyDown={handleKeydown} />
      </Combobox.Control>
      <Portal>
        <Combobox.Positioner>
          <Combobox.Content>
            <Combobox.ItemGroup>
              {combobox.collection.items.map(item => (
                <Combobox.Item key={item} item={item}>
                  <Combobox.ItemText>{item}</Combobox.ItemText>
                  <Combobox.ItemIndicator>✓</Combobox.ItemIndicator>
                </Combobox.Item>
              ))}
            </Combobox.ItemGroup>
          </Combobox.Content>
        </Combobox.Positioner>
      </Portal>
    </Combobox.RootProvider>
  );
};

function LexicalTextSelectionPane() {
  const editorState = useEditorState();
  const api = useNodeTreeViewContext();
  const panelNodeKey = getSelectedNodeKey(api);
  const [state, dispatch] = useReducer(
    textSelectionPaneReducer,
    {editorState, panelNodeKey},
    initTextSelectionPaneReducer,
  );
  useEffect(() => {
    dispatch({editorState, panelNodeKey});
  }, [panelNodeKey, editorState]);
  return state.cached || null;
}

function LexicalTreeView() {
  const collectionState = useEditorCollectionState();
  const {collection, focusNodeKey} = collectionState;
  const [editor] = useLexicalComposerContext();
  const editorRef = useRef(editor);
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);
  const treeView = useTreeView({
    collection,
    defaultExpandedValue: ['root'],
  });
  useEffect(() => {
    if (
      focusNodeKey !== null &&
      !treeView.expandedValue.includes(focusNodeKey)
    ) {
      treeView.expand([focusNodeKey]);
    }
  }, [treeView, focusNodeKey]);
  const splitter = useSplitter({
    defaultSize: [50, 50],
    panels: [{id: 'tree'}, {id: 'node'}],
  });

  return (
    <nav className="style-view-text-pane" aria-label="Lexical Nodes">
      <NodeTreeViewContext.Provider value={treeView}>
        <Splitter.RootProvider value={splitter}>
          <Splitter.Panel id="tree">
            <TreeView.RootProvider value={treeView}>
              <TreeView.Tree>
                <LexicalNodeTreeViewItem node="root" indexPath={[]} />
              </TreeView.Tree>
            </TreeView.RootProvider>
          </Splitter.Panel>
          <Splitter.ResizeTrigger id="tree:node" />
          <Splitter.Panel id="node">
            <LexicalTextSelectionPane />
          </Splitter.Panel>
        </Splitter.RootProvider>
      </NodeTreeViewContext.Provider>
    </nav>
  );
}

interface EditorCollectionState {
  editor: LexicalEditor;
  editorState: EditorState;
  collection: TreeCollection<NodeKey>;
  focusNodeKey: null | NodeKey;
}

function nextFocusNodeKey(state: EditorCollectionState): null | NodeKey {
  return state.editorState.read(() => {
    const selection = $getSelection();
    return selection && $isRangeSelection(selection)
      ? selection.focus.getNode().getKey()
      : null;
  });
}

function initEditorCollection(
  state: Omit<EditorCollectionState, 'collection' | 'focusNodeKey'> &
    Partial<Pick<EditorCollectionState, 'collection' | 'focusNodeKey'>>,
): EditorCollectionState {
  return Object.assign(state, {
    collection: createTreeCollection<NodeKey>({
      isNodeDisabled: () => false,
      nodeToChildren: nodeKey =>
        state.editorState.read(() => {
          const node = $getNodeByKey(nodeKey);
          return $isElementNode(node) ? node.getChildrenKeys() : [];
        }),
      nodeToString: nodeKey => nodeKey,
      nodeToValue: nodeKey => nodeKey,
      rootNode: 'root',
    }),
    focusNodeKey: null,
  });
}

function editorCollectionReducer(
  state: EditorCollectionState,
  action: Partial<EditorCollectionState>,
) {
  let nextState = {...state, ...action};
  if (action.editor && action.editor !== state.editor) {
    nextState = initEditorCollection(nextState);
  }
  nextState.focusNodeKey = nextFocusNodeKey(nextState);
  return nextState;
}

function useEditorCollectionState() {
  const [editor] = useLexicalComposerContext();
  const editorState = useEditorState();
  const [state, dispatch] = useReducer(
    editorCollectionReducer,
    {editor, editorState},
    initEditorCollection,
  );
  useEffect(() => {
    dispatch({editor, editorState});
  }, [editor, editorState]);
  return state;
}
