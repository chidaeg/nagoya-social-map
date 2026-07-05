#!/usr/bin/env node
/**
 * 名古屋市 障がい福祉社会資源マップ - 実データ生成スクリプト（ハイブリッド）
 *
 * 主データ : 名古屋市「ウェルネットなごや」障害福祉サービス事業所検索の一覧CSV
 *            （export_items エンドポイント / サービス種別ごとに取得 / Shift_JIS）
 *            → 最新・名古屋市独自事業(移動支援/地域活動支援)・対象者情報を含む。座標は無し。
 * 座標     : WAM NET オープンデータ(全国CSV・緯度経度付き)を事業所番号で突き合わせて補完。
 *            突き合わない分のみ 国土地理院ジオコーディングAPI(無料)で住所から付与。
 *
 * 使い方:
 *   node scripts/build-data.js
 *
 * キャッシュ:
 *   scripts/.cache/wel/      … ウェルネットの種別別CSV
 *   scripts/.cache/<WAM版>/  … WAMの種別別ZIP/CSV
 *   scripts/.cache/geocode.json … ジオコーディング結果（住所→座標）
 *
 * 出典: 名古屋市 介護・障害情報提供システム（ウェルネットなごや） /
 *       独立行政法人福祉医療機構 WAM NET / 国土地理院 地理院地図ジオコーディング
 */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

const WAM_VERSION = "202603"; // 座標補完に使うWAM版
const WEL_EXPORT =
  "https://www.kaigo-wel.city.nagoya.jp/view/wel/jigyosho/export_items";
const WAM_BASE = `https://www.wam.go.jp/content/files/pcpub/top/sfkopendata/${WAM_VERSION}`;
const GSI_API = "https://msearch.gsi.go.jp/address-search/AddressSearch";

const CACHE = path.join(__dirname, ".cache");
const WEL_CACHE = path.join(CACHE, "wel");
const WAM_CACHE = path.join(CACHE, WAM_VERSION);
const GEOCODE_CACHE = path.join(CACHE, "geocode.json");
const OUT = path.join(__dirname, "..", "data", "facilities.json");

// ウェルネットの種別番号(kind) -> 当サイトの表示カテゴリ。
// 基準該当/共生型は基本カテゴリへ集約。市独自事業(移動支援/地域活動支援)も含む。
const KIND_CATEGORY = {
  54: "計画相談支援",
  55: "障害児相談支援",
  56: "地域移行支援",
  57: "地域定着支援",
  58: "居宅介護",
  59: "重度訪問介護",
  60: "行動援護",
  61: "同行援護",
  62: "移動支援",
  84: "重度障害者等包括支援",
  92: "就労定着支援",
  93: "自立生活援助",
  94: "居宅介護",        // 基準該当
  95: "重度訪問介護",    // 基準該当
  96: "居宅介護",        // 共生型
  97: "重度訪問介護",    // 共生型
  64: "生活介護",
  65: "自立訓練（機能訓練）",
  66: "自立訓練（生活訓練）",
  67: "就労移行支援",    // 一般型
  107: "就労選択支援",
  68: "就労移行支援",    // 資格取得型
  69: "就労継続支援A型",
  70: "就労継続支援B型",
  71: "療養介護",
  72: "地域活動支援",
  74: "医療型児童発達支援",
  73: "児童発達支援",
  98: "居宅訪問型児童発達支援",
  76: "保育所等訪問支援",
  75: "放課後等デイサービス",
  89: "生活介護",        // 基準該当
  90: "自立訓練（機能訓練）", // 基準該当
  91: "自立訓練（生活訓練）", // 基準該当
  87: "児童発達支援",    // 基準該当
  88: "放課後等デイサービス", // 基準該当
  99: "生活介護",        // 共生型
  100: "自立訓練（機能訓練）", // 共生型
  101: "自立訓練（生活訓練）", // 共生型
  102: "児童発達支援",   // 共生型
  103: "放課後等デイサービス", // 共生型
  77: "共同生活援助（グループホーム）",
  78: "共同生活援助（グループホーム）", // 外部サービス利用型
  104: "共同生活援助（グループホーム）", // 日中サービス支援型
  79: "短期入所",
  80: "宿泊型自立訓練",
  81: "施設入所支援",
  82: "福祉型障害児入所施設",
  83: "医療型障害児入所施設",
  105: "短期入所",       // 基準該当
  106: "短期入所",       // 共生型
};

