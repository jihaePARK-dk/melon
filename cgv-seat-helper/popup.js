const FIELD_IDS = ["rowStart", "rowEnd", "seatStart", "seatEnd", "peopleCount"];
const DEFAULTS = { rowStart: "F", rowEnd: "O", seatStart: "16", seatEnd: "29", peopleCount: "2" };

const form = document.getElementById("form");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");

let pollTimer = null;

init();

async function init() {
  for (const id of FIELD_IDS) {
    const saved = (await chrome.storage.local.get(`seatHelperForm:${id}`))[`seatHelperForm:${id}`];
    document.getElementById(id).value = saved ?? DEFAULTS[id];
  }
  refreshState();
  pollTimer = setInterval(refreshState, 800);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const tabId = await getActiveTabId();
  if (!tabId) return;

  const values = {};
  for (const id of FIELD_IDS) {
    values[id] = document.getElementById(id).value.trim();
    chrome.storage.local.set({ [`seatHelperForm:${id}`]: values[id] });
  }

  const response = await chrome.runtime.sendMessage({
    type: "SEAT_HELPER_START",
    payload: { tabId, form: values },
  });
  if (!response.ok) {
    statusEl.textContent = response.error;
    return;
  }
  render(response.state);
});

stopBtn.addEventListener("click", async () => {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  const response = await chrome.runtime.sendMessage({ type: "SEAT_HELPER_STOP", payload: { tabId } });
  if (response.ok) render(response.state);
});

async function refreshState() {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  const response = await chrome.runtime.sendMessage({ type: "SEAT_HELPER_GET_STATE", payload: { tabId } });
  if (response.ok) render(response.state);
}

function render(state) {
  statusEl.textContent = state.status || (state.running ? "조회 중..." : "CGV 좌석 선택 화면에서 시작해주세요.");
  startBtn.disabled = state.running;
  stopBtn.disabled = !state.running;
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith("https://cgv.co.kr/") && !tab?.url?.startsWith("https://www.cgv.co.kr/")) {
    statusEl.textContent = "CGV 예매(좌석 선택) 페이지를 열고 다시 시도해주세요.";
    return null;
  }
  return tab.id;
}

window.addEventListener("unload", () => {
  if (pollTimer) clearInterval(pollTimer);
});
