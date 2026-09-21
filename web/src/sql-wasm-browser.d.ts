// The browser build of sql.js is the same module as the package's main one, but the package ships no types for this file.
declare module 'sql.js/dist/sql-wasm-browser.js' {
  import initSqlJs from 'sql.js';
  export default initSqlJs;
}
