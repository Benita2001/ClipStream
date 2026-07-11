import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

const DB_PATH = process.env.CLIPSTREAM_DB_PATH || path.join(__dirname, "..", "clipstream.db");
const SCHEMA_PATH = path.join(__dirname, "schema.sql");

/**
 * CREATE TABLE IF NOT EXISTS in schema.sql is a no-op against a table that
 * already exists, even if its column list has grown since — SQLite has no
 * "ADD COLUMN IF NOT EXISTS". This is a minimal, idempotent stand-in for a
 * migration framework: each entry adds one column to an existing table if
 * (and only if) it isn't already there, so re-running init.ts against an
 * older database stays safe.
 */
const COLUMN_MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: "campaigns", column: "cpm_rate", ddl: "ALTER TABLE campaigns ADD COLUMN cpm_rate TEXT NOT NULL DEFAULT '0'" },
  { table: "campaigns", column: "max_cpm", ddl: "ALTER TABLE campaigns ADD COLUMN max_cpm TEXT NOT NULL DEFAULT '0'" },
  { table: "clips", column: "per_clip_cap", ddl: "ALTER TABLE clips ADD COLUMN per_clip_cap TEXT" },
  { table: "clips", column: "is_capped", ddl: "ALTER TABLE clips ADD COLUMN is_capped INTEGER NOT NULL DEFAULT 0" },
  { table: "clips", column: "effective_cpm_rate", ddl: "ALTER TABLE clips ADD COLUMN effective_cpm_rate TEXT" },
  { table: "agent_decisions", column: "llm_used", ddl: "ALTER TABLE agent_decisions ADD COLUMN llm_used INTEGER NOT NULL DEFAULT 0" },
  { table: "campaigns", column: "description", ddl: "ALTER TABLE campaigns ADD COLUMN description TEXT" },
  { table: "campaigns", column: "source_link", ddl: "ALTER TABLE campaigns ADD COLUMN source_link TEXT" },
  // NOT NULL with a placeholder DEFAULT — existing rows indexed before this
  // column existed get "Untitled Campaign" rather than breaking the
  // NOT NULL constraint or being left NULL (name is required going forward,
  // see insertCampaign/POST /campaigns).
  {
    table: "campaigns",
    column: "name",
    ddl: "ALTER TABLE campaigns ADD COLUMN name TEXT NOT NULL DEFAULT 'Untitled Campaign'",
  },
];

function applyColumnMigrations(db: Database.Database): void {
  for (const { table, column, ddl } of COLUMN_MIGRATIONS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    const exists = columns.some((c) => c.name === column);
    if (!exists) {
      db.exec(ddl);
      console.log(`Migrated: added ${table}.${column}`);
    }
  }
}

function main() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(schema);
  applyColumnMigrations(db);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];

  console.log(`Initialized ClipStream SQLite DB at ${DB_PATH}`);
  console.log(`Journal mode: ${db.pragma("journal_mode", { simple: true })}`);
  console.log(`Tables: ${tables.map((t) => t.name).join(", ")}`);

  db.close();
}

main();