// WAM側の座標補完に使う種別ファイル番号（全国CSV）
const WAM_NUMS = [
  11, 12, 13, 14, 15, 21, 22, 24, 32, 33, 34, 41, 42, 45, 46, 52, 53, 54,
  60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70,
];

const NAGOYA_WARDS = [
  "千種区", "東区", "北区", "西区", "中村区", "中区",
  "昭和区", "瑞穂区", "熱田区", "中川区", "港区", "南区",
  "守山区", "緑区", "名東区", "天白区",
];
const WARD_SET = new Set(NAGOYA_WARDS);
const LAT_RANGE = [35.0, 35.3];
const LNG_RANGE = [136.78, 137.07];

// ---------- 汎用 ----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGet(url, dest) {
  return new Promise((resolve, reject) => {
    const file = dest ? fs.createWriteStream(dest) : null;
    const chunks = [];
    https
      .get(url, { headers: { "User-Agent": "nagoya-social-map/1.0" } }, (res) => {
        if (res.statusCode !== 200) {
          if (file) { file.close(); fs.existsSync(dest) && fs.unlinkSync(dest); }
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        res.on("data", (d) => { if (file) file.write(d); else chunks.push(d); });
        res.on("end", () => {
          if (file) file.end(() => resolve());
          else resolve(Buffer.concat(chunks).toString("utf8"));
        });
      })
      .on("error", (err) => {
        if (file) { file.close(); fs.existsSync(dest) && fs.unlinkSync(dest); }
        reject(err);
      });
  });
}

function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (c === "\r") { /* skip */ }
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function extractWard(addr) {
  const m = (addr || "").match(/名古屋市([^\s0-9０-９]{1,3}区)/);
  if (m && WARD_SET.has(m[1])) return m[1];
  return "";
}

// 漢数字(十まで対応)を半角数字へ。「三丁目」「十一」等を 3 / 11 に。
function kanjiToNum(s) {
  const d = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  return s.replace(/[〇一二三四五六七八九十]+/g, (run) => {
    let total = 0, cur = 0, has = false;
    for (const ch of run) {
      if (ch === "十") { cur = cur === 0 ? 1 : cur; total += cur * 10; cur = 0; has = true; }
      else { cur = d[ch]; has = true; }
    }
    total += cur;
    return has ? String(total) : run;
  });
}

