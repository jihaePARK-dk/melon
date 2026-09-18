import { parseSeatsFromApiData, findBestContiguousBlock } from "./lib/seatParser.js";

// ── 이 확장이 자동으로 하는 일은 "새로고침 → 조건에 맞는 빈 좌석 찾기 → 좌석 클릭"까지 뿐입니다.
// 로그인, 관람권 적용, 결제 단계는 절대 건드리지 않습니다. 좌석이 선택되면 실행을 멈추고
// 알림을 띄우니, 이후 로그인/결제는 직접 진행해주세요.

const CGV_URL = /^https:\/\/(www\.)?cgv\.co\.kr\//;
const runningByTab = new Map(); // tabId -> { stopRequested }

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true; // 비동기 응답
});

async function handleMessage(message) {
  if (message?.type === "SEAT_HELPER_GET_STATE") {
    return { ok: true, state: await getState(message.payload.tabId) };
  }
  if (message?.type === "SEAT_HELPER_STOP") {
    const { tabId } = message.payload;
    const ctrl = runningByTab.get(tabId);
    if (ctrl) ctrl.stopRequested = true;
    await saveState(tabId, { running: false, status: "중지됨" });
    return { ok: true, state: await getState(tabId) };
  }
  if (message?.type === "SEAT_HELPER_START") {
    const { tabId, form } = message.payload;
    const validation = validateForm(form);
    if (!validation.ok) return { ok: false, error: validation.error };
    if (runningByTab.has(tabId)) return { ok: true, state: await getState(tabId) };

    const ctrl = { stopRequested: false };
    runningByTab.set(tabId, ctrl);
    await saveState(tabId, { running: true, status: "조회 중...", runCount: 0, matchedSeats: null, error: undefined });
    runLoop({ tabId, ctrl, form: validation.form });
    return { ok: true, state: await getState(tabId) };
  }
  return { ok: false, error: "unknown message" };
}

function validateForm(form) {
  const seatStart = Number(form?.seatStart);
  const seatEnd = Number(form?.seatEnd);
  const peopleCount = Number(form?.peopleCount);
  if (!form?.rowStart || !form?.rowEnd || !Number.isInteger(seatStart) || !Number.isInteger(seatEnd)) {
    return { ok: false, error: "좌석 범위(열/번호)를 확인해주세요." };
  }
  if (!Number.isInteger(peopleCount) || peopleCount < 1) {
    return { ok: false, error: "관람 인원을 확인해주세요." };
  }
  return {
    ok: true,
    form: {
      rowStart: String(form.rowStart).trim().toUpperCase(),
      rowEnd: String(form.rowEnd).trim().toUpperCase(),
      seatStart,
      seatEnd,
      peopleCount,
    },
  };
}

