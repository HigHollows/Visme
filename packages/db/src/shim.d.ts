// Le paquet n'expose pas ses types via "exports" ; son API est celle de better-sqlite3.
declare module "better-sqlite3-multiple-ciphers" {
  import Database from "better-sqlite3";
  export = Database;
}
