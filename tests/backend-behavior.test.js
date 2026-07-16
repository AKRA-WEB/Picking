const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const rangeReads = [];
const VALID_LINE_USER_ID = "U0123456789abcdef0123456789abcdef";
const CHANGED_LINE_USER_ID = "Ufedcba9876543210fedcba9876543210";

function hasLoneSurrogate(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      i += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

function assertNoLoneSurrogates(value, label) {
  if (typeof value === "string") {
    assert.strictEqual(hasLoneSurrogate(value), false, label);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => assertNoLoneSurrogates(entry, label));
    return;
  }
  if (value && typeof value === "object") {
    Object.keys(value).forEach((key) => assertNoLoneSurrogates(value[key], label));
  }
}

class Range {
  constructor(sheet, row, column, rows, columns) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.rows = rows || 1;
    this.columns = columns || 1;
  }
  getValues() {
    rangeReads.push({
      row: this.row,
      column: this.column,
      rows: this.rows,
      columns: this.columns,
      locked: lock.held
    });
    return Array.from({ length: this.rows }, (_, r) =>
      Array.from({ length: this.columns }, (_, c) => this.sheet.value(this.row + r, this.column + c))
    );
  }
  setValues(values) {
    values.forEach((row, r) => row.forEach((value, c) => this.sheet.set(this.row + r, this.column + c, value)));
    return this;
  }
  setValue(value) { this.sheet.set(this.row, this.column, value); return this; }
  createTextFinder(searchText) {
    const range = this;
    let matchEntireCell = false;
    return {
      matchEntireCell(value) { matchEntireCell = value; return this; },
      matchCase() { return this; },
      findNext() {
        for (let r = 0; r < range.rows; r += 1) {
          for (let c = 0; c < range.columns; c += 1) {
            const value = String(range.sheet.value(range.row + r, range.column + c));
            if ((matchEntireCell && value === String(searchText)) || (!matchEntireCell && value.includes(String(searchText)))) {
              return { getRow: () => range.row + r };
            }
          }
        }
        return null;
      }
    };
  }
  setBackground() { return this; }
  setFontColor() { return this; }
  setFontWeight() { return this; }
  setNumberFormat() { return this; }
}

class Sheet {
  constructor(rows, maxColumns) {
    this.rows = rows.map((row) => row.slice());
    this.maxColumns = maxColumns || Math.max(1, ...this.rows.map((row) => row.length));
  }
  value(row, column) { return (this.rows[row - 1] || [])[column - 1] || ""; }
  set(row, column, value) {
    if (column > this.maxColumns) throw new Error("range exceeds grid columns");
    while (this.rows.length < row) this.rows.push([]);
    while (this.rows[row - 1].length < column) this.rows[row - 1].push("");
    this.rows[row - 1][column - 1] = value;
  }
  getLastRow() {
    for (let i = this.rows.length - 1; i >= 0; i -= 1) if (this.rows[i].some((v) => v !== "")) return i + 1;
    return 0;
  }
  getLastColumn() { return Math.max(0, ...this.rows.map((row) => row.length)); }
  getMaxColumns() { return this.maxColumns; }
  getMaxRows() { return Math.max(100, this.rows.length); }
  insertRowsAfter() {}
  insertColumnsAfter(column, count) {
    assert.strictEqual(column, this.maxColumns, "migration must append columns after the existing grid");
    this.maxColumns += count;
  }
  getRange(row, column, rows, columns) {
    if (column + (columns || 1) - 1 > this.maxColumns) throw new Error("range exceeds grid columns");
    return new Range(this, row, column, rows, columns);
  }
  getDataRange() { return new Range(this, 1, 1, this.getLastRow(), this.getLastColumn()); }
}

const requisition = new Sheet([[
  "uid", "timestamp", "billType", "requester", "assignee", "itemsJSON", "lineStatus", "doneBy", "doneAt",
  "token", "sentBy", "sentAt", "problemItems", "problemBy", "problemAt", "cardQuoteToken", "billNo", "clientRequestId", "lineAttemptAt", "linePayloadJSON"
]], 20);
const staff = new Sheet([
  ["name", "lineUserId", "active"],
  ["คลัง", VALID_LINE_USER_ID, true]
]);
const sheets = { Requisition: requisition, Staff: staff, ProductName: new Sheet([["id", "name", "defaultUnit", "active"]]) };
const cache = new Map();
const properties = new Map();
const lock = {
  held: false,
  failNext: false,
  onWait: null,
  waitCount: 0,
  waitLock() {
    this.waitCount += 1;
    if (this.failNext) { this.failNext = false; throw new Error("fixture lock timeout"); }
    if (this.onWait) {
      const callback = this.onWait;
      this.onWait = null;
      callback();
    }
    this.held = true;
  },
  releaseLock() { this.held = false; },
  hasLock() { return this.held; }
};
let uuid = 0;

const sandbox = {
  console,
  Date,
  JSON,
  Math,
  Object,
  Array,
  String,
  Number,
  Boolean,
  isFinite,
  encodeURIComponent,
  decodeURIComponent,
  SpreadsheetApp: { openById: () => ({ getSheetByName: (name) => sheets[name] }) },
  LockService: { getScriptLock: () => lock },
  CacheService: {
    getScriptCache: () => ({
      get: (key) => cache.get(key) || null,
      put: (key, value) => cache.set(key, value),
      remove: (key) => cache.delete(key)
    })
  },
  Session: { getScriptTimeZone: () => "Asia/Bangkok" },
  Utilities: {
    Charset: { UTF_8: "UTF_8" },
    DigestAlgorithm: { SHA_256: "SHA_256" },
    computeDigest: () => Array.from({ length: 32 }, (_, i) => i + 1),
    formatDate: (date, timezone, pattern) => {
      if (pattern === "yyyy-MM-dd") return "2026-07-15";
      if (pattern === "yyyyMMdd-HHmmss") return "20260715-120000";
      return "15/07/2026 12:00";
    },
    getUuid: () => "uuid-" + (++uuid)
  },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (key) => properties.get(key) || "", setProperty: (key, value) => properties.set(key, value) }) },
  UrlFetchApp: { fetch: () => { throw new Error("unexpected network call"); } },
  ContentService: { MimeType: { JSON: "JSON", TEXT: "TEXT" }, createTextOutput: (value) => ({ value, setMimeType() { return this; } }) }
};

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync("Code.gs.txt", "utf8"), sandbox);
const realPushLineFlex = sandbox.pushLineFlex;

