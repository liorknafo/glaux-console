import { useEffect, useState } from 'react';
import CodeEditor, { type CodeEditorProps } from '@cloudscape-design/components/code-editor';
import Textarea from '@cloudscape-design/components/textarea';

/**
 * The SQL editor: Cloudscape's Ace-based `CodeEditor`, the same component the
 * console's own query editors use.
 *
 * Ace loads lazily. It reaches for `document` at import time and weighs more
 * than the rest of this screen put together, so it arrives with the editor
 * rather than with the bundle, and the editor renders its own loading state
 * until it does.
 */

const EDITOR_I18N: CodeEditorProps.I18nStrings = {
  loadingState: 'Loading the SQL editor',
  errorState: 'The SQL editor could not load.',
  errorStateRecovery: 'Retry',
  editorGroupAriaLabel: 'SQL editor',
  statusBarGroupAriaLabel: 'Editor status bar',
  cursorPosition: (row, column) => `Ln ${row}, Col ${column}`,
  errorsTab: 'Errors',
  warningsTab: 'Warnings',
  preferencesButtonAriaLabel: 'Editor preferences',
  paneCloseButtonAriaLabel: 'Close',
  preferencesModalHeader: 'Editor preferences',
  preferencesModalCancel: 'Cancel',
  preferencesModalConfirm: 'Confirm',
  preferencesModalWrapLines: 'Wrap lines',
  preferencesModalTheme: 'Theme',
  preferencesModalLightThemes: 'Light themes',
  preferencesModalDarkThemes: 'Dark themes',
};

type Ace = CodeEditorProps['ace'];

export function SqlEditor({
  value,
  onChange,
  onRun,
  disabled,
}: {
  value: string;
  onChange(next: string): void;
  onRun(): void;
  disabled?: boolean;
}) {
  const [ace, setAce] = useState<Ace>();
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [preferences, setPreferences] = useState<CodeEditorProps.Preferences>();

  useEffect(() => {
    let cancelled = false;
    import('./ace').then(
      module => !cancelled && setAce(module.default as Ace),
      () => !cancelled && setLoadError(true),
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <div
      data-testid="sql-editor"
      // Cmd/Ctrl+Enter runs the query, as the console's editor does. It is bound
      // on the wrapper rather than through an ace command so the shortcut still
      // works while ace is loading and in the plain-textarea fallback.
      onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !disabled) {
          event.preventDefault();
          onRun();
        }
      }}
    >
      {loadError ? (
        <Textarea
          ariaLabel="SQL query"
          value={value}
          disabled={disabled}
          rows={12}
          spellcheck={false}
          data-testid="sql-editor-fallback"
          onChange={event => onChange(event.detail.value)}
        />
      ) : (
        <CodeEditor
          ace={ace}
          value={value}
          language="sql"
          loading={!ace}
          // `onChange`, not `onDelayedChange`: the editor's debounce would let
          // Run fire on the previous text when a query is typed and run
          // immediately, which is exactly what the shortcut invites.
          onChange={event => onChange(event.detail.value)}
          preferences={preferences}
          onPreferencesChange={event => setPreferences(event.detail)}
          onRecoveryClick={() => {
            setLoadError(false);
            setAttempt(current => current + 1);
          }}
          i18nStrings={EDITOR_I18N}
          editorContentHeight={280}
          ariaLabel="SQL query"
        />
      )}
    </div>
  );
}
