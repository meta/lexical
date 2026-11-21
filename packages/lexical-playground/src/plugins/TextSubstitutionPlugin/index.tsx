/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditor} from 'lexical';

import './index.css';

import {
  DEFAULT_TEXT_SUBSTITUTIONS,
  getExtensionDependencyFromEditor,
  TextSubstitutionExtension,
} from '@lexical/extension';
import {useSignalValue} from '@lexical/react/useExtensionSignalValue';
import {type JSX, useCallback, useMemo, useState} from 'react';

import Button from '../../ui/Button';
import {DialogActions} from '../../ui/Dialog';
import TextInput from '../../ui/TextInput';

export function TextSubstitutionDialog({
  activeEditor,
  onClose,
}: {
  activeEditor: LexicalEditor;
  onClose: () => void;
}): JSX.Element {
  const substitutionsSignal = useMemo(
    () =>
      getExtensionDependencyFromEditor(activeEditor, TextSubstitutionExtension)
        .output.substitutions,
    [activeEditor],
  );
  const substitutions = useSignalValue(substitutionsSignal);
  const [alias, setAlias] = useState('');
  const [replacement, setReplacement] = useState('');

  const setSubstitutions = useCallback(
    (next: Readonly<Record<string, string | null>>) => {
      getExtensionDependencyFromEditor(
        activeEditor,
        TextSubstitutionExtension,
      ).output.substitutions.value = next;
    },
    [activeEditor],
  );

  const isAddDisabled =
    alias.trim().length === 0 ||
    replacement.trim().length === 0 ||
    alias.trim() === replacement.trim();

  const onAdd = useCallback(() => {
    if (isAddDisabled) {
      return;
    }
    const nextAlias = alias.trim();
    setSubstitutions({
      ...substitutions,
      [nextAlias]: replacement.trim(),
    });
    setAlias('');
    setReplacement('');
  }, [alias, isAddDisabled, replacement, setSubstitutions, substitutions]);

  const onRemove = useCallback(
    (aliasToRemove: string) => {
      const next = {...substitutions};
      delete next[aliasToRemove];
      setSubstitutions(next);
    },
    [setSubstitutions, substitutions],
  );

  const onReset = useCallback(() => {
    setSubstitutions(DEFAULT_TEXT_SUBSTITUTIONS);
  }, [setSubstitutions]);

  // A `null` value removes a substitution, so it has no row here.
  const entries = Object.entries(substitutions)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <>
      <p className="TextSubstitutionDialog__note">
        Substitutions replace text as you type. Changes apply immediately, so
        you can keep typing in the editor while this dialog is open.
      </p>
      <ul className="TextSubstitutionDialog__list">
        {entries.map(([entryAlias, entryReplacement]) => (
          <li key={entryAlias} className="TextSubstitutionDialog__row">
            <span className="TextSubstitutionDialog__alias">{entryAlias}</span>
            <span className="TextSubstitutionDialog__arrow">→</span>
            <span className="TextSubstitutionDialog__replacement">
              {entryReplacement}
            </span>
            <Button
              small={true}
              onClick={() => onRemove(entryAlias)}
              data-test-id="text-substitution-remove">
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <TextInput
        label="Alias"
        placeholder="e.g. (c)"
        onChange={setAlias}
        value={alias}
        data-test-id="text-substitution-alias"
      />
      <TextInput
        label="Replacement"
        placeholder="e.g. ©"
        onChange={setReplacement}
        value={replacement}
        data-test-id="text-substitution-replacement"
      />
      <DialogActions>
        <Button onClick={onReset} data-test-id="text-substitution-reset">
          Reset to defaults
        </Button>
        <Button
          disabled={isAddDisabled}
          onClick={onAdd}
          data-test-id="text-substitution-add">
          Add
        </Button>
        <Button onClick={onClose}>Done</Button>
      </DialogActions>
    </>
  );
}