let productReads = 0;
let historyReads = 0;
sandbox.getProducts = () => { productReads += 1; return [{ name: "สินค้า" }]; };
sandbox.getStaff = () => [{ name: "คลัง", lineUserId: VALID_LINE_USER_ID, active: true }];
sandbox.getRecentRequisitions = () => { historyReads += 1; return []; };
const user = { id: "u1", name: "ผู้เบิก", roles: ["WAREHOUSE"], perms: {} };
const warm = sandbox.getBootstrapData({ includeProducts: false, includeRequisitions: false, historyRev: "0" }, user, "boot-warm", Date.now());
assert.strictEqual(productReads, 0, "warm bootstrap must not read products");
assert.strictEqual(historyReads, 0, "unchanged warm bootstrap must not read history");
assert.strictEqual(Object.prototype.hasOwnProperty.call(warm, "products"), false);
const cold = sandbox.getBootstrapData({ includeProducts: true }, user, "boot-cold", Date.now());
assert.strictEqual(productReads, 1, "cold bootstrap reads products once");
assert.strictEqual(historyReads, 1, "cold bootstrap reads history once");
assert.strictEqual(cold.user.name, "ผู้เบิก");

sandbox.pushLineFlex = () => ({ success: false, retryable: true, message: "fixture LINE failure" });
const payload = {
  billType: "บิลจัด",
  assignee: "คลัง",
  items: [{ name: "สินค้า", qty: 1, unit: "ลัง" }],
  clientRequestId: "request-1"
};
const partial = sandbox.saveRequisition(payload, user, "request-1", Date.now());
assert.strictEqual(partial.success, false, "partial LINE failure must not look successful to the hosted old frontend");
assert.strictEqual(partial.saved, true);
assert.strictEqual(partial.lineSent, false);
assert.strictEqual(partial.requisition.lineStatus, "pending_line");
assert.strictEqual(requisition.getLastRow(), 2, "first request appends one row");

const duplicate = sandbox.saveRequisition(payload, user, "request-1", Date.now());
assert.strictEqual(duplicate.duplicate, true);
assert.strictEqual(requisition.getLastRow(), 2, "duplicate request must not append another row");

const changedPayloadConflict = sandbox.saveRequisition(
  { ...payload, items: [{ name: "สินค้า", qty: 2, unit: "ลัง" }] },
  user,
  "request-1-changed",
  Date.now()
);
assert.strictEqual(changedPayloadConflict.success, false, "changed payload must not reuse the old success result");
assert.strictEqual(changedPayloadConflict.saved, false, "changed payload must remain unsaved");
assert.strictEqual(changedPayloadConflict.idempotencyConflict, true, "changed payload must report an explicit ID conflict");
assert.strictEqual(requisition.getLastRow(), 2, "changed payload must not append or alter the original bill");

sandbox.pushLineFlex = () => ({ success: true, quoteToken: "quote-1" });
const retried = sandbox.retryLineDelivery({ uid: partial.requisition.uid }, "retry-1", Date.now());
assert.strictEqual(retried.lineSent, true);
assert.strictEqual(retried.requisition.lineStatus, "pending");
assert.strictEqual(requisition.getLastRow(), 2, "LINE retry must reuse the saved bill");

assert.strictEqual(sandbox.lineRetryKey("request-1"), sandbox.lineRetryKey("request-1"), "provider retry key must be stable");
assert.match(sandbox.lineRetryKey("request-1"), /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);

// A card tap can arrive after LINE accepts the push but before save finalization.
// Finalization must preserve that advanced status rather than reverting to pending.
sandbox.pushLineFlex = (req) => {
  const found = sandbox.findRequisitionRow(requisition, req.uid);
  requisition.getRange(found.row, 7, 1, 1).setValue("picked");
  return { success: true, quoteToken: "quote-race" };
};
const raced = sandbox.saveRequisition({ ...payload, clientRequestId: "request-race" }, user, "request-race", Date.now());
assert.strictEqual(raced.requisition.lineStatus, "picked", "finalization must not overwrite a fast pick");

// Ship is only valid from picked/problem/done, never from LINE delivery intermediates.
sandbox.getLineDisplayName = () => "LINE User";
sandbox.replyQuoted = () => {};
sandbox.replyLine = () => {};
const raceRow = sandbox.findRequisitionRow(requisition, raced.requisition.uid);
requisition.getRange(raceRow.row, 7, 1, 1).setValue("pending_line");
const event = { replyToken: "reply", source: { groupId: "" }, postback: { data: "action=ship&uid=" + encodeURIComponent(raced.requisition.uid) + "&token=" + encodeURIComponent(raceRow.values[9]) } };
sandbox.handleLinePostback(event);
assert.strictEqual(requisition.value(raceRow.row, 7), "pending_line", "premature ship must be ignored");
requisition.getRange(raceRow.row, 7, 1, 1).setValue("picked");
sandbox.handleLinePostback(event);
assert.strictEqual(requisition.value(raceRow.row, 7), "sent", "picked bill may ship");
properties.set("LINE_GROUP_ID", "allowed-group");
requisition.getRange(raceRow.row, 7, 1, 1).setValue("picked");
sandbox.handleLinePostback({ ...event, source: {} });
assert.strictEqual(requisition.value(raceRow.row, 7), "picked", "missing group identity must not bypass a configured gate");
properties.delete("LINE_GROUP_ID");

// A failed final status lock leaves a leased line_sending state; after the lease,
// the same provider retry key safely reconciles the existing row.
sandbox.pushLineFlex = () => { lock.failNext = true; return { success: true, quoteToken: "quote-lease" }; };
const leased = sandbox.saveRequisition({ ...payload, clientRequestId: "request-lease" }, user, "request-lease", Date.now());
assert.strictEqual(leased.requisition.lineStatus, "line_sending");
const leasedRow = sandbox.findRequisitionRow(requisition, leased.requisition.uid);
requisition.getRange(leasedRow.row, 19, 1, 1).setValue(new Date(Date.now() - 5 * 60 * 1000));
sandbox.pushLineFlex = () => ({ success: true, deduplicated: true });
const reconciled = sandbox.retryLineDelivery({ uid: leased.requisition.uid }, "retry-lease", Date.now());
assert.strictEqual(reconciled.requisition.lineStatus, "pending");
assert.strictEqual(requisition.getLastRow(), 4, "lease recovery must not append a second bill");