// 住所をWAM/ウェルネット間で突き合わせ可能な正規形にする。
// 県・市を除去 → 建物名(最初の空白以降)を切り落とし → 全角/漢数字を半角に
// → 丁目/番地/番/号/の を「-」に統一。
function normAddr(addr) {
  if (!addr) return "";
  let s = addr.replace(/^愛知県/, "").replace(/名古屋市/, "");
  s = s.split(/[\s　]/)[0]; // 建物名・部屋番号を除去
  s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = kanjiToNum(s);
  s = s
    .replace(/丁目/g, "-")
    .replace(/番地|番/g, "-")
    .replace(/号/g, "")
    .replace(/の/g, "-")
    .replace(/[ー‐−–—\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/-$/, "");
  return s;
}

function inNagoya(lat, lng) {
  return (
    lat >= LAT_RANGE[0] && lat <= LAT_RANGE[1] &&
    lng >= LNG_RANGE[0] && lng <= LNG_RANGE[1]
  );
}

// ---------- WAM: 事業所番号/住所 -> 座標・URL ----------
async function buildWamCoordMap() {
  fs.mkdirSync(WAM_CACHE, { recursive: true });
  const byNo = new Map();
  const byAddr = new Map();
  const urlByNo = new Map(); // 事業所番号 -> 公式サイトURL（事業所URL優先、無ければ法人URL）
  for (const num of WAM_NUMS) {
    const zip = path.join(WAM_CACHE, `sfkopendata_${WAM_VERSION}_${num}.zip`);
    const csv = path.join(WAM_CACHE, `csvdownload0${num}.csv`);
    if (!fs.existsSync(zip) && !fs.existsSync(csv)) {
      try {
        await httpGet(`${WAM_BASE}/sfkopendata_${WAM_VERSION}_${num}.zip`, zip);
      } catch (e) { continue; }
    }
    if (!fs.existsSync(csv) && fs.existsSync(zip)) {
      try { execSync(`unzip -o -q "${zip}" -d "${WAM_CACHE}"`); } catch (e) { continue; }
    }
    if (!fs.existsSync(csv)) continue;
    const rows = parseCsv(fs.readFileSync(csv, "utf8"));
    const H = rows[0];
    const cNo = H.indexOf("事業所番号");
    const cCity = H.indexOf("事業所住所（市区町村）");
    const cAddr = H.indexOf("事業所住所（番地以降）");
    const cLat = H.indexOf("事業所緯度");
    const cLng = H.indexOf("事業所経度");
    const cUrl = H.indexOf("事業所URL");
    const cCorpUrl = H.indexOf("法人URL");
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const lat = parseFloat(r[cLat]);
      const lng = parseFloat(r[cLng]);
      if (!isFinite(lat) || !isFinite(lng) || !inNagoya(lat, lng)) continue;
      const coord = { lat, lng };
      const no = (r[cNo] || "").trim();
      if (no && !byNo.has(no)) byNo.set(no, coord);
      const key = normAddr((r[cCity] || "") + (r[cAddr] || ""));
      if (key && !byAddr.has(key)) byAddr.set(key, coord);
      const url = ((r[cUrl] || "").trim() || (r[cCorpUrl] || "").trim());
      if (no && url && /^https?:\/\//.test(url) && !urlByNo.has(no)) {
        urlByNo.set(no, url);
      }
    }
  }
  return { byNo, byAddr, urlByNo };
}

// ---------- ウェルネット: 種別ごとにCSV取得 ----------
async function fetchWelKind(kind) {
  fs.mkdirSync(WEL_CACHE, { recursive: true });
  const csv = path.join(WEL_CACHE, `wel_${kind}.csv`);
  if (!fs.existsSync(csv)) {
    const bin = path.join(WEL_CACHE, `wel_${kind}.bin`);
    const url = `${WEL_EXPORT}?kind%5B${kind}%5D=true`;
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try { await httpGet(url, bin); ok = true; }
      catch (e) { await sleep(1500); }
    }
    if (!ok) throw new Error(`ウェルネット取得失敗 kind=${kind}`);
    execSync(`iconv -f CP932 -t UTF-8 "${bin}" > "${csv}"`);
    fs.unlinkSync(bin);
    await sleep(400); // 連続アクセスを控えめに
  }
  return parseCsv(fs.readFileSync(csv, "utf8"));
}

// ---------- ジオコーディング（キャッシュ付き） ----------
let geocodeCache = {};
let geocodeDirty = 0;
function loadGeocodeCache() {
  if (fs.existsSync(GEOCODE_CACHE)) {
    try { geocodeCache = JSON.parse(fs.readFileSync(GEOCODE_CACHE, "utf8")); } catch (e) {}
  }
}
function saveGeocodeCache() {
  fs.writeFileSync(GEOCODE_CACHE, JSON.stringify(geocodeCache));
}
const GOOGLE_KEY = process.env.GOOGLE_GEOCODING_KEY || "";
const GOOGLE_API = "https://maps.googleapis.com/maps/api/geocode/json";
const googleMemo = new Map(); // Google結果は規約(30日)順守のためディスクに永続化しない

