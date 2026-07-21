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

// Parse `sc query type= all state= all` into MySQL/MariaDB services with running
// state. Splitting on SERVICE_NAME keeps each service's STATE with its name.
function parseDbServices(scQueryOutput) {
  const blocks = scQueryOutput.split(/(?=SERVICE_NAME:)/i);
  const out = [];
  for (const b of blocks) {
    const nm = b.match(/SERVICE_NAME:\s*(\S+)/i);
    if (!nm || !/mysql|maria/i.test(nm[1])) continue;
    out.push({ name: nm[1], running: /STATE\s*:\s*\d+\s+RUNNING/i.test(b) });
  }
  return out;
}

// Parse Get-CimInstance Win32_Service JSON (robust full enumeration, no sc-query
// pagination limits) → [{ name, running, pathName }] for mysql/maria services only.
function parseServicesJson(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const arr = Array.isArray(data) ? data : data ? [data] : [];
  return arr
    .filter((s) => s && /mysql|maria/i.test(s.Name || ""))
    .map((s) => ({
      name: s.Name,
      running: String(s.State || "").toLowerCase() === "running",
      pathName: s.PathName || "",
    }));
}

// True only when OD is configured to talk to a LOCAL database — this provisioner
// must never restart a service when OD points at a remote server.
function isLocalHost(host) {
  return ["localhost", "127.0.0.1", "::1", ".", ""].includes(
    String(host || "")
      .trim()
      .toLowerCase(),
  );
}

// Parse `sc qc <svc>` output for the mysqld/mariadbd binary path and its
// --defaults-file (my.ini). Returns { exePath, iniPath, binDir } (nulls if absent).
function parseServicePaths(scQcOutputOrPathLine) {
  const bin = scQcOutputOrPathLine.match(/BINARY_PATH_NAME\s*:\s*(.+)/i);
  // Accept either `sc qc` output (has BINARY_PATH_NAME:) or a bare binary-path line
  // (Get-CimInstance PathName).
  const rawLine = bin ? bin[1] : scQcOutputOrPathLine;
  let exePath = null;
  let iniPath = null;
  let binDir = null;
  {
    const line = rawLine.trim();
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

// True if the config already has an operator-managed init_file. The provisioner
// aborts in that case rather than override/strip someone else's startup script.
function hasInitFile(iniText) {
  return /^\s*init[_-]file\s*=/im.test(iniText);
}

// Reject anything that isn't a plain MySQL identifier — the db name is the only
// caller-influenced value that reaches the init SQL, so it must be strict.
function assertSafeDbName(db) {
  if (!/^[A-Za-z0-9_$]{1,64}$/.test(String(db || ""))) {
    throw new Error("unsafe db identifier");
  }
  return db;
}

// SELECT-only grant for both local host forms. DROP+CREATE (not CREATE IF NOT
// EXISTS) so a rerun rotates the password and clears any stale privileges on our
// dedicated account. One statement per line (init_file requirement). Never touches
// root or any non-edifi_ro account; never grants beyond the OD schema.
function buildInitSql(db, password, user = NEW_USER) {
  assertSafeDbName(db);
  return [
    `DROP USER IF EXISTS '${user}'@'localhost';`,
    `DROP USER IF EXISTS '${user}'@'127.0.0.1';`,
    `CREATE USER '${user}'@'localhost' IDENTIFIED BY '${password}';`,
    `CREATE USER '${user}'@'127.0.0.1' IDENTIFIED BY '${password}';`,
    `GRANT SELECT ON \`${db}\`.* TO '${user}'@'localhost';`,
    `GRANT SELECT ON \`${db}\`.* TO '${user}'@'127.0.0.1';`,
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
  parseDbServices,
  parseServicesJson,
  isLocalHost,
  parseServicePaths,
  injectInitFile,
  removeInitFile,
  hasInitFile,
  assertSafeDbName,
  buildInitSql,
  generatePassword,
};
