// 멜론티켓 좌석 선택 화면에서 "예매 가능해 보이는 좌석"을 찾아 강조 표시하고
// 사이드 패널에 목록으로 보여주는 스크립트입니다.
//
// 이 스크립트가 하지 않는 일:
//  - 새로고침을 자동으로 누르지 않습니다 (네트워크 요청을 스스로 만들지 않음)
//  - 좌석을 클릭/선택하지 않습니다
//  - 예매·결제를 진행하지 않습니다
// 오직 화면에 이미 그려진 좌석 상태를 읽어서 "더 빨리 보이게" 해줄 뿐입니다.

(function () {
  const HIGHLIGHT_ATTR = "data-mth-highlighted";
  const PANEL_ID = "mth-panel";
  const SCAN_DEBOUNCE_MS = 250;

  const NEGATIVE_CLASS_HINT = /(sold|unable|disable|block|reserved|selected|미배정|매진|불가|선택불가|판매완료|판매불가|배정불가)/i;
  const POSITIVE_CLASS_HINT = /(able|available|selectable|가능|선택가능|빈좌석|empty)/i;

  let scanTimer = null;
  let highlightsOn = true;
  let lastResult = { available: [], totalScanned: 0 };

  chrome.storage?.local.get("mthHighlightsOn").then((v) => {
    if (typeof v.mthHighlightsOn === "boolean") highlightsOn = v.mthHighlightsOn;
  });

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanAndRender, SCAN_DEBOUNCE_MS);
  }

  // ── 1) 좌석처럼 보이는 요소 찾기 ─────────────────────────────────────
  function findSeatCandidates() {
    const explicit = document.querySelectorAll(
      [
        'a[class*="seat" i]',
        'button[class*="seat" i]',
        'li[class*="seat" i]',
        '[data-seat]',
        '[class*="seat" i][onclick]',
        'svg [class*="seat" i]',
      ].join(", ")
    );
    let candidates = [...explicit].filter(isLeafClickable);
    if (candidates.length >= 8) return dedupe(candidates);

    // 클래스명에 seat가 없는 경우를 대비한 크기 기반 fallback:
    // "seat"/"좌석" 이 들어간 컨테이너 안에서, 작고 촘촘하게 반복되는 요소를 찾는다.
    const containers = [...document.querySelectorAll('[class*="seat" i], [id*="seat" i]')];
    let best = { el: null, count: 0 };
    for (const container of containers) {
      const kids = [...container.querySelectorAll("a, button, li, div, rect, circle")].filter(isSeatSized);
      if (kids.length > best.count) best = { el: container, count: kids.length };
    }
    if (best.el) {
      candidates = [...best.el.querySelectorAll("a, button, li, div, rect, circle")].filter(
        (el) => isSeatSized(el) && isLeafClickable(el)
      );
    }
    return dedupe(candidates);
  }

  function isLeafClickable(el) {
    // 다른 좌석 후보를 자식으로 포함하는 "그룹" 요소는 제외 (중복 방지)
    if (el.querySelector('[class*="seat" i]') && el.tagName !== "RECT" && el.tagName !== "CIRCLE") {
      const nestedSeatLike = [...el.querySelectorAll('[class*="seat" i]')].some(isSeatSized);
      if (nestedSeatLike) return false;
    }
    return true;
  }

  function isSeatSized(el) {
    const rect = el.getBoundingClientRect?.();
    if (!rect) return false;
    return rect.width >= 6 && rect.width <= 60 && rect.height >= 6 && rect.height <= 60;
  }

  function dedupe(list) {
    return [...new Set(list)];
  }

  // ── 2) 예매 가능 여부 판별 ───────────────────────────────────────────
  function classifyAvailability(el) {
    const classList = (el.getAttribute("class") || "").toLowerCase();
    const disabled =
      el.hasAttribute("disabled") ||
      el.getAttribute("aria-disabled") === "true" ||
      el.getAttribute("data-disabled") === "true";

    if (disabled) return false;
    if (NEGATIVE_CLASS_HINT.test(classList)) return false;
    if (POSITIVE_CLASS_HINT.test(classList)) return true;

    const style = window.getComputedStyle(el);
    if (style.pointerEvents === "none") return false;
    if (style.cursor === "not-allowed" || style.cursor === "default") return false;
    if (Number(style.opacity) > 0 && Number(style.opacity) < 0.5) return false;

    // 명확한 신호가 없으면 "클릭 가능한 상태"로 간주 (기본값: 예매 가능)
    return true;
  }

  // ── 3) 좌석 라벨 추정 (열 번호 + 순번) ────────────────────────────────
  function findRowMarkers() {
    const markers = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        const text = node.textContent?.trim();
        if (!text || node.children.length > 0) return NodeFilter.FILTER_SKIP;
        return /^\d{1,3}$/.test(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      markers.push({ row: node.textContent.trim(), rect });
    }
    return markers;
  }

  function labelSeat(el, rowMarkers) {
    const explicit = el.title || el.getAttribute("aria-label") || el.getAttribute("data-seat");
    if (explicit && explicit.trim()) return explicit.trim();

    const titleChild = el.querySelector?.("title");
    if (titleChild?.textContent?.trim()) return titleChild.textContent.trim();

    const rect = el.getBoundingClientRect();
    const centerY = rect.top + rect.height / 2;
    let nearest = null;
    let nearestDist = Infinity;
    for (const marker of rowMarkers) {
      if (marker.rect.left > rect.left) continue; // 행 번호는 좌석보다 왼쪽에 있다고 가정
      const dist = Math.abs(marker.rect.top + marker.rect.height / 2 - centerY);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = marker;
      }
    }
    if (nearest && nearestDist < 20) return `${nearest.row}열`;
    return "좌석";
  }

  // ── 4) 스캔 + 강조 표시 + 패널 렌더링 ──────────────────────────────────
  function clearHighlights() {
    document.querySelectorAll(`[${HIGHLIGHT_ATTR}]`).forEach((el) => {
      el.removeAttribute(HIGHLIGHT_ATTR);
      el.classList.remove("mth-seat-available");
      if (el instanceof SVGElement) {
        el.style.removeProperty("stroke");
        el.style.removeProperty("stroke-width");
        el.style.removeProperty("filter");
      }
    });
  }

  function scanAndRender() {
    clearHighlights();
    const candidates = findSeatCandidates();
    const rowMarkers = findRowMarkers();

    const seats = candidates.map((el) => ({
      el,
      available: classifyAvailability(el),
      label: labelSeat(el, rowMarkers),
    }));

    const available = seats.filter((s) => s.available);

    if (highlightsOn) {
      for (const seat of available) {
        seat.el.setAttribute(HIGHLIGHT_ATTR, "1");
        if (seat.el instanceof SVGElement) {
          seat.el.style.stroke = "#17c964";
          seat.el.style.strokeWidth = "3";
          seat.el.style.filter = "drop-shadow(0 0 4px #17c964)";
        } else {
          seat.el.classList.add("mth-seat-available");
        }
      }
    }

    lastResult = { available, totalScanned: seats.length };
    renderPanel();
  }

  // ── 5) 사이드 패널 UI ───────────────────────────────────────────────
  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="mth-header">
        <span>빈자리 도우미</span>
        <button class="mth-collapse" title="접기/펼치기">—</button>
      </div>
      <div class="mth-body">
        <div class="mth-summary"></div>
        <label class="mth-toggle">
          <input type="checkbox" class="mth-toggle-input" />
          좌석에 하이라이트 표시
        </label>
        <button class="mth-rescan">지금 화면 다시 읽기</button>
        <div class="mth-list"></div>
        <div class="mth-note">이 목록은 화면에 이미 표시된 좌석 상태를 읽은 것입니다. 클릭·선택·예매는 직접 진행해주세요.</div>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector(".mth-collapse").addEventListener("click", () => {
      panel.classList.toggle("mth-collapsed");
    });
    panel.querySelector(".mth-rescan").addEventListener("click", scanAndRender);
    const toggleInput = panel.querySelector(".mth-toggle-input");
    toggleInput.checked = highlightsOn;
    toggleInput.addEventListener("change", () => {
      highlightsOn = toggleInput.checked;
      chrome.storage?.local.set({ mthHighlightsOn: highlightsOn });
      scanAndRender();
    });

    return panel;
  }

  function renderPanel() {
    const panel = ensurePanel();
    const summary = panel.querySelector(".mth-summary");
    const list = panel.querySelector(".mth-list");

    if (lastResult.totalScanned === 0) {
      summary.textContent = "좌석 그리드를 찾지 못했습니다. 좌석 선택 화면을 열어주세요.";
      list.innerHTML = "";
      return;
    }

    summary.textContent = `빈자리 ${lastResult.available.length}개 / 전체 ${lastResult.totalScanned}개`;

    const groups = new Map();
    for (const seat of lastResult.available) {
      if (!groups.has(seat.label)) groups.set(seat.label, []);
      groups.get(seat.label).push(seat);
    }

    list.innerHTML = "";
    for (const [label, seats] of groups) {
      const item = document.createElement("div");
      item.className = "mth-list-item";
      item.textContent = seats.length > 1 ? `${label} (${seats.length}석)` : label;
      item.addEventListener("click", () => {
        seats[0].el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        flash(seats[0].el);
      });
      list.appendChild(item);
    }
  }

  function flash(el) {
    el.classList.add("mth-flash");
    setTimeout(() => el.classList.remove("mth-flash"), 900);
  }

  // ── 초기화 ───────────────────────────────────────────────────────
  function init() {
    ensurePanel();
    scheduleScan();
    const observer = new MutationObserver((mutations) => {
      // 우리가 직접 만든 변경(하이라이트 클래스/패널)은 무시해서 무한 루프 방지
      const meaningful = mutations.some(
        (m) => !(m.target.id === PANEL_ID || m.target.closest?.(`#${PANEL_ID}`))
      );
      if (meaningful) scheduleScan();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "disabled", "aria-disabled"],
    });
    window.addEventListener("resize", scheduleScan);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
