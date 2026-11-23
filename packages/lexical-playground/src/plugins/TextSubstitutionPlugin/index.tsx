/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {SettingName} from '../../appSettings';
import type {LexicalEditor} from 'lexical';

import './index.css';

import {
  DEFAULT_TEXT_SUBSTITUTIONS,
  getExtensionDependencyFromEditor,
  TextSubstitutionExtension,
} from '@lexical/extension';
import {useSignalValue} from '@lexical/react/useExtensionSignalValue';
import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {useSettings} from '../../context/SettingsContext';
import Button from '../../ui/Button';
import {DialogActions} from '../../ui/Dialog';

type Substitutions = Readonly<Record<string, string | null>>;

/** Substitutions the user turned off in the dialog, kept so they can be turned back on. */
type DisabledSubstitutions = Readonly<Record<string, string>>;

const DISABLED_SUBSTITUTIONS_STORAGE_KEY =
  'lexical-playground-disabled-substitutions';

function readDisabledSubstitutions(): DisabledSubstitutions {
  try {
    const raw = window.localStorage.getItem(DISABLED_SUBSTITUTIONS_STORAGE_KEY);
    if (raw === null) {
      return {};
    }
    return JSON.parse(raw) as DisabledSubstitutions;
  } catch {
    return {};
  }
}

function writeDisabledSubstitutions(next: DisabledSubstitutions): void {
  try {
    window.localStorage.setItem(
      DISABLED_SUBSTITUTIONS_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch {
    // Storage may be unavailable; the toggles still work in memory.
  }
}

function TextSubstitutionRow({
  alias,
  enabled,
  replacement,
  onRemove,
  onToggle,
  setSubstitutions,
  substitutions,
}: {
  alias: string;
  enabled: boolean;
  replacement: string;
  onRemove: () => void;
  onToggle: (nextEnabled: boolean) => void;
  setSubstitutions: (next: Substitutions) => void;
  substitutions: Substitutions;
}): JSX.Element {
  const [aliasDraft, setAliasDraft] = useState(alias);
  const [replacementDraft, setReplacementDraft] = useState(replacement);

  const commitAlias = useCallback(() => {
    const nextAlias = aliasDraft.trim();
    if (
      nextAlias.length === 0 ||
      nextAlias === alias ||
      nextAlias === replacement ||
      (nextAlias in substitutions && nextAlias !== alias)
    ) {
      // Invalid rename: revert to the stored alias.
      setAliasDraft(alias);
      return;
    }
    const next = {...substitutions};
    delete next[alias];
    next[nextAlias] = replacement;
    setSubstitutions(next);
  }, [alias, aliasDraft, replacement, setSubstitutions, substitutions]);

  const commitReplacement = useCallback(() => {
    const nextReplacement = replacementDraft.trim();
    if (
      nextReplacement.length === 0 ||
      nextReplacement === replacement ||
      nextReplacement === alias
    ) {
      // Invalid value: revert to the stored replacement.
      setReplacementDraft(replacement);
      return;
    }
    setSubstitutions({...substitutions, [alias]: nextReplacement});
  }, [alias, replacement, replacementDraft, setSubstitutions, substitutions]);

  return (
    <li className="TextSubstitutionDialog__row">
      <input
        aria-label={`Enable substitution for ${alias}`}
        checked={enabled}
        onChange={e => onToggle(e.target.checked)}
        type="checkbox"
        data-test-id="text-substitution-enable"
      />
      <input
        aria-label="Replace"
        className="Input__input TextSubstitutionDialog__input"
        data-test-id="text-substitution-alias-input"
        disabled={!enabled}
        onBlur={commitAlias}
        onChange={e => setAliasDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          }
        }}
        value={aliasDraft}
      />
      <input
        aria-label="With"
        className="Input__input TextSubstitutionDialog__input"
        data-test-id="text-substitution-replacement-input"
        disabled={!enabled}
        onBlur={commitReplacement}
        onChange={e => setReplacementDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          }
        }}
        value={replacementDraft}
      />
      <button
        aria-label={`Remove substitution for ${alias}`}
        className="TextSubstitutionDialog__remove"
        onClick={onRemove}
        type="button"
        data-test-id="text-substitution-remove">
        ×
      </button>
    </li>
  );
}