// Every retry must take a fresh short lease, while the fixed 24-hour window
// remains anchored to the requisition creation timestamp.
sandbox.pushLineFlex = () => ({ success: false, retryable: true, message: "fixture LINE failure" });
const renewed = sandbox.saveRequisition({ ...payload, clientRequestId: "request-renewed" }, user, "request-renewed", Date.now());
const renewedRow = sandbox.findRequisitionRow(requisition, renewed.requisition.uid);
const staleLease = new Date(Date.now() - 5 * 60 * 1000);
requisition.getRange(renewedRow.row, 19, 1, 1).setValue(staleLease);
const renewedRetry = sandbox.retryLineDelivery({ uid: renewed.requisition.uid }, "retry-renewed", Date.now());
assert.strictEqual(renewedRetry.requisition.lineStatus, "pending_line");
assert(
  new Date(requisition.value(renewedRow.row, 19)).getTime() > staleLease.getTime(),
  "retry must renew the short line_sending lease"
);

// A stale finalizer cannot overwrite a newer retry lease. Attempt B owns the
// renewed marker and must be the only attempt allowed to persist its result.
const attemptA = new Date(Date.now() - 5 * 60 * 1000);
const attemptB = new Date();
requisition.getRange(renewedRow.row, 7, 1, 1).setValue("line_sending");
requisition.getRange(renewedRow.row, 19, 1, 1).setValue(attemptB);
sandbox.finalizeLineAttempt(requisition, renewed.requisition.uid, "pending_line", "", attemptA);
assert.strictEqual(requisition.value(renewedRow.row, 7), "line_sending", "stale finalizer must not replace the newer lease state");
assert.strictEqual(new Date(requisition.value(renewedRow.row, 19)).getTime(), attemptB.getTime(), "stale finalizer must not clear or replace the newer lease marker");
sandbox.finalizeLineAttempt(requisition, renewed.requisition.uid, "pending", "quote-owned", attemptB);
assert.strictEqual(requisition.value(renewedRow.row, 7), "pending", "current lease owner may finalize delivery");

// Provider retry keys are only safe within LINE's 24-hour retry window.
// Expired rows must stop before another network call and require manual reconciliation.
sandbox.pushLineFlex = () => ({ success: false, retryable: true, message: "fixture LINE failure" });
const expired = sandbox.saveRequisition({ ...payload, clientRequestId: "request-expired" }, user, "request-expired", Date.now());
const expiredRow = sandbox.findRequisitionRow(requisition, expired.requisition.uid);
requisition.getRange(expiredRow.row, 2, 1, 1).setValue(new Date(Date.now() - 25 * 60 * 60 * 1000));
requisition.getRange(expiredRow.row, 19, 1, 1).setValue(new Date());
sandbox.pushLineFlex = () => { throw new Error("expired retry must not call LINE"); };
const expiredRetry = sandbox.retryLineDelivery({ uid: expired.requisition.uid }, "retry-expired", Date.now());
assert.strictEqual(expiredRetry.success, false);
assert.strictEqual(expiredRetry.saved, true);
assert.strictEqual(expiredRetry.retryable, false);
assert.strictEqual(expiredRetry.requisition.lineStatus, "pending_line");
assert.match(expiredRetry.message, /24/);
assert.strictEqual(requisition.getLastRow(), 6, "expired retry must not append another bill");

// The hosted production frontend does not send clientRequestId. If its first
// request saves the row but LINE fails, resubmitting the restored form must
// resolve to that unresolved row instead of appending another bill.
const legacyPayload = {
  billType: "บิลจัด",
  assignee: "คลัง",
  items: [{ name: "สินค้า legacy", qty: 1, unit: "ลัง" }]
};
properties.set("LINE_GROUP_ID", "original-group");
let frozenInitialPayload = null;
let frozenInitialRetryKey = null;
sandbox.pushLineFlex = (req, token, lineUserId, retryKey, frozenPayload) => {
  frozenInitialPayload = JSON.stringify(frozenPayload);
  frozenInitialRetryKey = retryKey;
  return { success: false, retryable: true, message: "fixture LINE failure" };
};
const legacyPartial = sandbox.saveRequisition(legacyPayload, user, "legacy-1", Date.now());
const rowsAfterLegacyPartial = requisition.getLastRow();
const legacyDuplicate = sandbox.saveRequisition(legacyPayload, user, "legacy-2", Date.now());
assert.strictEqual(legacyDuplicate.duplicate, true, "legacy retry must resolve the unresolved saved bill");
assert.strictEqual(requisition.getLastRow(), rowsAfterLegacyPartial, "legacy retry must not append a second bill");

// LINE requires the same retry key and request body. Changing Staff or group
// configuration after the first attempt must not change the retried payload.
sandbox.getStaff = () => [{ name: "คลัง", lineUserId: CHANGED_LINE_USER_ID, active: true }];
properties.set("LINE_GROUP_ID", "changed-group");
let frozenRetryPayload = null;
let frozenRetryKey = null;
sandbox.pushLineFlex = (req, token, lineUserId, retryKey, frozenPayload) => {
  frozenRetryPayload = JSON.stringify(frozenPayload);
  frozenRetryKey = retryKey;
  return { success: true, quoteToken: "quote-legacy" };
};
const legacyRetried = sandbox.retryLineDelivery({ uid: legacyPartial.requisition.uid }, "legacy-retry", Date.now());
assert.strictEqual(legacyRetried.lineSent, true);
assert.ok(frozenInitialPayload, "initial LINE attempt must receive a frozen payload");
assert.strictEqual(JSON.parse(frozenInitialPayload).to, "original-group", "initial LINE recipient must be frozen");
assert.strictEqual(
  JSON.parse(frozenInitialPayload).messages[0].substitution.assignee.mentionee.userId,
  VALID_LINE_USER_ID,
  "initial Staff mention target must be frozen"
);
assert.strictEqual(frozenRetryPayload, frozenInitialPayload, "LINE retry must reuse the exact initial recipient and messages");
assert.strictEqual(frozenRetryKey, frozenInitialRetryKey, "LINE retry must reuse the same provider retry key");