// 戻り値: { lat, lng, precise } または null
async function geocode(addr) {
  if (GOOGLE_KEY) return geocodeGoogle(addr);
  return geocodeGsi(addr);
}

// GSI: 無料・永続保存可。番地が無い地域は町丁目止まり(precise=false)。
async function geocodeGsi(addr) {
  if (addr in geocodeCache) return geocodeCache[addr];
  let result = null;
  try {
    const json = await httpGet(`${GSI_API}?q=${encodeURIComponent(addr)}`);
    const arr = JSON.parse(json);
    if (Array.isArray(arr) && arr.length && arr[0].geometry) {
      const [lng, lat] = arr[0].geometry.coordinates;
      if (inNagoya(lat, lng)) result = { lat, lng, precise: false };
    }
  } catch (e) { /* null */ }
  geocodeCache[addr] = result;
  if (++geocodeDirty % 25 === 0) saveGeocodeCache();
  await sleep(150);
  return result;
}

// Google: 高精度。location_type=ROOFTOP/RANGE_INTERPOLATED を precise とみなす。
async function geocodeGoogle(addr) {
  if (googleMemo.has(addr)) return googleMemo.get(addr);
  let result = null;
  try {
    const url = `${GOOGLE_API}?address=${encodeURIComponent(
      addr
    )}&language=ja&region=jp&key=${GOOGLE_KEY}`;
    const json = await httpGet(url);
    const data = JSON.parse(json);
    if (data.status === "OK" && data.results.length) {
      const g = data.results[0].geometry;
      const lat = g.location.lat, lng = g.location.lng;
      if (inNagoya(lat, lng)) {
        const precise =
          g.location_type === "ROOFTOP" || g.location_type === "RANGE_INTERPOLATED";
        result = { lat, lng, precise };
      }
    } else if (data.status === "OVER_QUERY_LIMIT" || data.status === "REQUEST_DENIED") {
      throw new Error("Google Geocoding: " + data.status + " " + (data.error_message || ""));
    }
  } catch (e) {
    if (/REQUEST_DENIED|OVER_QUERY_LIMIT/.test(e.message)) throw e;
  }
  googleMemo.set(addr, result);
  await sleep(60);
  return result;
}

