/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  type Binding,
  createBinding,
  createBindingV2__EXPERIMENTAL,
  createYjsBinding,
  type Provider,
} from '@lexical/yjs';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, test} from 'vitest';
import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  Map as YMap,
  XmlElement,
  XmlText,
} from 'yjs';

import {type CollabElementNode} from '../../CollabElementNode';
import {$createOrUpdateNodeFromYElement, $updateYFragment} from '../../SyncV2';

function getRootXmlText(root: CollabElementNode): XmlText {
  return (root as unknown as {_xmlText: XmlText})._xmlText;
}

function createTestDoc(): {doc: Doc; docMap: Map<string, Doc>} {
  const doc = new Doc();
  return {doc, docMap: new Map<string, Doc>([['test', doc]])};
}

/**
 * A `Doc` that holds many documents at once: `notes` is a `Y.Array` of
 * `Y.Map`s, each with its own `XmlText` body, so no editor root is a top-level
 * shared type.
 */
function createNotesDoc(): {doc: Doc; docMap: Map<string, Doc>} {
  const {doc, docMap} = createTestDoc();
  const notes = doc.getArray<YMap<XmlText>>('notes');
  notes.push(
    ['first', 'second'].map(() => {
      const note = new YMap<XmlText>();
      note.set('body', new XmlText());
      return note;
    }),
  );
  return {doc, docMap};
}

function getNoteBody(doc: Doc, index = 0): XmlText {
  const body = doc.getArray<YMap<XmlText>>('notes').get(index).get('body');
  if (!(body instanceof XmlText)) {
    throw new Error('expected an XmlText body');
  }
  return body;
}

/**
 * The V2 counterpart of {@link createNotesDoc}: each note's body is an
 * `XmlElement` created without a `nodeName`, as `doc.get(name, XmlElement)`
 * would produce for a top-level root.
 */
function createNotesDocV2(): {doc: Doc; docMap: Map<string, Doc>} {
  const {doc, docMap} = createTestDoc();
  const notes = doc.getArray<YMap<XmlElement>>('notes');
  notes.push(
    ['first', 'second'].map(() => {
      const note = new YMap<XmlElement>();
      note.set('body', new XmlElement());
      return note;
    }),
  );
  return {doc, docMap};
}

function getNoteElement(doc: Doc, index = 0): XmlElement {
  const body = doc.getArray<YMap<XmlElement>>('notes').get(index).get('body');
  if (!(body instanceof XmlElement)) {
    throw new Error('expected an XmlElement body');
  }
  return body;
}

/** Write the editor's tree into the binding's root, as the update listener does. */
function serialize(editor: LexicalEditor, binding: Binding): void {
  editor.read(() => {
    binding.doc.transact(() => {
      binding.root.syncChildrenFromLexical(
        binding,
        $getRoot(),
        null,
        null,
        null,
      );
    });
  });
}

/** Materialize the binding's root into the editor, as the observer does. */
function restore(editor: LexicalEditor, binding: Binding): void {
  editor.update(
    () => {
      $getRoot().clear();
      binding.root.applyChildrenYjsDelta(
        binding,
        getRootXmlText(binding.root).toDelta(),
      );
      binding.root.syncChildrenFromYjs(binding);
    },
    {discrete: true},
  );
}

describe('createYjsBinding', () => {
  test('uses default rootName "root"', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({name: 'yjs-binding-test'}),
    );
    const {doc, docMap} = createTestDoc();

    const binding = createYjsBinding({doc, docMap, editor, id: 'test'});

    expect(binding.root).toBeDefined();
    expect(doc.get('root', XmlText)).toBe(getRootXmlText(binding.root));
  });

  test('uses custom rootName', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({name: 'yjs-binding-test'}),
    );
    const {doc, docMap} = createTestDoc();

    const binding = createYjsBinding({
      doc,
      docMap,
      editor,
      id: 'test',
      rootName: 'customRoot',
    });

    expect(binding.root).toBeDefined();
    expect(doc.get('customRoot', XmlText)).toBe(getRootXmlText(binding.root));
    expect(doc.share.has('root')).toBe(false);
  });

  test('different rootNames create independent shared types', () => {
    using editor1 = buildEditorFromExtensions(
      defineExtension({name: 'yjs-binding-test-a'}),
    );
    using editor2 = buildEditorFromExtensions(
      defineExtension({name: 'yjs-binding-test-b'}),
    );
    const {doc, docMap} = createTestDoc();

    const binding1 = createYjsBinding({
      doc,
      docMap,
      editor: editor1,
      id: 'test',
      rootName: 'editor-a',
    });

    const binding2 = createYjsBinding({
      doc,
      docMap,
      editor: editor2,
      id: 'test',
      rootName: 'editor-b',
    });

    const xmlA = getRootXmlText(binding1.root);
    const xmlB = getRootXmlText(binding2.root);
    expect(xmlA).not.toBe(xmlB);
    expect(doc.get('editor-a', XmlText)).toBe(xmlA);
    expect(doc.get('editor-b', XmlText)).toBe(xmlB);
  });
});

