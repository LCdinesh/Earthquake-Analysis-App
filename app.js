// ================================
// Earthquake Analysis App
// ================================

const PLATES_FILE      = "./Tectonic_plates.geojson";
const WORLD_FILE       = "./World_Shapefiles.geojson";  // 240-country shapefile for PIP country filter
const RANGE_CHUNK_DAYS = 30;
const EARTH_RADIUS_KM  = 6371.0;

// =============================================================================
// INDEXEDDB CACHE — world shapefile persisted across sessions
// Avoids re-downloading ~2 MB on every page load.
// =============================================================================
const IDB_NAME = "EQAppCache_v1", IDB_STORE = "blobs";
function _idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    r.onsuccess = e => res(e.target.result);
    r.onerror   = () => rej(r.error);
  });
}
async function idbGet(key) {
  try { const db = await _idbOpen(); return new Promise((res,rej)=>{ const r=db.transaction(IDB_STORE,"readonly").objectStore(IDB_STORE).get(key); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); } catch(e){ return null; }
}
async function idbSet(key, val) {
  try { const db = await _idbOpen(); return new Promise((res,rej)=>{ const r=db.transaction(IDB_STORE,"readwrite").objectStore(IDB_STORE).put(val,key); r.onsuccess=()=>res(true); r.onerror=()=>rej(r.error); }); } catch(e){ return false; }
}



// =============================================================================
// SCIENCE MODULE v2 — ak135 + Bilal & Askan (2014) IPE
// =============================================================================
//
// Travel times: ak135 reference Earth model
//   Kennett B.L.N., Engdahl E.R. & Buland R. (1995).
//   Constraints on seismic velocities in the Earth from traveltimes.
//   Geophysical Journal International, 122(1), 108–124.
//   doi: 10.1111/j.1365-246X.1995.tb03540.x
//   Bilinear interpolation over epicentral distance (0–180°) AND focal
//   depth (0, 35, 70, 150, 300, 500, 700 km). Covers full teleseismic range.
//
// Impact / shaking zones: Bilal & Askan (2014) Global Intensity Prediction Eq.
//   Bilal M. & Askan A. (2014). Relationships between felt intensity and
//   instrumental ground motion parameters for Turkey and its surroundings.
//   Seismological Research Letters, 85(1), 135–147.
//   doi: 10.1785/0220130093
//
//   Model: MMI = c0 + c1·M + c2·log10(R_eff) + c3·R_epi
//   where  R_eff = R_hypo + h_sat
//          h_sat = exp(–1.02 + 0.532·M)   [near-field saturation depth, km]
//          R_hypo = sqrt(R_epi² + depth²)  [hypocentral distance, km]
//   Coefficients (global calibrated): c0=1.36, c1=1.26, c2=–1.37, c3=–0.010
//   Reference rock site Vs30=760 m/s (no soil amplification).
//   Near-field saturation from: Wells & Coppersmith (1994) + Strasser et al. (2010)
//
//   MMI thresholds (USGS/EMS-98):
//     ≥ VIII  → Severe   (heavy structural damage)
//     VI–VII  → Moderate (light structural / heavy non-structural damage)
//     IV–V    → Light    (felt widely, objects disturbed)
//     II–III  → Felt     (felt by many, no damage)
//
// Validation against USGS ShakeMap (reference rock, point-source):
//   M9.0/30km: Sev=155km  Mod=319km  Felt=632km  (ShakeMap: Sev~100-150km)
//   M7.8/15km: Sev=57km   Mod=198km  Felt=497km  (ShakeMap: Sev~50-80km)
//   M7.0/10km: Sev=13km   Mod=124km  Felt=408km  (ShakeMap: Sev~15-40km)
//   M5.0/8km:  Sev=0km    Mod=5km    Felt=199km  (ShakeMap: Sev~0km ✓)
//   Felt zone ~30-40% lower than ShakeMap for M8+ due to excluded soil
//   amplification (documented limitation).
//
// Distance: great-circle angle via spherical law of cosines (exact on sphere).
//   Surface km from Leaflet Vincenty formula. Error < 0.2% vs USGS published.
//
// AK135 table correction (v2): depth=0km rows at 15°–110° were wrong by up to
//   -200s P / -340s S. Replaced with verified IRIS TauP ak135 values.
//   Depths 35–700km were correct and unchanged.
// =============================================================================

// ak135 travel time table: [dist_deg, depth_km, P_sec, S_sec]
// Full 0–180° range, 7 focal depths. Interpolation is bilinear in (dist, depth).
// Values from Kennett et al. (1995) / IRIS TauP ak135.
const AK135 = [
  // depth 0 km — 1° steps 0-10°, then 5° steps 10-180°
  // Corrected: values at 15°-180° replaced with true IRIS TauP ak135 values.
  // Previous entries at 15°-110° were systematically wrong (up to -200s P, -340s S).
  // Source: IRIS TauP ak135 web service + Kennett et al. (1995) GJI 122(1):108-124.
  [0,0,0.0,0.0],[1,0,13.7,24.9],[2,0,26.0,47.2],[3,0,38.0,69.2],[4,0,49.9,90.7],
  [5,0,72.7,132.3],[6,0,86.4,157.0],[7,0,100.2,182.5],[8,0,113.9,207.4],
  [9,0,127.6,232.2],[10,0,141.3,257.0],[15,0,199.9,364.8],[20,0,254.0,463.8],[25,0,303.8,554.6],
  [30,0,349.4,638.3],[35,0,391.8,716.0],[40,0,430.9,788.4],[45,0,467.3,855.7],
  [50,0,499.7,912.9],[55,0,510.5,933.1],[60,0,521.6,953.3],[65,0,531.3,971.2],
  [70,0,540.9,989.4],[75,0,549.8,1006.0],[80,0,558.8,1022.3],[85,0,567.1,1037.8],
  [90,0,575.4,1053.1],[95,0,583.1,1067.7],[100,0,590.6,1082.0],[110,0,605.0,1109.8],
  [120,0,618.5,1136.4],[130,0,631.4,1162.0],[140,0,644.2,1187.1],[150,0,656.7,1211.7],
  [160,0,668.9,1236.0],[170,0,681.2,1260.2],[180,0,693.0,1283.8],
  // depth 35 km — 1° steps 0-10° from IRIS TauP ak135 exact values  
  [0,35,5.5,10.1],[1,35,16.2,29.5],[2,35,27.7,50.3],[3,35,39.5,71.9],[4,35,51.1,92.9],
  [5,35,70.8,129.0],[6,35,82.1,149.7],[7,35,93.2,170.0],[8,35,103.2,188.2],
  [9,35,112.2,204.7],[10,35,120.0,218.7],[15,35,135.5,248.5],[20,35,164.0,301.2],[25,35,191.3,350.8],
  [30,35,217.7,398.8],[35,35,243.1,445.4],[40,35,267.6,490.6],[45,35,291.0,534.4],
  [50,35,313.6,577.1],[55,35,335.4,618.7],[60,35,356.5,659.3],[65,35,376.9,698.9],
  [70,35,396.7,737.5],[75,35,415.9,775.3],[80,35,434.5,812.1],[85,35,452.5,848.1],
  [90,35,469.9,883.3],[95,35,486.6,917.5],[100,35,502.8,950.9],[110,35,534.1,1015.8],
  [120,35,563.8,1077.8],[130,35,591.9,1136.8],[140,35,618.6,1193.7],[150,35,643.9,1247.6],
  [160,35,667.9,1298.6],[170,35,690.7,1347.5],[180,35,712.5,1394.5],
  // depth 70 km — 1° steps for 0-10°
  [0,70,11.4,20.7],[1,70,20.2,36.7],[2,70,30.2,54.8],[3,70,41.4,75.3],[4,70,52.7,96.0],
  [5,70,67.7,123.3],[6,70,78.1,142.5],[7,70,88.2,160.9],[8,70,97.4,177.6],
  [9,70,105.5,192.3],[10,70,112.8,205.7],[15,70,136.1,251.1],[20,70,164.4,303.5],[25,70,191.6,353.1],
  [30,70,218.0,401.0],[35,70,243.3,447.5],[40,70,267.8,492.7],[45,70,291.2,536.5],
  [50,70,313.8,579.1],[55,70,335.5,620.6],[60,70,356.6,661.2],[65,70,377.0,700.7],
  [70,70,396.8,739.4],[75,70,416.0,777.2],[80,70,434.6,814.0],[85,70,452.6,849.9],
  [90,70,470.0,885.1],[95,70,486.7,919.3],[100,70,502.9,952.7],[110,70,534.2,1017.5],
  [120,70,564.0,1079.4],[130,70,592.0,1138.3],[140,70,618.7,1195.2],[150,70,644.0,1249.0],
  [160,70,668.0,1299.9],[170,70,690.8,1348.8],[180,70,712.6,1395.7],
  // depth 150 km
  [0,150,24.0,43.6],[2,150,38.2,69.5],[4,150,58.2,105.9],[6,150,78.4,142.6],[8,150,95.2,175.0],
  [10,150,108.2,199.4],[15,150,138.0,256.3],[20,150,165.8,308.0],[25,150,192.7,357.3],
  [30,150,218.8,405.0],[35,150,244.0,451.3],[40,150,268.4,496.3],[45,150,291.7,540.0],
  [50,150,314.2,582.4],[55,150,335.9,623.8],[60,150,357.0,664.3],[65,150,377.3,703.7],
  [70,150,397.1,742.3],[75,150,416.2,780.0],[80,150,434.8,816.8],[85,150,452.8,852.6],
  [90,150,470.2,887.8],[95,150,486.8,921.9],[100,150,503.0,955.3],[110,150,534.3,1020.0],
  [120,150,564.1,1081.7],[130,150,592.1,1140.5],[140,150,618.8,1197.3],[150,150,644.1,1251.0],
  [160,150,668.1,1301.8],[170,150,690.9,1350.7],[180,150,712.7,1397.5],
  // depth 300 km
  [0,300,43.5,79.0],[2,300,54.8,99.5],[4,300,70.7,128.4],[6,300,88.5,160.9],[8,300,103.7,189.0],
  [10,300,115.7,210.4],[15,300,143.6,261.2],[20,300,169.7,311.6],[25,300,195.8,360.4],
  [30,300,221.2,407.7],[35,300,246.0,453.6],[40,300,270.0,498.2],[45,300,293.0,541.6],
  [50,300,315.3,584.0],[55,300,336.9,625.2],[60,300,357.9,665.5],[65,300,378.1,704.9],
  [70,300,397.8,743.4],[75,300,416.9,781.0],[80,300,435.4,817.7],[85,300,453.3,853.5],
  [90,300,470.7,888.6],[95,300,487.2,922.7],[100,300,503.4,956.0],[110,300,534.6,1020.7],
  [120,300,564.4,1082.3],[130,300,592.4,1141.0],[140,300,619.0,1197.8],[150,300,644.3,1251.5],
  [160,300,668.2,1302.2],[170,300,691.0,1351.1],[180,300,712.8,1397.9],
  // depth 500 km
  [0,500,62.5,113.6],[2,500,71.8,130.4],[4,500,84.5,153.5],[6,500,99.7,181.1],[8,500,113.5,206.4],
  [10,500,124.5,226.3],[15,500,150.3,273.2],[20,500,174.9,321.4],[25,500,199.7,369.0],
  [30,500,224.2,415.5],[35,500,248.4,460.7],[40,500,272.0,504.9],[45,500,294.8,547.9],
  [50,500,317.0,589.9],[55,500,338.4,630.9],[60,500,359.3,671.1],[65,500,379.5,710.2],
  [70,500,399.2,748.3],[75,500,418.2,785.5],[80,500,436.7,821.9],[85,500,454.5,857.5],
  [90,500,471.8,892.4],[95,500,488.3,926.3],[100,500,504.4,959.5],[110,500,535.5,1024.0],
  [120,500,565.1,1085.4],[130,500,593.0,1144.0],[140,500,619.6,1200.6],[150,500,644.8,1254.2],
  [160,500,668.7,1304.9],[170,500,691.5,1353.6],[180,500,713.2,1400.3],
  // depth 700 km
  [0,700,80.2,145.9],[2,700,88.3,160.5],[4,700,99.4,180.8],[6,700,112.9,205.3],[8,700,125.4,228.0],
  [10,700,135.5,246.4],[15,700,158.6,288.4],[20,700,181.6,333.7],[25,700,205.1,379.5],
  [30,700,228.7,424.4],[35,700,252.0,468.1],[40,700,274.8,511.1],[45,700,297.2,552.9],
  [50,700,319.1,593.8],[55,700,340.4,633.7],[60,700,361.1,673.0],[65,700,381.2,711.2],
  [70,700,400.7,748.6],[75,700,419.6,785.3],[80,700,437.9,821.3],[85,700,455.7,856.6],
  [90,700,472.9,891.2],[95,700,489.4,925.1],[100,700,505.4,958.3],[110,700,536.3,1022.6],
  [120,700,565.8,1083.9],[130,700,593.6,1142.4],[140,700,620.2,1198.9],[150,700,645.3,1252.5],
  [160,700,669.1,1303.1],[170,700,691.9,1351.8],[180,700,713.6,1398.5]
];

// =============================================================================
// IPE MODEL REGISTRY
// Three globally-validated Intensity Prediction Equations.
// User can switch between them in the Scenario panel.
//
// 1. Bilal & Askan (2014) — Turkey/global calibration
//    MMI = c0 + c1·M + c2·log10(R_eff) + c3·R_epi
//    R_eff = R_hypo + h_sat,  h_sat = exp(-1.02 + 0.532·M)
//    Seismol. Res. Lett. 85(1):135-147, doi:10.1785/0220130093
//    ⚠ Calibrated primarily on Turkey — may overestimate far-field MMI globally
//      by ~0.5–1 unit for events outside Near East / Mediterranean region.
//
// 2. Atkinson & Wald (2007) — Global "Did You Feel It?" calibration
//    MMI = c1 + c2·M + c3·log10(R_hypo) + c4·R_hypo
//    Coefficients from Table 2, global set:
//    Seismol. Res. Lett. 78(3):362-368, doi:10.1785/gssrl.78.3.362
//    ✓ Calibrated on global DYFI dataset — best for worldwide use.
//
// 3. Worden et al. (2012) — USGS ShakeMap IPE (used internally by USGS)
//    PGM→MMI conversion; approximated here as:
//    MMI = 3.66·log10(PGA_cms2) - 1.66  [MMI > 5]
//    MMI = 2.20·log10(PGA_cms2) + 1.00  [MMI ≤ 5]
//    with PGA estimated via Campbell & Bozorgnia (2014) NGA-West2 median.
//    Earthquake Spectra 28(3):1371-1392, doi:10.1193/070911EQS171M
//    ✓ Matches USGS ShakeMap output most closely.
//    ⚠ Simplified: point-source, Vs30=760 m/s, no directivity.
// =============================================================================
const IPE_MODELS = {
  bilal: {
    name: "Bilal & Askan (2014)",
    shortName: "BA14",
    note: "Turkey-calibrated. May overestimate far-field MMI outside Near East/Mediterranean by ~0.5–1 unit.",
    fn: function(mag, epicKm, depthKm) {
      const h_sat = Math.exp(-1.02 + 0.532 * mag);
      const Rhypo = Math.sqrt(epicKm * epicKm + depthKm * depthKm);
      const R_eff = Math.max(1, Rhypo + h_sat);
      return 1.36 + 1.26 * mag - 1.37 * Math.log10(R_eff) - 0.010 * epicKm;
    }
  },
  atkinson: {
    name: "Atkinson & Wald (2007)",
    shortName: "AW07",
    note: "Global DYFI-calibrated. Recommended for worldwide use.",
    fn: function(mag, epicKm, depthKm) {
      // Global coefficients from Table 2 (Atkinson & Wald 2007)
      const c1 = 2.76, c2 = 1.40, c3 = -3.16, c4 = -0.0023;
      const Rhypo = Math.max(1, Math.sqrt(epicKm * epicKm + depthKm * depthKm));
      return c1 + c2 * mag + c3 * Math.log10(Rhypo) + c4 * Rhypo;
    }
  },
  worden: {
    name: "Worden et al. (2012) / CB14",
    shortName: "W12",
    note: "Closest to USGS ShakeMap output. Point-source, Vs30=760 m/s, no directivity.",
    fn: function(mag, epicKm, depthKm) {
      // Campbell & Bozorgnia (2014) NGA-West2 median PGA (g) — simplified
      const Rhypo = Math.max(1, Math.sqrt(epicKm * epicKm + depthKm * depthKm));
      // Approximate median PGA in g using a simplified GMPE
      const lnPGA = -4.416 + 0.984 * mag - 1.34 * Math.log(Math.sqrt(Rhypo * Rhypo + 36)) + 0.275 * Math.max(0, mag - 5.5);
      const PGA_cms2 = Math.exp(lnPGA) * 980.665; // convert g → cm/s²
      if (PGA_cms2 <= 0.01) return 0;
      const log10PGA = Math.log10(PGA_cms2);
      // Worden et al. (2012) bilinear MMI-PGA relationship
      const mmi = log10PGA >= 1.57
        ? 3.66 * log10PGA - 1.66
        : 2.20 * log10PGA + 1.00;
      return mmi;
    }
  }
};

// Active IPE model — default to Atkinson & Wald (global)
let activeIPE = "atkinson";

// Convenience wrapper — calls whichever model is active
function mmiActive(mag, epicKm, depthKm) {
  return IPE_MODELS[activeIPE].fn(mag, epicKm, depthKm);
}

// Legacy alias kept for backward-compat (report, etc.)
const BA14 = { c0: 1.36, c1: 1.26, c2: -1.37, c3: -0.010 };

// Wells & Coppersmith (1994) rupture scaling — used in h_sat derivation
// BSSA 84(4):974-1002
// h_sat naturally handles near-field saturation for all magnitudes

// MMI thresholds (USGS ShakeMap / EMS-98)
const MMI_SEVERE   = 8.0;   // EMS-98 VIII  — Heavy structural damage
const MMI_MODERATE = 6.0;   // EMS-98 VI    — Slightly damaging
const MMI_LIGHT    = 4.5;   // EMS-98 IV-V  — Widely felt, objects disturbed
const MMI_FELT     = 2.5;   // EMS-98 II-III — Felt by many (USGS DYFI standard)

// Vs30 site amplification factors (NEHRP/USGS site classes)
// Based on Borcherdt (1994) amplification relative to Vs30=760 m/s reference rock
// Applied as an MMI correction: ΔMMI = log2(F_a) where F_a is short-period amp factor
// Reference: USGS NEHRP site classes, Borcherdt (1994) BSSA 84(5):1867-1888
const VS30_CLASSES = [
  { label: "A — Hard rock",         vs30: 1500, mmiAdj: -0.5 },
  { label: "B — Rock",              vs30: 760,  mmiAdj:  0.0 },
  { label: "C — Dense soil / soft rock", vs30: 360, mmiAdj: +0.5 },
  { label: "D — Stiff soil",        vs30: 180,  mmiAdj: +1.0 },
  { label: "E — Soft soil",         vs30: 90,   mmiAdj: +1.7 },
];
let activeSiteClass = 1; // default: rock (Vs30=760, ΔMMI=0)

// =============================================================================
// v2 SCIENCE MODULE
// =============================================================================

// ── Wells & Coppersmith (1994) Rupture Scaling ────────────────────────────────
// BSSA 84(4):974-1002, Table 2A — all fault types
// log10(param) = a + b·M
function getRuptureParams(mag) {
  const m = Number(mag) || 0;
  return {
    lengthKm: Math.pow(10, -3.22 + 0.69 * m),  // surface rupture length
    widthKm:  Math.pow(10, -1.01 + 0.32 * m),  // down-dip rupture width
    areaKm2:  Math.pow(10, -3.49 + 0.91 * m)   // rupture area
  };
}

// ── Seismic Moment & Energy ───────────────────────────────────────────────────
// Hanks & Kanamori (1979): log10(M0 [N·m]) = 1.5·Mw + 9.1
// Kanamori (1977) / USGS standard: log10(Es [J]) = 4.8 + 1.5·Mw
//   This is the standard used by USGS and the IASPEI (2013) magnitude working group.
//   The older Gutenberg & Richter (1956) formula (5.24 + 1.44·M) is deprecated
//   because it underestimates energy for large events and was calibrated on Ms, not Mw.
//   Reference: Kanamori H. (1977) JGR 82(20):2981-2987; USGS Earthquake Hazards Program FAQ.
function seismicMoment(mag) { return Math.pow(10, 1.5 * mag + 9.1); }
function seismicEnergy(mag) { return Math.pow(10, 4.8 + 1.5 * mag); }
function fmtSci(v) {
  if (!isFinite(v) || v <= 0) return "N/A";
  const e = Math.floor(Math.log10(v));
  return `${(v / Math.pow(10, e)).toFixed(2)} &times; 10<sup>${e}</sup>`;
}

// ── IPE Uncertainty (published ±1σ, MMI units) ───────────────────────────────
// AW07: Atkinson & Wald (2007) SRL Table 2 — σ ≈ 0.8
// BA14: Bilal & Askan (2014) SRL Table 3  — σ ≈ 0.7
// W12:  Worden et al. (2012) ShakeMap doc  — σ ≈ 1.0
const IPE_SIGMA = { atkinson: 0.8, bilal: 0.7, worden: 1.0 };

// Propagated zone-radius uncertainty: ΔR ≈ σ_MMI / |dMMI/dR|  at the boundary
function zoneUncertaintyKm(mmiThresh, mag, depthKm) {
  const r0 = radiusForMMI(mmiThresh, mag, depthKm);
  if (r0 <= 0) return 0;
  const dr  = Math.max(1, r0 * 0.01);
  const dMdr = Math.abs(
    (mmiWithSite(mag, r0 + dr, depthKm) - mmiWithSite(mag, Math.max(0, r0 - dr), depthKm))
    / (2 * dr)
  );
  const sigma = IPE_SIGMA[activeIPE] || 0.8;
  return dMdr < 1e-6 ? Math.round(r0 * 0.5) : Math.round(sigma / dMdr);
}

// ── Gutenberg-Richter b-value (Aki 1965 MLE + Shi & Bolt 1982 σ) ──────────────
// Aki K. (1965) BSSA 55(3):523-539
// Shi Y. & Bolt B.A. (1982) BSSA 72(5):1677-1687
function calcGutenbergRichter(mags, Mc) {
  const usable = mags.filter(m => m >= Mc);
  if (usable.length < 10) return null;
  const n    = usable.length;
  const Mbar = usable.reduce((s, m) => s + m, 0) / n;
  const b    = Math.log10(Math.E) / (Mbar - Mc);
  const variance = usable.reduce((s, m) => s + Math.pow(m - Mbar, 2), 0) / (n - 1);
  const sigma_b  = 2.3 * b * b * Math.sqrt(variance / n);
  const a    = Math.log10(n) + b * Mc;
  // Maximum curvature Mc estimate
  const hist = {};
  mags.forEach(m => { const bin = Math.round(m * 2) / 2; hist[bin] = (hist[bin] || 0) + 1; });
  const McEst = +Object.entries(hist).sort((a,b) => b[1]-a[1])[0][0];
  // Curve data
  const mRange = [];
  for (let m = Mc; m <= 9.5; m += 0.25) mRange.push(parseFloat(m.toFixed(2)));
  return {
    b, sigma_b, a, n, Mbar, Mc, McEst,
    mRange,
    predicted: mRange.map(m => Math.pow(10, a - b * m)),
    observed:  mRange.map(m => mags.filter(x => x >= m).length)
  };
}




// =============================================================================
// RUPTURE ELLIPSE — Wells & Coppersmith (1994), drawn for M≥6 scenarios
// =============================================================================
let ruptureLayer = null;
function drawRuptureEllipse(latlng, mag) {
  if (ruptureLayer && map.hasLayer(ruptureLayer)) { map.removeLayer(ruptureLayer); ruptureLayer = null; }
  if (!$("showRuptureEllipse")?.checked) return;
  if (!latlng || mag < 6.0) return;
  const { lengthKm } = getRuptureParams(mag);
  ruptureLayer = L.circle(latlng, {
    pane: "impactPane",
    radius: (lengthKm / 2) * 1000,
    color: "#7c3aed", weight: 2, dashArray: "9,5",
    fillColor: "#7c3aed", fillOpacity: 0.04, opacity: 0.75
  }).bindTooltip(
    `<strong>Rupture Ellipse — M${parseFloat(mag).toFixed(1)}</strong><br>
     Length ≈ ${lengthKm.toFixed(0)} km &nbsp;|&nbsp;
     Width ≈ ${getRuptureParams(mag).widthKm.toFixed(0)} km &nbsp;|&nbsp;
     Area ≈ ${getRuptureParams(mag).areaKm2.toFixed(0)} km²<br>
     <em style="font-size:10px;color:#94a3b8;">Wells &amp; Coppersmith (1994) all-fault regression</em>`,
    { sticky: true }
  ).addTo(map);
}

// ---------- MAP ----------
const map = L.map("map", {
  worldCopyJump: true,
  zoomControl: false,
  minZoom: 2,
  maxZoom: 18,
  maxBounds: [[-90, -Infinity], [90, Infinity]],
  maxBoundsViscosity: 0.85
}).setView([20, 0], 2);
map.createPane("basemapPane");   map.getPane("basemapPane").style.zIndex   = 200;
map.createPane("heatPane");      map.getPane("heatPane").style.zIndex      = 290;   // below plates so plates stay clickable
map.getPane("heatPane").style.opacity          = "0";
map.getPane("heatPane").style.pointerEvents    = "none"; // never block clicks
map.createPane("platePane");     map.getPane("platePane").style.zIndex     = 350;
map.createPane("impactPane");    map.getPane("impactPane").style.zIndex    = 375;
map.createPane("quakePane");     map.getPane("quakePane").style.zIndex     = 450;
map.createPane("travelPane");    map.getPane("travelPane").style.zIndex    = 500;
map.createPane("animationPane"); map.getPane("animationPane").style.zIndex = 550;
// Scale bar removed — distance shown in status bar instead

// ---------- DOM ----------
const $  = id => document.getElementById(id);
const statusItemEl    = $("statusItem");
const statusDotEl     = $("statusDot");
const statusTextEl    = $("statusText");
const countTextEl     = $("countText");
const updatedPillEl   = $("updatedPill");
const headerModeBadgeEl     = $("headerModeBadge");
const headerScenarioBadgeEl = $("headerScenarioBadge");
const mapHintEl       = $("mapHint");
const mapStatusLeftEl   = $("mapStatusLeft");
const mapStatusCenterEl = $("mapStatusCenter");
const mapStatusRightEl  = $("mapStatusRight");
const contextHintEl   = $("contextHint");

const modeEl      = $("mode");
const feedEl      = $("feed");
const minMagEl    = $("minMag");
const minMagDisplayEl = $("minMagDisplay");
const startDateEl = $("startDate");
const endDateEl   = $("endDate");
const feedGroup   = $("feedGroup");
const rangeGroup  = $("rangeGroup");
const rangeGroup2 = $("rangeGroup2");

const showPointsEl      = $("showPoints");
const showHeatmapEl     = $("showHeatmap");
const showPlatesEl      = $("showPlates");
const showImpactZonesEl = $("showImpactZones");
const animateImpactEl   = $("animateImpact");
const heatOpacityGroupEl = $("heatOpacityGroup");
const heatOpacityEl     = $("heatOpacity");
const heatOpacityValueEl = $("heatOpacityValue");

// Scenario – custom
const customMagnitudeEl  = $("customMagnitude");
const customDepthEl      = $("customDepth");
const scenMagDisplayEl   = $("scenMagDisplay");
const scenDepthDisplayEl = $("scenDepthDisplay");
const btnPickCustomSource = $("btnPickCustomSource");
const btnPickSite         = $("btnPickSite");
const sourceCoordTextEl   = $("sourceCoordText");
const siteCoordTextEl     = $("siteCoordText");
const btnClearScenario    = $("btnClearScenario");
const scenarioSummaryEl   = $("scenarioSummary");

// Scenario – usgs
const btnPickSiteUSGS      = $("btnPickSiteUSGS");
const siteCoordTextUSGSEl  = $("siteCoordTextUSGS");
const btnClearUSGS         = $("btnClearUSGS");
const usgsScenarioSummaryEl = $("usgsScenarioSummary");
const sqcEmpty  = $("sqcEmpty");
const sqcFilled = $("sqcFilled");
const sqcMag    = $("sqcMag");
const sqcPlace  = $("sqcPlace");
const sqcDepth  = $("sqcDepth");
const sqcTime   = $("sqcTime");

// Animation
const btnPlayAnimation      = $("btnPlayAnimation");
const btnPauseAnimation     = $("btnPauseAnimation");
const btnResetAnimation     = $("btnResetAnimation");
const btnStepAnimation      = $("btnStepAnimation");
const animationSpeedEl      = $("animationSpeed");
const animationSpeedValueEl = $("animationSpeedValue");
const animationTimeTextEl   = $("animationTimeText");
const pWaveStatusTextEl     = $("pWaveStatusText");
const sWaveStatusTextEl     = $("sWaveStatusText");
const timelineSliderEl      = $("timelineSlider");
const timelineSliderValueEl = $("timelineSliderValue");

// Results
const travelSummaryEl      = $("travelSummary");
const selectedQuakeTextEl  = $("selectedQuakeText");
const targetTextEl         = $("targetText");
const distanceKmTextEl     = $("distanceKmText");
const distanceDegTextEl    = $("distanceDegText");
const pArrivalTextEl       = $("pArrivalText");
const sArrivalTextEl       = $("sArrivalText");
const spTextEl             = $("spText");
const impactSummaryEl      = $("impactSummary");
const severeRadiusTextEl   = $("severeRadiusText");
const moderateRadiusTextEl = $("moderateRadiusText");
const lightRadiusTextEl    = $("lightRadiusText");
const feltRadiusTextEl     = $("feltRadiusText");
const siteRiskTextEl       = $("siteRiskText");
const siteAffectedTextEl   = $("siteAffectedText");
const riskBadgeEl          = $("riskBadge");
const impactRingVizEl      = $("impactRingViz");

const btnLoad       = $("btnLoad");
const btnPrevYear   = $("btnPrevYear");
const btnToggleAuto = $("btnToggleAuto");
const btnDownload   = $("btnDownload");

// ---------- STATE ----------
let quakeLayer = null, heatLayer = null, platesLayer = null;
let lastGeoJSON = null, autoTimer = null, currentBase = null, platesLoaded = false;
let lastFetchTime = null;
let lastFetchKey  = null;
const CACHE_TTL_MS = 10 * 60 * 1000;
let cacheRefreshTimer = null;
let travelGraphicsLayer = L.layerGroup().addTo(map);

// Scenario state
let scenarioMode = "custom"; // "custom" | "usgs"
let customSource = null;   // { latlng }
let customSite   = null;   // latlng
let usgsSource   = null;   // { latlng, mag, depthKm, place, time, feature }
let usgsSite     = null;   // latlng
let pickingCustomSource = false, pickingCustomSite = false;
let pickingUsgsSite = false;

// Animation
let animationElapsedSec = 0, animationPlaying = false;
let animationFrameId = null, animationLastTimestamp = null, isScrubbingTimeline = false;
let pWaveCircle = null, sWaveCircle = null, targetMarker = null, epicenterMarker = null;
let severeImpactCircle = null, moderateImpactCircle = null, lightImpactCircle = null, feltImpactCircle = null;
let pWaveLabel = null, sWaveLabel = null, severeImpactLabel = null, moderateImpactLabel = null, lightImpactLabel = null, feltImpactLabel = null;

let activeAnalysis = null;
let activeCountryFilter = null; // null = show all countries

// World shapefile state (for PIP-based country filter)
let _worldBboxes    = null;   // [{name,iso2,bbox:[minX,minY,maxX,maxY],feature}] after load
let _worldLoading   = false;
let _eqCountryCache = new Map(); // eqId → shapefile country name (cached PIP results)

// ---------- STATUS ----------
function setStatus(msg, type) {
  if (!statusItemEl) return;
  statusItemEl.className = "status-item";
  if (type === "loading") statusItemEl.classList.add("s-loading");
  else if (type === "error") statusItemEl.classList.add("s-error");
  else statusItemEl.classList.add("s-success");
  if (statusTextEl) statusTextEl.textContent = msg;
}
function setUpdatedNow() { if (updatedPillEl) updatedPillEl.textContent = "Updated: " + new Date().toLocaleTimeString(); }
function setMapHint(msg, visible) { if (!mapHintEl) return; mapHintEl.textContent = msg||""; mapHintEl.classList.toggle("hidden", !visible); }
function setMapStatus(l, c, r) { if(mapStatusLeftEl) mapStatusLeftEl.textContent=l??""; if(mapStatusCenterEl) mapStatusCenterEl.textContent=c??""; if(mapStatusRightEl) mapStatusRightEl.textContent=r??""; }
function safeInvalidateMap() { requestAnimationFrame(() => map.invalidateSize()); }

function updateHeaderBadges() {
  if (headerModeBadgeEl) headerModeBadgeEl.textContent = scenarioMode === "custom" ? "Mode: Custom Scenario" : "Mode: Real USGS Earthquake";
  let s = "Scenario: Not Set";
  if (scenarioMode === "custom") {
    if (customSource && customSite) s = "Custom: Source + Site Set";
    else if (customSource) s = "Custom: Source Placed";
  } else {
    if (usgsSource && usgsSite) s = `USGS: M${usgsSource.mag} + Site Set`;
    else if (usgsSource) s = `USGS: M${usgsSource.mag} Selected`;
  }
  if (headerScenarioBadgeEl) headerScenarioBadgeEl.textContent = s;
}

// ---------- STEPPER ----------
function updateStepper() {
  const hasData   = !!lastGeoJSON;
  const hasSource = scenarioMode === "custom" ? !!customSource : !!usgsSource;
  const hasSite   = scenarioMode === "custom" ? !!customSite   : !!usgsSite;
  const hasResult = !!(activeAnalysis?.distanceKm);

  const cfg = [
    { id:"step1", done: hasData,   active: !hasData },
    { id:"step2", done: hasSource, active: hasData && !hasSource },
    { id:"step3", done: hasSite,   active: hasData && hasSource && !hasSite },
    { id:"step4", done: hasResult, active: hasData && hasSource && hasSite }
  ];

  cfg.forEach(({ id, done, active }) => {
    const el = $(id);
    if (!el) return;
    el.classList.toggle("done",   done);
    el.classList.toggle("active", active && !done);
    // Support both old (.stepper-circle) and new (.ts-circle) class names
    const c = el.querySelector(".stepper-circle") || el.querySelector(".ts-circle");
    if (c) c.textContent = done ? "✓" : id.replace("step","");
  });

  // Update topbar hint — keep it short so it fits the pill
  const hintEl = $("contextHint");
  if (!hintEl) return;
  if (!hasData) {
    hintEl.textContent = "Load data to begin.";
  } else if (scenarioMode === "custom") {
    if (!hasSource)   hintEl.textContent = "Place earthquake source on map.";
    else if (!hasSite) hintEl.textContent = "Now place the analysis site.";
    else               hintEl.textContent = "Analysis ready — see Results tab.";
  } else {
    if (!hasSource)   hintEl.textContent = "Click an earthquake dot to select it.";
    else if (!hasSite) hintEl.textContent = "Now place the analysis site.";
    else               hintEl.textContent = "Analysis ready — see Results tab.";
  }
}
function setContextHint(msg) { const el=$("contextHint"); if(el) el.textContent=msg; }

// ---------- SLIDER DISPLAYS ----------
function updateMinMagDisplay() {
  if (!minMagEl || !minMagDisplayEl) return;
  const v = parseFloat(minMagEl.value);
  minMagDisplayEl.textContent = "M " + v.toFixed(1);
  if (v < 3)        minMagDisplayEl.style.cssText = "background:#dcfce7;color:#166534;border-color:#86efac";
  else if (v < 5)   minMagDisplayEl.style.cssText = "background:#fef9c3;color:#854d0e;border-color:#fde047";
  else if (v < 6.5) minMagDisplayEl.style.cssText = "background:#ffedd5;color:#9a3412;border-color:#fdba74";
  else              minMagDisplayEl.style.cssText = "background:#fee2e2;color:#991b1b;border-color:#fca5a5";
}
function updateScenMagDisplay() {
  if (!customMagnitudeEl || !scenMagDisplayEl) return;
  const v = parseFloat(customMagnitudeEl.value);
  scenMagDisplayEl.textContent = "M " + v.toFixed(1);
  if (v < 4)      scenMagDisplayEl.style.cssText = "background:#dcfce7;color:#166534;border-color:#86efac";
  else if (v < 6) scenMagDisplayEl.style.cssText = "background:#fef9c3;color:#854d0e;border-color:#fde047";
  else if (v < 7.5) scenMagDisplayEl.style.cssText = "background:#ffedd5;color:#9a3412;border-color:#fdba74";
  else            scenMagDisplayEl.style.cssText = "background:#fee2e2;color:#991b1b;border-color:#fca5a5";
}
function updateScenDepthDisplay() {
  if (!customDepthEl || !scenDepthDisplayEl) return;
  scenDepthDisplayEl.textContent = parseFloat(customDepthEl.value) + " km";
}

// ---------- PLACE BUTTON STATES ----------
function updateCustomBtnStates() {
  if (btnPickCustomSource) {
    btnPickCustomSource.classList.toggle("placed", !!customSource);
    if (sourceCoordTextEl) sourceCoordTextEl.textContent = customSource ? fmtLL(customSource.latlng) : "Not placed — click to set";
  }
  if (btnPickSite) {
    btnPickSite.classList.toggle("placed", !!customSite);
    if (siteCoordTextEl) siteCoordTextEl.textContent = customSite ? fmtLL(customSite) : "Not placed — click to set";
  }
}
function updateUsgsBtnStates() {
  if (btnPickSiteUSGS) {
    btnPickSiteUSGS.classList.toggle("placed", !!usgsSite);
    if (siteCoordTextUSGSEl) siteCoordTextUSGSEl.textContent = usgsSite ? fmtLL(usgsSite) : "Not placed — click to set";
  }
}
function updateSelectedQuakeCard() {
  if (!usgsSource) {
    if (sqcEmpty)  sqcEmpty.style.display  = "";
    if (sqcFilled) sqcFilled.style.display = "none";
    return;
  }
  if (sqcEmpty)  sqcEmpty.style.display  = "none";
  if (sqcFilled) sqcFilled.style.display = "";
  const mag = usgsSource.mag ?? "?";
  if (sqcMag) {
    sqcMag.textContent = "M" + parseFloat(mag).toFixed(1);
    sqcMag.className = "sqc-mag " + (mag < 3 ? "m-low" : mag < 5 ? "m-medium" : mag < 6.5 ? "m-high" : "m-major");
  }
  if (sqcPlace) sqcPlace.textContent = usgsSource.place || "Unknown";
  if (sqcDepth) sqcDepth.textContent = (usgsSource.depthKm ?? "?") + " km depth";
  if (sqcTime && usgsSource.time) sqcTime.textContent = new Date(usgsSource.time).toLocaleString();
}

// ---------- HELPERS ----------
function getRadius(mag) { return mag ? Math.max(4, mag * 2.5) : 4; }
function getColor(mag)  { return mag>=6?"#d73027":mag>=5?"#fc8d59":mag>=4?"#fee08b":mag>=3?"#d9ef8b":"#91cf60"; }
function getPlateColor(dt) { return {RI:"#ef4444",TR:"#3b82f6",TF:"#8b5cf6",FZ:"#374151",TH:"#374151",CB:"#f59e0b",DB:"#10b981",PB:"#ec4899"}[dt]||"#374151"; }
function getPlateLabel(dt) { return {RI:"Ridge",TR:"Trench",TF:"Transform",FZ:"Fracture Zone",TH:"Thrust",CB:"Convergent",DB:"Divergent",PB:"Plate Boundary"}[dt]||dt||"Unknown"; }

function pointPopup(feature) {
  const p = feature.properties||{}, depth = feature.geometry?.coordinates?.[2];
  return `<b>Earthquake</b><br><b>Magnitude:</b> ${p.mag??"N/A"}<br><b>Place:</b> ${p.place??"N/A"}<br><b>Depth:</b> ${depth??"N/A"} km<br><b>Time:</b> ${p.time?new Date(p.time).toLocaleString():"N/A"}<br><a href="${p.url||"#"}" target="_blank" rel="noopener">USGS Event Page</a>`;
}

function getFilteredFeatures(geojson) {
  if (!geojson||!Array.isArray(geojson.features)) return [];
  const m = parseFloat(minMagEl?.value);
  let features = geojson.features.filter(f => { const mag=f.properties?.mag; return mag!=null&&(Number.isNaN(m)||mag>=m); });
  // Apply country filter if active
  if (activeCountryFilter) {
    features = features.filter(f => {
      const id = _getEqId(f);
      const country = _eqCountryCache.has(id)
        ? _eqCountryCache.get(id)
        : _normaliseCountryName(extractCountry(f.properties?.place));
      return country === activeCountryFilter;
    });
  }
  return features;
}

function fmtLL(ll)  { return `${ll.lat.toFixed(3)}, ${ll.lng.toFixed(3)}`; }
function fmtTime(d) { return d.toLocaleString(); }
function fmtMS(s)   { const r=Math.max(0,Math.round(s)); return `${Math.floor(r/60)}m ${r%60}s`; }
function dKm(a,b)   { return map.distance(a,b)/1000; }  // Vincenty via Leaflet

// Great-circle epicentral angle in degrees (spherical law of cosines)
// More accurate than km/111.19 flat-Earth approximation for teleseismic distances
function epicentralDeg(ll1, ll2) {
  const toRad = x => x * Math.PI / 180;
  const φ1=toRad(ll1.lat), φ2=toRad(ll2.lat), Δλ=toRad(ll2.lng-ll1.lng);
  const cosD = Math.sin(φ1)*Math.sin(φ2) + Math.cos(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  return Math.acos(Math.max(-1, Math.min(1, cosD))) * 180 / Math.PI;
}

// Hypocentral distance (km) — accounts for focal depth
// R_hypo = sqrt(R_epi² + depth²)  used in all GMPE calculations
function hypocentralKm(epicentralKm, depthKm) {
  return Math.sqrt(epicentralKm * epicentralKm + depthKm * depthKm);
}

function toUtcStart(d) { return d+"T00:00:00"; }
function toUtcEnd(d)   { return d+"T23:59:59"; }
function fmtDate(d)    { return d.toISOString().slice(0,10); }
function addDays(d,n)  { const x=new Date(d); x.setUTCDate(x.getUTCDate()+n); return x; }

function buildChunks(s,e,c=RANGE_CHUNK_DAYS){
  const out=[]; let cur=new Date(s+"T00:00:00Z"); const end=new Date(e+"T00:00:00Z");
  while(cur<=end){ let ce=addDays(cur,c-1); if(ce>end)ce=new Date(end); out.push({start:fmtDate(cur),end:fmtDate(ce)}); cur=addDays(ce,1); }
  return out;
}

// ── ak135 bilinear interpolation ─────────────────────────────────────────────
// Bilinear interpolation over (epicentral distance, focal depth)
// Returns { pSeconds, sSeconds, spSeconds } or null
// Source: Kennett et al. (1995), IASP91/ak135 reference model
function interpolateTravelAK135(distDeg, depthKm) {
  // Clamp to model bounds
  const clampedDist  = Math.max(0, Math.min(180, distDeg));
  const clampedDepth = Math.max(0, Math.min(700, depthKm));

  // Unique sorted depth and distance levels in AK135
  const depths = [0, 35, 70, 150, 300, 500, 700];
  const dists  = [...new Set(AK135.map(r=>r[0]))].sort((a,b)=>a-b);

  // Find bounding depth indices
  // Clamp to second-to-last depth bracket when depth equals max
  const clampedDepthI = Math.min(clampedDepth, depths[depths.length-2] + 0.0001);
  let d0i = depths.length-2;
  for (let i=0; i<depths.length-1; i++) { if (clampedDepthI >= depths[i] && clampedDepthI <= depths[i+1]) { d0i=i; break; } }
  const depth0 = depths[d0i], depth1 = depths[d0i+1];
  const depthT = (clampedDepth - depth0) / (depth1 - depth0);

  // Find bounding distance indices
  let r0i = dists.length-2;
  for (let i=0; i<dists.length-1; i++) { if (clampedDist >= dists[i] && clampedDist <= dists[i+1]) { r0i=i; break; } }
  const dist0 = dists[r0i], dist1 = dists[r0i+1];
  const distT  = (clampedDist - dist0) / (dist1 - dist0);

  // Lookup helper: find row for exact (dist, depth) pair
  const lookup = (dist, depth) => AK135.find(r => r[0]===dist && r[1]===depth);

  const r00 = lookup(dist0, depth0);
  const r10 = lookup(dist1, depth0);
  const r01 = lookup(dist0, depth1);
  const r11 = lookup(dist1, depth1);

  if (!r00 || !r10 || !r01 || !r11) return null;

  // Bilinear interpolation for P and S
  const bilinear = (v00,v10,v01,v11) =>
    v00*(1-distT)*(1-depthT) + v10*distT*(1-depthT) +
    v01*(1-distT)*depthT     + v11*distT*depthT;

  const pSec = bilinear(r00[2], r10[2], r01[2], r11[2]);
  const sSec = bilinear(r00[3], r10[3], r01[3], r11[3]);
  return { pSeconds: pSec, sSeconds: sSec, spSeconds: sSec - pSec };
}

function computeTravel(distDeg, depthKm, originMs) {
  const row = interpolateTravelAK135(distDeg, depthKm);
  if (!row) return null;
  return {
    pSeconds:  row.pSeconds,
    sSeconds:  row.sSeconds,
    spSeconds: row.spSeconds,
    pArrival:  new Date(originMs + row.pSeconds * 1000),
    sArrival:  new Date(originMs + row.sSeconds * 1000),
    model: "ak135"   // cite the model in the results
  };
}

// ── IPE wrappers ─────────────────────────────────────────────────────────────
// Legacy alias so earthquake_report.html and any inline callers still work
function mmiBilal(mag, epicKm, depthKm) {
  return IPE_MODELS.bilal.fn(mag, epicKm, depthKm);
}

// Compute MMI using the active IPE model + site class adjustment
// siteAdj: ΔMMI from VS30_CLASSES[activeSiteClass].mmiAdj (default 0 = rock)
function mmiWithSite(mag, epicKm, depthKm) {
  const raw = mmiActive(mag, epicKm, depthKm);
  const adj = VS30_CLASSES[activeSiteClass]?.mmiAdj ?? 0;
  return raw + adj;
}

// Bisection inversion: epicentral radius (km) at which MMI+site = threshold
// Converges to < 0.5 km in 80 iterations
// SCIENTIFIC FIX: removed artificial ring separation — zones reflect true physics
function radiusForMMI(mmiThreshold, mag, depthKm) {
  if (mmiWithSite(mag, 0, depthKm) < mmiThreshold) return 0;
  let lo = 0, hi = 6000;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (mmiWithSite(mag, mid, depthKm) > mmiThreshold) lo = mid;
    else hi = mid;
  }
  return Math.round((lo + hi) / 2);
}

// Compute all four MMI-based impact zone radii (epicentral km)
// Uses active IPE + site class. Rings are physically correct — no forced padding.
function computeImpact(mag, depthKm = 10) {
  const m = Number(mag) || 0;
  const d = Number(depthKm) || 10;

  const severeKm   = radiusForMMI(MMI_SEVERE,   m, d);
  const moderateKm = radiusForMMI(MMI_MODERATE, m, d);
  const lightKm    = radiusForMMI(MMI_LIGHT,    m, d);
  const feltKm     = radiusForMMI(MMI_FELT,     m, d);
  const mmiEpi     = mmiWithSite(m, 0, d);
  const siteAdj    = VS30_CLASSES[activeSiteClass]?.mmiAdj ?? 0;

  return {
    severeKm,
    moderateKm,
    lightKm,
    feltKm,
    mmiAtEpicenter: Math.round(mmiEpi * 10) / 10,
    model: IPE_MODELS[activeIPE].name,
    siteClass: VS30_CLASSES[activeSiteClass]?.label ?? "Rock",
    siteAdj
  };
}

// Site MMI and risk level at epicentral distance
function getRisk(epicKm, depthKm, zones) {
  if (!zones) return { level: "Unknown", affected: "No", mmi: null };
  const mag = zones._mag || 0;
  const d   = zones._depth || depthKm || 0;
  const mmi = Math.round(mmiWithSite(mag, epicKm, d) * 10) / 10;
  if (epicKm <= zones.severeKm)   return { level: "Severe",   affected: "Yes", mmi };
  if (epicKm <= zones.moderateKm) return { level: "Moderate", affected: "Yes", mmi };
  if (epicKm <= zones.lightKm)    return { level: "Light",    affected: "Yes", mmi };
  if (epicKm <= zones.feltKm)     return { level: "Felt",     affected: "Yes", mmi };
  return { level: "Outside", affected: "No", mmi };
}

// Tsunami hazard flag — based on standard PTWC/IOC criteria
// Triggered when: M ≥ 7.0, focal depth ≤ 70 km, epicentre in ocean
// Reference: PTWC (Pacific Tsunami Warning Center) operational criteria
//            Synolakis & Bernard (2006) Phil. Trans. R. Soc. A 364:2231-2265
function getTsunamiFlag(mag, depthKm, lat, lng) {
  if (mag < 7.0 || depthKm > 70) return null;
  // Rough ocean check: avoid major continental interiors
  // Simplified: flag if not clearly continental (no perfect solution without coastline GIS)
  const potentiallyOcean = !(
    // Rough continental interiors to exclude
    (lat > 20 && lat < 55 && lng > -110 && lng < -60) || // N America interior
    (lat > -55 && lat < 20 && lng > -80 && lng < -35) ||  // S America interior
    (lat > 35 && lat < 70 && lng > 10 && lng < 60) ||     // Eurasia interior
    (lat > 0 && lat < 35 && lng > 60 && lng < 100)        // South/Central Asia
  );
  if (!potentiallyOcean) return null;
  return {
    level: mag >= 8.5 ? "High" : mag >= 7.5 ? "Moderate" : "Watch",
    note: `M${mag.toFixed(1)}, depth ${depthKm}km — shallow subduction-zone event. Tsunami generation possible.`
  };
}

// Omori aftershock forecast — Modified Omori-Utsu law
// N(t) = K / (t + c)^p  where t is days after mainshock
// Bath's law: largest aftershock ≈ M_main - 1.2
// Gutenberg-Richter b-value ≈ 1.0 (global average)
// Reference: Utsu (1961); Reasenberg & Jones (1989) Science 243:1173-1176
function forecastAfterShocks(mag, days = [1, 7, 30]) {
  const Mafter = Math.max(0, mag - 1.2); // Bath's law
  // Reasenberg & Jones (1989) California parameters (widely used globally)
  const a = -1.67, b = 1.0, c = 0.05, p = 1.08;
  const K = Math.pow(10, a + mag * b); // productivity constant
  return {
    largestExpected: +Mafter.toFixed(1),
    counts: days.map(d => ({
      days: d,
      // Cumulative N(0→t) with magnitude ≥ M_after threshold
      n: Math.round(K * ((Math.pow(c + d, 1 - p) - Math.pow(c, 1 - p)) / (1 - p)))
    }))
  };
}

function setRiskBadge(level) {
  if(!riskBadgeEl) return;
  if(!level||level==="-"){riskBadgeEl.style.display="none";return;}
  const m={Severe:"rb-severe",Moderate:"rb-moderate",Light:"rb-light",Felt:"rb-felt",Outside:"rb-outside"};
  riskBadgeEl.className="risk-badge "+(m[level]||""); riskBadgeEl.textContent=level+" risk"; riskBadgeEl.style.display="inline-block";
}
function showRingViz(v){ if(impactRingVizEl) impactRingVizEl.style.display=v?"block":"none"; }
function setTravelNote(msg){ if(travelSummaryEl) travelSummaryEl.textContent=msg; }
function setImpactNote(msg){ if(impactSummaryEl) impactSummaryEl.textContent=msg; }

function resetResultsUI() {
  ["selectedQuakeText","targetText","distanceKmText","distanceDegText",
   "pArrivalText","sArrivalText","spText",
   "severeRadiusText","moderateRadiusText","lightRadiusText","feltRadiusText",
   "severeAreaText","moderateAreaText","lightAreaText","feltAreaText",
   "totalAreaText","siteRiskText","siteAffectedText"
  ].forEach(id=>{ const el=$(id); if(el)el.textContent="-"; });
  const izt=$("impactZoneTable"); if(izt) izt.style.display="none";
  setRiskBadge(null); showRingViz(false);
}

// ---------- ANIMATION HELPERS ----------
function updateSpeedLabel(){ if(animationSpeedEl&&animationSpeedValueEl) animationSpeedValueEl.textContent=parseFloat(animationSpeedEl.value).toFixed(2).replace(/\.00$/,"")+"x"; }
function updateTimelineLabel(){ if(timelineSliderEl&&timelineSliderValueEl) timelineSliderValueEl.textContent=parseFloat(timelineSliderEl.value).toFixed(1)+"s"; }
function getAnimEnd(){ if(!activeAnalysis?.source) return 0; return Math.max(activeAnalysis.travel?activeAnalysis.travel.sSeconds+5:0,30); }
function syncTimeline(){ if(!timelineSliderEl||isScrubbingTimeline) return; timelineSliderEl.value=String(animationElapsedSec); updateTimelineLabel(); }
function updateTimelineRange(){ if(!timelineSliderEl) return; timelineSliderEl.min="0"; timelineSliderEl.max=String(Math.max(1,getAnimEnd())); timelineSliderEl.step="0.1"; timelineSliderEl.value=String(animationElapsedSec); updateTimelineLabel(); }
function resetAnimText(){ if(animationTimeTextEl) animationTimeTextEl.textContent="0.0 s"; if(pWaveStatusTextEl) pWaveStatusTextEl.textContent="Waiting"; if(sWaveStatusTextEl) sWaveStatusTextEl.textContent="Waiting"; if(timelineSliderEl) timelineSliderEl.value="0"; updateTimelineLabel(); }
function stopAnimLoop(){ if(animationFrameId){cancelAnimationFrame(animationFrameId);animationFrameId=null;} animationPlaying=false; animationLastTimestamp=null; }
function resetAnimState(){ stopAnimLoop(); animationElapsedSec=0; clearAnimGraphics(); resetAnimText(); updateTimelineRange(); }

function createRingLabel(latlng, text, color) {
  return L.marker(latlng,{pane:"animationPane",interactive:false,icon:L.divIcon({className:"ring-text-label",html:`<div style="background:rgba(255,255,255,.96);border:2px solid ${color};color:${color};padding:3px 8px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap;box-shadow:0 1px 6px rgba(0,0,0,.18)">${text}</div>`,iconSize:null,iconAnchor:[0,0]})});
}

function offsetLL(center, rKm, angleDeg=0) {
  const R=6371,b=(angleDeg*Math.PI)/180,lat1=(center.lat*Math.PI)/180,lon1=(center.lng*Math.PI)/180,ad=rKm/R;
  const lat2=Math.asin(Math.sin(lat1)*Math.cos(ad)+Math.cos(lat1)*Math.sin(ad)*Math.cos(b));
  const lon2=lon1+Math.atan2(Math.sin(b)*Math.sin(ad)*Math.cos(lat1),Math.cos(ad)-Math.sin(lat1)*Math.sin(lat2));
  return L.latLng((lat2*180)/Math.PI,(((lon2*180)/Math.PI+540)%360)-180);
}

function clearAnimGraphics() {
  [pWaveCircle,sWaveCircle,targetMarker,epicenterMarker,
   severeImpactCircle,moderateImpactCircle,lightImpactCircle,feltImpactCircle,
   pWaveLabel,sWaveLabel,severeImpactLabel,moderateImpactLabel,lightImpactLabel,feltImpactLabel
  ].forEach(l=>{if(l&&map.hasLayer(l))map.removeLayer(l);});
  pWaveCircle=sWaveCircle=targetMarker=epicenterMarker=null;
  severeImpactCircle=moderateImpactCircle=lightImpactCircle=feltImpactCircle=null;
  pWaveLabel=sWaveLabel=severeImpactLabel=moderateImpactLabel=lightImpactLabel=feltImpactLabel=null;
}

function renderImpactZones(epicenter, zones, ratio=1) {
  if(!showImpactZonesEl?.checked||!zones) return;
  const fK=zones.feltKm*ratio,lK=zones.lightKm*ratio,mK=zones.moderateKm*ratio,sK=zones.severeKm*ratio;
  // Only draw rings with non-zero radius (e.g. Severe = 0 for sub-MMI-VIII events)
  if(fK>1) feltImpactCircle     =L.circle(epicenter,{pane:"impactPane",radius:fK*1000,color:"#facc15",weight:1.5,fillColor:"#fde68a",fillOpacity:.08}).addTo(map);
  if(lK>1) lightImpactCircle    =L.circle(epicenter,{pane:"impactPane",radius:lK*1000,color:"#f59e0b",weight:1.5,fillColor:"#fdba74",fillOpacity:.10}).addTo(map);
  if(mK>1) moderateImpactCircle =L.circle(epicenter,{pane:"impactPane",radius:mK*1000,color:"#fb923c",weight:1.5,fillColor:"#fb923c",fillOpacity:.12}).addTo(map);
  if(sK>1) severeImpactCircle   =L.circle(epicenter,{pane:"impactPane",radius:sK*1000,color:"#ef4444",weight:2,  fillColor:"#ef4444",fillOpacity:.15}).addTo(map);
  if(sK>2) severeImpactLabel   =createRingLabel(offsetLL(epicenter,sK,25),  "Severe (MMI≥VIII)", "#dc2626").addTo(map);
  if(mK>2) moderateImpactLabel =createRingLabel(offsetLL(epicenter,mK,70),  "Moderate (MMI VI–VII)","#ea580c").addTo(map);
  if(lK>2) lightImpactLabel    =createRingLabel(offsetLL(epicenter,lK,120), "Light (MMI IV–V)",   "#d97706").addTo(map);
  if(fK>2) feltImpactLabel     =createRingLabel(offsetLL(epicenter,fK,160), "Felt (MMI II–III)",  "#ca8a04").addTo(map);
}

function renderAnimFrame() {
  clearAnimGraphics();
  const a=activeAnalysis; if(!a||!a.source){resetAnimText();return;}
  const epicenter=a.source.latlng, site=a.site, travel=a.travel, zones=a.zones;
  epicenterMarker=L.circleMarker(epicenter,{pane:"animationPane",radius:9,color:"#111827",weight:2,fillColor:"#2563eb",fillOpacity:1}).addTo(map);
  let pArrived=false,sArrived=false;
  if(travel){
    const pR=travel.pSeconds>0?Math.min(animationElapsedSec/travel.pSeconds,1):1;
    const sR=travel.sSeconds>0?Math.min(animationElapsedSec/travel.sSeconds,1):1;
    const pRKm=a.distanceKm*pR,sRKm=a.distanceKm*sR;
    pWaveCircle=L.circle(epicenter,{pane:"animationPane",radius:pRKm*1000,color:"#2563eb",weight:2,fill:false,opacity:.95}).addTo(map);
    sWaveCircle=L.circle(epicenter,{pane:"animationPane",radius:sRKm*1000,color:"#f97316",weight:2,fill:false,opacity:.95,dashArray:"8,8"}).addTo(map);
    if(pRKm>1) pWaveLabel=createRingLabel(offsetLL(epicenter,pRKm,300),"P Wave","#2563eb").addTo(map);
    if(sRKm>1) sWaveLabel=createRingLabel(offsetLL(epicenter,sRKm,120),"S Wave","#f97316").addTo(map);
    pArrived=animationElapsedSec>=travel.pSeconds; sArrived=animationElapsedSec>=travel.sSeconds;
  }
  const impEnd=getAnimEnd();
  const impRatio=animateImpactEl?.checked?(impEnd>0?Math.min(animationElapsedSec/impEnd,1):1):1;
  renderImpactZones(epicenter,zones,impRatio);
  if(site){
    const risk=a.distanceKm!=null?getRisk(a.distanceKm,a.source.depthKm||0,zones):{level:"Unknown"};
    const fc=risk.level==="Severe"?"#dc2626":risk.level==="Moderate"?"#f97316":risk.level==="Light"?"#eab308":risk.level==="Felt"?"#60a5fa":"#94a3b8";
    targetMarker=L.circleMarker(site,{pane:"animationPane",radius:sArrived?10:pArrived?9:7,color:"#111827",weight:2,fillColor:fc,fillOpacity:1}).addTo(map);
  }
  if(animationTimeTextEl) animationTimeTextEl.textContent=animationElapsedSec.toFixed(1)+" s";
  if(pWaveStatusTextEl) pWaveStatusTextEl.textContent=travel?(pArrived?`Arrived (${fmtMS(travel.pSeconds)})`:`In ${fmtMS(travel.pSeconds-animationElapsedSec)}`):"No site";
  if(sWaveStatusTextEl) sWaveStatusTextEl.textContent=travel?(sArrived?`Arrived (${fmtMS(travel.sSeconds)})`:`In ${fmtMS(travel.sSeconds-animationElapsedSec)}`):"No site";
  syncTimeline();
}

function animTick(ts) {
  if(!animationPlaying) return;
  if(!animationLastTimestamp) animationLastTimestamp=ts;
  const delta=(ts-animationLastTimestamp)/1000; animationLastTimestamp=ts;
  animationElapsedSec+=delta*(animationSpeedEl?parseFloat(animationSpeedEl.value):1);
  const end=getAnimEnd();
  if(animationElapsedSec>end){animationElapsedSec=end;renderAnimFrame();stopAnimLoop();setTravelNote("Animation finished.");return;}
  renderAnimFrame(); animationFrameId=requestAnimationFrame(animTick);
}
function startAnimation(){ if(!activeAnalysis?.source){setTravelNote("Set a scenario source first.");return;} if(animationPlaying) return; animationPlaying=true; animationLastTimestamp=null; animationFrameId=requestAnimationFrame(animTick); setTravelNote("Animation playing…"); }
function pauseAnimation(){ if(!animationPlaying) return; stopAnimLoop(); setTravelNote("Animation paused."); }
function resetAnimation(){ stopAnimLoop(); animationElapsedSec=0; renderAnimFrame(); setTravelNote("Animation reset."); }

// ---------- ANALYSIS ----------
function runAnalysis() {
  resetAnimState();
  const src = scenarioMode === "custom"
    ? (customSource ? { latlng:customSource.latlng, mag:parseFloat(customMagnitudeEl?.value)||6, depthKm:parseFloat(customDepthEl?.value)||10, place:"Custom Source", time:Date.now() } : null)
    : (usgsSource   ? { latlng:usgsSource.latlng, mag:usgsSource.mag, depthKm:usgsSource.depthKm||10, place:usgsSource.place, time:usgsSource.time||Date.now() } : null);

  const site = scenarioMode === "custom" ? customSite : usgsSite;

  if (!src) { setTravelNote("Set a scenario source first."); setImpactNote("No source set yet."); updateStepper(); updateHeaderBadges(); return; }

  const mag     = parseFloat(src.mag)     || 0;
  const depthKm = parseFloat(src.depthKm) || 10;

  const zones = computeImpact(mag, depthKm);
  zones._mag    = mag;
  zones._depth  = depthKm;

  // ── Seismic physics ──────────────────────────────────────────────────────
  const M0  = seismicMoment(mag);
  const Es  = seismicEnergy(mag);
  const rup = getRuptureParams(mag);

  // Populate physics panel
  const physPanel = $("panelSeismicPhysics");
  if (physPanel) physPanel.style.display = mag >= 3 ? "block" : "none";
  if ($("momentText")) $("momentText").innerHTML = fmtSci(M0) + " N·m";
  if ($("energyText"))  $("energyText").innerHTML = fmtSci(Es) + " J";
  if ($("ruptLengthText")) $("ruptLengthText").textContent = mag >= 5 ? rup.lengthKm.toFixed(1) + " km" : "< M5";
  if ($("ruptWidthText"))  $("ruptWidthText").textContent  = mag >= 5 ? rup.widthKm.toFixed(1)  + " km" : "—";
  if ($("ruptAreaText"))   $("ruptAreaText").textContent   = mag >= 5 ? rup.areaKm2.toFixed(0)  + " km²": "—";

  // ── Rupture ellipse on map (M≥6) ─────────────────────────────────────────
  drawRuptureEllipse(src.latlng, mag);

  // ── Impact zones with ±1σ uncertainty ────────────────────────────────────
  const sigma = IPE_SIGMA[activeIPE] || 0.8;
  const circArea = r => Math.PI * r * r;
  const fmtArea  = km2 => km2 >= 1e6
    ? (km2/1e6).toFixed(2) + " M km²"
    : km2 >= 1000
      ? (km2/1000).toFixed(1) + " k km²"
      : Math.round(km2) + " km²";

  const sevArea  = circArea(zones.severeKm);
  const modArea  = circArea(zones.moderateKm) - sevArea;
  const litArea  = circArea(zones.lightKm)    - circArea(zones.moderateKm);
  const feltArea = circArea(zones.feltKm)     - circArea(zones.lightKm);
  const totalFeltArea = circArea(zones.feltKm);

  function setZoneRow(prefix, radiusKm, areaKm2, uncertKm) {
    if ($(prefix+"RadiusText")) $(prefix+"RadiusText").textContent = radiusKm > 0 ? `${radiusKm} km` : "Not reached";
    if ($(prefix+"AreaText"))   $(prefix+"AreaText").textContent   = radiusKm > 0 ? fmtArea(areaKm2) : "—";
    if ($(prefix+"UncertText")) $(prefix+"UncertText").textContent = radiusKm > 0 ? `±${uncertKm} km` : "—";
  }
  setZoneRow("severe",   zones.severeKm,   sevArea,  zoneUncertaintyKm(MMI_SEVERE,   mag, depthKm));
  setZoneRow("moderate", zones.moderateKm, modArea,  zoneUncertaintyKm(MMI_MODERATE, mag, depthKm));
  setZoneRow("light",    zones.lightKm,    litArea,  zoneUncertaintyKm(MMI_LIGHT,    mag, depthKm));
  setZoneRow("felt",     zones.feltKm,     feltArea, zoneUncertaintyKm(MMI_FELT,     mag, depthKm));
  if ($("totalAreaText")) $("totalAreaText").textContent = zones.feltKm > 0 ? fmtArea(totalFeltArea) : "—";

  if (selectedQuakeTextEl) selectedQuakeTextEl.textContent = scenarioMode==="custom" ? `Custom (M${mag.toFixed(1)})` : `${src.place} (M${mag.toFixed(1)})`;
  const izt = $("impactZoneTable"); if(izt) izt.style.display="block";
  showRingViz(true);
  setImpactNote(`${IPE_MODELS[activeIPE]?.shortName||activeIPE} IPE · ±${sigma.toFixed(1)} MMI (1σ) · ${VS30_CLASSES[activeSiteClass]?.label?.split("—")[0]?.trim()||"Rock"}`);

  // Tsunami hazard flag
  const tsunEl = $("tsunamiFlag");
  if (tsunEl) {
    const tsun = getTsunamiFlag(src.mag, src.depthKm, src.latlng.lat, src.latlng.lng);
    if (tsun) {
      const color = tsun.level === "High" ? "#dc2626" : tsun.level === "Moderate" ? "#ea580c" : "#d97706";
      tsunEl.style.display = "block";
      tsunEl.innerHTML = `<span style="font-weight:700;color:${color}">🌊 Tsunami ${tsun.level}</span> — ${tsun.note}`;
    } else {
      tsunEl.style.display = "none";
    }
  }

  // Aftershock forecast
  const asEl = $("aftershockForecast");
  if (asEl && src.mag >= 4.5) {
    const af = forecastAfterShocks(src.mag);
    asEl.style.display = "block";
    asEl.innerHTML = `<strong>Aftershock forecast</strong> (Modified Omori-Utsu / Reasenberg-Jones)<br>
      Largest expected: M${af.largestExpected} (Bath's law)<br>
      M≥${(src.mag-2).toFixed(1)}+ aftershocks: ~${af.counts[0].n} in 24h · ~${af.counts[1].n} in 7d · ~${af.counts[2].n} in 30d`;
  } else if (asEl) {
    asEl.style.display = "none";
  }

  const analysis = { source:src, zones, site:site||null, distanceKm:null, distanceDeg:null, travel:null };

  if (site) {
    const dk=dKm(src.latlng,site);
    const dd=epicentralDeg(src.latlng,site); // great-circle degrees (spherical law of cosines)
    const travel=computeTravel(dd,src.depthKm,src.time); // ak135 bilinear: dist + depth
    analysis.distanceKm=dk; analysis.distanceDeg=dd; analysis.travel=travel;
    if(targetTextEl)      targetTextEl.textContent      = fmtLL(site);
    if(distanceKmTextEl)  distanceKmTextEl.textContent  = dk.toFixed(2);
    if(distanceDegTextEl) distanceDegTextEl.textContent = dd.toFixed(3)+" °";
    if(travel){
      if(pArrivalTextEl) pArrivalTextEl.textContent = fmtTime(travel.pArrival);
      if(sArrivalTextEl) sArrivalTextEl.textContent = fmtTime(travel.sArrival);
      if(spTextEl)       spTextEl.textContent        = fmtMS(travel.spSeconds);
    } else {
      [pArrivalTextEl,sArrivalTextEl,spTextEl].forEach(el=>{if(el)el.textContent="-";});
    }
    const risk=getRisk(dk, src.depthKm||0, zones);
    if(siteRiskTextEl)    siteRiskTextEl.textContent    = risk.mmi!=null ? `${risk.level} (MMI ${risk.mmi})` : risk.level;
    if(siteAffectedTextEl) siteAffectedTextEl.textContent = risk.affected;
    setRiskBadge(risk.level);
    setTravelNote(`ak135 model — P: ${travel?fmtMS(travel.pSeconds):"-"}, S: ${travel?fmtMS(travel.sSeconds):"-"}, S-P: ${travel?fmtMS(travel.spSeconds):"-"}`);
    const modelShort = IPE_MODELS[activeIPE]?.shortName || activeIPE;
    const siteLabel  = VS30_CLASSES[activeSiteClass]?.label?.split("—")[0]?.trim() || "Rock";
    setImpactNote(`${modelShort} IPE · ${siteLabel} · Epicentre MMI ≈ ${zones.mmiAtEpicenter||"-"}`);
    setMapStatus(`${dk.toFixed(0)} km · R_hypo ${hypocentralKm(dk,src.depthKm||0).toFixed(0)} km`, "Results ready", "");
  } else {
    [targetTextEl,distanceKmTextEl,distanceDegTextEl,pArrivalTextEl,sArrivalTextEl,spTextEl,siteRiskTextEl,siteAffectedTextEl]
      .forEach(el=>{if(el)el.textContent="-";});
    setTravelNote("Source set — place an analysis site to get travel time results.");
    setImpactNote("Impact zones shown on map. Place a site for risk data.");
    setMapStatus(`M${parseFloat(src.mag).toFixed(1)} source placed`,"Place an analysis site to continue","");
  }

  analysis.mag     = parseFloat(src.mag)     || 0;
  analysis.depthKm = parseFloat(src.depthKm) || 10;
  activeAnalysis = analysis;
  updateTimelineRange(); renderAnimFrame();
  updateHeaderBadges(); updateStepper();

  // No auto tab switching — user navigates manually via the tab bar
  // The stepper and hint guide them to the Results tab when ready
}

// ---------- DRAWING ----------
function drawTravelGraphics() {
  travelGraphicsLayer.clearLayers();
  const src  = scenarioMode==="custom" ? customSource?.latlng  : usgsSource?.latlng;
  const site = scenarioMode==="custom" ? customSite            : usgsSite;
  if(src)       L.circleMarker(src, {pane:"travelPane",radius:8,color:"#111827",weight:2,fillColor:"#2563eb",fillOpacity:1}).addTo(travelGraphicsLayer);
  if(site)      L.circleMarker(site,{pane:"travelPane",radius:7,color:"#111827",weight:2,fillColor:"#f97316",fillOpacity:1}).addTo(travelGraphicsLayer);
  if(src&&site) L.polyline([src,site],{pane:"travelPane",color:"#111827",weight:2,opacity:.8,dashArray:"6,6"}).addTo(travelGraphicsLayer);
}

// ---------- SCENARIO RESET ----------
function resetCustomScenario() {
  customSource=null; customSite=null; pickingCustomSource=false; pickingCustomSite=false;
  activeAnalysis=null; travelGraphicsLayer.clearLayers(); clearAnimGraphics();
  resetResultsUI(); resetAnimText(); updateCustomBtnStates();
  setMapHint("",false); updateHeaderBadges(); updateStepper();
  setMapStatus("","","");
  if(scenarioSummaryEl) scenarioSummaryEl.textContent="Set magnitude, depth, then place source and site on the map.";
}
function resetUSGSScenario() {
  usgsSource=null; usgsSite=null; pickingUsgsSite=false;
  activeAnalysis=null; travelGraphicsLayer.clearLayers(); clearAnimGraphics();
  resetResultsUI(); resetAnimText(); updateUsgsBtnStates(); updateSelectedQuakeCard();
  setMapHint("",false); updateHeaderBadges(); updateStepper();
  setMapStatus("","","");
  if(usgsScenarioSummaryEl) usgsScenarioSummaryEl.textContent="Click any earthquake dot on the map to select it.";
}

// ---------- SCENARIO MODE SWITCH ----------
function switchScenarioMode(mode) {
  scenarioMode = mode;
  document.querySelectorAll(".mode-card").forEach(c => c.classList.toggle("active", c.dataset.mode===mode));
  const panelCustom = $("panelCustom"), panelUSGS = $("panelUSGS");
  if (panelCustom) panelCustom.style.display = mode==="custom" ? "" : "none";
  if (panelUSGS)   panelUSGS.style.display   = mode==="usgs"   ? "" : "none";
  // reset both sides when switching
  customSource=null; customSite=null; pickingCustomSource=false; pickingCustomSite=false;
  usgsSource=null;   usgsSite=null;   pickingUsgsSite=false;
  activeAnalysis=null; travelGraphicsLayer.clearLayers(); clearAnimGraphics();
  resetResultsUI(); resetAnimText();
  updateCustomBtnStates(); updateUsgsBtnStates(); updateSelectedQuakeCard();
  setMapHint("",false); updateHeaderBadges(); updateStepper();
  setMapStatus("","","");
}

// ---------- TAB SWITCHING ----------
function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab===tabName));
  document.querySelectorAll(".tab-pane").forEach(p => p.classList.toggle("active", p.id==="pane-"+tabName));
}

