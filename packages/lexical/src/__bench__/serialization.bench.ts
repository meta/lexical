/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {test} from 'vitest';

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type EditorState,
  type LexicalEditor,
  type LexicalNode,
  type ParagraphNode,
  TextNode,
} from '../index';
import {
  $applyJSONSetters,
  $walkJSONSetters,
  $writeJSONGetters,
} from '../LexicalUtils';

// Module-level sink so V8 cannot elide the work being measured.
let _benchSink: unknown;

const PARAGRAPHS = 2000;
const TEXTS_PER_PARAGRAPH = 5;

let benchEditor: LexicalEditor;

function buildEditor(): LexicalEditor {
  const editor = buildEditorFromExtensions(
    defineExtension({$initialEditorState: null, name: '[bench-serialization]'}),
  );
  editor.update(
    () => {
      const root = $getRoot();
      for (let i = 0; i < PARAGRAPHS; i++) {
        const paragraph = $createParagraphNode();
        for (let j = 0; j < TEXTS_PER_PARAGRAPH; j++) {
          const text = $createTextNode(`p${i} t${j}`);
          text.setFormat(j % 2 === 0 ? 1 : 0);
          paragraph.append(text);
        }
        root.append(paragraph);
      }
    },
    {discrete: true},
  );
  return editor;
}

test('EditorState.toJSON', async ({bench}) => {
  let editorState: EditorState;
  let json: string;
  let parseTarget: LexicalEditor;

  await bench.compare(
    bench(
      `${PARAGRAPHS * (TEXTS_PER_PARAGRAPH + 1) + 1} nodes`,
      {
        beforeAll: () => {
          editorState = buildEditor().getEditorState();
        },
      },
      () => {
        _benchSink = editorState.toJSON();
      },
    ),
    bench(
      `compact, ${PARAGRAPHS * (TEXTS_PER_PARAGRAPH + 1) + 1} nodes`,
      {
        beforeAll: () => {
          editorState = buildEditor().getEditorState();
        },
      },
      () => {
        _benchSink = editorState.toJSON(true);
      },
    ),
    bench(
      `parseEditorState, ${PARAGRAPHS * (TEXTS_PER_PARAGRAPH + 1) + 1} nodes`,
      {
        beforeAll: () => {
          const editor = buildEditor();
          json = JSON.stringify(editor.getEditorState().toJSON());
          parseTarget = editor;
        },
      },
      () => {
        _benchSink = parseTarget.parseEditorState(json);
      },
    ),
  );
});

// What the generated exporters buy, measured on TextNode only.
//
// The walk arm inlines `LexicalNode.exportJSON` without its generated-exporter
// dispatch, which is the only way to reach the walk for a class that has one.
// TextNode is the fair subject: it has no `exportJSON` override, so the two
// arms differ by exactly the thing being measured — the generated literal
// versus the schema-driven walk — with no post-processing on either side.
function buildTextNodes(): LexicalNode[] {
  const editor = buildEditor();
  const nodes: LexicalNode[] = [];
  editor.read(() => {
    for (const paragraph of $getRoot().getChildren()) {
      for (const child of (paragraph as ParagraphNode).getChildren()) {
        nodes.push(child);
      }
    }
  });
  benchEditor = editor;
  return nodes;
}

test('per-node exportJSON, TextNode', async ({bench}) => {
  let nodes: LexicalNode[] = [];

  await bench.compare(
    bench(
      'schema-driven walk',
      {
        beforeAll: () => {
          nodes = buildTextNodes();
        },
      },
      () => {
        benchEditor.read(() => {
          for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            const json: {[key: string]: unknown} = {};
            $writeJSONGetters(node, json, false);
            json.type = node.getType();
            json.version = 1;
            _benchSink = json;
          }
        });
      },
    ),
    bench(
      'generated literal',
      {
        beforeAll: () => {
          nodes = buildTextNodes();
        },
      },
      () => {
        benchEditor.read(() => {
          for (let i = 0; i < nodes.length; i++) {
            _benchSink = nodes[i].exportJSON();
          }
        });
      },
    ),
  );
});

// And what the generated parsers buy, on the same subject. The nodes are
// constructed once and never attached: TextNode's properties are all fields,
// so both arms write straight to the node and neither needs a writable clone
// — the timed region is the parser alone, which is a tenth of a microsecond
// per node and would otherwise vanish under the microseconds a node's
// creation and commit cost. Every property is
// carried so that each one is read; a compact document would measure the
// fall-through instead. Run inside a `read` for the class records the entry
// points resolve and the `$` convention they follow.
test('per-node updateFromJSON, TextNode', async ({bench}) => {
  let nodes: TextNode[] = [];
  let jsons: {[key: string]: unknown}[] = [];

  function buildInputs(): void {
    benchEditor = buildEditor();
    const serialized = JSON.stringify({
      detail: 0,
      format: 1,
      mode: 'normal',
      style: 'color: red',
      text: 'hello',
      type: 'text',
      version: 1,
    });
    const count = PARAGRAPHS * TEXTS_PER_PARAGRAPH;
    // Constructed in an update, which a node's key needs, and never appended:
    // the commit drops them from the node map, and the objects stay writable.
    benchEditor.update(
      () => {
        nodes = Array.from({length: count}, () => new TextNode(''));
      },
      {discrete: true},
    );
    // Parsed once per node rather than shared: a parser is handed a distinct
    // object per node, as it is by parseEditorState.
    jsons = Array.from(
      {length: count},
      () => JSON.parse(serialized) as {[key: string]: unknown},
    );
  }

  await bench.compare(
    bench('schema-driven walk', {beforeAll: buildInputs}, () => {
      benchEditor.read(() => {
        for (let i = 0; i < nodes.length; i++) {
          _benchSink = $walkJSONSetters(nodes[i], jsons[i]);
        }
      });
    }),
    bench('generated literal', {beforeAll: buildInputs}, () => {
      benchEditor.read(() => {
        for (let i = 0; i < nodes.length; i++) {
          _benchSink = $applyJSONSetters(nodes[i], jsons[i]);
        }
      });
    }),
  );
});
