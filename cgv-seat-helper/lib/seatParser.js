// 좌석 API 응답(JSON)에서 좌석 정보를 뽑아내는 순수 함수 모음.
// CGV API 응답의 정확한 필드명은 상영관/버전에 따라 달라질 수 있어서,
// 특정 필드명을 하드코딩하지 않고 "좌석/열/번호/상태처럼 보이는 키"를 휴리스틱으로 찾는다.

const ROW_COL_KEYS = /seat|seatno|seatnum|row|col|좌석|열/i;
const NUM_LIKE_KEYS = /no|num|number|row|col|seat/i;

const NAME_KEYS = ["seatNm", "seatName", "seatNo", "seatNum", "seatNoNm", "seatCd", "seatId"];
const ROW_KEYS = ["rowNm", "seatRowNm", "seatRow", "row", "seatLine", "lineNm", "seatNo"];
const NUMBER_KEYS = ["seatNo", "seatNum", "seatNumber", "colNo", "seatCol", "seatColNo", "no"];

const SOLD_LIKE = /(sold|rsv|reserv|occup|block|hold|disable|disabled|unavailable|impossible|close|closed|sellyn|sellout)/i;
const AVAILABLE_LIKE = /(avail|available|empty|remain|able|sale|selectable|bookable)/i;
const STATUS_KEY_LIKE = /(status|stat|stts|state|seat.*cd|cd.*seat|seat.*sts|sts.*seat|좌석.*상태|상태)/i;

const TRUE_WORDS = ["y", "yes", "true", "1", "가능", "예매가능", "선택가능", "빈좌석", "available", "empty", "free"];
const FALSE_WORDS = ["n", "no", "false", "0", "불가", "예매불가", "선택불가", "매진", "sold", "reserved", "disabled"];

// 중첩 객체를 순회하며 "좌석 레코드처럼 보이는 객체"를 모두 수집한다.
function findSeatLikeObjects(root) {
  const found = [];
  const seen = new Set();

  function walk(node) {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (looksLikeSeatRecord(node)) found.push(node);
    for (const value of Object.values(node)) walk(value);
  }

  walk(root);
  return found;
}

function looksLikeSeatRecord(obj) {
  const keys = Object.keys(obj).map((k) => k.toLowerCase());
  const joined = keys.join("|");
  return ROW_COL_KEYS.test(joined) && keys.some((k) => NUM_LIKE_KEYS.test(k));
}

// 중첩 객체를 "a.b.c" 형태의 평면 키로 펼친다 (얕은 키도 함께 남겨서 둘 다로 조회 가능하게).
function flatten(obj, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flatten(value, path, out);
    } else {
      out[key] = value;
      out[path] = value;
    }
  }
  return out;
}

function pickFirst(flat, candidateKeys) {
  const byLowerKey = new Map(Object.keys(flat).map((k) => [k.toLowerCase(), k]));
  for (const candidate of candidateKeys) {
    const actualKey = byLowerKey.get(candidate.toLowerCase());
    if (actualKey && flat[actualKey] !== undefined && flat[actualKey] !== null && flat[actualKey] !== "") {
      return flat[actualKey];
    }
  }
  return undefined;
}

function rowLetters(value) {
  const match = String(value || "").trim().toUpperCase().match(/[A-Z가-힣]+/);
  return match ? match[0] : "";
}

function firstNumber(value) {
  const match = String(value || "").match(/\d+/);
  return match ? Number(match[0]) : undefined;
}