// Once the first legacy bill is delivered, an intentionally identical new
// requisition remains valid and must not be suppressed by the compatibility fallback.
sandbox.pushLineFlex = () => ({ success: false, retryable: true, message: "fixture LINE failure" });
const rowsBeforeSecondLegacyBill = requisition.getLastRow();
const secondLegacyBill = sandbox.saveRequisition(legacyPayload, user, "legacy-new-bill", Date.now());
assert.strictEqual(secondLegacyBill.duplicate, undefined, "delivered legacy payload must not block a later intentional bill");
assert.strictEqual(requisition.getLastRow(), rowsBeforeSecondLegacyBill + 1, "intentional identical legacy bill must append after prior delivery");

// Rows created before payload freezing cannot be retried safely with the same
// provider key. They must stop for manual reconciliation without reading Staff
// or sending a reconstructed request.
const secondLegacyRow = sandbox.findRequisitionRow(requisition, secondLegacyBill.requisition.uid);
requisition.getRange(secondLegacyRow.row, 20, 1, 1).setValue("");
sandbox.getStaff = () => { throw new Error("retry must not read mutable Staff"); };
sandbox.pushLineFlex = () => { throw new Error("retry without frozen payload must not call LINE"); };
const unfrozenRetry = sandbox.retryLineDelivery({ uid: secondLegacyBill.requisition.uid }, "legacy-unfrozen", Date.now());
assert.strictEqual(unfrozenRetry.success, false);
assert.strictEqual(unfrozenRetry.retryable, false);
assert.strictEqual(unfrozenRetry.requisition.lineStatus, "line_failed");
properties.delete("LINE_GROUP_ID");
sandbox.getStaff = () => [{ name: "คลัง", lineUserId: VALID_LINE_USER_ID, active: true }];

// Historical idempotency lookup must not transfer the whole 20-column history
// while holding the global save lock. A row appended after the preflight
// snapshot is rechecked as a bounded lock delta so the race remains safe.
const largeRows = [[
  "uid", "timestamp", "billType", "requester", "assignee", "itemsJSON", "lineStatus", "doneBy", "doneAt",
  "token", "sentBy", "sentAt", "problemItems", "problemBy", "problemAt", "cardQuoteToken", "billNo", "clientRequestId", "lineAttemptAt", "linePayloadJSON"
]];
for (let i = 0; i < 1200; i += 1) {
  largeRows.push([
    "HIST-" + i, new Date(Date.now() - (i + 2) * 60 * 60 * 1000), "บิลจัด", "ผู้เบิก", "คลัง", "[]", "sent",
    "", "", "token-" + i, "", "", "", "", "", "", i + 1, "history-" + i, "", ""
  ]);
}
const largeRequisition = new Sheet(largeRows, 20);
const originalRequisitionSheet = sheets.Requisition;
sheets.Requisition = largeRequisition;
rangeReads.length = 0;
lock.waitCount = 0;
lock.onWait = () => {
  largeRequisition.rows.push([
    "RACE-DUPLICATE", new Date(), payload.billType, user.name, payload.assignee, JSON.stringify(payload.items), "pending_line",
    "", "", "race-token", "", "", "", "", "", "", 1201, "request-race-delta", new Date(), "{}"
  ]);
};
const raceDuplicate = sandbox.saveRequisition(
  { ...payload, clientRequestId: "request-race-delta" },
  user,
  "request-race-delta",
  Date.now()
);
assert.strictEqual(raceDuplicate.duplicate, true, "a duplicate appended after preflight must be caught under the lock");
assert.strictEqual(largeRequisition.getLastRow(), 1202, "the concurrent duplicate must not append a second row");
const lockedDedupReads = rangeReads.filter((read) => read.locked);
assert(
  lockedDedupReads.every((read) => read.rows <= 1),
  "save-lock duplicate recheck must inspect only rows appended after the preflight snapshot"
);
assert(
  rangeReads.filter((read) => !read.locked && read.rows > 1).every((read) => read.columns === 1),
  "historical exact request-id lookup must not transfer all 20 columns"
);

rangeReads.length = 0;
const missingLegacy = sandbox.findLegacyRequisitionDuplicate(largeRequisition, "missing-fingerprint");
assert.strictEqual(missingLegacy, null);
assert(
  rangeReads.filter((read) => read.column === 18).reduce((total, read) => total + read.rows, 0) <= 500,
  "legacy compatibility lookup must be bounded to the recent retry window"
);

const busyRows = [largeRows[0].slice()];
for (let i = 0; i < 600; i += 1) {
  busyRows.push([
    "BUSY-" + i, new Date(Date.now() - i * 1000), "บิลจัด", "ผู้เบิก", "คลัง", "[]", "sent",
    "", "", "busy-token-" + i, "", "", "", "", "", "", i + 1, "busy-" + i, "", ""
  ]);
}
const busyRequisition = new Sheet(busyRows, 20);
sheets.Requisition = busyRequisition;
lock.waitCount = 0;
sandbox.pushLineFlex = () => { throw new Error("uncertain legacy lookup must not append or call LINE"); };
const busyLegacyResult = sandbox.saveRequisition(legacyPayload, user, "legacy-busy", Date.now());
assert.strictEqual(busyLegacyResult.success, false);
assert.strictEqual(busyLegacyResult.retryable, true, "a bounded legacy lookup that cannot cover 24 hours must fail safely");
assert.strictEqual(busyRequisition.getLastRow(), 601, "uncertain legacy lookup must not risk appending a duplicate");
assert.strictEqual(lock.waitCount, 0, "uncertain historical legacy lookup must stop before the global lock");
sheets.Requisition = originalRequisitionSheet;

// Requisitions may contain more items than fit in one LINE card. The backend
// must persist every submitted item while presentation remains capped later.
const manyItemsRequisition = new Sheet([largeRows[0].slice()], 20);
sheets.Requisition = manyItemsRequisition;
sandbox.pushLineFlex = () => ({ success: false, retryable: true, message: "fixture LINE failure" });
const manyItems = Array.from({ length: 41 }, (_, index) => ({
  name: "สินค้า " + (index + 1),
  qty: index + 1,
  unit: "ชิ้น"
}));
const manyItemsResult = sandbox.saveRequisition(
  { ...payload, items: manyItems, clientRequestId: "request-41-items" },
  user,
  "request-41-items",
  Date.now()
);
assert.strictEqual(manyItemsResult.requisition.items.length, 41, "save response must retain item 41");
assert.strictEqual(
  JSON.parse(manyItemsRequisition.value(2, 6)).length,
  41,
  "stored requisition must retain item 41"
);
const manyItemsCard = JSON.stringify(sandbox.buildBillCard(manyItemsResult.requisition, "fixture-token"));
assert.match(manyItemsCard, /\+1 รายการ — ดูทั้งหมดในระบบ/, "LINE card must summarize items after row 40");
assert.doesNotMatch(manyItemsCard, /สินค้า 41/, "LINE card must keep its 40-item presentation cap");

