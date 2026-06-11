/**
 * Pure benefit-mapping functions extracted from mapOdApiBenefits in main.js.
 * No logging, no cache, no side effects — safe to import in tests and tools.
 *
 * Two resolution layers (mirrors main.js exactly):
 *   1. buildCatMap(covcatRows) — builds the CovCatNum → category string map
 *      from /covcat rows, using EbenefitCat then description fallback
 *   2. mapBenefits(rawBenefits, catMap) — maps raw OD benefit rows to
 *      structured entries; calls resolveBenefitCategory for each row
 */

const { resolveBenefitCategory } = require("./benefit-category");

const BEN_TYPE = {
  1: "CoInsurance",
  2: "Deductible",
  3: "Limitations",
  CoInsurance: "CoInsurance",
  Deductible: "Deductible",
  Limitations: "Limitations",
  ActiveCoverage: "CoInsurance",
};

const COV_LEVEL = {
  0: "None",
  1: "Individual",
  2: "Family",
  None: "None",
  Individual: "Individual",
  Family: "Family",
};

const TIME_PERIOD = {
  0: "None",
  1: "ServiceYear",
  2: "CalendarYear",
  3: "Lifetime",
  4: "Years2",
  5: "Years3",
  8: "Months6",
  12: "Months24",
  None: "None",
  ServiceYear: "ServiceYear",
  CalendarYear: "CalendarYear",
  Lifetime: "Lifetime",
  Years: "Years2",
  NumberInLast12Months: "Months12",
};

// Mirrors the inline default catMap used when odCovCatCache is null in main.js
const COV_CAT_NUM_DEFAULTS = {
  1: "DIAGNOSTIC",
  2: "PREVENTIVE",
  3: "BASIC",
  4: "ENDODONTIC",
  5: "PERIODONTIC",
  6: "ORAL_SURGERY",
  7: "PROSTHODONTIA",
  8: "IMPLANT",
  9: "ORTHODONTIC",
  10: "PREVENTIVE",
  11: "GENERAL",
  12: "MAJOR",
};

/**
 * Build a CovCatNum → category-string map from an array of /covcat rows.
 * Mirrors the map-building loop inside getOdCovCats() in main.js.
 * Returns COV_CAT_NUM_DEFAULTS if covcatRows is empty or falsy.
 *
 * @param {Array<{CovCatNum: number, Description: string, EbenefitCat?: number}>} covcatRows
 * @returns {Object.<number, string>}
 */
function buildCatMap(covcatRows) {
  if (!Array.isArray(covcatRows) || covcatRows.length === 0) {
    return { ...COV_CAT_NUM_DEFAULTS };
  }
  const map = {};
  for (const c of covcatRows) {
    const eben = Number(c.EbenefitCat ?? 0);
    const desc = (c.Description || "").toUpperCase();
    let cat = "GENERAL";
    if (eben === 2) cat = "PREVENTIVE";
    else if (eben === 3) cat = "DIAGNOSTIC";
    else if (eben === 4) cat = "BASIC";
    else if (eben === 5) cat = "ENDODONTIC";
    else if (eben === 6) cat = "PERIODONTIC";
    else if (eben === 7) cat = "ORAL_SURGERY";
    else if (eben === 8) cat = "PROSTHODONTIA";
    else if (eben === 9) cat = "CROWNS";
    else if (eben === 11) cat = "ORTHODONTIC";
    else if (eben === 12) cat = "IMPLANT";
    else if (desc === "DIAGNOSTIC" || desc.includes("DIAGN"))
      cat = "DIAGNOSTIC";
    else if (
      desc === "X-RAY" ||
      desc.includes("X-RAY") ||
      desc.includes("XRAY") ||
      desc.includes("RADIOGRAPH")
    )
      cat = "X_RAY";
    else if (desc === "PREVENTIVE" || desc.includes("PREVENT"))
      cat = "PREVENTIVE";
    else if (
      desc === "RESTORATIVE" ||
      desc.includes("RESTOR") ||
      desc === "BASIC"
    )
      cat = "BASIC";
    else if (desc === "ENDO" || desc.includes("ENDO")) cat = "ENDODONTIC";
    else if (
      desc === "PERIO" ||
      desc.startsWith("D4346") ||
      desc.includes("PERIO") ||
      desc.includes("SCALING") ||
      desc.includes("INFLAM") ||
      desc.includes("SRP")
    )
      cat = "PERIODONTIC";
    else if (
      desc === "ORAL SURGERY" ||
      desc.includes("ORAL") ||
      desc.includes("SURGERY")
    )
      cat = "ORAL_SURGERY";
    else if (desc === "CROWNS" || desc === "CROWN") cat = "CROWNS";
    else if (
      desc === "PROSTH" ||
      desc === "PROSTHODONTICS" ||
      desc.includes("PROSTHO") ||
      desc.includes("BRIDGE")
    )
      cat = "PROSTHODONTIA";
    else if (desc === "IMPLANT" || desc.includes("IMPLANT")) cat = "IMPLANT";
    else if (
      desc === "BU" ||
      desc === "BUILDUPS" ||
      desc.includes("BUILDUP") ||
      desc.includes("BUILD UP")
    )
      cat = "BUILDUPS";
    else if (
      desc === "PULP CAP" ||
      desc === "PULP_CAP" ||
      (desc.includes("PULP") && desc.includes("CAP"))
    )
      cat = "PULP_CAP";
    else if (desc === "ONLAY" || desc === "ONLAYS" || desc.includes("ONLAY"))
      cat = "ONLAYS";
    else if (
      desc === "NG" ||
      desc.includes("NIGHT GUARD") ||
      desc.includes("NIGHTGUARD") ||
      desc.includes("OCCLUSAL GUARD")
    )
      cat = "NIGHT_GUARD";
    else if (desc === "ARESTIN" || desc.includes("ARESTIN")) cat = "ARESTIN";
    else if (desc === "MAJOR" || desc.includes("MAJOR")) cat = "MAJOR";
    else if (desc === "ORTHODONTIC" || desc.includes("ORTHO"))
      cat = "ORTHODONTIC";
    else if (desc.includes("FLUORIDE")) cat = "FLUORIDE";
    else if (desc.includes("SEALANT")) cat = "SEALANTS";
    else if (desc.includes("EXAM")) cat = "EXAM";
    else if (desc.includes("PROPHY") || desc.includes("CLEANING"))
      cat = "PROPHY";
    else if (desc.includes("WAIT")) cat = "WAITING_PERIOD";
    else if (desc.includes("ANESTHESIA")) cat = "ANESTHESIA";
    else if (desc.includes("EMERGENCY")) cat = "EMERGENCY";
    else if (desc.includes("DENTURE")) cat = "DENTURES";
    else if (desc.includes("MAXILLOFACIAL") || desc.includes("ACCIDENT"))
      cat = "ACCIDENT";
    else if (desc) {
      const cleaned = desc
        .replace(/[_-]+/g, " ")
        .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
        .replace(/\s+/g, "_")
        .replace(/^_|_$/g, "")
        .substring(0, 40);
      cat = cleaned || "GENERAL";
    }
    map[c.CovCatNum] = cat;
  }
  return map;
}

