# 名古屋市 障がい福祉社会資源マップ

名古屋市内の障がい福祉サービス事業所を、カテゴリ別に検索・地図で確認できる非公式ガイドマップです。
[福岡市障がい福祉社会資源マップ](https://fukuoka-social-map.pages.dev/) を参考にした名古屋市版です。

**データ出典（ハイブリッド）**:
- 名簿: 名古屋市「ウェルネットなごや」障害福祉サービス事業所検索（更新頻度が高く、移動支援・地域活動支援など市独自事業や対象者情報も含む）
- 座標: WAM NET オープンデータと事業所番号で突き合わせて補完。不足分のみ国土地理院ジオコーディングAPIで付与。

現在 **名古屋市内 約6,900事業所** を収録しています（全件 緯度経度付き）。

> ⚠️ 本サイトは非公式です。正確な情報は各事業所・行政の公式情報をご確認ください。

## 技術構成

- 地図: **Google Maps JavaScript API**（ブラウザ用APIキーをHTTPリファラー制限で使用）
  - マーカークラスタリング: `@googlemaps/markerclusterer`
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
    └── build-data.js     # ウェルネット＋WAM＋ジオコーディングで facilities.json を生成
```

## 機能

- カテゴリ（グループ別・色分け）での絞り込み（全選択 / 全解除）
- 区（名古屋市16区）での絞り込み
- 事業所名・法人名・住所・種別のフリーワード検索
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
| `approx` | 位置がおおよそか（`true`=番地を特定できず周辺表示・地図では白抜きピン） |
| `corp` | 法人の名称 |
| `tel` | 電話番号（任意） |
| `url` | 公式サイトURL（任意） |
| `target` | 対象（身体/知的/精神/難病/障害児、任意） |
| `features` | 提供（給食/入浴/送迎、任意） |
| `note` | 備考（任意） |

## データの更新（facilities.json の再生成）

```bash
node scripts/build-data.js
```

`scripts/build-data.js` は次の手順で `data/facilities.json` を生成します。

1. **WAM NET** のサービス種別別CSVから「事業所番号 → 緯度経度」の対応表を作る。
2. **ウェルネットなごや** の `export_items`（サービス種別ごとのCSV）を取得し、名古屋市16区の行を抽出。
3. 各事業所の座標を **(1) 事業所番号でWAMと突き合わせ** → 無ければ **国土地理院API** で住所からジオコーディング。
4. 対象者（身体/知的/精神/難病/障害児）・提供（給食/入浴/送迎）・法人名などを付与して書き出し。

- キャッシュは `scripts/.cache/` 配下（`wel/`＝ウェルネットCSV、`<WAM版>/`＝WAM、`geocode.json`＝住所→座標）。
  再実行時は再利用されます。最新化したい時は対象キャッシュを削除してから実行してください。
- ウェルネットの種別番号 → 表示カテゴリの対応は `build-data.js` の `KIND_CATEGORY` で定義。
  種別やカテゴリを増減する場合は、ここと `data/categories.js` の両方を更新してください。
- 区の判定は住所の「名古屋市〇〇区」から行います。

### 収録範囲についてのメモ

- ウェルネットなごやは名古屋市の指定・登録情報を比較的高頻度で更新しており、
  `移動支援` `地域活動支援` などの**地域生活支援事業（市独自）**や `就労選択支援` も収録できます。
- 座標は WAM 由来（公式緯度経度）が大半で、WAMに無い新規事業所のみ住所ジオコーディングです。
- 番地まで特定できなかった住所（守山区志段味など大字・字エリアに多い）は、区・町丁目の代表点に
  落ちるため `approx: true` を付与し、地図では**白抜きピン**＋ポップアップ注記で「おおよその位置」と明示します。
  同一法人・同一事業所が複数サービスを行うことによる同一座標の重なりは、住所が同一なので approx 対象外です。
- データ元:
  [ウェルネットなごや 障害福祉サービス事業所検索](https://www.kaigo-wel.city.nagoya.jp/view/wel/jigyosho/) /
  [WAM NET オープンデータ](https://www.wam.go.jp/content/wamnet/pcpub/top/sfkopendata/) /
  [国土地理院 ジオコーディング](https://msearch.gsi.go.jp/)

## デプロイ（Cloudflare Pages）

ビルド不要の静的サイトなので、このディレクトリをそのまま公開できます。

- ビルドコマンド: **なし**
- 出力ディレクトリ: `/`（ルート）

### 方法A: Git連携（GitHub → Cloudflare Pages・推奨）

1. GitHubにリポジトリを作成して push

   ```bash
   gh repo create nagoya-social-map --public --source=. --remote=origin --push
   ```

2. [Cloudflare Pages](https://dash.cloudflare.com/) →「Pagesプロジェクトを作成」→
   GitHubの `nagoya-social-map` を選択。ビルド設定は上記（ビルドコマンドなし／出力 `/`）。
3. 以降は `main` に push するたびに自動デプロイされます。

### 方法B: Wrangler CLIで直接アップロード（GitHub不要）

```bash
npx wrangler pages deploy . --project-name nagoya-social-map
```

初回は Cloudflare へのログイン（ブラウザ認証）が求められます。

---

※ 本サイトは非公式です。正確な情報は各事業所・行政の公式情報をご確認ください。