// A backend-valid requisition can use the full 200-character Thai item name
// and 40-character Thai unit limits. The resulting Flex bubble must stay
// within LINE's 30 KB UTF-8 limit while reporting every card-only omission.
const maxThaiItemsRequisition = new Sheet([largeRows[0].slice()], 20);
sheets.Requisition = maxThaiItemsRequisition;
const maxThaiItems = Array.from({ length: 40 }, () => ({
  name: "ก".repeat(200),
  qty: 999999,
  unit: "ข".repeat(40)
}));
const maxThaiItemsResult = sandbox.saveRequisition(
  { ...payload, items: maxThaiItems, clientRequestId: "request-max-thai-items" },
  user,
  "request-max-thai-items",
  Date.now()
);
assert.strictEqual(
  JSON.parse(maxThaiItemsRequisition.value(2, 6)).length,
  40,
  "maximum-length Thai items must all remain stored"
);
const maxThaiCard = sandbox.buildBillCard(maxThaiItemsResult.requisition, "fixture-token");
const maxThaiBubbleBytes = Buffer.byteLength(JSON.stringify(maxThaiCard.contents), "utf8");
assert.strictEqual(
  sandbox.utf8JsonByteLength(maxThaiCard.contents),
  maxThaiBubbleBytes,
  "backend UTF-8 sizing must match the serialized bubble bytes"
);
assert.ok(maxThaiBubbleBytes <= 30000, `Flex bubble must be <= 30000 UTF-8 bytes, got ${maxThaiBubbleBytes}`);
const maxThaiCardContents = maxThaiCard.contents.body.contents[0].contents;
const maxThaiShownRows = maxThaiCardContents.filter((content) => content.type === "box").length;
assert.ok(maxThaiShownRows <= 40, "LINE card must retain the 40-item presentation cap");
assert.strictEqual(
  maxThaiCardContents.at(-1).text,
  "+" + (maxThaiItems.length - maxThaiShownRows) + " รายการ — ดูทั้งหมดในระบบ",
  "LINE card overflow summary must equal the card-only omitted row count"
);

// Staff and SSO identities are operational data, so a LINE display limit must
// not reject or rewrite them in Sheets. Even 11,000-character Thai identities
// accepted by the existing backend must produce a byte-safe bubble.
const longThaiIdentity = "ญ".repeat(11000);
const longRequesterRequisition = new Sheet([largeRows[0].slice()], 20);
sheets.Requisition = longRequesterRequisition;
sandbox.getStaff = () => [{ name: "คลัง", lineUserId: VALID_LINE_USER_ID, active: true }];
const longRequesterResult = sandbox.saveRequisition(
  { ...payload, clientRequestId: "request-long-requester" },
  { ...user, name: longThaiIdentity },
  "request-long-requester",
  Date.now()
);
assert.strictEqual(longRequesterRequisition.value(2, 4), longThaiIdentity, "full SSO requester identity must remain stored");
const longRequesterCard = sandbox.buildBillCard(longRequesterResult.requisition, "fixture-token");
const longRequesterBubbleBytes = Buffer.byteLength(JSON.stringify(longRequesterCard.contents), "utf8");
assert.ok(
  longRequesterBubbleBytes <= 30000,
  "an accepted 11,000-character Thai requester must still produce a <=30,000-byte bubble"
);
assert.match(
  longRequesterCard.contents.body.contents[2].contents[1].text,
  /… · /,
  "only the requester display text should be truncated with an explicit marker"
);

const longAssigneeRequisition = new Sheet([largeRows[0].slice()], 20);
sheets.Requisition = longAssigneeRequisition;
sandbox.getStaff = () => [{ name: longThaiIdentity, lineUserId: VALID_LINE_USER_ID, active: true }];
const longAssigneeResult = sandbox.saveRequisition(
  { ...payload, assignee: longThaiIdentity, clientRequestId: "request-long-assignee" },
  user,
  "request-long-assignee",
  Date.now()
);
assert.strictEqual(longAssigneeRequisition.value(2, 5), longThaiIdentity, "full Staff assignee identity must remain stored");
const longAssigneeCard = sandbox.buildBillCard(longAssigneeResult.requisition, "fixture-token");
const longAssigneeBubbleBytes = Buffer.byteLength(JSON.stringify(longAssigneeCard.contents), "utf8");
assert.ok(
  longAssigneeBubbleBytes <= 30000,
  "an accepted 11,000-character Thai assignee must still produce a <=30,000-byte bubble"
);
assert.match(
  longAssigneeCard.contents.body.contents[2].contents[0].text,
  /…$/,
  "only the assignee display text should be truncated with an explicit marker"
);
const longAssigneeMention = sandbox.buildMentionMessage(longAssigneeResult.requisition, VALID_LINE_USER_ID);
assert.strictEqual(longAssigneeMention.type, "textV2", "Staff with a LINE user ID must use the supported mention message type");
assert.ok(longAssigneeMention.text.length <= 5000, "LINE mention template must stay within the 5,000 UTF-16 code-unit limit");
const longAssigneePlain = sandbox.buildMentionMessage(longAssigneeResult.requisition, "");
assert.strictEqual(longAssigneePlain.type, "text", "missing LINE user ID must keep the plain-text fallback");
assert.ok(longAssigneePlain.text.length <= 5000, "plain Staff text must stay within the 5,000 UTF-16 code-unit limit");
assert.match(longAssigneePlain.text, /^@ญ+… เบิกสินค้า/, "plain Staff text must visibly mark display-only truncation");
assert.throws(
  () => sandbox.buildBillCard({ ...longAssigneeResult.requisition, items: [] }, longThaiIdentity),
  /Flex bubble exceeds 30,000 UTF-8 bytes/,
  "the builder must enforce a final byte invariant after all card rows are removed"
);