/**
 * Map raw OD benefit rows to structured entries.
 * Mirrors mapOdApiBenefits() in main.js exactly, minus logging and caches.
 * Adds `ebenefitcat` and `category_source` fields (present in v2.3.64 production too).
 * Phase 6D-1 adds `code_num` and `proc_code` — additive, null-safe, no PHI.
 *
 * @param {Array<Object>} rawBenefits  Raw rows from OD /benefits endpoint or MySQL
 * @param {Object}        catMap       Built by buildCatMap(); falls back to COV_CAT_NUM_DEFAULTS
 * @param {Object|null}   procCodeMap  Optional CodeNum → CDT-code-string map. Missing
 *                                     map or missing entry never drops a row — proc_code
 *                                     stays null and code_num is still forwarded.
 * @returns {Array}  Filtered, annotated benefit entries with _raw_received/_dropped/_dropped_reasons
 */
function mapBenefits(rawBenefits, catMap, procCodeMap) {
  const resolvedCatMap = catMap || COV_CAT_NUM_DEFAULTS;
  const results = [];
  const dropped_reasons = {};

  for (const b of rawBenefits) {
    const type = BEN_TYPE[b.BenefitType];
    if (!type) {
      const key = `type_${b.BenefitType}_unmapped`;
      dropped_reasons[key] = (dropped_reasons[key] || 0) + 1;
      continue;
    }
    const catFromCovCat = resolvedCatMap[b.CovCatNum] || "GENERAL";
    const { category, categorySource } = resolveBenefitCategory(
      catFromCovCat,
      b.EbenefitCat,
    );
    const coverage_level = COV_LEVEL[b.CoverageLevel] || "None";
    const code_num = Number(b.CodeNum) || null;

    const entry = {
      type,
      category,
      coverage_level,
      benefit_num: b.BenefitNum ?? null,
      cov_cat_num: Number(b.CovCatNum) || 0,
      ebenefitcat: Number(b.EbenefitCat ?? 0) || null,
      category_source: categorySource,
      plan_num: Number(b.PlanNum) || 0,
      pat_plan_num: Number(b.PatPlanNum) || 0,
      code_num,
      proc_code:
        (code_num != null &&
          procCodeMap != null &&
          typeof procCodeMap[code_num] === "string" &&
          procCodeMap[code_num]) ||
        null,
    };

    if (type === "CoInsurance") {
      entry.percent = Number(b.Percent);
    } else if (type === "Deductible") {
      entry.amount_cents =
        b.MonetaryAmt != null ? Math.round(Number(b.MonetaryAmt) * 100) : null;
    } else if (type === "Limitations") {
      if (b.Quantity != null) {
        entry.quantity = b.Quantity;
        entry.period = TIME_PERIOD[b.TimePeriod] || "None";
      }
      if (b.MonetaryAmt != null && Number(b.MonetaryAmt) > 0) {
        entry.amount_cents = Math.round(Number(b.MonetaryAmt) * 100);
      }
    }
    results.push(entry);
  }

  const filtered = results.filter((b) => {
    if (b.type === "CoInsurance") return b.percent > 0;
    if (b.type === "Deductible") return b.amount_cents != null;
    if (b.type === "Limitations")
      return b.quantity != null || b.amount_cents != null;
    return true;
  });

  filtered._raw_received = rawBenefits.length;
  filtered._dropped = rawBenefits.length - filtered.length;
  filtered._dropped_reasons = dropped_reasons;

  return filtered;
}

module.exports = {
  BEN_TYPE,
  COV_LEVEL,
  TIME_PERIOD,
  COV_CAT_NUM_DEFAULTS,
  buildCatMap,
  mapBenefits,
};
