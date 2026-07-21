/**
 * Remote read-only DB user provisioning for Open Dental's local MariaDB/MySQL.
 *
 * Creates an `edifi_ro` SELECT-only login using the DB engine's own init-file
 * mechanism, which runs as the server administrator at startup and needs NO
 * existing password. Open Dental's own root login is never touched. Used when an
 * office's stored DB password can't be recovered (OD locks it behind its runtime).
 *
 * This module holds the PURE, testable pieces (discovery parsing, my.ini
 * transforms, SQL + password generation). The stateful sequence (backup, inject,
 * restart service, verify, restore, rollback-on-failure) lives in main.js so it
 * can use the agent's config + mysql2 pool.
 */

const NEW_USER = "edifi_ro";

// Parse `sc query type= all state= all` output for a MySQL/MariaDB service name.
function parseDbServiceName(scQueryOutput) {
  const names = [];
  const re = /SERVICE_NAME:\s*(\S+)/gi;
  let m;
  while ((m = re.exec(scQueryOutput)) !== null) names.push(m[1]);
  // Prefer an exact common name, else the first mysql/maria service.
  const lc = (s) => s.toLowerCase();
  return (
    names.find((n) => ["mysql", "mariadb"].includes(lc(n))) ||
    names.find((n) => /mysql|maria/i.test(n)) ||
    null
  );
}

// Parse `sc qc <svc>` output for the mysqld/mariadbd binary path and its
// --defaults-file (my.ini). Returns { exePath, iniPath, binDir } (nulls if absent).
function parseServicePaths(scQcOutput) {
  const bin = scQcOutput.match(/BINARY_PATH_NAME\s*:\s*(.+)/i);
  let exePath = null;
  let iniPath = null;
  let binDir = null;
  if (bin) {
    const line = bin[1].trim();
    const exe =
      line.match(/"([^"]*mysqld[^"]*\.exe|[^"]*mariadbd[^"]*\.exe)"/i) ||
      line.match(/(\S*mysqld\.exe|\S*mariadbd\.exe)/i);
    if (exe) {
      exePath = exe[1];
      binDir = exePath.replace(/[\\/][^\\/]+$/, "");
    }
    // The whole arg is usually quoted as "--defaults-file=C:\dir with spaces\my.ini",
    // so the path runs until the next quote. Also handle a separately-quoted path.
    const ini = line.match(/--defaults-file="?([^"]+)/i);
    if (ini) iniPath = ini[1].trim();
  }
  return { exePath, iniPath, binDir };
}

// Insert an init_file directive under [mysqld]. Path must use forward slashes
// (MariaDB/MySQL my.ini treats backslashes as escapes). Idempotent-ish: strips any
// existing init_file first so re-runs don't stack directives.
function injectInitFile(iniText, sqlPathForwardSlash) {
  const cleaned = removeInitFile(iniText);
  const lines = cleaned.split(/\r?\n/);
  const out = [];
  let done = false;
  for (const l of lines) {
    out.push(l);
    if (!done && /^\s*\[mysqld\]\s*$/i.test(l)) {
      out.push(`init_file="${sqlPathForwardSlash}"`);
      done = true;
    }
  }
  return { text: out.join("\r\n"), injected: done };
}

// Remove any init_file/init-file line (used to restore my.ini after provisioning).
function removeInitFile(iniText) {
  return iniText
    .split(/\r?\n/)
    .filter((l) => !/^\s*init[_-]file\s*=/i.test(l))
    .join("\r\n");
}

// SELECT-only grant for both local host forms. One statement per line (init_file
// requirement). Never grants beyond the OD schema; never alters root.
function buildInitSql(db, password, user = NEW_USER) {
  const q = (s) => String(s).replace(/`/g, "");
  return [
    `CREATE USER IF NOT EXISTS '${user}'@'localhost' IDENTIFIED BY '${password}';`,
    `CREATE USER IF NOT EXISTS '${user}'@'127.0.0.1' IDENTIFIED BY '${password}';`,
    `GRANT SELECT ON \`${q(db)}\`.* TO '${user}'@'localhost';`,
    `GRANT SELECT ON \`${q(db)}\`.* TO '${user}'@'127.0.0.1';`,
    `FLUSH PRIVILEGES;`,
    "",
  ].join("\n");
}

// Strong ASCII password with no SQL/shell metacharacters (avoids quoting issues in
// the init-file and later connection). 24 chars from a safe alphabet.
function generatePassword(randomBytes) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(24);
  let s = "Ed1";
  for (let i = 0; i < 24; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

module.exports = {
  NEW_USER,
  parseDbServiceName,
  parseServicePaths,
  injectInitFile,
  removeInitFile,
  buildInitSql,
  generatePassword,
};
