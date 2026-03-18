#!/usr/bin/env node

/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { Sequelize, QueryTypes } = require("sequelize");

const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const getArgValue = (flag) => {
  const idx = argv.indexOf(flag);
  if (idx < 0) return "";
  return String(argv[idx + 1] ?? "").trim();
};

const apply = hasFlag("--apply");
const yes = hasFlag("--yes");
const all = hasFlag("--all");
const through = getArgValue("--through");
const env = String(process.env.NODE_ENV || "production").trim();

const migrationDir = path.join(__dirname, "..", "migrations");
const configPath = path.join(__dirname, "..", "config", "config.js");
const allMigrationFiles = fs
  .readdirSync(migrationDir)
  .filter((file) => file.endsWith(".js"))
  .sort();

if (apply && !yes) {
  console.error("Refusing to apply without --yes");
  process.exit(1);
}

if (apply && !all && !through) {
  console.error("Use --all or --through <filename> when --apply is set.");
  process.exit(1);
}

if (through && !allMigrationFiles.includes(through)) {
  console.error(`Migration file not found in migrations/: ${through}`);
  process.exit(1);
}

const configByEnv = require(configPath);
const cfg = configByEnv[env];

if (!cfg) {
  console.error(`No DB config found for env: ${env}`);
  process.exit(1);
}

const sequelize = new Sequelize(cfg.database, cfg.username, cfg.password, cfg);

const run = async () => {
  await sequelize.authenticate();

  await sequelize.query(
    "CREATE TABLE IF NOT EXISTS `SequelizeMeta` (`name` VARCHAR(255) NOT NULL PRIMARY KEY)",
    { type: QueryTypes.RAW }
  );

  const appliedRows = await sequelize.query("SELECT `name` FROM `SequelizeMeta`", {
    type: QueryTypes.SELECT,
  });
  const appliedSet = new Set(
    (appliedRows || [])
      .map((row) => String((row && row.name) || "").trim())
      .filter(Boolean)
  );

  const pending = allMigrationFiles.filter((name) => !appliedSet.has(name));
  let toMark = [];
  if (apply) {
    if (all) {
      toMark = pending.slice();
    } else {
      toMark = pending.filter((name) => name <= through);
    }
  }

  if (apply && toMark.length > 0) {
    for (const migrationName of toMark) {
      await sequelize.query("INSERT INTO `SequelizeMeta` (`name`) VALUES (:name)", {
        type: QueryTypes.INSERT,
        replacements: { name: migrationName },
      });
    }
  }

  const result = {
    env,
    mode: apply ? "apply" : "dry-run",
    total_migrations: allMigrationFiles.length,
    applied_count: appliedSet.size + (apply ? toMark.length : 0),
    pending_count_before: pending.length,
    marked_count: toMark.length,
    through: through || null,
    mark_all: all,
    to_mark: toMark,
    pending_preview: pending.slice(0, 20),
  };

  console.log(JSON.stringify(result, null, 2));
};

run()
  .catch((error) => {
    console.error(String(error && error.stack ? error.stack : error));
    process.exit(1);
  })
  .finally(async () => {
    try {
      await sequelize.close();
    } catch (_err) {
      // noop
    }
  });
