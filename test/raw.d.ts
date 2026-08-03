/**
 * Vite serves `?raw` imports as strings; TypeScript needs telling. Used so the D1 tests apply
 * db/schema.sql itself rather than a second, drifting copy of the DDL.
 */
declare module "*.sql?raw" {
  const contents: string;
  export default contents;
}
