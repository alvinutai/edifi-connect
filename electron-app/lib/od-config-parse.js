/**
 * Pure parse of Open Dental's FreeDentalConfig.xml text → DB connection fields.
 * Shared between main.js (USE_OD_CONFIG self-provision) and tests. No I/O.
 *
 * Hardening (no external XML dependency available in the vendored tree):
 *   - strips XML comments so commented-out/stale tags are never read
 *   - scopes extraction to the <DatabaseConnection> section when present, so a
 *     value from an unrelated section can't be picked up
 *   - decodes XML entities in values (a password may contain & < > " ')
 *   - preserves password whitespace; trims only host/db/user identifiers
 * Returns "" for absent password fields (never null) so callers branch on
 * plaintext vs. hash simply.
 */

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&"); // must be last so decoded values aren't re-decoded
}

function parseOdConfigXml(xml) {
  const noComments = xml.replace(/<!--[\s\S]*?-->/g, "");
  const section = noComments.match(
    /<DatabaseConnection>([\s\S]*?)<\/DatabaseConnection>/i,
  );
  const scope = section ? section[1] : noComments;
  const raw = (keys) => {
    for (const k of keys) {
      const m = scope.match(
        new RegExp("<" + k + ">([^<]*)<\\/" + k + ">", "i"),
      );
      if (m && m[1] !== "") return decodeEntities(m[1]);
    }
    return null;
  };
  const ident = (keys) => {
    const v = raw(keys);
    return v == null ? null : v.trim() || null;
  };
  return {
    host: ident(["DatabaseServer", "ComputerName", "Server"]),
    port: ident(["DatabasePort", "Port"]) || "3306",
    database: ident(["Database", "DbName"]),
    user: ident(["DatabaseUser", "DbUser", "User"]),
    plaintext: raw(["DatabasePassword", "DbPassword", "Password"]) || "",
    passHash: ident(["MySqlPassHash", "DatabasePasswordHash"]) || "",
  };
}

module.exports = { parseOdConfigXml };