// Exercise the frozen retry contract through the final HTTP serializer rather
// than stopping at the pushLineFlex argument boundary.
const httpRequisition = new Sheet([largeRows[0].slice()], 20);
sheets.Requisition = httpRequisition;
sandbox.getStaff = () => [{ name: "คลัง", lineUserId: VALID_LINE_USER_ID, active: true }];
properties.set("LINE_CHANNEL_TOKEN", "fixture-channel-token");
properties.set("LINE_GROUP_ID", "http-original-group");
const httpBodies = [];
const httpRetryKeys = [];
sandbox.UrlFetchApp.fetch = (url, options) => {
  httpBodies.push(options.payload);
  httpRetryKeys.push(options.headers["X-Line-Retry-Key"]);
  const code = httpBodies.length === 1 ? 500 : 200;
  return {
    getResponseCode: () => code,
    getContentText: () => code === 200 ? JSON.stringify({ sentMessages: [{}, { quoteToken: "quote-http" }] }) : "{}"
  };
};
sandbox.pushLineFlex = realPushLineFlex;
const httpPartial = sandbox.saveRequisition(
  { ...payload, clientRequestId: "request-http-frozen" },
  user,
  "request-http-frozen",
  Date.now()
);
assert.strictEqual(httpPartial.lineSent, false, "the first HTTP fixture must leave a retryable saved bill");
properties.set("LINE_GROUP_ID", "http-changed-group");
const httpRetried = sandbox.retryLineDelivery({ uid: httpPartial.requisition.uid }, "retry-http-frozen", Date.now());
assert.strictEqual(httpRetried.lineSent, true, "the second HTTP fixture must deliver the frozen retry");
assert.strictEqual(httpRetried.requisition.cardQuoteToken, "quote-http", "Flex quote-token selection must remain compatible with a preceding textV2 message");
assert.strictEqual(httpBodies.length, 2, "initial and retry attempts must both reach UrlFetchApp.fetch");
assert.strictEqual(httpBodies[1], httpBodies[0], "initial and retry HTTP request bodies must be byte-equivalent");
assert.strictEqual(httpRetryKeys[1], httpRetryKeys[0], "initial and retry HTTP requests must use the same provider retry key");
assert.strictEqual(JSON.parse(httpBodies[1]).to, "http-original-group", "HTTP retry must preserve the frozen recipient");
assert.deepStrictEqual(
  JSON.parse(httpBodies[0]).messages[0],
  {
    type: "textV2",
    text: "{assignee} เบิกสินค้า (บิลจัด)",
    substitution: {
      assignee: {
        type: "mention",
        mentionee: { type: "user", userId: VALID_LINE_USER_ID }
      }
    }
  },
  "outgoing Staff mention must use LINE's supported textV2 substitution shape"
);
const noLineUserPayload = sandbox.buildLinePushPayload(httpPartial.requisition, "fixture-token", "", "plain-group");
assert.strictEqual(noLineUserPayload.messages.length, 1, "Staff without a LINE user ID must keep the plain Flex-only path");
assert.match(
  noLineUserPayload.messages[0].contents.body.contents[2].contents[0].text,
  /มอบให้ @คลัง$/,
  "the no-lineUserId path must retain the plain assignee label"
);

function captureNewPayloadForStaffId(lineUserId, requestSuffix) {
  const sheet = new Sheet([largeRows[0].slice()], 20);
  sheets.Requisition = sheet;
  sandbox.getStaff = () => [{ name: "คลัง", lineUserId, active: true }];
  properties.set("LINE_GROUP_ID", "id-shape-group");
  let httpBody = "";
  sandbox.UrlFetchApp.fetch = (url, options) => {
    httpBody = options.payload;
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ sentMessages: [{}, { quoteToken: "quote-id-shape" }] })
    };
  };
  const result = sandbox.saveRequisition(
    { ...payload, clientRequestId: "request-id-shape-" + requestSuffix },
    user,
    "request-id-shape-" + requestSuffix,
    Date.now()
  );
  assert.strictEqual(result.lineSent, true);
  return JSON.parse(httpBody);
}

[
  VALID_LINE_USER_ID
].forEach((lineUserId, index) => {
  const sent = captureNewPayloadForStaffId(lineUserId, "valid-" + index);
  assert.strictEqual(sent.messages.length, 2, "valid LINE user IDs must add one textV2 mention");
  assert.strictEqual(sent.messages[0].substitution.assignee.mentionee.userId, lineUserId);
});

[
  ["", "empty"],
  ["   ", "whitespace"],
  ["U" + "a".repeat(31), "short"],
  ["U" + "a".repeat(33), "long"],
  ["U" + "a".repeat(31) + "g", "nonhex"],
  ["UABCDEF0123456789ABCDEF0123456789", "uppercase-hex"],
  ["u" + "a".repeat(32), "lower-prefix"],
  ["X" + "a".repeat(32), "typo-prefix"]
].forEach(([lineUserId, requestSuffix]) => {
  const sent = captureNewPayloadForStaffId(lineUserId, requestSuffix);
  assert.strictEqual(sent.messages.length, 1, "invalid LINE user ID must use the Flex-only fallback: " + requestSuffix);
  assert.strictEqual(sent.messages[0].type, "flex");
  assert.match(sent.messages[0].contents.body.contents[2].contents[0].text, /มอบให้ @คลัง$/);
});
const uppercaseIdFallback = sandbox.buildMentionMessage(
  { assignee: "คลัง", billType: "บิลจัด" },
  "UABCDEF0123456789ABCDEF0123456789"
);
assert.strictEqual(uppercaseIdFallback.type, "text", "uppercase hex must not be emitted as a LINE mention target");