const GENERAL_PREFERENCE_OPTIONS: {
  key: SettingName;
  label: string;
  hint?: string;
}[] = [
  {key: 'autoCapitaliseWords', label: 'Automatically capitalise words'},
  {key: 'useSmartQuotes', label: 'Use smart quotes'},
  {key: 'autoDetectLinks', label: 'Automatically detect links'},
  {key: 'autoDetectLists', label: 'Automatically detect lists'},
  {key: 'enableMarkdown', label: 'Enable Markdown'},
  {key: 'autoCorrectSpelling', label: 'Automatically correct spelling'},
  {
    hint: '(suggested replies appear below comments)',
    key: 'showSmartReply',
    label: 'Show Smart Reply suggestions',
  },
  {key: 'showLinkDetails', label: 'Show link details'},
  {
    key: 'insertEmojiWithColon',
    label: 'Insert emoji using the colon character',
  },
];

function GeneralPreferencesTab({onClose}: {onClose: () => void}): JSX.Element {
  const {setOption, settings} = useSettings();

  return (
    <>
      <table>
        <tbody>
          {GENERAL_PREFERENCE_OPTIONS.map(option => (
            <tr key={option.key}>
              <td className="PreferencesDialog__cell PreferencesDialog__option">
                <label className="PreferencesDialog__option-label">
                  <input
                    type="checkbox"
                    checked={settings[option.key]}
                    onChange={e => setOption(option.key, e.target.checked)}
                  />
                  <span>
                    {option.label}
                    {option.hint !== undefined && (
                      <>
                        <br />
                        <span className="PreferencesDialog__option-hint">
                          {option.hint}
                        </span>
                      </>
                    )}
                  </span>
                </label>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <DialogActions>
        <Button onClick={onClose}>Done</Button>
      </DialogActions>
    </>
  );
}

function SubstitutionsTab({
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
  const disabledSignal = useMemo(
    () =>
      getExtensionDependencyFromEditor(activeEditor, TextSubstitutionExtension)
        .output.disabled,
    [activeEditor],
  );
  const substitutions = useSignalValue(substitutionsSignal);
  const disabled = useSignalValue(disabledSignal);
  const [disabledSubstitutions, setDisabledSubstitutions] =
    useState<DisabledSubstitutions>(readDisabledSubstitutions);
  const [addAlias, setAddAlias] = useState('');
  const [addReplacement, setAddReplacement] = useState('');

  // Snapshot the state when the dialog opens, so Cancel can restore it.
  const snapshotRef = useRef<{
    disabledSubstitutions: DisabledSubstitutions;
    substitutions: Substitutions;
  } | null>(null);
  if (snapshotRef.current === null) {
    snapshotRef.current = {
      disabledSubstitutions: readDisabledSubstitutions(),
      substitutions,
    };
  }

  useEffect(() => {
    writeDisabledSubstitutions(disabledSubstitutions);
  }, [disabledSubstitutions]);

  const setSubstitutions = useCallback(
    (next: Substitutions) => {
      getExtensionDependencyFromEditor(
        activeEditor,
        TextSubstitutionExtension,
      ).output.substitutions.value = next;
    },
    [activeEditor],
  );

  const setAutomaticSubstitution = useCallback(
    (enabled: boolean) => {
      getExtensionDependencyFromEditor(
        activeEditor,
        TextSubstitutionExtension,
      ).output.disabled.value = !enabled;
    },
    [activeEditor],
  );

  const onAdd = useCallback(() => {
    const nextAlias = addAlias.trim();
    const nextReplacement = addReplacement.trim();
    if (
      nextAlias.length === 0 ||
      nextReplacement.length === 0 ||
      nextAlias === nextReplacement
    ) {
      return;
    }
    setSubstitutions({
      ...substitutions,
      [nextAlias]: nextReplacement,
    });
    setAddAlias('');
    setAddReplacement('');
  }, [addAlias, addReplacement, setSubstitutions, substitutions]);

  const onReset = useCallback(() => {
    setSubstitutions(DEFAULT_TEXT_SUBSTITUTIONS);
    setDisabledSubstitutions({});
  }, [setSubstitutions]);

  const onCancel = useCallback(() => {
    const snapshot = snapshotRef.current;
    if (snapshot !== null) {
      setSubstitutions(snapshot.substitutions);
      setDisabledSubstitutions(snapshot.disabledSubstitutions);
    }
    onClose();
  }, [onClose, setSubstitutions]);

  const onToggleEntry = useCallback(
    (alias: string, replacement: string, enabled: boolean) => {
      if (enabled) {
        // Turn it back on: restore the replacement and drop it from
        // the disabled list.
        const nextDisabled = {...disabledSubstitutions};
        delete nextDisabled[alias];
        setDisabledSubstitutions(nextDisabled);
        setSubstitutions({...substitutions, [alias]: replacement});
      } else {
        // Turn it off: keep the replacement in the disabled list so
        // it can be turned back on, and remove it from the active map.
        setDisabledSubstitutions({
          ...disabledSubstitutions,
          [alias]: replacement,
        });
        const next = {...substitutions};
        next[alias] = null;
        setSubstitutions(next);
      }
    },
    [disabledSubstitutions, setSubstitutions, substitutions],
  );

  const onRemoveEntry = useCallback(
    (alias: string) => {
      const nextDisabled = {...disabledSubstitutions};
      delete nextDisabled[alias];
      setDisabledSubstitutions(nextDisabled);
      const next = {...substitutions};
      delete next[alias];
      setSubstitutions(next);
    },
    [disabledSubstitutions, setSubstitutions, substitutions],
  );

  // A `null` value removes a substitution from the active map, so only
  // non-null entries are shown as enabled rows. Disabled entries live
  // in the disabled list and are shown unchecked.
  const entries: {alias: string; enabled: boolean; replacement: string}[] =
    Object.entries(substitutions)
      .filter((entry): entry is [string, string] => entry[1] !== null)
      .map(([alias, replacement]) => ({alias, enabled: true, replacement}))
      .concat(
        Object.entries(disabledSubstitutions).map(([alias, replacement]) => ({
          alias,
          enabled: false,
          replacement,
        })),
      )
      .sort((a, b) => a.alias.localeCompare(b.alias));

  return (
    <>
      <label className="PreferencesDialog__master">
        <input
          type="checkbox"
          checked={!disabled}
          onChange={e => setAutomaticSubstitution(e.target.checked)}
          data-test-id="text-substitution-automatic"
        />
        <span>Automatic substitution</span>
      </label>
      <div className="PreferencesDialog__table-header" aria-hidden="true">
        <span className="PreferencesDialog__table-header-spacer PreferencesDialog__table-header-spacer--checkbox" />
        <span>Replace</span>
        <span>With</span>
        <span className="PreferencesDialog__table-header-spacer PreferencesDialog__table-header-spacer--remove" />
      </div>
      <ul className="TextSubstitutionDialog__list">
        <li className="TextSubstitutionDialog__row">
          <span className="PreferencesDialog__table-header-spacer PreferencesDialog__table-header-spacer--checkbox" />
          <input
            aria-label="Replace"
            className="Input__input TextSubstitutionDialog__input"
            data-test-id="text-substitution-add-alias"
            onChange={e => setAddAlias(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                onAdd();
              }
            }}
            placeholder="Add a new substitution"
            value={addAlias}
          />
          <input
            aria-label="With"
            className="Input__input TextSubstitutionDialog__input"
            data-test-id="text-substitution-add-replacement"
            onBlur={onAdd}
            onChange={e => setAddReplacement(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                onAdd();
              }
            }}
            value={addReplacement}
          />
          <span className="PreferencesDialog__table-header-spacer PreferencesDialog__table-header-spacer--remove" />
        </li>
        {entries.map(entry => (
          <TextSubstitutionRow
            // Key on alias and replacement so the row remounts with
            // fresh drafts when the entry changes from outside (for
            // example, Reset to defaults), instead of syncing state
            // in an effect.
            key={`${entry.alias}\n${entry.replacement}\n${entry.enabled}`}
            alias={entry.alias}
            enabled={entry.enabled}
            replacement={entry.replacement}
            onRemove={() => onRemoveEntry(entry.alias)}
            onToggle={enabled =>
              onToggleEntry(entry.alias, entry.replacement, enabled)
            }
            setSubstitutions={setSubstitutions}
            substitutions={substitutions}
          />
        ))}
      </ul>
      <DialogActions>
        <Button onClick={onReset} data-test-id="text-substitution-reset">
          Reset to defaults
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
        <Button onClick={onClose}>OK</Button>
      </DialogActions>
    </>
  );
}

export function PreferencesDialog({
  activeEditor,
  onClose,
}: {
  activeEditor: LexicalEditor;
  onClose: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<'general' | 'substitutions'>('substitutions');

  return (
    <div className="PreferencesDialog">
      <div
        className="PreferencesDialog__tabs"
        role="tablist"
        aria-label="Preferences">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'general'}
          className="PreferencesDialog__tab"
          onClick={e => {
            e.preventDefault();
            setTab('general');
          }}>
          General
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'substitutions'}
          className="PreferencesDialog__tab"
          onClick={e => {
            e.preventDefault();
            setTab('substitutions');
          }}>
          Substitutions
        </button>
      </div>
      {tab === 'general' ? (
        <GeneralPreferencesTab onClose={onClose} />
      ) : (
        <SubstitutionsTab activeEditor={activeEditor} onClose={onClose} />
      )}
    </div>
  );
}
