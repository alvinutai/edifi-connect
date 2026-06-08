// Extracts deduplicated positive-integer PatNums from OD REST appointment arrays.
// Pure function — no Electron, no network, no PHI fields read or returned.
// Input: array of arrays (one per date queried).
// Output: number[], length <= 10.

const SCHEDULED_STATUSES = new Set(["Scheduled", 1, "1"]);

function extractPatNumCandidates(aptArrays) {
  const seen = new Set();
  const candidates = [];

  for (const apts of aptArrays) {
    if (!Array.isArray(apts)) continue;
    for (const apt of apts) {
      if (candidates.length >= 10) break;
      if (!SCHEDULED_STATUSES.has(apt.AptStatus)) continue;

      const raw = apt.PatNum;
      const n =
        typeof raw === "number"
          ? raw
          : parseInt(String(raw ?? ""), 10);

      if (!Number.isInteger(n) || n <= 0) continue;
      if (seen.has(n)) continue;

      seen.add(n);
      candidates.push(n);
    }
    if (candidates.length >= 10) break;
  }

  return candidates;
}

module.exports = { extractPatNumCandidates };