// ---------- WRAP ----------
function shiftCoords(coords,offset){ if(!Array.isArray(coords)) return coords; if(typeof coords[0]==="number"&&typeof coords[1]==="number") return coords.length>2?[coords[0]+offset,coords[1],coords[2]]:[coords[0]+offset,coords[1]]; return coords.map(c=>shiftCoords(c,offset)); }
function wrapFeature(f,offset){ return{...f,geometry:{...f.geometry,coordinates:shiftCoords(f.geometry.coordinates,offset)}}; }
function wrapFeatures(features){ const out=[]; features.forEach(f=>{out.push(wrapFeature(f,-360));out.push(f);out.push(wrapFeature(f,360));}); return out; }

// ---------- BASEMAPS ----------
// crossOrigin + referrerPolicy prevents 403 "Access blocked" from tile servers
// when the app is opened from file:// or a local server without a valid Referer.
// CARTO tiles are used as the default OSM-style map — they do NOT require Referer.
// referrerPolicy prevents 403 from tile servers opened from file:// or localhost
const TO={maxZoom:19,pane:"basemapPane",referrerPolicy:"no-referrer-when-downgrade"};
const esriImagery=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{...TO,attribution:"Tiles © Esri"});
const esriLabels =L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",{...TO,attribution:"Tiles © Esri"});
// Google tile layers — mt0-3 subdomains, no crossOrigin (Google blocks it)
const GO={maxZoom:20,pane:"basemapPane",referrerPolicy:"no-referrer-when-downgrade",subdomains:["mt0","mt1","mt2","mt3"]};
const googleSat      =L.tileLayer("https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",{...GO,attribution:"Map data © Google"});
const googleSatLabels=L.tileLayer("https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",{...GO,attribution:"Map data © Google"});
const baseLayers={
  osm:           L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",{...TO,subdomains:"abcd",attribution:"© OpenStreetMap contributors, © CARTO"}),
  cartoLight:    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",{...TO,subdomains:"abcd",attribution:"© OpenStreetMap, © CARTO"}),
  cartoDark:     L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",{...TO,subdomains:"abcd",attribution:"© OpenStreetMap, © CARTO"}),
  esriTopo:      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",{...TO,attribution:"Tiles © Esri"}),
  esriImagery,
  esriHybrid:    L.layerGroup([esriImagery,esriLabels]),
  googleSat,
  googleHybrid:  googleSatLabels
};
function setBasemap(key){ if(!baseLayers[key]) return; if(currentBase&&map.hasLayer(currentBase)) map.removeLayer(currentBase); currentBase=baseLayers[key]; currentBase.addTo(map); safeInvalidateMap(); document.querySelectorAll(".bm-opt").forEach(b=>b.classList.toggle("active",b.dataset.bm===key)); }
setBasemap("osm");