describe('createYjsBinding with getXmlText', () => {
  test('uses an XmlText that is not a top-level shared type', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({name: 'yjs-binding-test'}),
    );
    const {doc, docMap} = createNotesDoc();

    const binding = createYjsBinding({
      doc,
      docMap,
      editor,
      getXmlText: getNoteBody,
      id: 'test',
    });

    expect(getRootXmlText(binding.root)).toBe(getNoteBody(doc));
    expect(doc.share.has('root')).toBe(false);
  });

  test('takes precedence over rootName', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({name: 'yjs-binding-test'}),
    );
    const {doc, docMap} = createNotesDoc();

    const binding = createYjsBinding({
      doc,
      docMap,
      editor,
      getXmlText: getNoteBody,
      id: 'test',
      rootName: 'customRoot',
    });

    expect(getRootXmlText(binding.root)).toBe(getNoteBody(doc));
    expect(doc.share.has('customRoot')).toBe(false);
  });

  test('rejects a root that is not integrated into the doc', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({name: 'yjs-binding-test'}),
    );
    const {doc, docMap} = createNotesDoc();

    expect(() =>
      createYjsBinding({
        doc,
        docMap,
        editor,
        getXmlText: () => new XmlText(),
        id: 'test',
      }),
    ).toThrow('getXmlText must return an XmlText');
  });

  test('rejects a root that could not be resolved', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({name: 'yjs-binding-test'}),
    );
    const {doc, docMap} = createNotesDoc();

    expect(() =>
      createYjsBinding({
        doc,
        docMap,
        editor,
        // what reaching for a note the doc has not synced yet returns
        getXmlText: () => doc.getMap<XmlText>('missing').get('body') as XmlText,
        id: 'test',
      }),
    ).toThrow('getXmlText must return an XmlText');
  });

  test('a nested root round-trips to another client', () => {
    using localEditor = buildEditorFromExtensions(
      defineExtension({$initialEditorState: null, name: 'yjs-binding-local'}),
    );
    using remoteEditor = buildEditorFromExtensions(
      defineExtension({$initialEditorState: null, name: 'yjs-binding-remote'}),
    );
    const {doc: localDoc, docMap: localDocMap} = createNotesDoc();
    const localBinding = createYjsBinding({
      doc: localDoc,
      docMap: localDocMap,
      editor: localEditor,
      getXmlText: getNoteBody,
      id: 'test',
    });

    localEditor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('Note body')));
      },
      {discrete: true},
    );
    serialize(localEditor, localBinding);

    // the content lands in the nested body, not in a top-level `root`
    expect(getNoteBody(localDoc).length).toBeGreaterThan(0);
    expect(localDoc.share.has('root')).toBe(false);

    // A second client owns its own Doc, synced with an update message, so it
    // resolves its own nested XmlText rather than reusing the local collab
    // nodes cached on the shared type.
    const remoteDoc = new Doc();
    applyUpdate(remoteDoc, encodeStateAsUpdate(localDoc));
    const remoteBinding = createYjsBinding({
      doc: remoteDoc,
      docMap: new Map<string, Doc>([['test', remoteDoc]]),
      editor: remoteEditor,
      getXmlText: getNoteBody,
      id: 'test',
    });
    restore(remoteEditor, remoteBinding);

    expect(remoteEditor.read(() => $getRoot().getTextContent())).toBe(
      'Note body',
    );
    // the sibling note in the same Doc is untouched by this binding
    expect(getNoteBody(remoteDoc, 1).length).toBe(0);
  });
});