// ---------- メイン ----------
async function main() {
  loadGeocodeCache();
  console.log(
    `ジオコーダ: ${GOOGLE_KEY ? "Google Geocoding API（高精度）" : "国土地理院 GSI（無料）"}`
  );
  console.log("① WAMの座標テーブルを構築中...");
  const { byNo: wamByNo, byAddr: wamByAddr, urlByNo: wamUrlByNo } = await buildWamCoordMap();
  console.log(`   WAM座標: 事業所番号 ${wamByNo.size} / 住所 ${wamByAddr.size} / URL ${wamUrlByNo.size}`);

  console.log("② ウェルネットの一覧を取得中（種別ごと）...");
  const out = [];
  const seen = new Set();
  const stats = {};
  let viaNo = 0, viaAddr = 0, geocoded = 0, dropped = 0;
  const kinds = Object.keys(KIND_CATEGORY);

  for (const kind of kinds) {
    const category = KIND_CATEGORY[kind];
    let rows;
    try { rows = await fetchWelKind(kind); }
    catch (e) { console.log(`   SKIP kind=${kind} (${e.message})`); continue; }
    const H = rows[0];
    const c = (n) => H.indexOf(n);
    const cName = c("施設・サービス名");
    const cNo = c("障害福祉サービス等事業所番号");
    const cCorp = c("法人の名称");
    const cAddr = c("所在地");
    const cTel = c("電話番号");
    const cId = c("ID");
    const targetCols = ["身体", "知的", "精神", "難病", "障害児"].map((t) => [t, c(t)]);
    const featCols = ["給食", "入浴", "送迎"].map((t) => [t, c(t)]);

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const name = (r[cName] || "").trim();
      if (!name) continue;
      const addr = (r[cAddr] || "").replace(/^愛知県/, "").trim();
      const ward = extractWard(r[cAddr]);
      if (!ward) continue; // 名古屋市16区以外（市外データ等）は除外

      const bizNo = (r[cNo] || "").replace(/"/g, "").trim();
      const id = (bizNo || `wel${r[cId]}`) + "_" + kind;
      if (seen.has(id)) continue;
      seen.add(id);

      // 座標の決定順:
      //   1) 事業所番号でWAM一致（公式座標）
      //   2) 住所一致でWAM座標を再利用（併設サービスの公式座標）
      //   3) 建物名を除いた住所でジオコーディング（推定 = approx）
      let coord = null;
      let approx = false;
      if (bizNo && wamByNo.has(bizNo)) { coord = wamByNo.get(bizNo); viaNo++; }
      if (!coord) {
        const key = normAddr(r[cAddr]);
        if (key && wamByAddr.has(key)) { coord = wamByAddr.get(key); viaAddr++; }
      }
      if (!coord) {
        const g = await geocode(addr.split(/[\s　]/)[0]); // 建物名を除いて精度向上
        if (g) {
          coord = { lat: g.lat, lng: g.lng };
          approx = !g.precise; // Googleで番地確定(ROOFTOP等)なら正確扱い
          geocoded++;
        }
      }
      if (!coord) { dropped++; continue; }

      const target = targetCols.filter(([, idx]) => (r[idx] || "").trim() === "1").map(([t]) => t);
      const features = featCols.filter(([, idx]) => (r[idx] || "").trim() === "1").map(([t]) => t);

      out.push({
        id,
        name,
        category,
        ward,
        address: addr,
        corp: (r[cCorp] || "").trim(),
        lat: Math.round(coord.lat * 1e6) / 1e6,
        lng: Math.round(coord.lng * 1e6) / 1e6,
        approx,
        tel: (r[cTel] || "").trim(),
        url: (bizNo && wamUrlByNo.get(bizNo)) || "",
        target,
        features,
        note: "",
      });
      stats[category] = (stats[category] || 0) + 1;
    }
  }
  saveGeocodeCache();

  // 位置不確実の判定:
  // 同一座標に「異なる住所」が3件以上集まっている点は、番地を特定できず代表点
  // (区役所・町丁目の中心など)に落ちた粗い座標とみなし approx=true にする。
  // ※ 同一法人・同一事業所が複数サービスを行うケースは住所が同じなので対象外。
  const addrByCoord = {};
  out.forEach((x) => {
    const k = x.lat + "," + x.lng;
    (addrByCoord[k] = addrByCoord[k] || new Set()).add(x.address);
  });
  let coarse = 0;
  out.forEach((x) => {
    const k = x.lat + "," + x.lng;
    if (addrByCoord[k].size >= 3) { x.approx = true; coarse++; }
  });

  out.sort(
    (a, b) =>
      a.ward.localeCompare(b.ward, "ja") ||
      a.category.localeCompare(b.category, "ja") ||
      a.name.localeCompare(b.name, "ja")
  );
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");

  console.log("\n=== カテゴリ別件数 ===");
  Object.entries(stats).sort().forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  console.log(`\n座標の出所: 事業所番号一致 ${viaNo} / 住所一致 ${viaAddr} / ジオコーディング(推定) ${geocoded} / 取得失敗で除外 ${dropped}`);
  console.log(`位置不確実(approx)としてマーク: ${out.filter((x) => x.approx).length} 件（うち粗い代表点 ${coarse} 件）`);
  console.log(`✅ 合計 ${out.length} 件を ${path.relative(process.cwd(), OUT)} に書き出しました`);
}

main().catch((e) => { console.error(e); process.exit(1); });
