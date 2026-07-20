/**
 * Pure parse of Open Dental's FreeDentalConfig.xml → DB connection fields.
 * Shared between main.js (USE_OD_CONFIG self-provision) and tests. No I/O.
 *
 * The field names match Open Dental's config schema; several legacy aliases are
 * accepted per tag. Matching is case-insensitive. Returns "" for absent password
 * fields (never null) so callers can branch on plaintext vs. hash simply.
 */

function parseOdConfigXml(xml) {
  const get = (keys) => {
    for (const k of keys) {
      const m = xml.match(new RegExp("<" + k + ">([^<]*)<\\/" + k + ">", "i"));
      if (m && m[1].trim()) return m[1].trim();
    }
    return null;
  };
  return {
    host: get(["DatabaseServer", "ComputerName", "Server"]),
    port: get(["DatabasePort", "Port"]) || "3306",
    database: get(["Database", "DbName"]),
    user: get(["DatabaseUser", "DbUser", "User"]),
    plaintext: get(["DatabasePassword", "DbPassword", "Password"]) || "",
    passHash: get(["MySqlPassHash", "DatabasePasswordHash"]) || "",
  };
}

module.exports = { parseOdConfigXml };