async function runLoop({ tabId, ctrl, form }) {
  const POLL_INTERVAL_MS = 1800; // 서버 부담을 줄이기 위한 최소 간격. 더 짧게 줄이지 마세요.

  try {
    while (!ctrl.stopRequested) {
      const state = await getState(tabId);
      await saveState(tabId, { running: true, runCount: state.runCount + 1, status: "새로고침 중..." });

      const tab = await chrome.tabs.get(tabId);
      if (!CGV_URL.test(tab.url || "")) {
        await fail(tabId, ctrl, "CGV 예매 페이지가 아닙니다. 좌석 선택 화면에서 다시 시도해주세요.");
        return;
      }

      const capture = await refreshAndCaptureSeatApi(tabId);
      if (!capture.clicked) {
        await fail(tabId, ctrl, "새로고침 버튼을 찾지 못했습니다.");
        return;
      }
      if (!capture.ok || capture.data === undefined) {
        // 일시적인 응답 실패는 재시도 (좌석창을 닫았거나 네트워크 지연일 수 있음)
        await saveState(tabId, { status: capture.error || "좌석 정보를 불러오지 못했습니다. 재시도 중..." });
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const { available, unknown } = parseSeatsFromApiData(capture.data, form);
      const block = findBestContiguousBlock(available, form.peopleCount);
      const unknownNote = unknown.length ? `, 상태 미확인 ${unknown.length}개` : "";

      if (block.length === 0) {
        await saveState(tabId, {
          status: `범위 내 빈자리 없음 (조회 ${state.runCount + 1}회${unknownNote})`,
          matchedSeats: null,
        });
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      await saveState(tabId, { status: `빈자리 발견, ${block.length}석 선택 중...` });
      const clickResult = await selectSeatsOnPage(tabId, block.map((s) => s.label));

      if (clickResult.clickedLabels.length === 0) {
        await saveState(tabId, { status: "좌석을 찾았지만 클릭에 실패했습니다. 화면을 확인해주세요." });
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      // 목표 달성: 좌석 선택까지만 자동화하고 여기서 멈춘다. 로그인/결제는 사용자가 직접.
      await saveState(tabId, {
        running: false,
        status: `좌석 ${clickResult.clickedLabels.join(", ")} 선택 완료. 이후 로그인/결제는 직접 진행해주세요.`,
        matchedSeats: clickResult.clickedLabels,
      });
      notify(`좌석 선택 완료: ${clickResult.clickedLabels.join(", ")}`);
      return;
    }
    await saveState(tabId, { running: false, status: "중지됨" });
  } catch (err) {
    await fail(tabId, ctrl, err instanceof Error ? err.message : "알 수 없는 오류");
  } finally {
    if (runningByTab.get(tabId) === ctrl) runningByTab.delete(tabId);
  }
}

async function fail(tabId, ctrl, message) {
  ctrl.stopRequested = true;
  await saveState(tabId, { running: false, status: message, error: message });
}

function notify(message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "CGV 좌석 자동 선택 도우미",
    message,
  });
}

// ── 페이지에 주입되는 함수들 (MAIN world에서 실행) ──────────────────────────
// CGV 사이트 마크업이 바뀌면 아래 셀렉터가 깨질 수 있습니다. 그럴 경우
// "새로고침" 버튼 / 좌석 버튼의 실제 클래스명을 다시 확인해서 갱신해주세요.

async function refreshAndCaptureSeatApi(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [5000],
    func: (timeoutMs) =>
      new Promise((resolve) => {
        const isSeatApiUrl = (url) => {
          try {
            const u = new URL(url, window.location.origin);
            return (
              (u.hostname === "api.cgv.co.kr" && u.pathname === "/cnm/atkt/searchIfSeatData") ||
              (u.origin === window.location.origin && u.pathname === "/api/v1/booking/searchIfSeatData")
            );
          } catch {
            return false;
          }
        };

        const refreshBtn =
          [
            ...document.querySelectorAll(
              'button.btn-icon[title="새로고침"], button[title="새로고침"], button[aria-label="새로고침"]'
            ),
          ].find((el) => !el.disabled) ||
          [...document.querySelectorAll("button")].find(
            (el) =>
              !el.disabled &&
              [el.title, el.getAttribute("aria-label"), el.textContent]
                .filter(Boolean)
                .join(" ")
                .replace(/\s+/g, "")
                .includes("새로고침")
          );

        if (!refreshBtn) {
          resolve({ clicked: false, ok: false, error: "refresh button not found" });
          return;
        }

        let settled = false;
        const origFetch = window.fetch;
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;

        const cleanup = () => {
          window.fetch = origFetch;
          XMLHttpRequest.prototype.open = origOpen;
          XMLHttpRequest.prototype.send = origSend;
        };
        const finish = (payload) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(payload);
        };

        window.fetch = async (...fetchArgs) => {
          const url = typeof fetchArgs[0] === "string" ? fetchArgs[0] : fetchArgs[0]?.url;
          const res = await origFetch(...fetchArgs);
          if (url && isSeatApiUrl(url)) {
            res
              .clone()
              .json()
              .then((data) => finish({ clicked: true, ok: res.ok, status: res.status, data }))
              .catch(() => finish({ clicked: true, ok: false, error: "response was not JSON" }));
          }
          return res;
        };

        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
          this.__seatHelperUrl = String(url);
          return origOpen.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.send = function (...sendArgs) {
          const xhr = this;
          if (xhr.__seatHelperUrl && isSeatApiUrl(xhr.__seatHelperUrl)) {
            xhr.addEventListener("loadend", () => {
              try {
                const data = xhr.responseType === "json" ? xhr.response : JSON.parse(xhr.responseText);
                finish({ clicked: true, ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
              } catch {
                finish({ clicked: true, ok: false, error: "response was not JSON" });
              }
            });
          }
          return origSend.apply(xhr, sendArgs);
        };

        window.setTimeout(() => finish({ clicked: true, ok: false, error: "seat API response timeout" }), timeoutMs);
        refreshBtn.click();
      }),
  });
  return result;
}

async function selectSeatsOnPage(tabId, labels) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [labels],
    func: (targetLabels) => {
      const isDisabled = (el) =>
        el.hasAttribute("disabled") ||
        el.getAttribute("aria-disabled") === "true" ||
        el.className.toString().toLowerCase().includes("disabled");

      const clickLikeUser = (el) => {
        el.scrollIntoView({ block: "center", inline: "center" });
        for (const type of ["pointerdown", "mousedown", "mouseup"]) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
        el.click();
      };

      const seatButtons = [
        ...document.querySelectorAll(
          "[class*='seatMap_seatPositionWrap__'] button, button[class*='seatMap_seatNumber__']"
        ),
      ];

      const clickedLabels = [];
      for (const label of targetLabels) {
        const normalized = String(label).replace(/\s+/g, "").toUpperCase();
        const btn = seatButtons.find(
          (el) => String(el.textContent || "").replace(/\s+/g, "").toUpperCase() === normalized && !isDisabled(el)
        );
        if (btn) {
          clickLikeUser(btn);
          clickedLabels.push(normalized);
        }
      }
      return clickedLabels;
    },
  });
  return { clickedLabels: result || [] };
}

// ── 상태 저장/조회 ──────────────────────────────────────────────────────

const DEFAULT_STATE = { running: false, status: "", runCount: 0, matchedSeats: null };

function stateKey(tabId) {
  return `seatHelperState:${tabId}`;
}

async function getState(tabId) {
  const key = stateKey(tabId);
  const stored = (await chrome.storage.local.get(key))[key];
  if (!stored) return DEFAULT_STATE;
  if (stored.running && !runningByTab.has(tabId)) {
    // 서비스워커가 재시작되어 루프가 끊긴 경우
    const recovered = { ...stored, running: false, status: "중지됨 (백그라운드 재시작)" };
    await chrome.storage.local.set({ [key]: recovered });
    return recovered;
  }
  return stored;
}

async function saveState(tabId, patch) {
  const next = { ...(await getState(tabId)), ...patch };
  await chrome.storage.local.set({ [stateKey(tabId)]: next });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