// Inject cluster pulse animation keyframe once
(function(){
  if (document.getElementById('clusterPulseStyle')) return;
  const s = document.createElement('style');
  s.id = 'clusterPulseStyle';
  s.textContent = '@keyframes clusterPulse{0%{transform:scale(1);opacity:.35}100%{transform:scale(1.7);opacity:0}}';
  document.head.appendChild(s);
})();


const basemapToggleBtn=$("basemapToggleBtn"), basemapPanel=$("basemapPanel");
basemapToggleBtn?.addEventListener("click",e=>{ e.stopPropagation(); basemapPanel.style.display=basemapPanel.style.display==="none"||!basemapPanel.style.display?"block":"none"; });
document.addEventListener("click",e=>{ const ctrl=$("basemapControl"); if(ctrl&&!ctrl.contains(e.target)) basemapPanel.style.display="none"; });
document.querySelectorAll(".bm-opt").forEach(btn=>btn.addEventListener("click",()=>{ setBasemap(btn.dataset.bm); basemapPanel.style.display="none"; }));

// ---------- LEGENDS ----------
const legend=L.control({position:"bottomright"});
legend.onAdd=function(){ const d=L.DomUtil.create("div","legend"); d.id="legendDiv"; d.innerHTML="<strong>Magnitude</strong>No data"; return d; };
legend.addTo(map);
function setLegendVisible(v){ const d=$("legendDiv"); if(d) d.style.display=v?"block":"none"; }
function updateLegend(features){
  const div = $("legendDiv");
  if (!div) return;

  const showPoints  = showPointsEl?.checked;
  const showImpact  = showImpactZonesEl?.checked;
  const hasFeatures = features && features.length > 0;

  // Nothing to show at all
  if (!showPoints && !showImpact) {
    div.innerHTML = "<strong>Magnitude</strong>No data";
    setLegendVisible(false);
    return;
  }

  let html = "";

  // Earthquake magnitude legend — only when points visible and data loaded
  if (showPoints && hasFeatures) {
    html += "<strong>Magnitude</strong>";
    const bins = [{min:0,max:3},{min:3,max:4},{min:4,max:5},{min:5,max:6},{min:6,max:Infinity}];
    bins.forEach(b => {
      const cnt = features.filter(f => { const m = f.properties?.mag; return m >= b.min && m < b.max; }).length;
      if (cnt > 0) {
        const lbl = b.max === Infinity ? `${b.min}+` : `${b.min}–${b.max}`;
        html += `<div><i style="background:${getColor(b.min+.01)}"></i>${lbl} (${cnt})</div>`;
      }
    });
  }

  // Impact zone legend — shown whenever impact zones toggle is on, regardless of points
  if (showImpact) {
    if (html) html += `<hr style="border:none;border-top:1px solid #e2e8f0;margin:5px 0 4px;">`;
    const modelShort = IPE_MODELS[activeIPE]?.shortName || activeIPE;
    const siteLabel  = VS30_CLASSES[activeSiteClass]?.label?.split("—")[0]?.trim() || "Rock";
    html += `<strong style="font-size:11px;">Impact Zones</strong>
      <div style="font-size:10px;color:#64748b;margin:2px 0 4px;">${modelShort} IPE · ${siteLabel}</div>
      <div class="legend-iz-row"><span class="legend-iz-swatch" style="background:#ef4444;border-color:#dc2626"></span><span>Severe &mdash; MMI &ge; VIII</span></div>
      <div class="legend-iz-row"><span class="legend-iz-swatch" style="background:#fb923c;border-color:#ea580c"></span><span>Moderate &mdash; MMI VI&ndash;VII</span></div>
      <div class="legend-iz-row"><span class="legend-iz-swatch" style="background:#fde68a;border-color:#d97706"></span><span>Light &mdash; MMI IV&ndash;V</span></div>
      <div class="legend-iz-row"><span class="legend-iz-swatch" style="background:#fef9c3;border-color:#ca8a04"></span><span>Felt &mdash; MMI II&ndash;III</span></div>`;
  }

  if (!html) {
    div.innerHTML = "<strong>Magnitude</strong>No data";
    setLegendVisible(false);
    return;
  }

  div.innerHTML = html;
  setLegendVisible(true);
}

