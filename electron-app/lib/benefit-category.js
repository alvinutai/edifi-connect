/**
 * OD benefit category resolution — shared between mapOdApiBenefits and tests.
 *
 * Two-layer resolution:
 *   1. catMap[CovCatNum]  — built from /covcat endpoint (EbenefitCat + description)
 *   2. EbenefitCat on the raw benefit row — fallback only when CovCatNum gives GENERAL
 *
 * Rule: a specific category from CovCatNum always wins.
 *       EbenefitCat is only consulted when the result would otherwise be GENERAL.
 */

// Benefit-row-level EbenefitCat → category name.
// This is the EbenefitCat field ON the individual benefit row, not on the covcat definition.
// Standard OD enum — consistent across all OD installations.
const BENEFIT_ROW_EBENCAT_MAP = {
  2: "PREVENTIVE",
  3: "DIAGNOSTIC",
  4: "BASIC",
  5: "ENDODONTIC",
  6: "PERIODONTIC",
  7: "ORAL_SURGERY",
  8: "PROSTHODONTIA",
  9: "CROWNS",
  11: "ORTHODONTIC",
  12: "IMPLANT",
};

/**
 * Resolve the final benefit category for one OD benefit row.
 *
 * @param {string}      catFromCovCat  Category resolved from catMap[CovCatNum] (or "GENERAL")
 * @param {number|null} ebenRaw        Raw EbenefitCat value from the OD benefit row
 * @returns {{ category: string, categorySource: string }}
 */
function resolveBenefitCategory(catFromCovCat, ebenRaw) {
  const eben = Number(ebenRaw ?? 0);
  if (catFromCovCat !== "GENERAL") {
    return { category: catFromCovCat, categorySource: "CovCatNum" };
  }
  const fromEben = BENEFIT_ROW_EBENCAT_MAP[eben];
  if (fromEben) {
    return { category: fromEben, categorySource: "EbenefitCat" };
  }
  return { category: "GENERAL", categorySource: "fallback" };
}

module.exports = { BENEFIT_ROW_EBENCAT_MAP, resolveBenefitCategory };
