// 名古屋市 障がい福祉社会資源マップ - メインロジック（Google Maps版）
(function () {
  "use strict";

  const NAGOYA_CENTER = { lat: 35.1607, lng: 136.9099 }; // 名古屋市中心付近
  const DEFAULT_ZOOM = 12;
  const LIST_LIMIT = 300; // 一覧に描画する最大件数（地図には全件表示）

  let map = null;
  let clusterer = null;
  let infoWindow = null;
  let mapReady = false;
  let markersBuilt = false;

  // 状態
  const state = {
    facilities: [],
    markers: new Map(), // id -> google.maps.Marker
    activeCategories: new Set(),
    ward: "",
    query: "",
    activeId: null,
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
    map: document.getElementById("map"),
  };

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
    clusterer = new markerClusterer.MarkerClusterer({
      map,
      markers: [],
      // クラスタをクリックしても拡大しない（標準のズーム挙動を無効化）
      onClusterClick: () => {},
      // 表示範囲内のマーカーだけをクラスタ化する軽量アルゴリズム（ズーム/移動が軽い）。
      // radius: まとめる範囲（大きいほど軽い）。
      // maxZoom: この値を超えてズームインするとクラスタを解除して個別ピン表示
      //   （小さいほど早くピンに変わる。地図の初期ズームは12）。
      algorithm: new markerClusterer.SuperClusterViewportAlgorithm({
        radius: 100,
        maxZoom: 14,
      }),
    });
    mapReady = true;
    maybeBuildMarkers();
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

  function makeMarker(f) {
    const color = window.CATEGORY_COLOR[f.category] || "#64748b";
    const marker = new google.maps.Marker({
      position: { lat: f.lat, lng: f.lng },
      icon: markerIcon(f, color),
      title: f.name,
    });
    marker.facilityId = f.id;
    marker.addListener("click", () => {
      openInfo(f);
      highlightList(f.id);
    });
    return marker;
  }

  function openInfo(f) {
    // 位置指定でInfoWindowを開く（クラスタ内マーカーでも確実に表示される）
    infoWindow.setContent(popupHtml(f));
    infoWindow.setPosition({ lat: f.lat, lng: f.lng });
    infoWindow.open(map);
    state.activeId = f.id;
  }

  function popupHtml(f) {
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
      "</div>"
    );
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

  // ----- 描画 -----
  function render() {
    const list = filtered();

    // 地図マーカー（クラスタ）を再構築
    if (mapReady && markersBuilt) {
      const visibleMarkers = [];
      list.forEach((f) => {
        const m = state.markers.get(f.id);
        if (m) visibleMarkers.push(m);
      });
      clusterer.clearMarkers();
      clusterer.addMarkers(visibleMarkers);
    }

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
      openInfo(f);
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
  }

  // 地図とデータが両方そろったらマーカーを生成する
  function maybeBuildMarkers() {
    if (!mapReady || markersBuilt || !state.facilities.length) return;
    state.facilities.forEach((f) => state.markers.set(f.id, makeMarker(f)));
    markersBuilt = true;
    render();
  }

  // ----- データ読み込み -----
  function load() {
    buildCategoryFilters();
    buildWardSelect();
    bindEvents();

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