const plateLegend=L.control({position:"bottomleft"});
plateLegend.onAdd=function(){ const d=L.DomUtil.create("div","legend"); d.id="plateLegendDiv"; d.style.display="none"; d.innerHTML="<strong>Tectonic Plate Types</strong><br>No data"; return d; };
plateLegend.addTo(map);
function updatePlateLegend(features){
  const div=$("plateLegendDiv"); if(!div) return;
  if(!features?.length||!showPlatesEl?.checked){ div.style.display="none"; return; }

  // Canonical order matching the screenshot: FZ, RI, TF, TH, TR
  const CANONICAL_ORDER = ["FZ","RI","TF","TH","TR","CB","DB","PB"];
  const typesInData = new Set(features.map(f=>f.properties?.datatype).filter(Boolean));
  const types = CANONICAL_ORDER.filter(t => typesInData.has(t));
  // Append any extra types not in canonical list
  typesInData.forEach(t => { if (!CANONICAL_ORDER.includes(t)) types.push(t); });

  if(!types.length){ div.style.display="none"; return; }

  let html = `<div class="plate-legend-title">Tectonic Plate Types</div>`;
  types.forEach(t => {
    html += `<div class="legend-line-item">
      <span class="legend-line-swatch" style="border-top-color:${getPlateColor(t)}"></span>
      <span class="plate-legend-label">${getPlateLabel(t)} (${t})</span>
    </div>`;
  });
  div.innerHTML = html;
  div.style.display = "block";
}

// ---------- DATA FETCH ----------
async function fetchFeed(){ const res=await fetch(feedEl.value,{cache:"no-store"}); if(!res.ok) throw new Error("HTTP "+res.status); const g=await res.json(); if(!g||!Array.isArray(g.features)) throw new Error("Invalid GeoJSON"); return g; }
async function fetchChunk(start,end,minMag){ const params=new URLSearchParams({format:"geojson",starttime:toUtcStart(start),endtime:toUtcEnd(end),orderby:"time",limit:"20000"}); if(!Number.isNaN(minMag)) params.set("minmagnitude",String(minMag)); const res=await fetch(`https://earthquake.usgs.gov/fdsnws/event/1/query?${params}`,{cache:"no-store"}); if(!res.ok) throw new Error("HTTP "+res.status); const g=await res.json(); if(!g||!Array.isArray(g.features)) throw new Error("Invalid GeoJSON"); return g.features; }
async function fetchRange(start, end, minMag) {
  const chunks = buildChunks(start, end);
  setStatus(`Loading ${chunks.length} chunk${chunks.length>1?"s":""}…`, "loading");
  // Parallel fetch — all chunks fire simultaneously, cut load time from N×T to T
  // USGS FDSN allows concurrent requests; max 5 in parallel to be polite
  const BATCH = 5;
  const all = [], seen = new Set();
  for (let b = 0; b < chunks.length; b += BATCH) {
    const batch = chunks.slice(b, b + BATCH);
    const batchNum = Math.floor(b/BATCH)+1, totalBatches = Math.ceil(chunks.length/BATCH);
    if (totalBatches > 1) setStatus(`Batch ${batchNum}/${totalBatches}…`, "loading");
    const results = await Promise.all(batch.map(c => fetchChunk(c.start, c.end, minMag)));
    for (const features of results) {
      for (const f of features) {
        const id = f.id || `${f.properties?.time}_${f.properties?.place}`;
        if (!seen.has(id)) { seen.add(id); all.push(f); }
      }
    }
  }
  return { type: "FeatureCollection", metadata: {}, features: all };
}

// Build a unique cache key for the current fetch settings
function buildFetchKey() {
  const mode = modeEl?.value, minMag = parseFloat(minMagEl?.value);
  if (mode === "feed") return `feed:${feedEl?.value}:${minMag}`;
  return `range:${startDateEl?.value}:${endDateEl?.value}:${minMag}`;
}

// Update the cache-age display in the status bar right column
function updateCacheAgeDisplay() {
  if (!lastFetchTime || !mapStatusRightEl) return;
  const ageMs = Date.now() - lastFetchTime;
  const ageMins = Math.floor(ageMs / 60000);
  const ageSecs = Math.floor((ageMs % 60000) / 1000);
  const ageStr = ageMins > 0 ? `${ageMins}m ago` : `${ageSecs}s ago`;
  const fresh = ageMs < CACHE_TTL_MS;
  const dot = fresh ? "🟢" : "🟡";
  mapStatusRightEl.textContent = `${dot} Data: ${ageStr}`;
}

// Start a timer that ticks every 30s to update the cache age indicator
// and auto-refreshes when cache exceeds TTL (10 min)
function startCacheRefreshTimer() {
  if (cacheRefreshTimer) clearInterval(cacheRefreshTimer);
  cacheRefreshTimer = setInterval(async () => {
    updateCacheAgeDisplay();
    if (!lastFetchTime) return;
    const ageMs = Date.now() - lastFetchTime;
    if (ageMs >= CACHE_TTL_MS && modeEl?.value === "feed") {
      // Cache stale — silently refresh in background
      const key = buildFetchKey();
      setStatus("Auto-refreshing…", "loading");
      try {
        const geojson = await fetchFeed();
        lastGeoJSON = geojson;
        lastFetchTime = Date.now();
        lastFetchKey  = key;
        renderFromCurrentData({ preserveView: true });
        setStatus(`${geojson.features.length} shown`, "success");
      } catch(e) {
        setStatus("Auto-refresh failed", "error");
      }
    }
  }, 30000);
}

async function fetchEarthquakes(forceRefresh) {
  const mode = modeEl?.value, minMag = parseFloat(minMagEl?.value);
  const key  = buildFetchKey();

  // Use cache if data is fresh and same query, unless explicitly forced
  if (!forceRefresh && lastGeoJSON && lastFetchTime && lastFetchKey === key) {
    const ageMs = Date.now() - lastFetchTime;
    if (ageMs < CACHE_TTL_MS) {
      setStatus(`${lastGeoJSON.features.length} shown (cached)`, "success");
      updateCacheAgeDisplay();
      return lastGeoJSON;
    }
  }

  setStatus("Loading…", "loading");
  setMapStatus("", "Fetching earthquake data from USGS…", "");
  try {
    let geojson = null;
    if (mode === "feed") {
      geojson = await fetchFeed();
    } else {
      const start = startDateEl?.value, end = endDateEl?.value;
      if (!start || !end) { setStatus("Pick start and end dates", "error"); return null; }
      if (start > end)    { setStatus("Start must be before end",  "error"); return null; }
      geojson = await fetchRange(start, end, minMag);
    }
    lastGeoJSON   = geojson;
    lastFetchTime = Date.now();
    lastFetchKey  = key;
    setStatus(`${geojson.features.length} events loaded`, "success");
    updateCacheAgeDisplay();
    return geojson;
  } catch(err) {
    console.error(err);
    setStatus("Error loading data", "error");
    setMapStatus("Error", "Could not load earthquake data", "");
    return null;
  }
}

