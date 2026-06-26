// 名古屋市 障がい福祉社会資源マップ - メインロジック（Google Maps版）
(function () {
  "use strict";

  const NAGOYA_CENTER = { lat: 35.1607, lng: 136.9099 }; // 名古屋市中心付近
  const DEFAULT_ZOOM = 12;
  const LIST_LIMIT = 300; // 一覧に描画する最大件数（地図には全件表示）

  let map = null;
  let clusterer = null;
  let infoWindow = null;
  // 開いている吹き出しの状態。同一地点に複数事業所がある場合、members に該当の
  // 事業所を並べ、index を ◀ ▶ で切り替える（ページャー）。
  let popupState = null; // { members: [facility...], index: number } or null
  let mapReady = false;
  let markersBuilt = false;
  let clustererSynced = false; // 初回クラスタ描画はコンストラクタ任せ→render()で1度だけスキップ

  // 状態
  const state = {
    facilities: [],
    markers: new Map(), // coordKey -> google.maps.Marker（同一地点は1マーカーに集約）
    groups: new Map(), // coordKey -> [facility...]（同一座標の事業所をまとめる）
    activeCategories: new Set(),
    ward: "",
    query: "",
    activeId: null,
  };

  // ログイン状態（Googleログイン）
  const auth = {
    clientId: null, // /api/config から取得
    user: null, // { email, name } or null
  };

  // ----- DOM参照 -----
  const els = {
    catFilters: document.getElementById("category-filters"),
    wardSelect: document.getElementById("ward-select"),
    search: document.getElementById("search-input"),
    list: document.getElementById("facility-list"),
    count: document.getElementById("result-count"),
    checkAll: document.getElementById("check-all"),
    uncheckAll: document.getElementById("uncheck-all"),
    sidebar: document.getElementById("sidebar"),
    toggleSidebar: document.getElementById("toggle-sidebar"),
    searchPanel: document.getElementById("search-panel"),
    searchPanelToggle: document.getElementById("search-panel-toggle"),
    map: document.getElementById("map"),
  };

  const SEARCH_COLLAPSED_KEY = "nagoya-map:search-collapsed";

  // ===== Google Maps 初期化（APIのcallbackから呼ばれる）=====
  window.initMap = function () {
    map = new google.maps.Map(els.map, {
      center: NAGOYA_CENTER,
      zoom: DEFAULT_ZOOM,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      gestureHandling: "greedy",
    });
    infoWindow = new google.maps.InfoWindow({ maxWidth: 320 });
    // 吹き出しのDOMが描画されるたびに発火（開く／ページ切替のたび）。
    infoWindow.addListener("domready", () => {
      document.querySelectorAll(".popup__memo").forEach(hydrateMemo);
      // 同一地点に複数事業所がある場合の ◀ ▶ ページャー
      document.querySelectorAll(".popup__pager-btn").forEach((btn) => {
        btn.onclick = () => {
          if (!popupState || popupState.members.length < 2) return;
          const n = popupState.members.length;
          popupState.index = (popupState.index + Number(btn.dataset.dir) + n) % n;
          renderPopup();
        };
      });
    });
    // 吹き出し以外（地図の余白）をクリックしたら閉じる。
    map.addListener("click", closeInfo);
    // 吹き出しの×ボタンで閉じたときも一覧のアクティブ表示を解除する。
    infoWindow.addListener("closeclick", () => {
      state.activeId = null;
      els.list.querySelectorAll(".facility-item.active").forEach((li) => {
        li.classList.remove("active");
      });
    });
    // クラスタリングは maybeBuildMarkers() で全マーカーをそろえてから生成する。
    // （ビューポート方式は①描画時にprojectionが必要 ②初回renderで必ずマーカーを
    //   load() させる必要がある——空のmarkersで生成すると getClusters が未構築の
    //   trees を触り「Cannot read properties of undefined (reading 'range')」で落ちる——
    //   ため、projectionが使える初回idle後にマーカーごとまとめて生成する。）
    google.maps.event.addListenerOnce(map, "idle", function () {
      mapReady = true;
      maybeBuildMarkers();
    });
  };

  // キー不正・課金未設定など読み込み失敗時の案内
  window.gm_authFailure = function () {
    els.map.innerHTML =
      '<div style="padding:24px;font-size:.9rem;color:#b91c1c;line-height:1.7">' +
      "地図を読み込めませんでした。<br>Google Maps APIキーの制限（ウェブサイト/HTTPリファラー）や" +
      "請求設定をご確認ください。</div>";
  };

  // ----- カテゴリ絞り込みUIを生成 -----
  function buildCategoryFilters() {
    const frag = document.createDocumentFragment();
    window.CATEGORY_GROUPS.forEach((g) => {
      const title = document.createElement("div");
      title.className = "cat-group__title";
      title.innerHTML =
        '<span class="cat-group__dot" style="background:' +
        g.color +
        '"></span>' +
        g.group;
      frag.appendChild(title);

      g.categories.forEach((cat) => {
        state.activeCategories.add(cat);
        const label = document.createElement("label");
        label.className = "cat-item";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.value = cat;
        cb.addEventListener("change", () => {
          if (cb.checked) state.activeCategories.add(cat);
          else state.activeCategories.delete(cat);
          render();
        });
        label.appendChild(cb);
        label.appendChild(document.createTextNode(cat));
        frag.appendChild(label);
      });
    });
    els.catFilters.appendChild(frag);
  }

  // ----- 区セレクトを生成 -----
  function buildWardSelect() {
    window.NAGOYA_WARDS.forEach((w) => {
      const opt = document.createElement("option");
      opt.value = w;
      opt.textContent = w;
      els.wardSelect.appendChild(opt);
    });
  }

  function setAllCategories(checked) {
    els.catFilters.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = checked;
      if (checked) state.activeCategories.add(cb.value);
      else state.activeCategories.delete(cb.value);
    });
    render();
  }

  // ----- マーカー生成 -----
  function markerIcon(f, color) {
    if (f.approx) {
      // 位置不確実: 白抜き・色枠
      return {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 6,
        fillColor: "#ffffff",
        fillOpacity: 0.95,
        strokeColor: color,
        strokeWeight: 2,
      };
    }
    return {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 6,
      fillColor: color,
      fillOpacity: 1,
      strokeColor: "#ffffff",
      strokeWeight: 1.5,
    };
  }

  // 同一座標を束ねるためのキー
  function coordKey(f) {
    return f.lat + "," + f.lng;
  }

  // state.facilities を座標ごとに state.groups へ集約する
  function buildGroups() {
    state.groups.clear();
    state.facilities.forEach((f) => {
      const k = coordKey(f);
      if (!state.groups.has(k)) state.groups.set(k, []);
      state.groups.get(k).push(f);
    });
  }

  // 同一地点の事業所群につき1つのマーカーを作る（重なりで埋もれるのを防ぐ）。
  // 見た目・位置は先頭事業所を代表に使い、クリックで吹き出し（ページャー付き）を開く。
  function makeGroupMarker(key, facilities) {
    const rep = facilities[0];
    const color = window.CATEGORY_COLOR[rep.category] || "#64748b";
    const extra = facilities.length - 1;
    const marker = new google.maps.Marker({
      position: { lat: rep.lat, lng: rep.lng },
      icon: markerIcon(rep, color),
      title: extra > 0 ? rep.name + " 他" + extra + "件" : rep.name,
    });
    marker.groupKey = key;
    marker.addListener("click", () => openInfoForFacility(rep));
    return marker;
  }

  // ある事業所の吹き出しを開く。同一地点の「現在の絞り込みで表示中の」事業所を
  // members に並べ、f をその先頭ページに合わせて表示する。
  function openInfoForFacility(f) {
    const visible = new Set(filtered().map((x) => x.id));
    const all = state.groups.get(coordKey(f)) || [f];
    let members = all.filter((x) => visible.has(x.id));
    if (!members.length) members = [f]; // 念のためのフォールバック
    let index = members.findIndex((x) => x.id === f.id);
    if (index < 0) index = 0;
    popupState = { members, index };
    renderPopup();
  }

  // popupState の内容で吹き出しを描画する（初回表示・ページ切替の両方で使う）。
  function renderPopup() {
    const { members, index } = popupState;
    const f = members[index];
    // 位置指定でInfoWindowを開く（クラスタ内マーカーでも確実に表示される）
    infoWindow.setContent(popupHtml(f, index, members.length));
    infoWindow.setPosition({ lat: f.lat, lng: f.lng });
    infoWindow.open(map);
    state.activeId = f.id;
    highlightList(f.id);
  }

  // 吹き出しを閉じ、一覧のアクティブ表示も解除する。
  // （地図クリック・吹き出しの×ボタンの両方から呼ばれる）
  function closeInfo() {
    infoWindow.close();
    popupState = null;
    state.activeId = null;
    els.list.querySelectorAll(".facility-item.active").forEach((li) => {
      li.classList.remove("active");
    });
  }

  function popupHtml(f, index, total) {
    // 同一地点に複数事業所がある場合のページャー（◀ n / N ▶）
    const pager =
      total > 1
        ? '<div class="popup__pager">' +
          '<button type="button" class="popup__pager-btn" data-dir="-1" aria-label="前の事業所">◀</button>' +
          '<span class="popup__pager-pos">' +
          (index + 1) +
          " / " +
          total +
          " 件（同じ場所）</span>" +
          '<button type="button" class="popup__pager-btn" data-dir="1" aria-label="次の事業所">▶</button>' +
          "</div>"
        : "";
    const targets = (f.target || [])
      .map((t) => '<span class="tag">' + t + "</span>")
      .join("");
    const features = (f.features || [])
      .map((t) => '<span class="tag tag--feature">' + t + "</span>")
      .join("");
    const corp = f.corp
      ? '<div class="popup__row"><b>法人</b> ' + esc(f.corp) + "</div>"
      : "";
    const tel = f.tel
      ? '<div class="popup__row"><b>TEL</b> <a href="tel:' +
        f.tel +
        '">' +
        f.tel +
        "</a></div>"
      : "";
    const url = f.url
      ? '<div class="popup__row"><a href="' +
        f.url +
        '" target="_blank" rel="noopener">公式サイト ↗</a></div>'
      : "";
    return (
      '<div class="popup">' +
      pager +
      '<div class="popup__name">' +
      esc(f.name) +
      "</div>" +
      '<div class="popup__row"><b>種別</b> ' +
      esc(f.category) +
      "</div>" +
      '<div class="popup__row"><b>住所</b> ' +
      esc(f.address) +
      "</div>" +
      corp +
      tel +
      url +
      (targets
        ? '<div class="popup__targets"><b>対象</b> ' + targets + "</div>"
        : "") +
      (features
        ? '<div class="popup__targets"><b>提供</b> ' + features + "</div>"
        : "") +
      (f.approx
        ? '<div class="popup__approx">📍 地図上の位置はおおよそです（番地を特定できず周辺を表示）</div>'
        : "") +
      (f.note ? '<div class="popup__row">' + esc(f.note) + "</div>" : "") +
      // メモ欄（ログイン中だけ編集可。中身は domready 後に hydrateMemo で差し込む）
      '<div class="popup__memo" data-id="' +
      esc(f.id) +
      '">' +
      '<div class="popup__memo-head">📝 メモ</div>' +
      '<div class="popup__memo-body">' +
      (auth.user ? "読込中…" : "🔒 ログインするとメモを残せます") +
      "</div>" +
      "</div>" +
      "</div>"
    );
  }

  // ===== メモ欄（吹き出し内）=====

  // domready で呼ばれ、メモを取得して編集UIを差し込む。
  async function hydrateMemo(container) {
    if (container.dataset.hydrated) return;
    container.dataset.hydrated = "1";
    if (!auth.user) return; // 未ログイン時はシェルの案内文のまま
    const id = container.dataset.id;
    const body = container.querySelector(".popup__memo-body");
    body.textContent = "読込中…";
    try {
      const res = await fetch("/api/memo/" + encodeURIComponent(id));
      if (!res.ok) throw new Error();
      const memo = await res.json();
      renderMemoEditor(container, id, memo);
    } catch {
      body.textContent = "メモの読込に失敗しました";
    }
  }

  function renderMemoEditor(container, id, memo) {
    const body = container.querySelector(".popup__memo-body");
    body.innerHTML = "";

    const ta = document.createElement("textarea");
    ta.className = "popup__memo-input";
    ta.placeholder = "この事業所のメモ（自分だけに表示）";
    ta.value = memo && memo.text ? memo.text : "";

    const row = document.createElement("div");
    row.className = "popup__memo-row";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "popup__memo-save";
    btn.textContent = "保存";
    const status = document.createElement("span");
    status.className = "popup__memo-status";
    if (memo && memo.updatedAt) {
      status.textContent =
        "更新 " + fmtDate(memo.updatedAt) + (memo.author ? " / " + memo.author : "");
    }

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      status.textContent = "保存中…";
      try {
        const res = await fetch("/api/memo/" + encodeURIComponent(id), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: ta.value }),
        });
        if (!res.ok) throw new Error();
        const saved = await res.json();
        status.textContent = saved
          ? "保存しました（" + fmtDate(saved.updatedAt) + "）"
          : "空のため削除しました";
      } catch {
        status.textContent = "保存に失敗しました";
      } finally {
        btn.disabled = false;
      }
    });

    row.appendChild(btn);
    row.appendChild(status);
    body.appendChild(ta);
    body.appendChild(row);
  }

  function fmtDate(iso) {
    try {
      return new Date(iso).toLocaleString("ja-JP", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ----- 絞り込み -----
  function filtered() {
    const q = state.query.trim().toLowerCase();
    return state.facilities.filter((f) => {
      if (!state.activeCategories.has(f.category)) return false;
      if (state.ward && f.ward !== state.ward) return false;
      if (q) {
        const hay = (f.name + " " + f.address + " " + f.category).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  // 絞り込み結果（facility配列）→ 対応するマーカー配列（同一地点は1つに集約）。
  // 同じ座標の事業所が1件でも該当すれば、その地点のマーカーを表示する。
  function visibleMarkerList(list) {
    const seen = new Set();
    const visibleMarkers = [];
    list.forEach((f) => {
      const key = coordKey(f);
      if (seen.has(key)) return;
      seen.add(key);
      const m = state.markers.get(key);
      if (m) visibleMarkers.push(m);
    });
    return visibleMarkers;
  }

  // クラスタへ反映する絞り込み。初回はクラスタ生成時に描画済みなのでスキップし、
  // overlayのprojectionが未準備の瞬間に clearMarkers/addMarkers が走るのを防ぐ。
  function updateClusterer(list) {
    if (!mapReady || !markersBuilt || !clusterer) return;
    if (!clustererSynced) {
      clustererSynced = true;
      return;
    }
    clusterer.clearMarkers();
    clusterer.addMarkers(visibleMarkerList(list));
  }

  // ----- 描画 -----
  function render() {
    const list = filtered();

    // 地図マーカー（クラスタ）を絞り込みに合わせて再構築
    updateClusterer(list);

    // 一覧（多すぎると重いので上限まで描画。地図には全件表示される）
    els.count.textContent = list.length;
    els.list.innerHTML = "";
    const frag = document.createDocumentFragment();
    const shown = list.slice(0, LIST_LIMIT);
    shown.forEach((f) => {
      const li = document.createElement("li");
      li.className = "facility-item" + (f.id === state.activeId ? " active" : "");
      li.dataset.id = f.id;
      const color = window.CATEGORY_COLOR[f.category] || "#64748b";
      li.innerHTML =
        '<div class="facility-item__name">' +
        esc(f.name) +
        "</div>" +
        '<div class="facility-item__meta">' +
        '<span class="tag" style="background:' +
        color +
        '">' +
        esc(f.category) +
        "</span>" +
        '<span class="tag tag--ward">' +
        esc(f.ward) +
        "</span>" +
        "</div>" +
        '<div class="facility-item__addr">' +
        esc(f.address) +
        "</div>";
      li.addEventListener("click", () => setActive(f.id, true));
      frag.appendChild(li);
    });
    els.list.appendChild(frag);

    if (list.length === 0) {
      els.list.innerHTML =
        '<li style="padding:18px 14px;color:var(--text-muted);font-size:.82rem;">条件に合う事業所がありません。</li>';
    } else if (list.length > LIST_LIMIT) {
      const more = document.createElement("li");
      more.style.cssText =
        "padding:12px 14px;color:var(--text-muted);font-size:.78rem;background:#f8fafc;";
      more.textContent =
        "他 " +
        (list.length - LIST_LIMIT) +
        " 件は地図に表示中です。検索・カテゴリ・区で絞り込むと一覧に表示されます。";
      els.list.appendChild(more);
    }
  }

  function highlightList(id) {
    state.activeId = id;
    els.list.querySelectorAll(".facility-item").forEach((li) => {
      li.classList.toggle("active", li.dataset.id === id);
    });
    const activeLi = els.list.querySelector(
      '.facility-item[data-id="' + id + '"]'
    );
    if (activeLi) activeLi.scrollIntoView({ block: "nearest" });
  }

  // ----- アクティブ選択（一覧→地図の連動）-----
  function setActive(id, panTo) {
    const f = state.facilities.find((x) => x.id === id);
    if (f && map) {
      if (panTo) {
        map.panTo({ lat: f.lat, lng: f.lng });
        if (map.getZoom() < 16) map.setZoom(16);
      }
      openInfoForFacility(f);
    }
    highlightList(id);
    // モバイルでは地図を見せるためサイドバーを閉じる
    if (panTo && window.matchMedia("(max-width: 760px)").matches) {
      els.sidebar.classList.remove("open");
    }
  }

  // ----- イベント -----
  function bindEvents() {
    els.search.addEventListener("input", (e) => {
      state.query = e.target.value;
      render();
    });
    els.wardSelect.addEventListener("change", (e) => {
      state.ward = e.target.value;
      render();
    });
    els.checkAll.addEventListener("click", () => setAllCategories(true));
    els.uncheckAll.addEventListener("click", () => setAllCategories(false));
    els.toggleSidebar.addEventListener("click", () => {
      els.sidebar.classList.toggle("open");
    });

    // 絞り込みパネルの開閉（前回状態を localStorage に保存）
    applySearchCollapsed(localStorage.getItem(SEARCH_COLLAPSED_KEY) === "1");
    els.searchPanelToggle.addEventListener("click", () => {
      const collapsed = !els.searchPanel.classList.contains("collapsed");
      applySearchCollapsed(collapsed);
      try {
        localStorage.setItem(SEARCH_COLLAPSED_KEY, collapsed ? "1" : "0");
      } catch {
        /* プライベートモード等で書けなくても無視 */
      }
    });
  }

  function applySearchCollapsed(collapsed) {
    els.searchPanel.classList.toggle("collapsed", collapsed);
    els.searchPanelToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }

  // クラスタの吹き出し（数字つき円）を描画する。
  // 件数が多いクラスタほど濃い青、少ないほど薄い青で表示する。
  // count を、画面内クラスタの最大件数 stats.clusters.markers.max に対する
  // 比率で評価し、薄い青→濃い青へ線形補間する。
  function renderCluster({ count, position }, stats) {
    const max = Math.max(stats.clusters.markers.max, count, 1);
    const t = max <= 1 ? 0 : (count - 1) / (max - 1); // 0:最小 〜 1:最大
    const lerp = (a, b) => Math.round(a + (b - a) * t);
    // 薄い鮮やか青(125,196,255) → 濃い鮮やか青(0,92,230) を補間
    const fill = `rgb(${lerp(125, 0)},${lerp(196, 92)},${lerp(255, 230)})`;
    const textColor = t > 0.5 ? "#ffffff" : "#0d47a1"; // 濃い背景は白文字
    const r = 20; // 円の半径
    const pad = 8; // ぼかしが切れないようにする余白
    const size = (r + pad) * 2;
    const c = r + pad; // 中心
    // 枠線は付けず、feGaussianBlur で輪郭をふわっとぼかす
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter></defs><circle cx="${c}" cy="${c}" r="${r}" fill="${fill}" fill-opacity="0.9" filter="url(#b)"/></svg>`;
    return new google.maps.Marker({
      position,
      zIndex: 1000 + count,
      icon: {
        url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
        scaledSize: new google.maps.Size(size, size),
        anchor: new google.maps.Point(c, c),
      },
      label: {
        text: String(count),
        color: textColor,
        fontSize: "13px",
        fontWeight: "700",
      },
    });
  }

  // 地図とデータが両方そろったらマーカーとクラスタリングを生成する
  function maybeBuildMarkers() {
    if (!mapReady || markersBuilt || !state.facilities.length) return;
    buildGroups();
    state.groups.forEach((facs, key) =>
      state.markers.set(key, makeGroupMarker(key, facs))
    );

    // 表示範囲内のマーカーだけをクラスタ化／描画する軽量アルゴリズム。
    // ズームインで全件が個別ピン化しても、画面外は描画しないので軽い。
    //   radius: まとめる範囲。 maxZoom: これを超えてズームインすると個別ピン表示。
    // 絞り込み後のマーカーを渡して生成することで、初回renderで必ず load() が走り、
    // getClusters-before-load クラッシュ（reading 'range'）を回避する。
    // 以降の描画はコンストラクタ（overlayのprojection準備後に実行）に任せ、
    // render() 側のクラスタ更新は初回スキップする（updateClusterer 参照）。
    clusterer = new markerClusterer.MarkerClusterer({
      map,
      markers: visibleMarkerList(filtered()),
      onClusterClick: () => {}, // クラスタのクリック拡大を無効化
      algorithm: new markerClusterer.SuperClusterViewportAlgorithm({
        radius: 100,
        maxZoom: 14,
      }),
      renderer: { render: renderCluster },
    });

    markersBuilt = true;
    render(); // 一覧を反映（クラスタは上で生成済みなので初回は触らない）
  }

  // ===== Googleログイン =====

  // GIS（Sign in with Google）スクリプトの読み込み待ち。
  function waitForGIS() {
    return new Promise((resolve, reject) => {
      const ready = () => window.google && google.accounts && google.accounts.id;
      if (ready()) return resolve();
      let n = 0;
      const t = setInterval(() => {
        if (ready()) {
          clearInterval(t);
          resolve();
        } else if (++n > 100) {
          clearInterval(t);
          reject(new Error("Googleログインを読み込めませんでした"));
        }
      }, 100);
    });
  }

  async function initAuth() {
    try {
      const res = await fetch("/api/config");
      const cfg = await res.json();
      auth.clientId = cfg.clientId || null;
      auth.user = cfg.user || null;
    } catch {
      /* 設定取得失敗時はログイン非表示のまま地図は使える */
    }
    if (auth.clientId) {
      try {
        await waitForGIS();
        google.accounts.id.initialize({
          client_id: auth.clientId,
          callback: onGoogleCredential,
        });
      } catch {
        /* GISが読めない場合はボタンを出さない */
      }
    }
    updateAuthUI();
  }

  function updateAuthUI() {
    const area = document.getElementById("auth-area");
    if (!area) return;
    area.innerHTML = "";

    if (auth.user) {
      const name = document.createElement("span");
      name.className = "auth-user";
      name.textContent = auth.user.name || auth.user.email;
      const out = document.createElement("button");
      out.type = "button";
      out.className = "auth-btn";
      out.textContent = "ログアウト";
      out.addEventListener("click", logout);
      area.appendChild(name);
      area.appendChild(out);
    } else if (auth.clientId && window.google && google.accounts && google.accounts.id) {
      const holder = document.createElement("div");
      area.appendChild(holder);
      google.accounts.id.renderButton(holder, {
        type: "standard",
        theme: "outline",
        size: "medium",
        text: "signin",
        shape: "pill",
      });
    }
  }

  async function onGoogleCredential(resp) {
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential: resp.credential }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        alert(e.error || "ログインに失敗しました");
        return;
      }
      const data = await res.json();
      auth.user = data.user;
      updateAuthUI();
      refreshOpenPopup();
    } catch {
      alert("ログインに失敗しました");
    }
  }

  async function logout() {
    try {
      await fetch("/api/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    auth.user = null;
    if (window.google && google.accounts && google.accounts.id) {
      google.accounts.id.disableAutoSelect();
    }
    updateAuthUI();
    refreshOpenPopup();
  }

  // 開いている吹き出しを今のログイン状態で開き直す（メモ欄を更新）。
  function refreshOpenPopup() {
    if (!state.activeId) return;
    const f = state.facilities.find((x) => x.id === state.activeId);
    if (f) openInfoForFacility(f);
  }

  // ----- データ読み込み -----
  function load() {
    buildCategoryFilters();
    buildWardSelect();
    bindEvents();
    initAuth();

    fetch("data/facilities.json")
      .then((r) => {
        if (!r.ok) throw new Error("データの読み込みに失敗しました (" + r.status + ")");
        return r.json();
      })
      .then((data) => {
        state.facilities = data;
        render(); // 一覧は地図前でも表示
        maybeBuildMarkers();
      })
      .catch((err) => {
        els.list.innerHTML =
          '<li style="padding:18px 14px;color:#b91c1c;font-size:.82rem;">' +
          esc(err.message) +
          "<br>ローカルで開く場合は簡易サーバー（例: <code>python3 -m http.server</code>）経由でアクセスしてください。</li>";
        console.error(err);
      });
  }

  load();
})();