function guessAvailability(flat) {
  const entries = Object.entries(flat)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => [k, String(v).trim()]);

  // 1) 상태처럼 보이는 키의 값이 명확히 매진/불가/가능 단어면 그걸 우선한다.
  for (const [key, val] of entries) {
    if (STATUS_KEY_LIKE.test(key.toLowerCase())) {
      const lower = val.toLowerCase();
      if (/sold|reserved|disabled|unavailable|hold|block|매진|예약|예매완료|선택불가|판매불가|장애|불가/.test(lower)) {
        return { available: false, reason: `${key}=${val}` };
      }
      if (/available|empty|free|normal|open|예매가능|선택가능|빈좌석|가능좌석/.test(lower)) {
        return { available: true, reason: `${key}=${val}` };
      }
    }
  }

  // 2) 불가/가능을 뜻하는 boolean-like 값 (키 이름이 sold/available류인 경우)
  for (const [key, val] of entries) {
    const lowerKey = key.toLowerCase();
    if (SOLD_LIKE.test(lowerKey) && TRUE_WORDS.includes(val.toLowerCase())) {
      return { available: false, reason: `${key}=${val}` };
    }
    if (AVAILABLE_LIKE.test(lowerKey) && FALSE_WORDS.includes(val.toLowerCase())) {
      return { available: false, reason: `${key}=${val}` };
    }
  }
  for (const [key, val] of entries) {
    if (AVAILABLE_LIKE.test(key.toLowerCase()) && TRUE_WORDS.includes(val.toLowerCase())) {
      return { available: true, reason: `${key}=${val}` };
    }
  }

  return { available: null, reason: "상태 필드 미확인" };
}

function toRowIndex(row) {
  return /^[A-Z]+$/.test(row) ? row.split("").reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0) : null;
}

function rowInRange(row, rowStart, rowEnd) {
  const a = toRowIndex(rowStart);
  const b = toRowIndex(rowEnd);
  const r = toRowIndex(row);
  if (r === null || a === null || b === null) {
    return row >= rowStart && row <= rowEnd;
  }
  return r >= Math.min(a, b) && r <= Math.max(a, b);
}

/**
 * apiData(좌석 API 응답 JSON)에서 조건(rowStart~rowEnd, seatStart~seatEnd)에 맞는
 * 좌석만 골라 available / unknown 목록으로 분류한다.
 */
export function parseSeatsFromApiData(apiData, { rowStart, rowEnd, seatStart, seatEnd }) {
  const rStart = String(rowStart).trim().toUpperCase();
  const rEnd = String(rowEnd).trim().toUpperCase();
  const nStart = Math.min(seatStart, seatEnd);
  const nEnd = Math.max(seatStart, seatEnd);

  const records = findSeatLikeObjects(apiData)
    .map((raw) => {
      const flat = flatten(raw);
      const name = pickFirst(flat, NAME_KEYS);
      const row = rowLetters(pickFirst(flat, ROW_KEYS) ?? name);
      const number = firstNumber(pickFirst(flat, NUMBER_KEYS) ?? name);
      const { available, reason } = guessAvailability(flat);
      return {
        row,
        number,
        label: `${row}${number ?? ""}`,
        name: name ? String(name) : `${row}${number ?? ""}`,
        available,
        reason,
      };
    })
    .filter((s) => s.row && Number.isInteger(s.number))
    .filter((s) => rowInRange(s.row, rStart, rEnd))
    .filter((s) => s.number >= nStart && s.number <= nEnd);

  const available = records.filter((s) => s.available === true);
  const unknown = records.filter((s) => s.available === null);

  return { available, unknown, total: records.length };
}

function rowOrderThenNumber(a, b) {
  return (toRowIndex(a.row) ?? 0) - (toRowIndex(b.row) ?? 0) || a.number - b.number;
}

/** 정렬된 좌석 목록에서 같은 열에 번호가 연속으로 이어지는 가장 긴 묶음을 찾는다. */
export function findBestContiguousBlock(seats, targetCount) {
  const sorted = seats.slice().sort(rowOrderThenNumber);
  const groups = [];
  for (const seat of sorted) {
    const lastGroup = groups[groups.length - 1];
    const lastSeat = lastGroup?.[lastGroup.length - 1];
    if (lastSeat && lastSeat.row === seat.row && seat.number === lastSeat.number + 1) {
      lastGroup.push(seat);
    } else {
      groups.push([seat]);
    }
  }
  const exact = groups.find((g) => g.length >= targetCount);
  if (exact) return exact.slice(0, targetCount);
  return groups.slice().sort((a, b) => b.length - a.length)[0] || [];
}