// Existing rows retry their already-frozen body verbatim, even if that body
// predates new Staff ID validation and contains the legacy mention shape.
const oldFrozenRequisition = new Sheet([largeRows[0].slice()], 20);
sheets.Requisition = oldFrozenRequisition;
const oldFrozenReq = {
  uid: "OLD-FROZEN-ID",
  timestamp: new Date().toISOString(),
  billType: "บิลจัด",
  requester: "ผู้เบิก",
  assignee: "คลัง",
  items: [{ name: "สินค้าเดิม", qty: 1, unit: "ลัง" }],
  billNo: 1,
  clientRequestId: "old-frozen-id"
};
const oldFrozenPayload = {
  to: "old-frozen-group",
  messages: [
    { type: "text", text: "@คลัง เบิกสินค้า (บิลจัด)", mention: { mentionees: [{ index: 0, length: 5, userId: "line-user" }] } },
    sandbox.buildBillCard(oldFrozenReq, "old-token")
  ]
};
const oldFrozenBody = JSON.stringify(oldFrozenPayload);
oldFrozenRequisition.rows.push([
  oldFrozenReq.uid, new Date(), oldFrozenReq.billType, oldFrozenReq.requester, oldFrozenReq.assignee,
  JSON.stringify(oldFrozenReq.items), "pending_line", "", "", "old-token", "", "", "", "", "", "", 1,
  oldFrozenReq.clientRequestId, "", oldFrozenBody
]);
let oldFrozenRetryBody = "";
sandbox.UrlFetchApp.fetch = (url, options) => {
  oldFrozenRetryBody = options.payload;
  return {
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ sentMessages: [{}, { quoteToken: "quote-old-frozen" }] })
  };
};
const oldFrozenRetried = sandbox.retryLineDelivery({ uid: oldFrozenReq.uid }, "retry-old-frozen-id", Date.now());
assert.strictEqual(oldFrozenRetried.lineSent, true);
assert.strictEqual(oldFrozenRetryBody, oldFrozenBody, "new Staff validation must not rewrite an already-frozen retry body");

// Truncating at the existing UTF-16 limits must not split a valid emoji into a
// lone surrogate in stored data, the frozen retry payload, or the HTTP body.
const surrogateRequisition = new Sheet([largeRows[0].slice()], 20);
sheets.Requisition = surrogateRequisition;
sandbox.getStaff = () => [{ name: "คลัง", lineUserId: VALID_LINE_USER_ID, active: true }];
properties.set("LINE_GROUP_ID", "surrogate-group");
const surrogateHttpBodies = [];
sandbox.UrlFetchApp.fetch = (url, options) => {
  surrogateHttpBodies.push(options.payload);
  return {
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ sentMessages: [{}, { quoteToken: "quote-surrogate" }] })
  };
};
const boundaryName = "n".repeat(199) + "😀";
const boundaryUnit = "u".repeat(39) + "😀";
const malformedName = "\uD83D" + "A" + "\uDE00" + "😀😀" + "\uD83D";
const malformedUnit = "\uDE00" + "B" + "\uD83D" + "C" + "😀😀" + "\uDE00";
const exactName = "e".repeat(198) + "😀";
const exactUnit = "f".repeat(38) + "😀";
assert.strictEqual(sandbox.truncateUtf16Safe("A", 0), "", "zero-unit bound must return empty text");
assert.strictEqual(sandbox.truncateUtf16Safe("A", 1), "A", "one-unit bound must retain one BMP character");
assert.strictEqual(sandbox.truncateUtf16Safe("😀", 1), "", "one-unit bound must not split an emoji");
assert.strictEqual(sandbox.truncateUtf16Safe(exactName, 200), exactName, "exact 200-unit valid pair must remain intact");
assert.strictEqual(sandbox.truncateUtf16Safe(exactUnit, 40), exactUnit, "exact 40-unit valid pair must remain intact");
assert.strictEqual(
  sandbox.truncateLineDisplayText("A".repeat(199) + "\uD83D" + "B", 200),
  "A".repeat(199) + "B",
  "a removed lone surrogate must not displace a fitting valid display character"
);
assert.strictEqual(
  sandbox.truncateLineDisplayText("\uD83D".repeat(201), 200),
  "",
  "all-invalid display content must not produce a false ellipsis"
);
assert.strictEqual(
  sandbox.truncateLineDisplayText("\uD83D" + "A", 1),
  "A",
  "a valid one-unit character after an invalid unit must fill a one-unit display cap"
);
assert.strictEqual(
  sandbox.truncateLineDisplayText("A".repeat(201), 200),
  "A".repeat(199) + "…",
  "genuinely over-cap valid content must retain an ellipsis within the cap"
);
assert.strictEqual(
  sandbox.truncateLineDisplayText("A".repeat(198) + "😀", 200),
  "A".repeat(198) + "😀",
  "a valid pair that exactly fits the display cap must remain intact without ellipsis"
);
assert.strictEqual(
  sandbox.truncateLineDisplayText("A".repeat(199) + "😀", 200),
  "A".repeat(199) + "…",
  "a valid pair that crosses the display cap must be replaced by a truthful ellipsis"
);
const cappedInspection = { count: 0 };
const cappedStartedAt = Date.now();
assert.strictEqual(
  sandbox.truncateUtf16Safe("x".repeat(5000000), 200, cappedInspection),
  "x".repeat(200),
  "ordinary oversized input must return only the requested prefix"
);
assert.strictEqual(cappedInspection.count, 200, "ordinary oversized input must stop after filling the output cap");
assert.ok(Date.now() - cappedStartedAt < 1000, "5M ASCII truncation must finish within a generous one-second budget");
const displayInspection = { count: 0 };
const displayStartedAt = Date.now();
assert.strictEqual(
  sandbox.truncateLineDisplayText("y".repeat(5000000), 200, displayInspection),
  "y".repeat(199) + "…",
  "ordinary oversized display input must remain bounded and visibly truncated"
);
assert.strictEqual(displayInspection.count, 201, "display overflow detection must use only one bounded lookahead inspection");
assert.ok(Date.now() - displayStartedAt < 1000, "5M ASCII display truncation must finish within a generous one-second budget");
const invalidPrefixInspection = { count: 0 };
assert.strictEqual(
  sandbox.truncateUtf16Safe("\uD83D".repeat(1000) + "A".repeat(200), 200, invalidPrefixInspection),
  "A".repeat(200),
  "invalid code units before the cap must be removed before counting retained output"
);
assert.strictEqual(
  invalidPrefixInspection.count,
  1200,
  "a pathological invalid prefix must be inspected until enough valid output is found"
);
assert.deepStrictEqual(
  Array.from(sandbox.normalizeItems([{ name: "\uD83D\uD83D", qty: 1, unit: "\uDE00\uDE00" }])),
  [],
  "an item whose bounded fields contain only unpaired surrogates must be rejected"
);
const surrogateResult = sandbox.saveRequisition(
  {
    ...payload,
    items: [
      { name: boundaryName, qty: 1, unit: boundaryUnit },
      { name: malformedName, qty: 2, unit: malformedUnit },
      { name: exactName, qty: 3, unit: exactUnit },
      { name: "😀😀", qty: 4, unit: "😀😀" }
    ],
    clientRequestId: "request-surrogate-boundary"
  },
  user,
  "request-surrogate-boundary",
  Date.now()
);
assert.strictEqual(surrogateResult.lineSent, true);
const storedSurrogateItems = JSON.parse(surrogateRequisition.value(2, 6));
assert.strictEqual(storedSurrogateItems[0].name, "n".repeat(199), "name must keep the complete prefix before a split emoji");
assert.strictEqual(storedSurrogateItems[0].unit, "u".repeat(39), "unit must keep the complete prefix before a split emoji");
assert.strictEqual(storedSurrogateItems[1].name, "A😀😀", "name must remove lone surrogates and preserve adjacent valid pairs");
assert.strictEqual(storedSurrogateItems[1].unit, "BC😀😀", "unit must remove leading, middle, and trailing lone surrogates");
assert.strictEqual(storedSurrogateItems[2].name, exactName, "exact-boundary name must preserve its valid pair");
assert.strictEqual(storedSurrogateItems[2].unit, exactUnit, "exact-boundary unit must preserve its valid pair");
assert.strictEqual(storedSurrogateItems[3].name, "😀😀", "adjacent valid emoji must remain unchanged");
assert.strictEqual(storedSurrogateItems[3].unit, "😀😀", "adjacent valid emoji units must remain unchanged");
const frozenSurrogatePayload = JSON.parse(surrogateRequisition.value(2, 20));
const providerSurrogatePayload = JSON.parse(surrogateHttpBodies[0]);
assertNoLoneSurrogates(storedSurrogateItems, "stored normalized items must not contain lone surrogates");
assertNoLoneSurrogates(frozenSurrogatePayload, "frozen LINE payload must not contain lone surrogates");
assertNoLoneSurrogates(providerSurrogatePayload, "provider HTTP payload must not contain lone surrogates");

