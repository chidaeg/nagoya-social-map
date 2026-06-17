# 名古屋市 障がい福祉社会資源マップ

名古屋市内の障がい福祉サービス事業所を、カテゴリ別に検索・地図で確認できる非公式ガイドマップです。
[福岡市障がい福祉社会資源マップ](https://fukuoka-social-map.pages.dev/) を参考にした名古屋市版です。

**データ出典**: 独立行政法人福祉医療機構 WAM NET「障害福祉サービス等情報公表システム」オープンデータ（2026年3月末版）。
現在 **名古屋市内 約5,700事業所** を収録しています（緯度経度付き）。

> ⚠️ 本サイトは非公式です。正確な情報は各事業所・行政の公式情報をご確認ください。

## 技術構成

- 地図: **Leaflet + OpenStreetMap**（無料・APIキー不要）
- フロント: 素のHTML / CSS / JavaScript（ビルド不要）
- データ: `data/facilities.json`（事業所一覧）/ `data/categories.js`（カテゴリ・区の定義）
- ホスティング想定: **Cloudflare Pages**（静的サイトをそのまま公開可能）

## ローカルで動かす

`fetch` を使うため、ファイルを直接開くのではなく簡易サーバー経由でアクセスします。

```bash
cd /Users/chiaki/Desktop/test
python3 -m http.server 8000
# ブラウザで http://localhost:8000 を開く
```

## ディレクトリ構成

```
.
├── index.html            # 画面本体
├── css/style.css         # スタイル
├── js/app.js             # 地図・絞り込み・一覧の連動ロジック
├── data/
│   ├── categories.js     # カテゴリグループ・色・名古屋市16区の定義
│   └── facilities.json   # 事業所データ（build-data.js で生成）
└── scripts/
    └── build-data.js     # WAM NETデータから facilities.json を生成
```

## 機能

- カテゴリ（グループ別・色分け）での絞り込み（全選択 / 全解除）
- 区（名古屋市16区）での絞り込み
- 事業所名・住所・種別のフリーワード検索
- 一覧 ↔ 地図マーカーの連動（クリックで該当位置へ移動・ポップアップ表示）
- スマホ対応（一覧の開閉）

## データ項目（facilities.json）

| キー | 内容 |
| --- | --- |
| `id` | 一意なID |
| `name` | 事業所名 |
| `category` | サービス種別（`data/categories.js` の定義と一致させる） |
| `ward` | 区（名古屋市16区のいずれか） |
| `address` | 住所 |
| `lat` / `lng` | 緯度・経度 |
| `tel` | 電話番号（任意） |
| `url` | 公式サイトURL（任意） |
| `target` | 対象（身体/知的/精神/発達/児童 など、任意） |
| `note` | 備考（任意） |

## データの更新（facilities.json の再生成）

`scripts/build-data.js` が WAM NET のオープンデータ（サービス種別別ZIP・全国一括）を
ダウンロードし、**事業所住所が名古屋市**の行だけを抽出して `data/facilities.json` を生成します。
各CSVに事業所緯度・経度が含まれるため、ジオコーディングは不要です。

```bash
node scripts/build-data.js          # 最新版(既定: 202603)で生成
node scripts/build-data.js 202509   # 版(YYYYMM)を指定して生成
```

- ダウンロードしたZIP/CSVは `scripts/.cache/<版>/` にキャッシュされます（再実行時は再利用）。
- 区の判定は住所の「名古屋市〇〇区」から行います（`北名古屋市` は別の市なので除外）。
- WAMサービス種別 → 表示カテゴリの対応は `build-data.js` の `SERVICE_MAP` で定義しています。
  新しい版でカテゴリを増減する場合は、ここと `data/categories.js` の両方を更新してください。

### 収録範囲についての注意

- WAM NET は**自立支援給付（障害福祉サービス）**が対象です。
  `移動支援` `日中一時支援` などの**地域生活支援事業**（市町村事業）は含まれません。
  これらを載せる場合は名古屋市のオープンデータ等から別途追加してください。
- 最新版の公開は WAM NET の
  [オープンデータページ](https://www.wam.go.jp/content/wamnet/pcpub/top/sfkopendata/) を確認してください。

## デプロイ（Cloudflare Pages）

ビルド不要のため、このディレクトリをそのまま公開できます。

- ビルドコマンド: なし
- 出力ディレクトリ: `/`（ルート）

GitリポジトリをCloudflare Pagesに接続するか、`wrangler pages deploy .` で公開できます。

---

※ 本サイトは非公式です。正確な情報は各事業所・行政の公式情報をご確認ください。
