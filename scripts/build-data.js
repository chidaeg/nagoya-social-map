#!/usr/bin/env node
/**
 * 名古屋市 障がい福祉社会資源マップ - 実データ生成スクリプト
 *
 * WAM NET「障害福祉サービス等情報公表システム」のオープンデータ（都道府県横断・
 * サービス種別別ZIP）をダウンロードし、名古屋市分を抽出して data/facilities.json を生成する。
 * 各CSVには事業所緯度・経度が含まれるため、ジオコーディングは不要。
 *
 * 使い方:
 *   node scripts/build-data.js            # 最新版(YYYYMM)で生成
 *   node scripts/build-data.js 202509     # 版を指定
 *
 * 出典: 独立行政法人福祉医療機構 WAM NET
 *   https://www.wam.go.jp/content/wamnet/pcpub/top/sfkopendata/
 */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");
const os = require("os");

const VERSION = process.argv[2] || "202603"; // 既定: 2026年3月末版
const BASE = `https://www.wam.go.jp/content/files/pcpub/top/sfkopendata/${VERSION}`;
const CACHE_DIR = path.join(__dirname, ".cache", VERSION);
const OUT = path.join(__dirname, "..", "data", "facilities.json");

// WAMサービス種別番号 -> 当サイトの表示カテゴリ名
// （categories.js のカテゴリと一致させること）
const SERVICE_MAP = {
  11: "居宅介護",
  12: "重度訪問介護",
  15: "同行援護",
  13: "行動援護",
  14: "重度障害者等包括支援",
  22: "生活介護",
  24: "短期入所",
  21: "療養介護",
  45: "就労継続支援A型",
  46: "就労継続支援B型",
  60: "就労移行支援",
  62: "就労定着支援",
  41: "自立訓練（機能訓練）",
  42: "自立訓練（生活訓練）",
  63: "児童発達支援",
  64: "医療型児童発達支援",
  65: "放課後等デイサービス",
  66: "居宅訪問型児童発達支援",
  67: "保育所等訪問支援",
  33: "共同生活援助（グループホーム）",
  32: "施設入所支援",
  34: "宿泊型自立訓練",
  61: "自立生活援助",
  68: "福祉型障害児入所施設",
  69: "医療型障害児入所施設",
  52: "計画相談支援",
  53: "地域移行支援",
  54: "地域定着支援",
  70: "障害児相談支援",
};

// ---- HTTPダウンロード ----
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (err) => {
        file.close();
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        reject(err);
      });
  });
}

// ---- CSVパーサ（クォート・改行・エスケープ対応）----
function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else q = false;
      } else cur += c;
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

const NAGOYA_WARDS = [
  "千種区", "東区", "北区", "西区", "中村区", "中区",
  "昭和区", "瑞穂区", "熱田区", "中川区", "港区", "南区",
  "守山区", "緑区", "名東区", "天白区",
];

const WARD_SET = new Set(NAGOYA_WARDS);
function extractWard(cityField, addrField) {
  const hay = (cityField || "") + " " + (addrField || "");
  // 「名古屋市」直後〜最初の「区」までを区名として取り出す。
  // 単純な includes だと「東区」が「名東区」に含まれて誤判定するため正規表現で抽出する。
  const m = hay.match(/名古屋市([^\s0-9０-９]{1,3}区)/);
  if (m && WARD_SET.has(m[1])) return m[1];
  return "";
}

async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const out = [];
  const seen = new Set();
  const stats = {};

  for (const [num, category] of Object.entries(SERVICE_MAP)) {
    const zipPath = path.join(CACHE_DIR, `sfkopendata_${VERSION}_${num}.zip`);
    const csvPath = path.join(CACHE_DIR, `csvdownload0${num}.csv`);

    // ダウンロード（キャッシュがあれば再利用）
    if (!fs.existsSync(zipPath)) {
      const url = `${BASE}/sfkopendata_${VERSION}_${num}.zip`;
      process.stdout.write(`↓ ${category} (${num}) ... `);
      try {
        await download(url, zipPath);
        console.log("done");
      } catch (e) {
        console.log("SKIP (" + e.message + ")");
        continue;
      }
    }

    // 解凍（CSV名が想定と異なる場合に備えてZIP内の.csvを探す）
    let csv = csvPath;
    if (!fs.existsSync(csv)) {
      try {
        execSync(`unzip -o -q "${zipPath}" -d "${CACHE_DIR}"`);
      } catch (e) {
        console.log(`  ! unzip失敗 ${num}: ${e.message}`);
        continue;
      }
    }
    if (!fs.existsSync(csv)) {
      const found = fs
        .readdirSync(CACHE_DIR)
        .filter((f) => f.toLowerCase().endsWith(".csv") && f.includes(num));
      if (found.length) csv = path.join(CACHE_DIR, found[0]);
      else { console.log(`  ! CSV見つからず ${num}`); continue; }
    }

    const rows = parseCsv(fs.readFileSync(csv, "utf8"));
    const H = rows[0];
    const col = (name) => H.indexOf(name);
    const cName = col("事業所の名称");
    const cCity = col("事業所住所（市区町村）");
    const cAddr = col("事業所住所（番地以降）");
    const cLat = col("事業所緯度");
    const cLng = col("事業所経度");
    const cTel = col("事業所電話番号");
    const cUrl = col("事業所URL");
    const cNo = col("事業所番号");

    let count = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const city = r[cCity] || "";
      // 「北名古屋市」(別の市) は "名古屋市" を部分文字列に含むため除外する
      if (!city.includes("名古屋市") || city.includes("北名古屋市")) continue;
      const ward = extractWard(city, r[cAddr]);
      const lat = parseFloat(r[cLat]);
      const lng = parseFloat(r[cLng]);
      if (!isFinite(lat) || !isFinite(lng) || lat === 0 || lng === 0) continue;

      // 同一事業所が同一サービスで重複しないよう事業所番号+種別でユニーク化
      const bizNo = (r[cNo] || "").trim();
      const id = (bizNo || `g${num}-${i}`) + "_" + num;
      if (seen.has(id)) continue;
      seen.add(id);

      out.push({
        id,
        name: (r[cName] || "").trim(),
        category,
        ward,
        address: (city + (r[cAddr] || "")).replace(/^愛知県/, ""),
        lat: Math.round(lat * 1e6) / 1e6,
        lng: Math.round(lng * 1e6) / 1e6,
        tel: (r[cTel] || "").trim(),
        url: (r[cUrl] || "").trim(),
        target: [],
        note: "",
      });
      count++;
    }
    stats[category] = count;
  }

  // 名称→区→カテゴリ順で安定ソート
  out.sort(
    (a, b) =>
      a.ward.localeCompare(b.ward, "ja") ||
      a.category.localeCompare(b.category, "ja") ||
      a.name.localeCompare(b.name, "ja")
  );

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log("\n=== カテゴリ別件数 ===");
  Object.entries(stats).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  console.log(`\n✅ 合計 ${out.length} 件を ${path.relative(process.cwd(), OUT)} に書き出しました（版: ${VERSION}）`);

  const noWard = out.filter((x) => !x.ward).length;
  if (noWard) console.log(`⚠️ 区を特定できなかった件数: ${noWard}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