// Requester and assignee remain full-fidelity Sheet data, while every new LINE
// display surface removes embedded lone surrogates and retains valid pairs.
const malformedRequesterIdentity = "\uD83D" + "REQ" + "\uDE00" + "😀😀" + "ญ".repeat(11000) + "\uD83D";
const malformedAssigneeIdentity = "\uDE00" + "ASSIGN" + "\uD83D" + "😀😀" + "ญ".repeat(11000) + "\uDE00";
const identityRequisition = new Sheet([largeRows[0].slice()], 20);
sheets.Requisition = identityRequisition;
sandbox.getStaff = () => [{ name: malformedAssigneeIdentity, lineUserId: "", active: true }];
properties.set("LINE_GROUP_ID", "identity-group");
let identityHttpBody = "";
sandbox.UrlFetchApp.fetch = (url, options) => {
  identityHttpBody = options.payload;
  return {
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ sentMessages: [{ quoteToken: "quote-identity" }] })
  };
};
const identityResult = sandbox.saveRequisition(
  { ...payload, assignee: malformedAssigneeIdentity, clientRequestId: "request-malformed-identities" },
  { ...user, name: malformedRequesterIdentity },
  "request-malformed-identities",
  Date.now()
);
assert.strictEqual(identityRequisition.value(2, 4), malformedRequesterIdentity, "full malformed requester identity must remain stored verbatim");
assert.strictEqual(identityRequisition.value(2, 5), malformedAssigneeIdentity, "full malformed assignee identity must remain stored verbatim");
const identityFrozenPayload = JSON.parse(identityRequisition.value(2, 20));
const identityProviderPayload = JSON.parse(identityHttpBody);
assertNoLoneSurrogates(identityFrozenPayload, "new frozen identity payload must not contain lone surrogates");
assertNoLoneSurrogates(identityProviderPayload, "new provider identity payload must not contain lone surrogates");
const identityCardMeta = identityProviderPayload.messages[0].contents.body.contents[2].contents;
assert.match(identityCardMeta[0].text, /@ASSIGN😀😀ญ+…$/, "assignee Flex display must preserve valid pairs and mark truncation");
assert.match(identityCardMeta[1].text, /^ผู้เบิก REQ😀😀ญ+… · /, "requester Flex display must preserve valid pairs and mark truncation");
const malformedPlainMention = sandbox.buildMentionMessage(identityResult.requisition, "UABCDEF0123456789ABCDEF0123456789");
assert.strictEqual(malformedPlainMention.type, "text", "invalid uppercase ID must select the plain mention fallback");
assertNoLoneSurrogates(malformedPlainMention, "plain mention fallback must not contain lone surrogates");
assert.match(malformedPlainMention.text, /^@ASSIGN😀😀ญ+… เบิกสินค้า/, "plain fallback must preserve pairs and mark display truncation");
sandbox.UrlFetchApp.fetch = () => { throw new Error("unexpected network call"); };
sheets.Requisition = originalRequisitionSheet;

const legacyRequisition = new Sheet([[
  "uid", "timestamp", "billType", "requester", "assignee", "itemsJSON", "lineStatus", "doneBy", "doneAt",
  "token", "sentBy", "sentAt", "problemItems", "problemBy", "problemAt", "cardQuoteToken", "billNo"
]], 17);
const migrationSheets = {
  ProductName: new Sheet([["id", "name", "defaultUnit", "active"]], 4),
  Staff: new Sheet([["name", "lineUserId", "active"]], 3),
  Requisition: legacyRequisition
};
assert.doesNotThrow(
  () => sandbox.setupDatabase({ getSheetByName: (name) => migrationSheets[name], insertSheet: () => { throw new Error("unexpected insert"); } }),
  "17-column Requisition migration must expand grid capacity before writing 20 headers"
);
assert.strictEqual(legacyRequisition.getMaxColumns(), 20, "migration must ensure the full 20-column grid");

console.log(
  "Picking backend behavior: PASS (max Thai items " + maxThaiBubbleBytes + " bytes/" + maxThaiShownRows +
  " rows; long requester " + longRequesterBubbleBytes + " bytes; long assignee " + longAssigneeBubbleBytes + " bytes)"
);