describe('createBindingV2__EXPERIMENTAL with getXmlElement', () => {
  test('uses an XmlElement that is not a top-level shared type', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({name: 'yjs-binding-v2-test'}),
    );
    const {doc, docMap} = createNotesDocV2();

    const binding = createBindingV2__EXPERIMENTAL(editor, 'test', doc, docMap, {
      getXmlElement: getNoteElement,
    });

    expect(binding.root).toBe(getNoteElement(doc));
    expect(doc.share.has('root-v2')).toBe(false);
  });

  test('takes precedence over rootName', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({name: 'yjs-binding-v2-test'}),
    );
    const {doc, docMap} = createNotesDocV2();

    const binding = createBindingV2__EXPERIMENTAL(editor, 'test', doc, docMap, {
      getXmlElement: getNoteElement,
      rootName: 'customRoot',
    });

    expect(binding.root).toBe(getNoteElement(doc));
    expect(doc.share.has('customRoot')).toBe(false);
  });

  test('rejects a root that is not integrated into the doc', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({name: 'yjs-binding-v2-test'}),
    );
    const {doc, docMap} = createNotesDocV2();

    expect(() =>
      createBindingV2__EXPERIMENTAL(editor, 'test', doc, docMap, {
        getXmlElement: () => new XmlElement(),
      }),
    ).toThrow('getXmlElement must return an XmlElement');
  });

  test('rejects a root created with a nodeName', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({name: 'yjs-binding-v2-test'}),
    );
    const {doc, docMap} = createNotesDocV2();
    const named = new XmlElement('note');
    doc.getMap<XmlElement>('named').set('body', named);

    expect(() =>
      createBindingV2__EXPERIMENTAL(editor, 'test', doc, docMap, {
        getXmlElement: () => named,
      }),
    ).toThrow('must be created without a nodeName');
  });

  test('a nested root round-trips to another client', () => {
    using localEditor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: 'yjs-binding-v2-local',
      }),
    );
    using remoteEditor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: 'yjs-binding-v2-remote',
      }),
    );
    const {doc: localDoc, docMap: localDocMap} = createNotesDocV2();
    const localBinding = createBindingV2__EXPERIMENTAL(
      localEditor,
      'test',
      localDoc,
      localDocMap,
      {getXmlElement: getNoteElement},
    );

    localEditor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('Note body')));
      },
      {discrete: true},
    );
    localEditor.read(() => {
      localDoc.transact(() => {
        $updateYFragment(
          localDoc,
          localBinding.root,
          $getRoot(),
          localBinding,
          new Set(['root']),
        );
      });
    });

    // the content lands in the nested body, not in a top-level `root-v2`
    expect(getNoteElement(localDoc).length).toBeGreaterThan(0);
    expect(localDoc.share.has('root-v2')).toBe(false);

    const remoteDoc = new Doc();
    applyUpdate(remoteDoc, encodeStateAsUpdate(localDoc));
    const remoteBinding = createBindingV2__EXPERIMENTAL(
      remoteEditor,
      'test',
      remoteDoc,
      new Map<string, Doc>([['test', remoteDoc]]),
      {getXmlElement: getNoteElement},
    );
    remoteEditor.update(
      () => {
        $getRoot().clear();
        $createOrUpdateNodeFromYElement(
          remoteBinding.root,
          remoteBinding,
          null,
          true,
        );
      },
      {discrete: true},
    );

    expect(remoteEditor.read(() => $getRoot().getTextContent())).toBe(
      'Note body',
    );
    // the sibling note in the same Doc is untouched by this binding
    expect(getNoteElement(remoteDoc, 1).length).toBe(0);
  });
});

describe('createBinding (legacy wrapper)', () => {
  test('delegates to createYjsBinding with default rootName', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({name: 'yjs-binding-legacy'}),
    );
    const {doc, docMap} = createTestDoc();

    const binding = createBinding(
      editor,
      null as unknown as Provider,
      'test',
      doc,
      docMap,
    );

    expect(binding.root).toBeDefined();
    expect(doc.get('root', XmlText)).toBe(getRootXmlText(binding.root));
  });

  test('throws invariant when doc is null', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({name: 'yjs-binding-legacy'}),
    );
    const docMap = new Map<string, Doc>();

    expect(() =>
      createBinding(editor, null as unknown as Provider, 'test', null, docMap),
    ).toThrow('createBinding: doc is null or undefined');
  });
});
