/**
 * The schema tree behind the editor, read from the Glue Data Catalog.
 *
 * Glue rather than Athena's own `ListDatabases`/`ListTableMetadata`: the spec
 * calls for a "Glue-backed schema tree", glaux's Athena is Glue-backed, and
 * glaux v0.1 documents the Athena query APIs without the metadata ones. Going
 * to Glue directly is one hop instead of two, and it is the same data the Glue
 * screen shows.
 *
 * The reading itself lives in `deep/glue/catalog.ts` so the tree and the Glue
 * screen cannot disagree about what a table is; this module is the Athena
 * screen's view of it.
 */

export {
  fetchDatabases,
  fetchTables,
  loadGlueCatalog,
  readDatabases,
  readNextToken,
  readTables,
  selectStatement,
} from '../glue/catalog';

export type {
  GlueColumn as SchemaColumn,
  GlueDatabase as SchemaDatabase,
  GlueTable as SchemaTable,
} from '../glue/catalog';