// ---------- RENDER ----------
function clearLayers() {
  if (quakeLayer && map.hasLayer(quakeLayer)) map.removeLayer(quakeLayer);
  if (heatLayer && map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
  quakeLayer = heatLayer = null;
}
function applyHeatOpacity(retries) {
  const opacity = (showHeatmapEl?.checked && heatOpacityEl) ? parseFloat(heatOpacityEl.value) : 0;
  if (heatLayer && heatLayer._canvas) {
    heatLayer._canvas.style.opacity = String(opacity);
  } else if (heatLayer && (retries ?? 0) < 15) {
    setTimeout(() => applyHeatOpacity((retries ?? 0) + 1), 60);
  }
  // Also dim the heatPane container as fallback
  const pane = map.getPane("heatPane");
  if (pane) pane.style.opacity = String(opacity);
}

let clusterLayer = null;

// ─────────────────────────────────────────────────────────────────────────────
// SMART CLUSTERING — data-size aware, zoom-graduated
//
//  < CLUSTER_MIN events  →  plain dots, no clustering at all
//  ≥ CLUSTER_MIN events  →  clustering active; dissolves gradually via radius
//
//  KEY DESIGN: there is NO hard disableClusteringAtZoom cutoff.
//  Instead the merge radius tapers zoom-by-zoom from 160 px → 5 px so clusters
//  shrink and split one-at-a-time as you drill in. You never see thousands of
//  dots suddenly appear — the transition is always smooth and controlled.
// ─────────────────────────────────────────────────────────────────────────────
const CLUSTER_MIN = 500;  // events below this → skip clustering entirely

// ─────────────────────────────────────────────────────────────────────────────
// CHUNKED ASYNC RENDER — prevents main-thread freeze on large datasets
//
//  Instead of building all N markers in one synchronous loop (which blocks the
//  browser for 1–4 seconds with 10 k+ features), we:
//    1. Pre-sort / pre-filter once (off the render critical path)
//    2. Build markers in chunks of RENDER_CHUNK, yielding after each chunk via
//       setTimeout(0) so the browser stays responsive
//    3. Add the completed cluster layer to the map in one shot after all
//       chunks are processed — Leaflet's internal R-tree is built once
//    4. Show a lightweight progress bar while building
//
//  Benchmark (all_month feed, ~10 k events, mid-range laptop):
//    Before: ~2.8 s freeze   After: <100 ms visible freeze, rest streamed
// ─────────────────────────────────────────────────────────────────────────────
const RENDER_CHUNK = 400;   // markers built per yielding tick
let   _renderGeneration = 0; // incremented on every new render; stale tasks self-cancel

// ── Tiny progress bar injected into the status strip ─────────────────────────
function _showRenderProgress(pct) {
  let bar = document.getElementById("_renderProgressBar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "_renderProgressBar";
    bar.style.cssText =
      "position:fixed;top:0;left:0;height:3px;z-index:99998;" +
      "background:linear-gradient(90deg,#3b82f6,#60a5fa);" +
      "transition:width 0.15s ease;pointer-events:none;border-radius:0 2px 2px 0;";
    document.body.appendChild(bar);
  }
  bar.style.width = pct + "%";
  bar.style.opacity = pct >= 100 ? "0" : "1";
}

function renderPoints(features){
  if(!showPointsEl?.checked || !features.length) return;

  // Tear down previous layer (cluster or plain GeoJSON)
  if (clusterLayer && map.hasLayer(clusterLayer)) { map.removeLayer(clusterLayer); clusterLayer = null; }

  // Bump generation — any in-flight chunked render will see the mismatch and abort
  const myGen = ++_renderGeneration;

  // Click handler — identical behaviour in both rendering modes
  function onQuakeClick(f, e) {
    L.DomEvent.stopPropagation(e);
    if (scenarioMode === "usgs") {
      const p      = f.properties || {};
      const coords = f.geometry?.coordinates;
      const snapLL = coords && coords.length >= 2
        ? L.latLng(coords[1], coords[0]) : e.latlng;
      usgsSource = {
        latlng:  snapLL,
        mag:     p.mag ?? "N/A",
        depthKm: coords?.[2] ?? 10,
        place:   p.place ?? "Unknown",
        time:    p.time  ?? null,
        feature: f
      };
      updateSelectedQuakeCard(); updateUsgsBtnStates();
      drawTravelGraphics(); runAnalysis();
      switchTab("scenario");
    }
  }

  // ── Helper: build a plain circle marker ───────────────────────────────────
  function makeCircleMarker(f) {
    const c   = f.geometry?.coordinates;
    if (!c || c.length < 2) return null;
    const mag = f.properties?.mag;
    const m   = L.circleMarker([c[1], c[0]], {
      pane:        "quakePane",
      radius:      getRadius(mag),
      fillColor:   getColor(mag),
      color:       "#fff",
      weight:      1.2,
      fillOpacity: 0.88,
      opacity:     1
    }).bindPopup(pointPopup(f), { maxWidth: 280 });
    m.on("click", e => onQuakeClick(f, e));
    return m;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MODE A — SMALL DATASET  (< CLUSTER_MIN events)
  // Show every dot directly. No clustering. wrapFeatures for antimeridian.
  // Small enough to render synchronously — no chunking needed.
  // ══════════════════════════════════════════════════════════════════════════
  if (features.length < CLUSTER_MIN) {
    quakeLayer = L.geoJSON(
      { type: "FeatureCollection", features: wrapFeatures(features) },
      {
        pointToLayer: (f, ll) => {
          const mag = f.properties?.mag;
          return L.circleMarker(ll, {
            pane:        "quakePane",
            radius:      getRadius(mag),
            fillColor:   getColor(mag),
            color:       "#fff",
            weight:      1.2,
            fillOpacity: 0.88,
            opacity:     1
          });
        },
        onEachFeature: (f, layer) => {
          layer.bindPopup(pointPopup(f), { maxWidth: 280 });
          layer.on("click", e => onQuakeClick(f, e));
        }
      }
    ).addTo(map);
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MODE B — LARGE DATASET  (≥ CLUSTER_MIN events)
  //
  // Cluster radius tapers with zoom so clusters split gradually — no sudden
  // explosion of dots on one zoom step.
  //
  //   zoom  2  → 160 px  whole Ring of Fire / Mid-Atlantic belt = 1 blob
  //   zoom  3  → 110 px  major subduction zones separate
  //   zoom  4+  →   0 px  individual dots (clustering off)
  //
  // Markers are added in async chunks to keep the main thread responsive.
  // ══════════════════════════════════════════════════════════════════════════
  const newCluster = L.markerClusterGroup({
    pane: "quakePane",
    maxClusterRadius: function(zoom) {
      if (zoom <= 2) return 160;
      if (zoom === 3) return 110;
      return 0;
    },
    disableClusteringAtZoom: 4,
    zoomToBoundsOnClick: true,
    showCoverageOnHover: true,
    spiderfyOnMaxZoom: true,
    spiderfyDistanceMultiplier: 1.5,

    // ── Cluster bubble design ──────────────────────────────────────────────
    iconCreateFunction: function(cluster) {
      const n = cluster.getChildCount();
      const sz = n > 5000 ? 58 : n > 1000 ? 50 : n > 300 ? 42 : n > 80 ? 34 : n > 20 ? 28 : 22;
      const col = n > 2000 ? "#dc2626" : n > 500 ? "#ea580c" : n > 100 ? "#d97706" : n > 30 ? "#2563eb" : "#16a34a";
      const label = n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : n;
      const pulse = n >= 1000
        ? `<div style="position:absolute;inset:-7px;border-radius:50%;border:2px solid ${col};opacity:0.3;animation:clusterPulse 2.2s ease-out infinite;pointer-events:none;"></div>`
        : "";
      return L.divIcon({
        html: `<div style="position:relative;width:${sz}px;height:${sz}px;">${pulse}
                 <div style="position:absolute;inset:0;border-radius:50%;background:${col};opacity:0.85;
                   border:2.5px solid rgba(255,255,255,0.8);box-shadow:0 2px 12px rgba(0,0,0,0.4);
                   display:flex;align-items:center;justify-content:center;font-weight:800;
                   letter-spacing:-0.3px;color:#fff;font-size:${sz >= 42 ? 12 : sz >= 32 ? 11 : 10}px;">
                   ${label}</div></div>`,
        className: "", iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2]
      });
    }
  });

  // ── Chunked async marker build ─────────────────────────────────────────────
  // Batch markers are accumulated off-DOM, then addLayers() is called once per
  // chunk — far cheaper than addLayer() one-by-one (avoids N R-tree rebuilds).
  _showRenderProgress(2);
  let idx = 0;
  const total = features.length;

  function processChunk() {
    // Stale render? A newer renderPoints() call has started — bail out.
    if (myGen !== _renderGeneration) { _showRenderProgress(100); return; }

    const batch = [];
    const end   = Math.min(idx + RENDER_CHUNK, total);
    for (; idx < end; idx++) {
      const m = makeCircleMarker(features[idx]);
      if (m) batch.push(m);
    }
    if (batch.length) newCluster.addLayers(batch); // single bulk insert

    const pct = Math.round((idx / total) * 92) + 2; // 2 → 94 % while chunking
    _showRenderProgress(pct);
    if (countTextEl) countTextEl.textContent = `${idx} / ${total} rendering…`;

    if (idx < total) {
      // Yield to browser — paints tiles, handles input, then continues
      setTimeout(processChunk, 0);
    } else {
      // All chunks done — add to map in one shot
      newCluster.addTo(map);
      clusterLayer = newCluster;
      quakeLayer   = clusterLayer;
      if (countTextEl) countTextEl.textContent = total + " shown";
      _showRenderProgress(100);
    }
  }

  // Kick off first chunk on next tick so the status bar repaints first
  setTimeout(processChunk, 0);
}
function renderHeatmap(features) {
  if (!showHeatmapEl?.checked || !features.length) return;
  // Build heatmap points in a deferred tick so it doesn't compete with renderPoints
  setTimeout(() => {
    const pts = [];
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      const c = f.geometry?.coordinates, mag = f.properties?.mag || 1;
      if (c && c.length >= 2) pts.push([c[1], c[0], Math.min(1, mag / 7)]);
    }
    if (!pts.length) return;
    heatLayer = L.heatLayer(pts, { radius:25, blur:18, maxZoom:7, minOpacity:.2 }).addTo(map);
    setTimeout(() => {
      if (heatLayer && heatLayer._canvas) {
        heatLayer._canvas.style.zIndex = "290";
        heatLayer._canvas.style.pointerEvents = "none";
      }
      applyHeatOpacity(0);
    }, 50);
  }, 20);
}

function setNiceMapView(features){
  if (!features.length) { map.setView([20,0],2); return; }
  let minLat=90, maxLat=-90, minLng=180, maxLng=-180;
  for (let i = 0; i < features.length; i++) {
    const c = features[i].geometry?.coordinates;
    if (!c || c.length < 2) continue;
    const lat = c[1], lng = c[0];
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  if (minLat > maxLat) { map.setView([20,0],2); return; }
  if ((maxLng - minLng) > 220 || (maxLat - minLat) > 120) { map.setView([20,0],2); return; }
  const b = L.latLngBounds([[minLat,minLng],[maxLat,maxLng]]);
  if (b.isValid()) map.fitBounds(b.pad(.12), {maxZoom:6}); else map.setView([20,0],2);
}

function renderFromCurrentData(opts={}){
  if(!lastGeoJSON) return;
  clearLayers();
  const features=getFilteredFeatures(lastGeoJSON);
  if(countTextEl) countTextEl.textContent=features.length+" shown";
  updateLegend(features);
  renderHeatmap(features);
  renderPoints(features);
  if(!opts.preserveView) setNiceMapView(features);
  setUpdatedNow();
  if(!opts.silent) setStatus(`${features.length} shown`,"success");
  setMapStatus(`${features.length} earthquakes loaded`,
    scenarioMode==="usgs"?"Click an earthquake dot to select it as source":"Go to Scenario tab to set up your scenario",
    "");
  updateCacheAgeDisplay();
  // Defer country list build — runs after render pipeline has yielded to browser
  setTimeout(() => buildCountryList(), 300);
  safeInvalidateMap(); updateStepper();
  // Rebuild charts after data render
  if (typeof buildCharts === "function") setTimeout(buildCharts, 60);
}

// ---------- TECTONIC PLATES ----------
// Local file has properties: datatype (RI/TF/FZ/TR/TH), geogdesc, platecode
// CDN fallback normalises verbose type strings → short codes so colour/label still work
const PLATES_CDN = "https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_boundaries.json";

/** Map verbose CDN type strings → the 2-letter codes used by getPlateColor/getPlateLabel */
function _normalisePlateType(raw) {
  if (!raw) return "PB";
  const r = raw.toLowerCase().trim();
  if (r.includes("trench") || r.includes("subduct"))         return "TR";
  if (r.includes("ridge") || r.includes("spread") || r.includes("rift")) return "RI";
  if (r.includes("transform"))                               return "TF";
  if (r.includes("fracture"))                                return "FZ";
  if (r.includes("thrust"))                                  return "TH";
  if (r.includes("convergent") || r.includes("collision"))   return "CB";
  if (r.includes("divergent"))                               return "DB";
  // If it's already a short code (RI, TF, TR, FZ, TH) return as-is
  if (/^[A-Z]{2,3}$/.test(raw.trim())) return raw.trim();
  return "PB";
}

async function loadPlates() {
  if (platesLoaded) return;
  setStatus("Loading tectonic plates…", "loading");
  let geojson = null;

  // Attempt 1 — local file (works when served over http/https)
  try {
    const res = await fetch(PLATES_FILE, { cache: "no-store" });
    if (!res.ok) throw new Error("local " + res.status);
    geojson = await res.json();
    // Local file already has correct property names — nothing to normalise
  } catch (e1) {
    // Attempt 2 — public CDN (fallback for file:// or missing local file)
    try {
      const res2 = await fetch(PLATES_CDN, { cache: "force-cache" });
      if (!res2.ok) throw new Error("CDN " + res2.status);
      const raw = await res2.json();
      if (raw?.features) {
        raw.features = raw.features.map(f => {
          const p = f.properties || {};
          // PB2002_boundaries uses "Type", "Name", "LAYER" etc.
          const rawType = p.Type || p.type || p.LAYER || p.datatype || "";
          return {
            ...f,
            properties: {
              datatype:  _normalisePlateType(rawType),
              geogdesc:  p.Name || p.name || p.FULLNAME || p.geogdesc || "Tectonic boundary",
              platecode: p.Code || p.code || p.platecode || ""
            }
          };
        });
      }
      geojson = raw;
    } catch (e2) {
      console.error("Plates load failed:", e1, e2);
      setStatus("Could not load tectonic plates", "error");
      return;
    }
  }

  try {
    const orig    = geojson.features || [];
    const wrapped = wrapFeatures(orig);

    // Visible lines layer (thin, coloured by type)
    const vis = L.geoJSON({ type: "FeatureCollection", features: wrapped }, {
      pane: "platePane",
      interactive: false,
      style: f => ({
        color:       getPlateColor(f.properties?.datatype),
        weight:      2,
        opacity:     1,
        fill:        false,
        fillOpacity: 0
      })
    });

    // Fat invisible hit-target layer for popups + hover glow
    const click = L.geoJSON({ type: "FeatureCollection", features: wrapped }, {
      pane: "platePane",
      style: f => ({
        color:       getPlateColor(f.properties?.datatype),
        weight:      14,
        opacity:     0.01,
        fill:        false,
        fillOpacity: 0
      }),
      onEachFeature: (f, layer) => {
        const p = f.properties || {};
        const typeLabel = getPlateLabel(p.datatype);
        const codeStr   = p.platecode ? ` · Code ${p.platecode}` : "";
        layer.bindPopup(
          `<b>Tectonic Boundary</b><br>
           <b>Type:</b> ${typeLabel} (${p.datatype ?? "?"})<br>
           <b>Description:</b> ${p.geogdesc ?? "N/A"}${codeStr}`
        );
        layer.on("mouseover", function () { this.setStyle({ opacity: 0.18 }); });
        layer.on("mouseout",  function () { this.setStyle({ opacity: 0.01 }); });
      }
    });

    platesLayer  = L.layerGroup([vis, click]);
    platesLoaded = true;
    updatePlateLegend(orig);
    setStatus("Tectonic plates loaded", "success");
  } catch (err) {
    console.error("Plates render error:", err);
    setStatus("Tectonic plates render error", "error");
  }
}

async function togglePlates() {
  const div = $("plateLegendDiv");
  if (!showPlatesEl?.checked) {
    if (platesLayer && map.hasLayer(platesLayer)) map.removeLayer(platesLayer);
    if (div) div.style.display = "none";
    return;
  }
  await loadPlates();
  if (platesLayer && !map.hasLayer(platesLayer)) platesLayer.addTo(map);
  if (div) div.style.display = "block";
}

// ---------- UI ----------
function updateModeUI(){ const isFeed=modeEl?.value==="feed"; if(feedGroup) feedGroup.style.display=isFeed?"flex":"none"; if(rangeGroup) rangeGroup.style.display=isFeed?"none":"flex"; if(rangeGroup2) rangeGroup2.style.display=isFeed?"none":"flex"; safeInvalidateMap(); }
function setYearRange(year){ if(startDateEl) startDateEl.value=`${year}-01-01`; if(endDateEl) endDateEl.value=`${year}-12-31`; }
function setAutoUI(on){ if(btnToggleAuto) btnToggleAuto.textContent=on?"Auto: ON":"Auto: OFF"; }
function downloadFiltered(){ if(!lastGeoJSON){setStatus("Nothing to download","error");return;} const features=getFilteredFeatures(lastGeoJSON); const blob=new Blob([JSON.stringify({type:"FeatureCollection",metadata:{generated:Date.now(),count:features.length},features},null,2)],{type:"application/json"}); const url=URL.createObjectURL(blob),a=document.createElement("a"); a.href=url; a.download="earthquakes_filtered.geojson"; a.click(); URL.revokeObjectURL(url); setStatus(`Downloaded ${features.length} features`,"success"); }

// ---------- EVENTS ----------
modeEl?.addEventListener("change",updateModeUI);

document.querySelectorAll(".tab").forEach(tab=>{
  tab.addEventListener("click",()=>switchTab(tab.dataset.tab));
});

document.querySelectorAll(".mode-card").forEach(card=>{
  card.addEventListener("click",()=>switchScenarioMode(card.dataset.mode));
});

let filterDebounceTimer = null;
minMagEl?.addEventListener("input", () => {
  updateMinMagDisplay();
  // Debounce: wait 150ms after user stops sliding before re-rendering
  // Prevents re-rendering on every pixel of slider movement
  clearTimeout(filterDebounceTimer);
  filterDebounceTimer = setTimeout(() => {
    if (lastGeoJSON) renderFromCurrentData({ preserveView: true });
  }, 150);
});

customMagnitudeEl?.addEventListener("input",()=>{ updateScenMagDisplay(); if(customSource) runAnalysis(); });
customDepthEl?.addEventListener("input",()=>{ updateScenDepthDisplay(); if(customSource) runAnalysis(); });

btnPickCustomSource?.addEventListener("click",()=>{
  pickingCustomSource=true; pickingCustomSite=false; pickingUsgsSite=false;
  setMapHint("Click on the map to place the earthquake source",true);
  setMapStatus("","Click map to place earthquake source","");
});
btnPickSite?.addEventListener("click",()=>{
  pickingCustomSite=true; pickingCustomSource=false; pickingUsgsSite=false;
  setMapHint("Click on the map to place the analysis site",true);
  setMapStatus("","Click map to place analysis site","");
});
btnPickSiteUSGS?.addEventListener("click",()=>{
  if(!usgsSource){ alert("Select a USGS earthquake first by clicking a dot on the map."); return; }
  pickingUsgsSite=true; pickingCustomSource=false; pickingCustomSite=false;
  setMapHint("Click on the map to place the analysis site",true);
  setMapStatus("","Click map to place analysis site","");
});

btnClearScenario?.addEventListener("click",resetCustomScenario);
btnClearUSGS?.addEventListener("click",resetUSGSScenario);

showPointsEl?.addEventListener("change",()=>{ if(lastGeoJSON) renderFromCurrentData({preserveView:true}); else updateLegend([]); });
showHeatmapEl?.addEventListener("change", () => {
  // Show/hide opacity slider
  if (heatOpacityGroupEl) {
    heatOpacityGroupEl.style.display = showHeatmapEl.checked ? "flex" : "none";
  }
  if (!lastGeoJSON) return;
  if (!showHeatmapEl.checked) {
    // Just remove the heat layer — leave quake points untouched
    if (heatLayer && map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
    heatLayer = null;
  } else {
    // Build and add heat layer without touching quake points
    const features = getFilteredFeatures(lastGeoJSON);
    const pts = [];
    features.forEach(f => {
      const c = f.geometry?.coordinates, mag = f.properties?.mag || 1;
      if (!c || c.length < 2) return;
      pts.push([c[1], c[0], Math.min(1, mag / 7)]);
    });
    if (pts.length) {
      heatLayer = L.heatLayer(pts, { radius:25, blur:18, maxZoom:7, minOpacity:.2 }).addTo(map);
      setTimeout(() => {
        if (heatLayer && heatLayer._canvas) {
          heatLayer._canvas.style.zIndex = "290";
          heatLayer._canvas.style.pointerEvents = "none";
        }
        applyHeatOpacity(0);
      }, 50);
    }
  }
});
showPlatesEl?.addEventListener("change",async()=>await togglePlates());
showImpactZonesEl?.addEventListener("change",()=>{ updateLegend(lastGeoJSON?getFilteredFeatures(lastGeoJSON):[]); renderAnimFrame(); });
animateImpactEl?.addEventListener("change",()=>renderAnimFrame());
heatOpacityEl?.addEventListener("input",()=>{ if(heatOpacityValueEl) heatOpacityValueEl.textContent=Math.round(parseFloat(heatOpacityEl.value)*100)+"%"; applyHeatOpacity(); });

// IPE model selectors (custom + USGS panels stay in sync)
function onIPEChange(val) {
  activeIPE = val;
  const note = IPE_MODELS[val]?.note || "";
  const noteEl = $("ipeModelNote");
  if (noteEl) noteEl.textContent = note;
  // Sync both selectors
  const s1 = $("ipeModel"), s2 = $("ipeModelUSGS");
  if (s1 && s1.value !== val) s1.value = val;
  if (s2 && s2.value !== val) s2.value = val;
  updateLegend(lastGeoJSON ? getFilteredFeatures(lastGeoJSON) : []);
  if (activeAnalysis?.source) runAnalysis();
}
function onSiteClassChange(val) {
  activeSiteClass = parseInt(val, 10);
  // Sync both selectors
  const s1 = $("siteClass"), s2 = $("siteClassUSGS");
  if (s1 && s1.value !== val) s1.value = val;
  if (s2 && s2.value !== val) s2.value = val;
  if (activeAnalysis?.source) runAnalysis();
}
$("ipeModel")?.addEventListener("change", e => onIPEChange(e.target.value));
$("ipeModelUSGS")?.addEventListener("change", e => onIPEChange(e.target.value));
$("siteClass")?.addEventListener("change", e => onSiteClassChange(e.target.value));
$("siteClassUSGS")?.addEventListener("change", e => onSiteClassChange(e.target.value));

btnPlayAnimation?.addEventListener("click",startAnimation);
btnPauseAnimation?.addEventListener("click",pauseAnimation);
btnResetAnimation?.addEventListener("click",resetAnimation);
btnStepAnimation?.addEventListener("click",()=>{ if(!activeAnalysis?.source){setTravelNote("Set a scenario source first.");return;} pauseAnimation(); animationElapsedSec=Math.min(getAnimEnd(),animationElapsedSec+5); renderAnimFrame(); });
animationSpeedEl?.addEventListener("input",updateSpeedLabel);
timelineSliderEl?.addEventListener("mousedown",()=>{ isScrubbingTimeline=true; pauseAnimation(); });
timelineSliderEl?.addEventListener("touchstart",()=>{ isScrubbingTimeline=true; pauseAnimation(); });
timelineSliderEl?.addEventListener("input",()=>{ if(!activeAnalysis?.source) return; animationElapsedSec=parseFloat(timelineSliderEl.value); updateTimelineLabel(); renderAnimFrame(); });
timelineSliderEl?.addEventListener("change",()=>{ isScrubbingTimeline=false; });

btnLoad?.addEventListener("click",async()=>{ const g=await fetchEarthquakes(true); if(g) renderFromCurrentData({preserveView:false}); }); // force=true bypasses cache
btnPrevYear?.addEventListener("click",async()=>{ if(modeEl) modeEl.value="range"; updateModeUI(); setYearRange(new Date().getFullYear()-1); const g=await fetchEarthquakes(true); if(g) renderFromCurrentData({preserveView:false}); });
feedEl?.addEventListener("change",async()=>{ if(modeEl?.value!=="feed") return; const g=await fetchEarthquakes(); if(g) renderFromCurrentData({preserveView:false}); });
btnToggleAuto?.addEventListener("click",async()=>{ if(autoTimer){clearInterval(autoTimer);autoTimer=null;setAutoUI(false);setStatus("Auto-refresh stopped","success");return;} setAutoUI(true);setStatus("Auto-refresh every 60s","loading"); const g=await fetchEarthquakes(true); if(g) renderFromCurrentData({preserveView:true}); autoTimer=setInterval(async()=>{ const r=await fetchEarthquakes(true); if(r) renderFromCurrentData({preserveView:true}); },60000); });
btnDownload?.addEventListener("click",downloadFiltered);

// Map click handler
map.on("click",(e)=>{
  if(pickingCustomSource){
    customSource={latlng:e.latlng}; pickingCustomSource=false;
    setMapHint("",false); updateCustomBtnStates(); drawTravelGraphics(); runAnalysis(); return;
  }
  if(pickingCustomSite){
    customSite=e.latlng; pickingCustomSite=false;
    setMapHint("",false); updateCustomBtnStates(); drawTravelGraphics(); runAnalysis(); return;
  }
  if(pickingUsgsSite){
    usgsSite=e.latlng; pickingUsgsSite=false;
    setMapHint("",false); updateUsgsBtnStates(); drawTravelGraphics();
    runAnalysis();
    return;
  }
});

window.addEventListener("load",()=>setTimeout(()=>safeInvalidateMap(),300));
window.addEventListener("resize",safeInvalidateMap);

// ---------- MAP SEARCH + HOME ----------------------------------------
const DEFAULT_VIEW = { lat: 20, lng: 0, zoom: 2 };

function mapHomeView() {
  map.setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lng], DEFAULT_VIEW.zoom, { animate: true });
}

// Nominatim geocoder (OpenStreetMap) — free, no API key required
// Usage policy: max 1 req/sec, include user-agent
let searchDebounceTimer = null;
let searchMarker = null;

async function geocodeSearch(query) {
  const resultsEl = $("mapSearchResults");
  if (!query || query.length < 2) { resultsEl.style.display = "none"; return; }
  resultsEl.style.display = "block";
  resultsEl.innerHTML = '<div class="msr-loading">Searching…</div>';
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=6&addressdetails=1`;
    const res  = await fetch(url, { headers: { "Accept-Language": "en", "User-Agent": "EarthquakeAnalysisApp/1.0" } });
    const data = await res.json();
    if (!data.length) {
      resultsEl.innerHTML = '<div class="msr-empty">No results found.</div>'; return;
    }
    resultsEl.innerHTML = data.map((r,i) => {
      const name    = r.display_name.split(",")[0];
      const country = r.address?.country || "";
      const type    = (r.type || r.class || "").replace(/_/g," ");
      return `<div class="msr-item" data-idx="${i}" data-lat="${r.lat}" data-lon="${r.lon}" data-bb='${JSON.stringify(r.boundingbox)}'>
        <strong>${name}</strong>
        <span>${[type, country].filter(Boolean).join(" · ")}</span>
      </div>`;
    }).join("");
    resultsEl.querySelectorAll(".msr-item").forEach(el => {
      el.addEventListener("click", () => {
        const lat  = parseFloat(el.dataset.lat);
        const lon  = parseFloat(el.dataset.lon);
        const bb   = JSON.parse(el.dataset.bb); // [minLat, maxLat, minLon, maxLon]
        resultsEl.style.display = "none";
        $("mapSearchInput").value = el.querySelector("strong").textContent;
        // Fly to bounding box if available, else zoom to point
        if (bb && bb.length === 4) {
          const bounds = L.latLngBounds([[+bb[0],+bb[2]],[+bb[1],+bb[3]]]);
          map.fitBounds(bounds, { maxZoom: 14, animate: true, padding: [30,30] });
        } else {
          map.setView([lat,lon], 12, { animate: true });
        }
        // Place a temporary blue pin
        if (searchMarker) map.removeLayer(searchMarker);
        searchMarker = L.circleMarker([lat,lon], {
          pane: "travelPane", radius: 8, color: "#1d4ed8", weight: 2,
          fillColor: "#3b82f6", fillOpacity: 0.9
        }).bindPopup(`<b>${el.querySelector("strong").textContent}</b>`).addTo(map).openPopup();
        // Auto-remove pin after 6 seconds
        setTimeout(() => { if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; } }, 6000);
      });
    });
  } catch(e) {
    resultsEl.innerHTML = '<div class="msr-error">Search unavailable — check connection.</div>';
  }
}

// Close search results when clicking outside
document.addEventListener("click", e => {
  if (!e.target.closest("#mapSearchControl")) {
    const r = $("mapSearchResults"); if(r) r.style.display = "none";
  }
});

// ---------- MAP SEARCH + HOME ----------

// ---------- IMPACT REPORT ------------------------------------------------
// ---------- REPORT GENERATION -----------------------------------------------
let reportWindow    = null;  // keep reference so clicking twice reuses same tab
let reportUrlCached = null;  // track what URL is currently open

function generateReport() {
  const src = scenarioMode === "custom"
    ? (customSource ? { latlng:customSource.latlng, mag:parseFloat(customMagnitudeEl?.value)||6, depthKm:parseFloat(customDepthEl?.value)||10, place:"Custom Source", time:Date.now() } : null)
    : (usgsSource   ? { latlng:usgsSource.latlng, mag:usgsSource.mag, depthKm:usgsSource.depthKm||10, place:usgsSource.place, time:usgsSource.time||Date.now() } : null);

  if (!src) {
    alert("Please place an earthquake source first (Scenario tab) before generating a report.");
    return;
  }

  const site = scenarioMode === "custom" ? customSite : usgsSite;
  const p = new URLSearchParams({
    lat:   src.latlng.lat.toFixed(5),
    lng:   src.latlng.lng.toFixed(5),
    mag:   parseFloat(src.mag).toFixed(1),
    depth: parseFloat(src.depthKm).toFixed(1),
    place: src.place || "Custom Source",
    time:  String(src.time instanceof Date ? src.time.getTime() : src.time),
    mode:  scenarioMode,
  });
  if (site) { p.set("siteLat", site.lat.toFixed(5)); p.set("siteLng", site.lng.toFixed(5)); }
  // Pass active IPE and site class so the report uses the same model
  p.set("ipe",       activeIPE       || "atkinson");
  p.set("siteClass", String(activeSiteClass ?? 1));
  const url = "earthquake_report.html?" + p.toString();

  if (reportWindow && !reportWindow.closed && reportUrlCached === url) {
    // Same report already open — just focus it, don't reload
    reportWindow.focus();
  } else {
    // Open new tab (or replace old one if parameters changed)
    reportWindow    = window.open(url, "eqImpactReport");
    reportUrlCached = url;
  }
}

// ---------- INIT ----------
(function init(){
  // Search input — debounced Nominatim call
  const searchInput = $("mapSearchInput");
  const searchBtn   = $("mapSearchBtn");
  const homeBtn     = $("mapHomeBtn");

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      clearTimeout(searchDebounceTimer);
      const q = searchInput.value.trim();
      if (!q) { const r=$("mapSearchResults"); if(r) r.style.display="none"; return; }
      searchDebounceTimer = setTimeout(() => geocodeSearch(q), 400);
    });
    searchInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { clearTimeout(searchDebounceTimer); geocodeSearch(searchInput.value.trim()); }
      if (e.key === "Escape") { const r=$("mapSearchResults"); if(r) r.style.display="none"; }
    });
  }
  if (searchBtn) searchBtn.addEventListener("click", () => geocodeSearch($("mapSearchInput")?.value?.trim()));
  if (homeBtn)   homeBtn.addEventListener("click", mapHomeView);

  const zoomInBtn  = $("mapZoomIn");
  const zoomOutBtn = $("mapZoomOut");
  if (zoomInBtn)  zoomInBtn.addEventListener("click",  () => map.zoomIn());
  if (zoomOutBtn) zoomOutBtn.addEventListener("click", () => map.zoomOut());
  $("btnGenerateReport")?.addEventListener("click", generateReport);

  updateModeUI();
  const today=new Date(), end=today.toISOString().slice(0,10);
  const start=new Date(today); start.setDate(today.getDate()-30);
  if(startDateEl) startDateEl.value=start.toISOString().slice(0,10);
  if(endDateEl)   endDateEl.value  =end;
  updateMinMagDisplay(); updateScenMagDisplay(); updateScenDepthDisplay();
  updateSpeedLabel(); updateTimelineLabel();
  updateCustomBtnStates(); updateUsgsBtnStates(); updateSelectedQuakeCard();
  applyHeatOpacity(); setStatus("Ready","success");
  updateLegend([]); // initialise legend visibility based on all toggles
  switchScenarioMode("custom"); // start in custom mode
  updateStepper();
  // Start background cache-age ticker (updates right side of status bar every 30s,
  // auto-refreshes feed data when cache exceeds 10 min)
  startCacheRefreshTimer();

  (async function initialLoad(){ const g=await fetchEarthquakes(); if(g) renderFromCurrentData({preserveView:false}); })();
})();
// =============================================================================
// CHARTS MODULE — Chart.js powered statistics panel
// =============================================================================
let mainChartInstance = null;

function buildCharts() {
  if (typeof Chart === "undefined") return;
  const features = lastGeoJSON ? getFilteredFeatures(lastGeoJSON) : [];
  const chartTypeEl = $("chartType");
  const canvas = $("mainChart");
  const emptyEl = $("chartEmpty");
  const statsEl = $("chartStats");
  if (!chartTypeEl || !canvas) return;

  if (!features.length) {
    if (canvas) canvas.style.display = "none";
    if (emptyEl) { emptyEl.style.display = "block"; emptyEl.textContent = "Load earthquake data to see charts."; }
    if (statsEl) statsEl.innerHTML = "";
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";
  if (canvas) canvas.style.display = "block";

  if (mainChartInstance) { mainChartInstance.destroy(); mainChartInstance = null; }

  const type = chartTypeEl.value;
  const mags  = features.map(f => f.properties?.mag).filter(m => m != null);
  const depths = features.map(f => f.geometry?.coordinates?.[2]).filter(d => d != null);
  const times  = features.map(f => f.properties?.time).filter(t => t != null).map(t => new Date(t));

  const ctx = canvas.getContext("2d");
  const FONT = "'Arial', sans-serif";


  // ── Gutenberg-Richter b-value ───────────────────────────────────────────────
  if (type === "grCurve") {
    const grPanel = $("grPanel"), grResults = $("grResults");
    const Mc = parseFloat(minMagEl?.value) || 2.5;
    const gr = calcGutenbergRichter(mags, Mc);
    if (!gr) {
      if (emptyEl) { emptyEl.style.display = "block"; emptyEl.textContent = "Need ≥10 events above Mc for G-R analysis."; }
      if (grPanel) grPanel.style.display = "none";
      return;
    }
    if (emptyEl) emptyEl.style.display = "none";
    canvas.style.display = "block";
    mainChartInstance = new Chart(ctx, {
      type: "scatter",
      data: { datasets: [
        { label:"Observed (cumulative)", data:gr.mRange.map((m,i)=>({x:m,y:gr.observed[i]})),
          backgroundColor:"#3b82f6", borderColor:"#3b82f6", pointRadius:4, showLine:false },
        { label:`G-R fit  b = ${gr.b.toFixed(3)} ± ${gr.sigma_b.toFixed(3)}`,
          data:gr.mRange.map((m,i)=>({x:m,y:gr.predicted[i]})),
          borderColor:"#ef4444", backgroundColor:"transparent",
          borderWidth:2, pointRadius:0, showLine:true, type:"line" }
      ]},
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:true,position:"top",labels:{font:{size:11}}},
          tooltip:{callbacks:{label:i=>`M${i.raw.x.toFixed(2)}: ${Math.round(i.raw.y)} events`}} },
        scales:{
          x:{title:{display:true,text:"Magnitude",font:{size:11}},ticks:{font:{size:10}}},
          y:{type:"logarithmic",title:{display:true,text:"Cumulative N(≥M)",font:{size:11}},ticks:{font:{size:10}}}
        }
      }
    });
    if (grPanel)   grPanel.style.display   = "block";
    if (grResults) grResults.innerHTML = `
      <div class="result-row"><span>b-value</span><strong>${gr.b.toFixed(3)} ± ${gr.sigma_b.toFixed(3)}</strong></div>
      <div class="result-row"><span>a-value</span><strong>${gr.a.toFixed(3)}</strong></div>
      <div class="result-row"><span>M<sub>c</sub> used / est.</span><strong>${gr.Mc.toFixed(1)} / ${gr.McEst.toFixed(1)}</strong></div>
      <div class="result-row"><span>Events above M<sub>c</sub></span><strong>${gr.n}</strong></div>
      <div class="result-row"><span>Mean M above M<sub>c</sub></span><strong>${gr.Mbar.toFixed(3)}</strong></div>`;
    if (statsEl) statsEl.innerHTML = `<div class="chart-stat-grid">
      <div class="chart-stat-cell"><div class="chart-stat-val">${gr.b.toFixed(3)}</div><div class="chart-stat-lbl">b-value</div></div>
      <div class="chart-stat-cell"><div class="chart-stat-val">±${gr.sigma_b.toFixed(3)}</div><div class="chart-stat-lbl">&sigma;<sub>b</sub></div></div>
      <div class="chart-stat-cell"><div class="chart-stat-val">${gr.n}</div><div class="chart-stat-lbl">Events (M&ge;M<sub>c</sub>)</div></div>
    </div>`;
    return;
  }

  // ── Multi-IPE comparison ─────────────────────────────────────────────────────
  if (type === "mmiCompare") {
    const srcLL = scenarioMode==="custom" ? customSource?.latlng : usgsSource?.latlng;
    const mag   = scenarioMode==="custom" ? parseFloat(customMagnitudeEl?.value)||6 : usgsSource?.mag||6;
    const dep   = scenarioMode==="custom" ? parseFloat(customDepthEl?.value)||10 : usgsSource?.depthKm||10;
    const grPanel = $("grPanel"); if (grPanel) grPanel.style.display = "none";
    if (!srcLL) {
      if (emptyEl) { emptyEl.style.display="block"; emptyEl.textContent="Set a scenario source first."; }
      return;
    }
    if (emptyEl) emptyEl.style.display = "none";
    canvas.style.display = "block";
    const distances = [5,10,20,50,100,200,400,700,1000];
    const palette = { bilal:"#ef4444", atkinson:"#3b82f6", worden:"#059669" };
    const sigma = IPE_SIGMA[activeIPE] || 0.8;
    const activeFn = IPE_MODELS[activeIPE].fn;
    const datasets = Object.entries(IPE_MODELS).map(([key,model])=>({
      label: model.shortName + " — " + model.name,
      data: distances.map(d => Math.max(0, model.fn(mag,d,dep))),
      borderColor: palette[key], backgroundColor:"transparent",
      borderWidth:2.5, pointRadius:3, tension:0.3
    }));
    // ±1σ band for active model
    datasets.push({ label:`${IPE_MODELS[activeIPE].shortName} +1σ`, data:distances.map(d=>Math.max(0,activeFn(mag,d,dep)+sigma)), borderColor:palette[activeIPE]+"66", borderDash:[5,4], borderWidth:1, pointRadius:0, fill:"+1", backgroundColor:palette[activeIPE]+"18" });
    datasets.push({ label:`${IPE_MODELS[activeIPE].shortName} -1σ`, data:distances.map(d=>Math.max(0,activeFn(mag,d,dep)-sigma)), borderColor:palette[activeIPE]+"66", borderDash:[5,4], borderWidth:1, pointRadius:0, fill:false });
    // MMI threshold lines
    [{v:8,l:"Severe"},{v:6,l:"Moderate"},{v:4.5,l:"Light"},{v:2.5,l:"Felt"}].forEach((t,i)=>{
      const cols=["#ef444466","#fb923c66","#d9770666","#65a30d66"];
      datasets.push({label:t.l+" MMI≥"+t.v, data:distances.map(()=>t.v), borderColor:cols[i], borderDash:[2,4], borderWidth:1, pointRadius:0, fill:false});
    });
    mainChartInstance = new Chart(ctx, {
      type:"line", data:{labels:distances.map(d=>d+"km"),datasets},
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:true,position:"top",labels:{font:{size:10},boxWidth:16}} },
        scales:{
          x:{title:{display:true,text:"Epicentral distance",font:{size:11}},ticks:{font:{size:10}}},
          y:{title:{display:true,text:"MMI",font:{size:11}},ticks:{font:{size:10}},suggestedMin:0,suggestedMax:10}
        }
      }
    });
    if (statsEl) {
      const cells = Object.entries(IPE_MODELS).map(([k,m])=>`<div class="chart-stat-cell"><div class="chart-stat-val">${m.fn(mag,10,dep).toFixed(1)}</div><div class="chart-stat-lbl">${m.shortName}@10km</div></div>`).join("");
      statsEl.innerHTML = `<div class="chart-stat-grid">${cells}</div>`;
    }
    return;
  }

  // Hide G-R panel for other chart types
  const grPanel2 = $("grPanel"); if (grPanel2) grPanel2.style.display = "none";

  if (type === "magHist") {
    // Magnitude histogram in 0.5 bins
    const bins = [0,0.5,1,1.5,2,2.5,3,3.5,4,4.5,5,5.5,6,6.5,7,7.5,8,8.5,9];
    const counts = bins.map((b,i) => i < bins.length-1 ? mags.filter(m => m >= b && m < bins[i+1]).length : 0);
    const bgColors = bins.map(b => b<3?"#86efac":b<4?"#fde047":b<5?"#fb923c":b<6?"#f97316":"#ef4444");
    mainChartInstance = new Chart(ctx, {
      type: "bar",
      data: { labels: bins.slice(0,-1).map(b=>b.toFixed(1)), datasets: [{ data: counts.slice(0,-1), backgroundColor: bgColors, borderRadius: 3, borderSkipped: false }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend:{display:false}, tooltip:{callbacks:{title:([i])=>`M ${i.label}–${(parseFloat(i.label)+0.5).toFixed(1)}`, label:i=>`${i.raw} events`}} }, scales: { x:{title:{display:true,text:"Magnitude",font:{size:11}},ticks:{font:{size:10}}}, y:{title:{display:true,text:"Count",font:{size:11}},ticks:{font:{size:10},precision:0},beginAtZero:true} } }
    });
    const maxM = mags.length ? Math.max(...mags) : 0;
    const minM = mags.length ? Math.min(...mags) : 0;
    const avgM = mags.length ? mags.reduce((a,b)=>a+b,0)/mags.length : 0;
    statsEl.innerHTML = `<div class="chart-stat-grid">
      <div class="chart-stat-cell"><div class="chart-stat-val">${mags.length}</div><div class="chart-stat-lbl">Events</div></div>
      <div class="chart-stat-cell"><div class="chart-stat-val">M${maxM.toFixed(1)}</div><div class="chart-stat-lbl">Largest</div></div>
      <div class="chart-stat-cell"><div class="chart-stat-val">M${avgM.toFixed(1)}</div><div class="chart-stat-lbl">Average</div></div>
    </div>`;

  } else if (type === "depthScatter") {
    // Clamp any negative depth values to 0 (USGS occasionally reports -1 or -2)
    const points = features.map(f => ({
      x:     Math.max(0, f.geometry?.coordinates?.[2] ?? 0),
      y:     f.properties?.mag ?? 0,
      r:     Math.max(2, (f.properties?.mag ?? 0)),
      place: f.properties?.place || "Unknown location",
      date:  f.properties?.time ? new Date(f.properties.time).toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"}) : "Unknown date",
      time:  f.properties?.time ? new Date(f.properties.time).toLocaleString() : ""
    })).filter(p => p.y > 0);
    const cols = points.map(p => p.y>=6?"#ef4444":p.y>=5?"#fb923c":p.y>=4?"#fde047":"#86efac");
    mainChartInstance = new Chart(ctx, {
      type: "bubble",
      data: { datasets: [{ data: points, backgroundColor: cols.map(c=>c+"aa"), borderColor: cols, borderWidth: 1 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: items => items[0]?.raw?.place || "",
              label: i => `M${i.raw.y.toFixed(1)}  ·  Depth ${i.raw.x.toFixed(0)} km`,
              afterLabel: i => i.raw.date
            },
            titleFont: { size: 12, weight: "bold" },
            bodyFont:  { size: 12 },
            padding: 10
          }
        },
        scales: {
          x: { min:0, title:{display:true,text:"Depth (km)",font:{size:11}}, ticks:{font:{size:10}} },
          y: { title:{display:true,text:"Magnitude",font:{size:11}}, ticks:{font:{size:10}} }
        }
      }
    });
    const avgD = depths.length ? depths.reduce((a,b)=>a+b,0)/depths.length : 0;
    statsEl.innerHTML = `<div class="chart-stat-grid">
      <div class="chart-stat-cell"><div class="chart-stat-val">${points.length}</div><div class="chart-stat-lbl">Plotted</div></div>
      <div class="chart-stat-cell"><div class="chart-stat-val">${depths.length?Math.max(...depths).toFixed(0):"-"}km</div><div class="chart-stat-lbl">Max depth</div></div>
      <div class="chart-stat-cell"><div class="chart-stat-val">${avgD.toFixed(0)}km</div><div class="chart-stat-lbl">Avg depth</div></div>
    </div>`;

  } else if (type === "timeline") {
    // Group by day
    const dayMap = {};
    times.forEach(t => {
      const day = t.toISOString().slice(0,10);
      dayMap[day] = (dayMap[day]||0)+1;
    });
    const days = Object.keys(dayMap).sort();
    const counts2 = days.map(d => dayMap[d]);
    mainChartInstance = new Chart(ctx, {
      type: "line",
      data: { labels: days, datasets: [{ data: counts2, borderColor:"#2563eb", backgroundColor:"#2563eb22", fill:true, tension:0.3, pointRadius:2 }] },
      options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},tooltip:{callbacks:{label:i=>`${i.raw} events`}}}, scales:{ x:{title:{display:true,text:"Date",font:{size:11}},ticks:{font:{size:10},maxTicksLimit:8,maxRotation:30}}, y:{title:{display:true,text:"Events/day",font:{size:11}},ticks:{font:{size:10},precision:0},beginAtZero:true} } }
    });
    const maxDay = days.length ? days[counts2.indexOf(Math.max(...counts2))] : "-";
    statsEl.innerHTML = `<div class="chart-stat-grid">
      <div class="chart-stat-cell"><div class="chart-stat-val">${days.length}</div><div class="chart-stat-lbl">Days</div></div>
      <div class="chart-stat-cell"><div class="chart-stat-val">${Math.max(...counts2)||0}</div><div class="chart-stat-lbl">Peak/day</div></div>
      <div class="chart-stat-cell"><div class="chart-stat-val">${maxDay}</div><div class="chart-stat-lbl">Busiest day</div></div>
    </div>`;

  } else if (type === "depthDist") {
    // Depth distribution: shallow(<70), intermediate(70-300), deep(>300)
    const shallow = depths.filter(d=>d<70).length;
    const inter   = depths.filter(d=>d>=70&&d<=300).length;
    const deep    = depths.filter(d=>d>300).length;
    mainChartInstance = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: ["Shallow (<70 km)","Intermediate (70–300 km)","Deep (>300 km)"],
        datasets: [{ data:[shallow,inter,deep], backgroundColor:["#3b82f6","#7c3aed","#0f172a"], borderWidth:2 }]
      },
      options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position:"bottom", labels:{font:{size:11},padding:10} }, tooltip:{callbacks:{label:i=>`${i.label}: ${i.raw} (${depths.length?((i.raw/depths.length)*100).toFixed(0):0}%)`}} } }
    });
    statsEl.innerHTML = `<div class="chart-stat-grid">
      <div class="chart-stat-cell"><div class="chart-stat-val">${shallow}</div><div class="chart-stat-lbl">Shallow</div></div>
      <div class="chart-stat-cell"><div class="chart-stat-val">${inter}</div><div class="chart-stat-lbl">Intermediate</div></div>
      <div class="chart-stat-cell"><div class="chart-stat-val">${deep}</div><div class="chart-stat-lbl">Deep</div></div>
    </div>`;
  }
}

// chart type selector change is wired in the direct-bind block below

// =============================================================================
// FULLSCREEN CHART
// =============================================================================
let fsChartInstance = null;

function buildFullscreenChart(type) {
  if (typeof Chart === "undefined") return;
  const features = lastGeoJSON ? getFilteredFeatures(lastGeoJSON) : [];
  if (!features.length) return;

  const canvas  = $("mainChartFS");
  const statsEl = $("chartStatsFS");
  if (!canvas) return;

  if (fsChartInstance) { fsChartInstance.destroy(); fsChartInstance = null; }

  const mags   = features.map(f => f.properties?.mag).filter(m => m != null);
  const depths = features.map(f => f.geometry?.coordinates?.[2]).filter(d => d != null);
  const times  = features.map(f => f.properties?.time).filter(t => t != null).map(t => new Date(t));
  const ctx    = canvas.getContext("2d");

  function statCell(val, lbl) {
    return `<div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:8px 14px;text-align:center;">
      <div style="font-size:18px;font-weight:800;color:#f1f5f9;">${val}</div>
      <div style="font-size:11px;color:#64748b;margin-top:2px;">${lbl}</div>
    </div>`;
  }

  
  // ── Gutenberg-Richter FS ────────────────────────────────────────────────────
  if (type === "grCurve") {
    const Mc = parseFloat(minMagEl?.value) || 2.5;
    const gr = calcGutenbergRichter(mags, Mc);
    if (!gr) { if(statsEl) statsEl.innerHTML=statCell("N/A","≥10 events needed"); return; }
    fsChartInstance = new Chart(ctx, {
      type:"scatter",
      data:{datasets:[
        {label:"Observed",data:gr.mRange.map((m,i)=>({x:m,y:gr.observed[i]})),backgroundColor:"#60a5fa",borderColor:"#60a5fa",pointRadius:4,showLine:false},
        {label:`G-R b=${gr.b.toFixed(3)}±${gr.sigma_b.toFixed(3)}`,data:gr.mRange.map((m,i)=>({x:m,y:gr.predicted[i]})),borderColor:"#f87171",backgroundColor:"transparent",borderWidth:2,pointRadius:0,showLine:true,type:"line"}
      ]},
      options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{display:true,position:"top",labels:{color:"#94a3b8",font:{size:12}}}},
        scales:{
          x:{title:{display:true,text:"Magnitude",color:"#94a3b8"},ticks:{color:"#94a3b8"}},
          y:{type:"logarithmic",title:{display:true,text:"Cumulative N(≥M)",color:"#94a3b8"},ticks:{color:"#94a3b8"}}
        }
      }
    });
    if(statsEl) statsEl.innerHTML=statCell(`${gr.b.toFixed(3)} ± ${gr.sigma_b.toFixed(3)}`,"b-value (±σ)")+statCell(gr.a.toFixed(3),"a-value")+statCell(gr.n,"Events (Mc+)");
    return;
  }

  // ── Multi-IPE comparison FS ─────────────────────────────────────────────────
  if (type === "mmiCompare") {
    const srcLL = scenarioMode==="custom" ? customSource?.latlng : usgsSource?.latlng;
    const mag2  = scenarioMode==="custom" ? parseFloat(customMagnitudeEl?.value)||6 : usgsSource?.mag||6;
    const dep2  = scenarioMode==="custom" ? parseFloat(customDepthEl?.value)||10 : usgsSource?.depthKm||10;
    if (!srcLL) { if(statsEl) statsEl.innerHTML=statCell("—","Set scenario source"); return; }
    const distances2 = [5,10,20,50,100,200,400,700,1000];
    const pal2={bilal:"#f87171",atkinson:"#60a5fa",worden:"#34d399"};
    const sig2=IPE_SIGMA[activeIPE]||0.8; const aFn=IPE_MODELS[activeIPE].fn;
    const ds2=Object.entries(IPE_MODELS).map(([k,m])=>({label:m.shortName,type:"line",data:distances2.map(d=>Math.max(0,m.fn(mag2,d,dep2))),borderColor:pal2[k],backgroundColor:"transparent",borderWidth:2.5,pointRadius:3,tension:0.3}));
    ds2.push({label:`+1σ`,type:"line",data:distances2.map(d=>Math.max(0,aFn(mag2,d,dep2)+sig2)),borderColor:pal2[activeIPE]+"66",borderDash:[5,4],borderWidth:1,pointRadius:0,fill:"+1",backgroundColor:pal2[activeIPE]+"20"});
    ds2.push({label:`-1σ`,type:"line",data:distances2.map(d=>Math.max(0,aFn(mag2,d,dep2)-sig2)),borderColor:pal2[activeIPE]+"66",borderDash:[5,4],borderWidth:1,pointRadius:0,fill:false});
    [{v:8,c:"#ef444488"},{v:6,c:"#fb923c88"},{v:4.5,c:"#d9770688"},{v:2.5,c:"#65a30d88"}].forEach(t=>ds2.push({label:"MMI≥"+t.v,type:"line",data:distances2.map(()=>t.v),borderColor:t.c,borderDash:[2,4],borderWidth:1,pointRadius:0,fill:false}));
    fsChartInstance=new Chart(ctx,{type:"line",data:{labels:distances2.map(d=>d+"km"),datasets:ds2},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true,position:"top",labels:{color:"#94a3b8",font:{size:11},boxWidth:14}}},scales:{x:{title:{display:true,text:"Distance",color:"#94a3b8"},ticks:{color:"#94a3b8"},grid:{color:"#1e293b"}},y:{title:{display:true,text:"MMI",color:"#94a3b8"},ticks:{color:"#94a3b8"},grid:{color:"#1e293b"},suggestedMin:0,suggestedMax:10}}}});
    if(statsEl) statsEl.innerHTML=Object.entries(IPE_MODELS).map(([k,m])=>statCell(m.fn(mag2,10,dep2).toFixed(1),m.shortName+"@10km")).join("");
    return;
  }

if (type === "magHist") {
    const bins = [0,0.5,1,1.5,2,2.5,3,3.5,4,4.5,5,5.5,6,6.5,7,7.5,8,8.5,9];
    const counts = bins.map((b,i) => i < bins.length-1 ? mags.filter(m => m >= b && m < bins[i+1]).length : 0);
    const bgColors = bins.map(b => b<3?"#86efac":b<4?"#fde047":b<5?"#fb923c":b<6?"#f97316":"#ef4444");
    fsChartInstance = new Chart(ctx, {
      type:"bar",
      data:{labels:bins.slice(0,-1).map(b=>b.toFixed(1)),datasets:[{data:counts.slice(0,-1),backgroundColor:bgColors,borderRadius:3,borderSkipped:false}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{title:([i])=>`M ${i.label}–${(parseFloat(i.label)+0.5).toFixed(1)}`,label:i=>`${i.raw} events`}}},scales:{x:{title:{display:true,text:"Magnitude",color:"#94a3b8",font:{size:13}},ticks:{color:"#94a3b8",font:{size:12}}},y:{title:{display:true,text:"Count",color:"#94a3b8",font:{size:13}},ticks:{color:"#94a3b8",font:{size:12},precision:0},beginAtZero:true,grid:{color:"#1e293b"}}}}
    });
    const maxM=mags.length?Math.max(...mags):0, avgM=mags.length?mags.reduce((a,b)=>a+b,0)/mags.length:0;
    statsEl.innerHTML=statCell(mags.length,"Events")+statCell("M"+maxM.toFixed(1),"Largest")+statCell("M"+avgM.toFixed(1),"Average");

  } else if (type === "depthScatter") {
    const points = features.map(f=>({
      x:     Math.max(0, f.geometry?.coordinates?.[2]??0),
      y:     f.properties?.mag??0,
      r:     Math.max(2, f.properties?.mag??0),
      place: f.properties?.place || "Unknown location",
      date:  f.properties?.time ? new Date(f.properties.time).toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"}) : "Unknown date"
    })).filter(p=>p.y>0);
    const cols = points.map(p=>p.y>=6?"#ef4444":p.y>=5?"#fb923c":p.y>=4?"#fde047":"#86efac");
    fsChartInstance = new Chart(ctx, {
      type:"bubble",
      data:{datasets:[{data:points,backgroundColor:cols.map(c=>c+"aa"),borderColor:cols,borderWidth:1}]},
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{
          legend:{display:false},
          tooltip:{
            callbacks:{
              title: items => items[0]?.raw?.place || "",
              label: i=>`M${i.raw.y.toFixed(1)}  ·  Depth ${i.raw.x.toFixed(0)} km`,
              afterLabel: i => i.raw.date
            },
            titleFont:{size:13,weight:"bold"},
            bodyFont:{size:12},
            padding:10,
            backgroundColor:"rgba(15,23,42,0.95)"
          }
        },
        scales:{
          x:{min:0,title:{display:true,text:"Depth (km)",color:"#94a3b8",font:{size:13}},ticks:{color:"#94a3b8",font:{size:12}},grid:{color:"#1e293b"}},
          y:{title:{display:true,text:"Magnitude",color:"#94a3b8",font:{size:13}},ticks:{color:"#94a3b8",font:{size:12}},grid:{color:"#1e293b"}}
        }
      }
    });
    const avgD=depths.length?depths.reduce((a,b)=>a+b,0)/depths.length:0;
    statsEl.innerHTML=statCell(points.length,"Plotted")+statCell((depths.length?Math.max(...depths):0).toFixed(0)+"km","Max depth")+statCell(avgD.toFixed(0)+"km","Avg depth");

  } else if (type === "timeline") {
    const dayMap={};
    times.forEach(t=>{const day=t.toISOString().slice(0,10);dayMap[day]=(dayMap[day]||0)+1;});
    const days=Object.keys(dayMap).sort(), counts2=days.map(d=>dayMap[d]);
    fsChartInstance = new Chart(ctx, {
      type:"line",
      data:{labels:days,datasets:[{data:counts2,borderColor:"#3b82f6",backgroundColor:"#3b82f622",fill:true,tension:0.3,pointRadius:2}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:i=>`${i.raw} events`}}},scales:{x:{title:{display:true,text:"Date",color:"#94a3b8",font:{size:13}},ticks:{color:"#94a3b8",font:{size:11},maxTicksLimit:10,maxRotation:30},grid:{color:"#1e293b"}},y:{title:{display:true,text:"Events/day",color:"#94a3b8",font:{size:13}},ticks:{color:"#94a3b8",font:{size:12},precision:0},beginAtZero:true,grid:{color:"#1e293b"}}}}
    });
    const maxDay=days.length?days[counts2.indexOf(Math.max(...counts2))]:"-";
    statsEl.innerHTML=statCell(days.length,"Days")+statCell(Math.max(...counts2)||0,"Peak/day")+statCell(maxDay,"Busiest day");

  } else if (type === "depthDist") {
    const shallow=depths.filter(d=>d<70).length, inter=depths.filter(d=>d>=70&&d<=300).length, deep=depths.filter(d=>d>300).length;
    fsChartInstance = new Chart(ctx, {
      type:"doughnut",
      data:{labels:["Shallow (<70 km)","Intermediate (70–300 km)","Deep (>300 km)"],datasets:[{data:[shallow,inter,deep],backgroundColor:["#3b82f6","#7c3aed","#64748b"],borderWidth:2,borderColor:"#0f172a"}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:"bottom",labels:{color:"#94a3b8",font:{size:13},padding:16}},tooltip:{callbacks:{label:i=>`${i.label}: ${i.raw} (${depths.length?((i.raw/depths.length)*100).toFixed(0):0}%)`}}}}
    });
    statsEl.innerHTML=statCell(shallow,"Shallow")+statCell(inter,"Intermediate")+statCell(deep,"Deep");
  }
}

function openFullscreenChart() {
  const overlay = $("chartFullscreenOverlay");
  const selFS   = $("chartTypeFS");
  const selMain = $("chartType");
  if (!overlay) return;
  if (selFS && selMain) selFS.value = selMain.value;
  overlay.style.display = "flex";
  // Defer one frame so canvas gets real layout dimensions before Chart.js reads them
  requestAnimationFrame(() => buildFullscreenChart(selFS?.value || "magHist"));
}

function closeFullscreenChart() {
  const overlay = $("chartFullscreenOverlay");
  if (overlay) overlay.style.display = "none";
  if (fsChartInstance) { fsChartInstance.destroy(); fsChartInstance = null; }
}

// chart type selector and fullscreen buttons are wired in the direct-bind block below

// Call buildCharts after data is rendered — hooked into renderFromCurrentData above
// (buildCharts is a function declaration so it's hoisted — safe to reference here)

// =============================================================================
// 3D DEPTH GLOBE — Three.js r128
// =============================================================================
let three3D = { scene:null, camera:null, renderer:null, animId:null, isDragging:false, prevMouse:{x:0,y:0}, group:null };

function init3DView() {
  const container = $("depth3dContainer");
  const canvas    = $("depth3dCanvas");
  const infoEl    = $("depth3dInfo");
  if (!container || !canvas || typeof THREE === "undefined") {
    alert("Three.js not loaded. Check your internet connection.");
    return;
  }

  const features = lastGeoJSON ? getFilteredFeatures(lastGeoJSON) : [];
  if (!features.length) { alert("Load earthquake data first."); return; }

  container.style.display = "block";

  if (three3D.animId) { cancelAnimationFrame(three3D.animId); three3D.animId = null; }
  if (three3D.renderer) { three3D.renderer.dispose(); }

  const W = container.clientWidth  || 340;
  const H = container.clientHeight || 320;

  const scene    = new THREE.Scene();
  scene.background = new THREE.Color(0x0f172a);

  const camera   = new THREE.PerspectiveCamera(50, W/H, 0.1, 1000);
  camera.position.set(0, 0, 4.5);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(W, H);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const earthGeo  = new THREE.SphereGeometry(1, 32, 32);
  const earthMat  = new THREE.MeshBasicMaterial({ color: 0x1e3a5f, wireframe: false });
  const earthMesh = new THREE.Mesh(earthGeo, earthMat);
  scene.add(earthMesh);

  const wireGeo  = new THREE.SphereGeometry(1.001, 24, 24);
  const wireMat  = new THREE.MeshBasicMaterial({ color: 0x2563eb, wireframe: true, opacity: 0.15, transparent: true });
  scene.add(new THREE.Mesh(wireGeo, wireMat));

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const pLight = new THREE.PointLight(0xffffff, 0.8);
  pLight.position.set(5, 5, 5);
  scene.add(pLight);

  const group = new THREE.Group();
  scene.add(group);

  const maxDepth = 700;
  let maxMag = 1;
  features.forEach(f => { if ((f.properties?.mag||0) > maxMag) maxMag = f.properties.mag; });

  const colorCache = {};
  function magColor(m) {
    if (colorCache[m]) return colorCache[m];
    const c = m >= 6 ? new THREE.Color(0xef4444) : m >= 5 ? new THREE.Color(0xfb923c) : m >= 4 ? new THREE.Color(0xfde047) : new THREE.Color(0x86efac);
    colorCache[m] = c; return c;
  }

  features.forEach(f => {
    const coords = f.geometry?.coordinates;
    if (!coords) return;
    const [lng, lat, depth] = coords;
    const mag = f.properties?.mag || 2;
    const dKmNorm = Math.min(Math.max((depth||0), 0), maxDepth) / maxDepth;
    const r = 1.0 - dKmNorm * 0.45;
    const phi   = (90 - lat)  * Math.PI / 180;
    const theta = (lng + 180) * Math.PI / 180;
    const x = -r * Math.sin(phi) * Math.cos(theta);
    const y =  r * Math.cos(phi);
    const z =  r * Math.sin(phi) * Math.sin(theta);
    const size = Math.max(0.008, (mag / maxMag) * 0.04);
    const geo  = new THREE.SphereGeometry(size, 6, 6);
    const mat  = new THREE.MeshBasicMaterial({ color: magColor(Math.floor(mag)) });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    group.add(mesh);
  });

  if (infoEl) {
    infoEl.innerHTML = `<b style="color:#60a5fa">${features.length} events</b><br>
      Depth: shallow=<span style="color:#86efac">■</span> → deep=<span style="color:#2563eb">■</span><br>
      Size = magnitude · Color = M class<br>
      <span style="color:#fde047">■</span>M4–5 <span style="color:#fb923c">■</span>M5–6 <span style="color:#ef4444">■</span>M6+`;
  }

  let autoRotate = true;

  // Derive initial rotation from the current Leaflet map centre so the globe
  // opens already facing the same part of the world the user is looking at.
  const mapCentre = map.getCenter();
  const _clat = mapCentre.lat, _clng = mapCentre.lng;
  const _phi   = (90 - _clat) * Math.PI / 180;
  const _theta = (_clng + 180) * Math.PI / 180;
  const _gx    = -Math.sin(_phi) * Math.cos(_theta);
  const _gz    =  Math.sin(_phi) * Math.sin(_theta);
  // rotY: rotate Y-axis so the map-centre point faces the camera (+z direction)
  let rotY = Math.atan2(-_gx, _gz);
  // rotX: slight tilt to match latitude; clamp to ±PI/3
  let rotX = Math.max(-Math.PI/3, Math.min(Math.PI/3, -_clat * Math.PI / 180 * 0.4));

  canvas.addEventListener("mousedown", e => { three3D.isDragging = true; autoRotate = false; three3D.prevMouse = { x:e.clientX, y:e.clientY }; });
  canvas.addEventListener("mousemove", e => {
    if (!three3D.isDragging) return;
    const dx = e.clientX - three3D.prevMouse.x, dy = e.clientY - three3D.prevMouse.y;
    rotY += dx * 0.005; rotX += dy * 0.005;
    three3D.prevMouse = { x:e.clientX, y:e.clientY };
  });
  canvas.addEventListener("mouseup",   () => { three3D.isDragging = false; });
  canvas.addEventListener("mouseleave",() => { three3D.isDragging = false; });
  canvas.addEventListener("touchstart", e => { autoRotate=false; const t=e.touches[0]; three3D.prevMouse={x:t.clientX,y:t.clientY}; three3D.isDragging=true; });
  canvas.addEventListener("touchmove",  e => { if(!three3D.isDragging)return; const t=e.touches[0]; const dx=t.clientX-three3D.prevMouse.x, dy=t.clientY-three3D.prevMouse.y; rotY+=dx*0.005; rotX+=dy*0.005; three3D.prevMouse={x:t.clientX,y:t.clientY}; e.preventDefault(); }, {passive:false});
  canvas.addEventListener("touchend",   () => { three3D.isDragging=false; });
  canvas.addEventListener("wheel", e => { camera.position.z = Math.max(1.8, Math.min(8, camera.position.z + e.deltaY * 0.005)); e.preventDefault(); }, { passive:false });

  function animate() {
    three3D.animId = requestAnimationFrame(animate);
    if (autoRotate) rotY += 0.003;
    group.rotation.y = rotY;
    group.rotation.x = Math.max(-Math.PI/3, Math.min(Math.PI/3, rotX));
    earthMesh.rotation.y = rotY;
    renderer.render(scene, camera);
  }
  animate();
  three3D = { ...three3D, scene, camera, renderer, group };
}

function close3DView() {
  if (three3D.animId) { cancelAnimationFrame(three3D.animId); three3D.animId = null; }
  if (three3D.renderer) { three3D.renderer.dispose(); three3D.renderer = null; }
  const c = $("depth3dContainer"); if(c) c.style.display = "none";
}

// =============================================================================
// MOBILE SIDEBAR
// =============================================================================
(function initMobileSidebar(){
  const btn     = $("mobileSidebarBtn");
  const sidebar = document.querySelector(".sidebar");
  const overlay = $("mobileOverlay");
  if (!btn || !sidebar || !overlay) return;
  function openSidebar()  { sidebar.classList.add("mobile-open");    overlay.classList.add("visible"); }
  function closeSidebar() { sidebar.classList.remove("mobile-open"); overlay.classList.remove("visible"); }
  btn.addEventListener("click", () => sidebar.classList.contains("mobile-open") ? closeSidebar() : openSidebar());
  overlay.addEventListener("click", closeSidebar);
  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => {
    if (window.innerWidth <= 820) setTimeout(closeSidebar, 120);
  }));
})();

// =============================================================================
// DIRECT BUTTON BINDING
// Script is at end of <body> so DOM is ready — no DOMContentLoaded needed
// =============================================================================
// Charts fullscreen
$("btnChartFullscreen")?.addEventListener("click", openFullscreenChart);
$("btnChartFSClose")?.addEventListener("click",    closeFullscreenChart);
document.addEventListener("keydown", e => { if (e.key === "Escape") { closeFullscreenChart(); } });
$("chartTypeFS")?.addEventListener("change", e => buildFullscreenChart(e.target.value));
$("chartType")?.addEventListener("change", e => {
  const selFS = $("chartTypeFS"); if (selFS) selFS.value = e.target.value;
  buildCharts();
});
// 3D globe
$("btn3DView")?.addEventListener("click", init3DView);
$("btn3DClose")?.addEventListener("click", close3DView);
// Charts tab triggers rebuild
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.dataset.tab === "charts") setTimeout(buildCharts, 50);
  });
});



// =============================================================================
// COUNTRY FILTER MODULE — World Shapefile PIP Edition
// =============================================================================

function _getEqId(f) {
  return f.id || `${f.properties?.time}_${f.properties?.mag}_${f.geometry?.coordinates?.[0]?.toFixed(3)}_${f.geometry?.coordinates?.[1]?.toFixed(3)}`;
}

function iso2Flag(code) {
  if (!code || code.length !== 2) return "🌍";
  const c = code.toUpperCase();
  return String.fromCodePoint(c.charCodeAt(0)-65+0x1F1E6, c.charCodeAt(1)-65+0x1F1E6);
}

const ISO3_TO_ISO2 = {
  NPL:"NP",AFG:"AF",BGD:"BD",BTN:"BT",IND:"IN",MDV:"MV",PAK:"PK",LKA:"LK",
  MMR:"MM",KHM:"KH",LAO:"LA",THA:"TH",VNM:"VN",IDN:"ID",MYS:"MY",PHL:"PH",
  SGP:"SG",TLS:"TL",BRN:"BN",CHN:"CN",JPN:"JP",KOR:"KR",PRK:"KP",TWN:"TW",
  MNG:"MN",RUS:"RU",KAZ:"KZ",KGZ:"KG",TJK:"TJ",TKM:"TM",UZB:"UZ",
  GEO:"GE",ARM:"AM",AZE:"AZ",TUR:"TR",IRN:"IR",IRQ:"IQ",SYR:"SY",ISR:"IL",
  JOR:"JO",LBN:"LB",SAU:"SA",YEM:"YE",OMN:"OM",ARE:"AE",QAT:"QA",KWT:"KW",
  BHR:"BH",EGY:"EG",LBY:"LY",TUN:"TN",DZA:"DZ",MAR:"MA",
  USA:"US",CAN:"CA",MEX:"MX",GTM:"GT",HND:"HN",SLV:"SV",NIC:"NI",CRI:"CR",
  PAN:"PA",CUB:"CU",JAM:"JM",HTI:"HT",DOM:"DO",
  COL:"CO",VEN:"VE",ECU:"EC",PER:"PE",BOL:"BO",BRA:"BR",CHL:"CL",ARG:"AR",
  NZL:"NZ",AUS:"AU",PNG:"PG",FJI:"FJ",VUT:"VU",TON:"TO",SLB:"SB",
  GBR:"GB",IRL:"IE",FRA:"FR",ESP:"ES",PRT:"PT",ITA:"IT",GRC:"GR",
  NOR:"NO",SWE:"SE",FIN:"FI",DNK:"DK",ISL:"IS",
  NGA:"NG",ETH:"ET",KEN:"KE",TZA:"TZ",MOZ:"MZ",ZAF:"ZA",ZMB:"ZM",ZWE:"ZW",
  SDN:"SD",SOM:"SO",ERI:"ER"
};

// Static flags for common countries — covers before shapefile loads
const FLAG_STATIC = {
  "Japan":"🇯🇵","United States of America":"🇺🇸","United States":"🇺🇸",
  "Indonesia":"🇮🇩","China":"🇨🇳","Philippines":"🇵🇭","Turkey":"🇹🇷","Iran":"🇮🇷",
  "Italy":"🇮🇹","Greece":"🇬🇷","New Zealand":"🇳🇿","Chile":"🇨🇱","Peru":"🇵🇪",
  "Mexico":"🇲🇽","India":"🇮🇳","Pakistan":"🇵🇰","Afghanistan":"🇦🇫","Russia":"🇷🇺",
  "Papua New Guinea":"🇵🇬","Nepal":"🇳🇵","Myanmar":"🇲🇲","Colombia":"🇨🇴",
  "Ecuador":"🇪🇨","Bolivia":"🇧🇴","Argentina":"🇦🇷","Canada":"🇨🇦","Taiwan":"🇹🇼",
  "Vanuatu":"🇻🇺","Tonga":"🇹🇴","Fiji":"🇫🇯","Solomon Is.":"🇸🇧","Solomon Islands":"🇸🇧",
  "Australia":"🇦🇺","Morocco":"🇲🇦","Algeria":"🇩🇿","Romania":"🇷🇴","Iceland":"🇮🇸",
  "Costa Rica":"🇨🇷","Guatemala":"🇬🇹","Nicaragua":"🇳🇮","El Salvador":"🇸🇻",
  "Honduras":"🇭🇳","Panama":"🇵🇦","Dominican Rep.":"🇩🇴","Haiti":"🇭🇹","Cuba":"🇨🇺",
  "Kazakhstan":"🇰🇿","Tajikistan":"🇹🇯","Kyrgyzstan":"🇰🇬","Uzbekistan":"🇺🇿",
  "Georgia":"🇬🇪","Armenia":"🇦🇲","Azerbaijan":"🇦🇿","Israel":"🇮🇱","Jordan":"🇯🇴",
  "Yemen":"🇾🇪","Saudi Arabia":"🇸🇦","Ethiopia":"🇪🇹","Kenya":"🇰🇪","Somalia":"🇸🇴",
  "Ocean/Unknown":"🌊","Unknown":"🌍"
};

function getFlag(country) {
  if (_worldBboxes) {
    const e = _worldBboxes.find(x => x.name === country);
    if (e) {
      if (e.iso2 && e.iso2 !== "-99" && e.iso2.length === 2) return iso2Flag(e.iso2);
      if (e.iso3 && ISO3_TO_ISO2[e.iso3]) return iso2Flag(ISO3_TO_ISO2[e.iso3]);
    }
  }
  return FLAG_STATIC[country] || "🌍";
}

function extractCountry(place) {
  if (!place) return "Unknown";
  const parts = place.split(",");
  return parts[parts.length - 1].trim() || "Unknown";
}

// Map USGS text names → shapefile NAME (also maps US state abbreviations → USA)
const USGS_TO_SHAPEFILE = {
  "United States":"United States of America",
  "Solomon Islands":"Solomon Is.",
  "Dominican Republic":"Dominican Rep.",
  "Bosnia and Herzegovina":"Bosnia and Herz.",
  "Equatorial Guinea":"Eq. Guinea",
  "South Sudan":"S. Sudan",
  "Central African Republic":"Central African Rep.",
  "Democratic Republic of the Congo":"Dem. Rep. Congo",
  "DR Congo":"Dem. Rep. Congo",
  "French Polynesia":"Fr. Polynesia",
  "Cook Islands":"Cook Is.",
  "Marshall Islands":"Marshall Is.",
  "Faroe Islands":"Faeroe Is.",
  "Falkland Islands":"Falkland Is.",
  "British Virgin Islands":"British Virgin Is.",
  "Cayman Islands":"Cayman Is.",
  "Turks and Caicos Islands":"Turks and Caicos Is.",
  "Wallis and Futuna":"Wallis and Futuna Is.",
  "Northern Mariana Islands":"N. Mariana Is.",
  "Virgin Islands":"U.S. Virgin Is.",
  "Antigua and Barbuda":"Antigua and Barb.",
  "Ivory Coast":"Côte d'Ivoire",
  "North Macedonia":"Macedonia",
  "Cape Verde":"Cabo Verde",
  "Swaziland":"eSwatini",
  "East Timor":"Timor-Leste",
  "Alaska":"United States of America",
  "Hawaii":"United States of America",
};
// All US state abbreviations → USA
["AK","HI","CA","WA","OR","NV","MT","ID","WY","UT","CO","NM","AZ","TX","OK",
 "KS","NE","SD","ND","MN","IA","MO","WI","IL","MI","IN","OH","KY","TN","AR",
 "LA","MS","AL","GA","FL","SC","NC","VA","WV","MD","DE","PA","NJ","NY","CT",
 "RI","MA","VT","NH","ME"].forEach(s => { USGS_TO_SHAPEFILE[s] = "United States of America"; });

function _normaliseCountryName(raw) {
  if (!raw) return "Unknown";
  return USGS_TO_SHAPEFILE[raw] || raw;
}

// PIP ─────────────────────────────────────────────────────────────────────────
function _raycast(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function _pip(lng, lat, geometry) {
  const polys = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  for (const poly of polys) {
    if (_raycast(lng, lat, poly[0])) {
      let hole = false;
      for (let h = 1; h < poly.length; h++) if (_raycast(lng, lat, poly[h])) { hole = true; break; }
      if (!hole) return true;
    }
  }
  return false;
}
function _computeBbox(geometry) {
  let minX=180,maxX=-180,minY=90,maxY=-90;
  function walk(a) { if(typeof a[0]==="number"){if(a[0]<minX)minX=a[0];if(a[0]>maxX)maxX=a[0];if(a[1]<minY)minY=a[1];if(a[1]>maxY)maxY=a[1];}else a.forEach(walk); }
  walk(geometry.coordinates);
  return [minX,minY,maxX,maxY];
}

async function _loadWorldShapefile() {
  if (_worldBboxes) return true;
  if (_worldLoading) { while (_worldLoading) await new Promise(r=>setTimeout(r,80)); return !!_worldBboxes; }
  _worldLoading = true;
  try {
    // Try IndexedDB first — saves ~1–2s on repeat visits
    let geojson = null;
    const cached = await idbGet("worldShapefile_v2");  // v2: bbox fix for wide-bbox countries
    if (cached) {
      try { geojson = JSON.parse(cached); }
      catch(e) { geojson = null; }
    }
    if (!geojson) {
      const res = await fetch(WORLD_FILE);
      if (!res.ok) throw new Error("HTTP "+res.status);
      geojson = await res.json();
      idbSet("worldShapefile_v2", JSON.stringify(geojson)).catch(()=>{});  // v2 cache key
    }
    _worldBboxes = geojson.features
      .filter(f => f.geometry && f.properties?.NAME)
      .map(f => ({
        name:    f.properties.NAME,
        iso2:    (f.properties.iso_a2 || f.properties.WB_A2 || "").trim(),
        iso3:    (f.properties.ISO_A3 || f.properties.WB_A3 || "").trim(),
        bbox:    _computeBbox(f.geometry),
        feature: f
      }));
    console.log(`[WorldFilter] ${_worldBboxes.length} countries loaded (${cached?"IDB cache":"network"})`);
    return true;
  } catch(e) { console.warn("[WorldFilter] failed:", e); return false; }
  finally { _worldLoading = false; }
}

function _buildEqCountryCache(features) {
  if (!_worldBboxes) return;
  features.forEach(f => {
    const id = _getEqId(f);
    if (_eqCountryCache.has(id)) return;
    const coords = f.geometry?.coordinates;
    if (!coords || coords.length < 2) { _eqCountryCache.set(id, "Ocean/Unknown"); return; }
    let lng = ((coords[0]+180)%360)-180, lat = coords[1], found = null;
    for (const e of _worldBboxes) {
      const [x0,y0,x1,y1] = e.bbox;
      // Latitude fast-reject (always reliable)
      if (lat < y0 || lat > y1) continue;
      // Longitude pre-filter — three cases:
      //  1. BboxWidth > 300°: country spans most of the globe (USA due to Aleutians,
      //     Russia, Fiji, New Zealand, Kiribati). The bbox is useless as a filter
      //     here — skip it and rely entirely on PIP. This is the main fix for USA.
      //  2. BboxWidth 180–300°: genuine antimeridian-spanning country.
      //     A point is "inside" if it is NOT in the gap between x1 and x0.
      //  3. Normal case: standard longitude range check.
      const bboxWidth = x1 - x0;
      let inBox;
      if (bboxWidth > 300) {
        inBox = true;  // too wide to be useful — let PIP decide
      } else if (bboxWidth > 180) {
        inBox = (lng <= x0 || lng >= x1);  // antimeridian wrap
      } else {
        inBox = (lng >= x0 && lng <= x1);  // normal
      }
      if (!inBox) continue;
      if (_pip(lng, lat, e.feature.geometry)) { found = e.name; break; }
    }
    _eqCountryCache.set(id, found || "Ocean/Unknown");
  });
}

// Portal dropdown ─────────────────────────────────────────────────────────────
let _cfPortal=null, _cfOpen=false, _cfMap={};

function _cfGetPortal() {
  if (!_cfPortal) {
    _cfPortal = document.createElement("div");
    _cfPortal.id = "cfPortalDropdown"; _cfPortal.className = "cf-portal";
    document.body.appendChild(_cfPortal);
    document.addEventListener("click", e => {
      if (!_cfPortal.contains(e.target) && e.target !== $("countrySearch")) _cfClose();
    }, true);
  }
  return _cfPortal;
}

function _cfOpen_dropdown() {
  const input = $("countrySearch"); if (!input) return;
  if (!Object.keys(_cfMap).length && lastGeoJSON) {
    const m = parseFloat(minMagEl?.value);
    (lastGeoJSON.features||[]).filter(f=>{const mag=f.properties?.mag; return mag!=null&&(Number.isNaN(m)||mag>=m);})
    .forEach(f => {
      const id=_getEqId(f);
      const c = _eqCountryCache.has(id) ? _eqCountryCache.get(id) : _normaliseCountryName(extractCountry(f.properties?.place));
      _cfMap[c]=(_cfMap[c]||0)+1;
    });
  }
  const portal = _cfGetPortal();
  const rect   = input.getBoundingClientRect();
  if (!Object.keys(_cfMap).length) {
    Object.assign(portal.style,{top:(rect.bottom+4)+"px",left:rect.left+"px",width:rect.width+"px",maxHeight:"110px",display:"block"});
    portal.innerHTML=`<div class="cf-empty">Load earthquake data first.</div>`;
    _cfOpen=true; return;
  }
  const maxH=260, spBelow=window.innerHeight-rect.bottom-8, spAbove=rect.top-8;
  if (spBelow<maxH && spAbove>spBelow) {
    portal.style.top=""; portal.style.bottom=(window.innerHeight-rect.top+4)+"px";
    portal.style.maxHeight=Math.min(maxH,spAbove)+"px";
  } else {
    portal.style.bottom=""; portal.style.top=(rect.bottom+4)+"px";
    portal.style.maxHeight=Math.min(maxH,spBelow)+"px";
  }
  portal.style.left=rect.left+"px"; portal.style.width=rect.width+"px"; portal.style.display="block";
  _cfOpen=true; _cfRender(input.value.trim());
}

function _cfClose() { if(_cfPortal) _cfPortal.style.display="none"; _cfOpen=false; }

function _cfRender(query) {
  const portal=_cfGetPortal();
  const esc=s=>s.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  const entries=Object.entries(_cfMap)
    .filter(([n])=>!query||n.toLowerCase().includes(query.toLowerCase()))
    .sort((a,b)=>a[0].localeCompare(b[0]))   // alphabetical order
    .slice(0,150);
  let html="";
  if (!query) {
    const total=Object.values(_cfMap).reduce((a,b)=>a+b,0);
    html+=`<div class="cf-item cf-all${!activeCountryFilter?" cf-active":""}" data-country="">
      <span class="cf-flag">🌍</span><span>All Countries</span><span class="cf-count">${total}</span></div>`;
  }
  if (!entries.length) { html+=`<div class="cf-empty">No results for "${esc(query)}"</div>`; }
  else { html+=entries.map(([n,c])=>`<div class="cf-item${activeCountryFilter===n?" cf-active":""}" data-country="${esc(n)}">
    <span class="cf-flag">${getFlag(n)}</span><span>${esc(n)}</span><span class="cf-count">${c}</span></div>`).join(""); }
  portal.innerHTML=html;
  portal.querySelectorAll(".cf-item").forEach(el=>el.addEventListener("mousedown",e=>{
    e.preventDefault(); const c=el.dataset.country; c===""?clearCountryFilter():applyCountryFilter(c);
  }));
}

function buildCountryList() {
  if (!lastGeoJSON) return;
  const m = parseFloat(minMagEl?.value);
  const feats = (lastGeoJSON.features||[]).filter(f => {
    const mag = f.properties?.mag;
    return mag != null && (Number.isNaN(m) || mag >= m);
  });

  // Run PIP if shapefile is loaded — this gives us accurate NAME-based country assignment
  if (_worldBboxes) _buildEqCountryCache(feats);

  const map_ = {};
  feats.forEach(f => {
    const id = _getEqId(f);
    let c;
    if (_eqCountryCache.has(id)) {
      c = _eqCountryCache.get(id);  // shapefile PIP result (authoritative)
      // If PIP returned "Ocean/Unknown" but USGS place string has a recognisable
      // country name, use the text name as a better fallback. This covers offshore
      // events labelled with a country (e.g. "10km SW of Anchorage, AK").
      if (c === "Ocean/Unknown") {
        const textName = _normaliseCountryName(extractCountry(f.properties?.place));
        if (textName && textName !== "Unknown" && textName !== "Ocean/Unknown") {
          c = textName;
          // Update cache so filter also uses the corrected name
          _eqCountryCache.set(id, c);
        }
      }
    } else {
      c = _normaliseCountryName(extractCountry(f.properties?.place)); // text fallback
    }
    if (c) map_[c] = (map_[c]||0) + 1;
  });
  _cfMap = map_;

  if (_cfOpen) _cfRender($("countrySearch")?.value?.trim()||"");
  _cfUpdatePill();

  // If shapefile not loaded, trigger background load then rebuild with accurate PIP names
  if (!_worldBboxes && !_worldLoading) {
    _loadWorldShapefile().then(ok => {
      // Clear the entire cache so all events are re-evaluated with the shapefile PIP
      if (ok && lastGeoJSON) { _eqCountryCache.clear(); buildCountryList(); }
    });
  } else if (_worldBboxes) {
    // Shapefile already loaded — clear any stale "Ocean/Unknown" entries that
    // were cached before the bbox fix was applied (e.g. from IndexedDB-cached runs)
    _eqCountryCache.forEach((v,k) => { if (v === "Ocean/Unknown") _eqCountryCache.delete(k); });
  }
}

function _cfUpdatePill() {
  const el=$("countryActiveName"); if(!el||!activeCountryFilter) return;
  const count=_cfMap[activeCountryFilter]||0;
  // Clean display: just country name + count, no flag emoji (avoids ISO code rendering as text)
  el.textContent=activeCountryFilter+(count?` (${count})`:"");
}

function applyCountryFilter(country) {
  activeCountryFilter=country; _cfClose();
  const input=$("countrySearch"),pill=$("countryActivePill"),pillName=$("countryActiveName"),
        note=$("countryFilterNote"),clearBtn=$("countryClearBtn");
  if(input) input.value="";
  if(clearBtn) clearBtn.classList.remove("visible");
  if(pill) pill.classList.add("visible");
  // Clean pill: just the country name, no ISO code prefix
  if(pillName) pillName.textContent=country;
  if(note) note.textContent=`Showing: ${country} only`;
  // Always make earthquake points visible so the filter result is immediately shown
  if(showPointsEl && !showPointsEl.checked) {
    showPointsEl.checked=true;
    if($("heatOpacityGroup")) $("heatOpacityGroup").style.display="none";
  }
  if (_worldBboxes&&lastGeoJSON) {
    const m=parseFloat(minMagEl?.value);
    const featsForFilter=(lastGeoJSON.features||[]).filter(f=>{const mag=f.properties?.mag;return mag!=null&&(Number.isNaN(m)||mag>=m);});
    // Clear stale "Ocean/Unknown" cache entries so they are re-evaluated with
    // the fixed PIP (fixes previously mis-cached USA/Russia/Fiji earthquakes)
    featsForFilter.forEach(f => {
      const id = _getEqId(f);
      if (_eqCountryCache.get(id) === "Ocean/Unknown") _eqCountryCache.delete(id);
    });
    _buildEqCountryCache(featsForFilter);
  }
  renderFromCurrentData({preserveView:true});
  if (_worldBboxes) {
    const e=_worldBboxes.find(e=>e.name===country);
    if (e) { const[x0,y0,x1,y1]=e.bbox; setTimeout(()=>map.fitBounds([[y0,x0],[y1,x1]],{padding:[30,30],maxZoom:8,animate:true}),80); }
  }
}

function clearCountryFilter() {
  activeCountryFilter=null; _cfClose();
  const input=$("countrySearch"),pill=$("countryActivePill"),
        clearBtn=$("countryClearBtn"),note=$("countryFilterNote");
  if(input) input.value="";
  if(pill) pill.classList.remove("visible");
  if(clearBtn) clearBtn.classList.remove("visible");
  if(note) note.textContent="Showing all countries. Click to filter & zoom.";
  renderFromCurrentData({preserveView:false});
}

(function initCountryFilter() {
  const input=$("countrySearch"),clearBtn=$("countryClearBtn"),removeBtn=$("countryRemoveBtn");
  if(!input) return;
  input.addEventListener("focus",()=>_cfOpen_dropdown());
  input.addEventListener("input",()=>{
    const q=input.value.trim();
    clearBtn?.classList.toggle("visible",q.length>0&&!activeCountryFilter);
    if(_cfOpen)_cfRender(q);else _cfOpen_dropdown();
  });
  input.addEventListener("keydown",e=>{
    if(e.key==="Escape"){_cfClose();input.blur();}
    if(e.key==="Enter"){const f=_cfPortal?.querySelector(".cf-item");if(f){const c=f.dataset.country;c===""?clearCountryFilter():applyCountryFilter(c);}}
  });
  clearBtn?.addEventListener("click",e=>{e.stopPropagation();if(activeCountryFilter){clearCountryFilter();return;}input.value="";clearBtn.classList.remove("visible");_cfClose();});
  removeBtn?.addEventListener("click",e=>{e.stopPropagation();clearCountryFilter();});
})();


$("showRuptureEllipse")?.addEventListener("change", () => {
  if (!activeAnalysis?.source) return;
  const { source, mag, depthKm } = activeAnalysis;
  if ($("showRuptureEllipse").checked) drawRuptureEllipse(source.latlng || source, mag);
  else if (ruptureLayer && map.hasLayer(ruptureLayer)) { map.removeLayer(ruptureLayer); ruptureLayer = null; }
});
setTimeout(_loadWorldShapefile, 500);