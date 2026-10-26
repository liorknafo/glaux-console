import ace from 'ace-builds';
import 'ace-builds/css/ace.css';
import 'ace-builds/css/theme/cloud_editor.css';
import 'ace-builds/css/theme/cloud_editor_dark.css';

/**
 * Ace, wired for the one language this console edits.
 *
 * `ace-builds/esm-resolver` registers every mode, theme, keybinding and
 * extension ace ships — hundreds of chunks. Registering the four modules the SQL
 * editor actually uses keeps the editor's lazy chunk small while going through
 * ace's own loader, so the bundler resolves the URLs rather than the browser
 * guessing them at runtime (which would break under glaux's `/console` mount).
 *
 * This module is only ever imported dynamically: ace touches `document` at
 * import time, and the editor is one screen out of many.
 */

ace.config.setModuleLoader('ace/mode/sql', () => import('ace-builds/src-noconflict/mode-sql.js'));
ace.config.setModuleLoader(
  'ace/theme/cloud_editor',
  () => import('ace-builds/src-noconflict/theme-cloud_editor.js'),
);
ace.config.setModuleLoader(
  'ace/theme/cloud_editor_dark',
  () => import('ace-builds/src-noconflict/theme-cloud_editor_dark.js'),
);
ace.config.setModuleLoader(
  'ace/ext/searchbox',
  () => import('ace-builds/src-noconflict/ext-searchbox.js'),
);

// No worker is registered: ace's SQL mode ships no syntax-check worker, and a
// worker script would not resolve under glaux's `/console` mount anyway.

export default ace;
