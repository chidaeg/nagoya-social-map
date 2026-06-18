// 名古屋市 障がい福祉社会資源マップ - メインロジック
(function () {
  "use strict";

  const NAGOYA_CENTER = [35.1607, 136.9099]; // 名古屋市中心付近
  const DEFAULT_ZOOM = 12;

  // 状態
  const state = {
    facilities: [],
    markers: new Map(), // id -> Leaflet marker
    activeCategories: new Set(), // 表示中のカテゴリ
    ward: "",
    query: "",
    activeId: null,
  };

  // ----- 地図初期化 -----
  const map = L.map("map", { zoomControl: true }).setView(
    NAGOYA_CENTER,
    DEFAULT_ZOOM
  );
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  // 件数が多いためマーカーをクラスタリングして表示する
  const clusterGroup = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 50,
    spiderfyOnMaxZoom: true,
    chunkedLoading: true,
  });
  map.addLayer(clusterGroup);

  const LIST_LIMIT = 300; // 一覧に描画する最大件数（地図には全件表示）

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
  function makeMarker(f) {
    const color = window.CATEGORY_COLOR[f.category] || "#64748b";
    const icon = L.divIcon({
      className: "",
      html: '<div class="marker-pin" style="background:' + color + '"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 18],
      popupAnchor: [0, -16],
    });
    const marker = L.marker([f.lat, f.lng], { icon });
    marker.bindPopup(popupHtml(f));
    marker.on("click", () => setActive(f.id, false));
    return marker;
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
    const visibleMarkers = [];
    list.forEach((f) => {
      const m = state.markers.get(f.id);
      if (m) visibleMarkers.push(m);
    });
    clusterGroup.clearLayers();
    clusterGroup.addLayers(visibleMarkers);

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

  // ----- アクティブ選択（一覧↔地図の連動）-----
  function setActive(id, panTo) {
    state.activeId = id;
    const f = state.facilities.find((x) => x.id === id);
    const marker = state.markers.get(id);
    if (f && marker) {
      if (panTo) {
        // クラスタ内のマーカーでも見えるようズームしてからポップアップを開く
        clusterGroup.zoomToShowLayer(marker, () => marker.openPopup());
      } else {
        marker.openPopup();
      }
    }
    // 一覧のハイライト更新
    els.list.querySelectorAll(".facility-item").forEach((li) => {
      li.classList.toggle("active", li.dataset.id === id);
    });
    const activeLi = els.list.querySelector('.facility-item[data-id="' + id + '"]');
    if (activeLi) activeLi.scrollIntoView({ block: "nearest" });
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
        data.forEach((f) => state.markers.set(f.id, makeMarker(f)));
        render();
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
