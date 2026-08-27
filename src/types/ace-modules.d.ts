/**
 * ace-builds ships types for its entry point but not for the individual
 * `src-noconflict` modes and themes, which are prebuilt bundles. They are
 * imported purely for their side effect — registering themselves with ace —
 * so an empty declaration is the whole contract.
 */
declare module 'ace-builds/src-noconflict/mode-sql.js';
declare module 'ace-builds/src-noconflict/theme-cloud_editor.js';
declare module 'ace-builds/src-noconflict/theme-cloud_editor_dark.js';
declare module 'ace-builds/src-noconflict/ext-searchbox.js';
