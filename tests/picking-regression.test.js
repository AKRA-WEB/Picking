const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const backend = fs.readFileSync(path.join(root, "Code.gs.txt"), "utf8");
const frontend = fs.readFileSync(path.join(root, "index.html"), "utf8");
const problem = fs.readFileSync(path.join(root, "problem.html"), "utf8");
const version = JSON.parse(fs.readFileSync(path.join(root, "version.json"), "utf8")).version;

function functionSource(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.notStrictEqual(start, -1, "missing function " + name);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error("unterminated function " + name);
}

function currentVersion(html) {
  const match = html.match(/const CURRENT_VERSION = "([^"]+)"/);
  assert(match, "CURRENT_VERSION missing");
  return match[1];
}

assert.match(backend, /"clientRequestId"/, "durable request-id column is required");
assert.match(backend, /"linePayloadJSON"/, "LINE retry must persist the exact initial push payload");
assert.match(backend, /action === "bootstrap"/, "single-auth bootstrap action is required");
assert.match(backend, /action === "retryLine"/, "recoverable LINE retry action is required");

const bootstrap = functionSource(backend, "getBootstrapData");
assert.match(bootstrap, /includeProducts/, "bootstrap must honor catalog cache state");
assert.match(bootstrap, /user:/, "bootstrap must return the verified user");

const save = functionSource(backend, "saveRequisition");
assert.match(save, /clientRequestId/, "save must use the durable request ID");
assert.match(save, /findLegacyRequisitionDuplicate/, "legacy clients without request IDs need a server-side duplicate fallback");
assert.match(save, /saved:\s*true/, "save response must report durable success explicitly");
assert.match(save, /lineSent:/, "save response must distinguish LINE delivery");
assert.doesNotMatch(
  functionSource(backend, "retryLineDelivery"),
  /getStaff\(/,
  "LINE retry must never rebuild its recipient from mutable Staff data"
);
assert.match(backend, /X-Line-Retry-Key/, "LINE pushes must use a stable provider retry key");
const pushLineMessages = functionSource(backend, "pushLineMessages");
assert.match(pushLineMessages, /code === 409/, "provider duplicate acceptance must reconcile as delivered");
assert(
  pushLineMessages.indexOf("sentMessages =") < pushLineMessages.indexOf("code === 409"),
  "provider duplicate response must preserve sentMessages for quote-token recovery"
);
assert.match(backend, /LINE_RETRY_WINDOW_MS\s*=\s*24\s*\*/, "automatic LINE retries must stop after 24 hours");
assert.match(functionSource(backend, "requireAuth"), /typeof data\.valid !== "boolean"/, "malformed auth responses must be transient verification failures");

const reportProblem = functionSource(backend, "reportProblem");
assert(
  reportProblem.lastIndexOf("releaseLock") < reportProblem.indexOf("pushQuoted"),
  "problem LINE notification must occur after releasing the mutation lock"
);

const postback = functionSource(backend, "handleLinePostback");
assert(
  postback.indexOf("getLineDisplayName") < postback.indexOf("waitLock"),
  "LINE profile lookup must occur before acquiring the mutation lock"
);
assert(
  postback.lastIndexOf("releaseLock") < postback.lastIndexOf("replyQuoted"),
  "LINE reply must occur after releasing the mutation lock"
);

const recent = functionSource(backend, "getRecentRequisitions");
assert.doesNotMatch(recent, /Math\.max\(max,\s*ROW_SCAN_CHUNK\)/, "200-row read must not fetch 500 rows");

assert.match(frontend, /function isMockMode\(/, "mock mode must be explicit");
assert.match(frontend, /searchParams\.get\("mock"\) === "1"/, "mock mode must require ?mock=1");
const boot = functionSource(frontend, "boot");
assert.doesNotMatch(boot, /verifySsoToken\(/, "normal boot must not verify Main separately");
assert.match(
  boot,
  /if \(!bootSession\.fresh\)\s*\{\s*showApp\(\);\s*hadCache = hydrateCachedData\(\);/,
  "a fresh SSO token must be verified before prior cached operational data is shown"
);
assert.match(frontend, /PENDING_SSO/, "fresh SSO replacement must survive transient reloads without falling back to the prior session");
assert.match(boot, /allowCachedData:\s*!bootSession\.fresh/, "fresh and pending SSO tokens must force authenticated uncached payloads");
assert.match(frontend, /PENDING_SUBMIT/, "in-flight submit identity must have durable browser storage");
const submitRequisition = functionSource(frontend, "submitRequisition");
assert.match(submitRequisition, /persistPendingSubmit\(snapshot\)[\s\S]*apiCall\("saveRequisition"/, "submit identity must persist before the network call");
assert.match(submitRequisition, /serverReq && e\.result\.saved/, "the new frontend must reconcile the old-client-safe partial failure response");
assert.match(functionSource(frontend, "loadBootstrap"), /reconcilePendingSubmit\(\)/, "authenticated bootstrap must reconcile a reload/crash submit identity");
assert.match(frontend, /function shouldPollUpdates\(/, "adaptive polling eligibility is required");
assert.match(frontend, /function needsLineRecovery\(/, "persisted LINE intermediates must not be shown as success");
assert.match(frontend, /function shouldWatchRequisition\(/, "poll watcher must follow persisted requisition state");
assert.match(
  functionSource(frontend, "pollForUpdates"),
  /state\.activeTab === "history"\) renderHistory\(\)/,
  "visible History must reevaluate time-based recovery UI on every poll"
);
const retryLine = functionSource(frontend, "retryLine");
assert(
  retryLine.indexOf("state.pendingWatchUid = shouldWatchRequisition(result.requisition)") < retryLine.indexOf("if (!needsLineRecovery(result))"),
  "retry recovery responses must establish their watcher before presentation branching"
);
assert.match(frontend, /HISTORY_PAGE_SIZE/, "history rendering must be bounded");
assert.doesNotMatch(frontend, /function hasPickAccess\(/, "obsolete client-side access helper must be removed after GAS bootstrap migration");
assert.doesNotMatch(frontend, /function loadInitialData\(/, "obsolete getInitialData wrapper must be removed after GAS bootstrap migration");
assert.match(
  functionSource(frontend, "mockApi"),
  /r\.clientRequestId !== data\.clientRequestId/,
  "mock save must exclude its existing optimistic row when calculating the first bill number"
);
assert.doesNotMatch(frontend, /cdn\.tailwindcss\.com|fonts\.googleapis\.com|unpkg\.com/, "production startup assets must be local");
assert.match(functionSource(frontend, "readCache"), /isMockMode\(\) \? mockCache/, "mock must not read production cache");
assert.match(functionSource(frontend, "setCache"), /if \(isMockMode\(\)\) mockCache/, "mock must not write production cache");
assert.match(functionSource(frontend, "loadBootstrap"), /if \(!isMockMode\(\)\) localStorage\.setItem/, "mock must not overwrite the production session");
assert.match(problem, /function isMockMode\(/, "problem form mock mode must be explicit");
assert.match(problem, /if\(data\.warning\)/, "problem form must surface partial LINE failure");
assert.match(problem, /params\.get\("lineFail"\)===\"1\"/, "problem mock must cover LINE partial failure");
assert.doesNotMatch(problem, /fonts\.googleapis\.com/, "problem form font must not block on a third party");
assert.strictEqual(currentVersion(frontend), version, "index/version.json must match");

const fixtures = {
  products: Array.from({ length: 4761 }, (_, i) => ({
    id: "P" + String(i + 1).padStart(5, "0"),
    name: "สินค้า " + (i + 1),
    defaultUnit: "ลัง",
    active: true
  })),
  requisitions: Array.from({ length: 200 }, (_, i) => ({
    uid: "FIX-" + i,
    timestamp: new Date(2026, 6, 15, 8, i % 60).toISOString(),
    billType: "บิลจัด",
    assignee: "คลัง",
    items: [{ name: "สินค้า " + (i + 1), qty: 1, unit: "ลัง" }],
    lineStatus: i === 0 ? "pending_line" : "pending"
  }))
};
assert.strictEqual(fixtures.products.length, 4761);
assert.strictEqual(fixtures.requisitions.length, 200);

const frontendSandbox = {
  state: {
    activeTab: "new",
    historyDirty: false,
    requisitions: [{ uid: "PENDING-request-1", clientRequestId: "request-1", clientStatus: "failed" }]
  },
  renderHistory() {}
};
vm.createContext(frontendSandbox);
vm.runInContext(functionSource(frontend, "replaceRequisition"), frontendSandbox);
frontendSandbox.replaceRequisition("PENDING-request-1", { uid: "PENDING-request-1", clientRequestId: "request-1", clientStatus: "sending" });
frontendSandbox.replaceRequisition("PENDING-request-1", { uid: "PICK-1", clientRequestId: "request-1", lineStatus: "pending" });
assert.strictEqual(frontendSandbox.state.requisitions.length, 1, "same-ID retry must not leave a ghost optimistic row");
assert.strictEqual(frontendSandbox.state.requisitions[0].uid, "PICK-1");

const pendingStorage = new Map();
const pendingSandbox = {
  state: { session: { id: "user-1", name: "ผู้ใช้ 1" } },
  CACHE_KEYS: { PENDING_SUBMIT: "pick_pending_submit_v1" },
  PENDING_SUBMIT_TTL_MS: 24 * 60 * 60 * 1000,
  Date,
  JSON,
  encodeURIComponent,
  isMockMode: () => false,
  localStorage: {
    getItem: (key) => pendingStorage.get(key) || null,
    setItem: (key, value) => pendingStorage.set(key, value),
    removeItem: (key) => pendingStorage.delete(key)
  }
};
vm.createContext(pendingSandbox);
vm.runInContext(functionSource(frontend, "pendingSubmitStorageKey"), pendingSandbox);
vm.runInContext(functionSource(frontend, "persistPendingSubmit"), pendingSandbox);
vm.runInContext(functionSource(frontend, "readPendingSubmit"), pendingSandbox);
vm.runInContext(functionSource(frontend, "clearPendingSubmit"), pendingSandbox);
const pendingSnapshot = { clientRequestId: "reload-request-1", billType: "บิลจัด", assignee: "คลัง", items: [] };
pendingSandbox.persistPendingSubmit(pendingSnapshot);
assert.strictEqual(pendingSandbox.readPendingSubmit().clientRequestId, "reload-request-1", "reload must recover the same request ID");
pendingSandbox.state.session = { id: "user-2", name: "ผู้ใช้ 2" };
assert.strictEqual(pendingSandbox.readPendingSubmit(), null, "one user's pending request must not be exposed to another user");
pendingSandbox.state.session = { id: "user-1", name: "ผู้ใช้ 1" };
pendingSandbox.clearPendingSubmit("reload-request-1");
assert.strictEqual(pendingSandbox.readPendingSubmit(), null, "confirmed request must clear durable pending state");
pendingSandbox.localStorage.setItem = () => { throw new Error("storage unavailable"); };
assert.doesNotThrow(() => pendingSandbox.persistPendingSubmit(pendingSnapshot), "storage failure must not block the requisition submit");
pendingSandbox.localStorage.removeItem = () => { throw new Error("storage unavailable"); };
assert.doesNotThrow(() => pendingSandbox.clearPendingSubmit("reload-request-1"), "storage cleanup failure must not turn a saved requisition into a client failure");

const boundaryLocalStorage = new Map([["akra_pick_session", JSON.stringify({ token: "old-token", id: "old-user" })]]);
const boundarySessionStorage = new Map();
const boundarySandbox = {
  APP_CONFIG: { STORAGE_KEY: "akra_pick_session" },
  PENDING_SSO_KEY: "akra_pick_pending_sso",
  JSON,
  Error,
  isMockMode: () => false,
  localStorage: {
    getItem: (key) => boundaryLocalStorage.get(key) || null,
    setItem: (key, value) => boundaryLocalStorage.set(key, value),
    removeItem: (key) => boundaryLocalStorage.delete(key)
  },
  sessionStorage: {
    getItem: (key) => boundarySessionStorage.get(key) || null,
    setItem: (key, value) => boundarySessionStorage.set(key, value),
    removeItem: (key) => boundarySessionStorage.delete(key)
  }
};
vm.createContext(boundarySandbox);
vm.runInContext(functionSource(frontend, "readPendingSsoToken"), boundarySandbox);
vm.runInContext(functionSource(frontend, "persistPendingSsoToken"), boundarySandbox);
vm.runInContext(functionSource(frontend, "clearPendingSsoToken"), boundarySandbox);
vm.runInContext(functionSource(frontend, "resolveBootSession"), boundarySandbox);
const freshBoundary = boundarySandbox.resolveBootSession(new URLSearchParams("sso=fresh%2Btoken"));
assert.strictEqual(freshBoundary.token, "fresh+token");
assert.strictEqual(freshBoundary.fresh, true);
assert.strictEqual(boundaryLocalStorage.has("akra_pick_session"), false, "fresh SSO must supersede the prior saved session immediately");
const reloadBoundary = boundarySandbox.resolveBootSession(new URLSearchParams());
assert.strictEqual(reloadBoundary.token, "fresh+token", "transient reload must retry the fresh token, not the old session");
assert.strictEqual(reloadBoundary.fresh, true);
boundarySandbox.clearPendingSsoToken();

const reconcileSnapshot = { clientRequestId: "reconcile-1", billType: "บิลจัด", assignee: "คลัง", items: [] };
let restoredSnapshot = null;
let clearedRequest = null;
let resetCount = 0;
const reconcileSandbox = {
  state: { requisitions: [], retryClientRequestId: "" },
  readPendingSubmit: () => reconcileSnapshot,
  clearPendingSubmit: (id) => { clearedRequest = id; },
  restoreSubmitSnapshot: (snapshot) => { restoredSnapshot = snapshot; },
  resetForm: () => { resetCount += 1; },
  toast: () => {}
};
vm.createContext(reconcileSandbox);
vm.runInContext(functionSource(frontend, "reconcilePendingSubmit"), reconcileSandbox);
reconcileSandbox.reconcilePendingSubmit();
assert.strictEqual(reconcileSandbox.state.retryClientRequestId, "reconcile-1", "unconfirmed reload must reuse the original request ID");
assert.strictEqual(restoredSnapshot.clientRequestId, "reconcile-1", "unconfirmed reload must restore the original submit snapshot");
reconcileSandbox.state.requisitions = [{ uid: "PICK-1", clientRequestId: "reconcile-1" }];
reconcileSandbox.reconcilePendingSubmit();
assert.strictEqual(clearedRequest, "reconcile-1", "confirmed refresh must clear the durable pending request");
assert.strictEqual(resetCount, 1, "an unchanged restored duplicate must be removed after server reconciliation");

vm.runInContext(functionSource(frontend, "needsLineRecovery"), frontendSandbox);
assert.strictEqual(
  frontendSandbox.needsLineRecovery({ lineSent: true, requisition: { lineStatus: "line_sending" } }),
  true,
  "final-lock uncertainty must remain a visible recovery state"
);
assert.strictEqual(
  frontendSandbox.needsLineRecovery({ lineSent: true, requisition: { lineStatus: "pending" } }),
  false,
  "confirmed persisted delivery may be shown as success"
);

vm.runInContext("const LINE_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;", frontendSandbox);
vm.runInContext(functionSource(frontend, "isLineRetryExpiredClient"), frontendSandbox);
vm.runInContext(functionSource(frontend, "shouldWatchRequisition"), frontendSandbox);
assert.strictEqual(frontendSandbox.shouldWatchRequisition({ lineStatus: "line_failed" }), false, "terminal LINE failure must stop fast polling");
assert.strictEqual(frontendSandbox.shouldWatchRequisition({ lineStatus: "picked" }), false, "advanced bills must stop fast polling");
assert.strictEqual(frontendSandbox.shouldWatchRequisition({ lineStatus: "pending" }), true, "active operational bills remain watched");
assert.strictEqual(
  frontendSandbox.shouldWatchRequisition({ lineStatus: "pending_line", timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), lineAttemptAt: new Date().toISOString() }),
  false,
  "expired cached LINE failures must stop polling and require manual reconciliation"
);

async function verifySubmitIdempotencyConflictRecovery() {
  const formElements = {
    "staff-select": { value: "คลัง" },
    "submit-btn": { disabled: false },
    "form-status": { textContent: "" }
  };
  const persistedSnapshots = [];
  const restoredSnapshots = [];
  const clearedRequests = [];
  const apiPayloads = [];
  const messages = [];
  const conflictSandbox = {
    state: {
      billType: "บิลจัด",
      isSubmitting: false,
      retryClientRequestId: "request-original",
      requisitions: [],
      localStatusByUid: {},
      activeTab: "new"
    },
    $: (id) => formElements[id],
    collectSubmitItems: () => [{ name: "สินค้า", qty: 2, unit: "ลัง", isFreeText: false }],
    validateSubmit: () => true,
    cloneSubmitItems: (items) => items.map((item) => ({ ...item })),
    createClientRequestId: () => "request-replacement",
    persistPendingSubmit: (snapshot) => persistedSnapshots.push({ ...snapshot }),
    createOptimisticRequisition: (snapshot) => ({
      uid: "PENDING-" + snapshot.clientRequestId,
      clientRequestId: snapshot.clientRequestId,
      items: snapshot.items
    }),
    replaceRequisition: (uid, req) => {
      conflictSandbox.state.requisitions = conflictSandbox.state.requisitions.filter((row) => row.uid !== uid);
      conflictSandbox.state.requisitions.unshift(req);
    },
    resetForm: () => {},
    perfStart: () => "mark",
    perfEnd: () => {},
    apiCall: (action, data) => {
      apiPayloads.push({ ...data, items: data.items.map((item) => ({ ...item })) });
      if (apiPayloads.length === 1) {
        const error = new Error("คำขอนี้ถูกบันทึกด้วยข้อมูลอื่นแล้ว");
        error.result = { success: false, saved: false, retryable: false, idempotencyConflict: true };
        return Promise.reject(error);
      }
      return Promise.resolve({
        success: true,
        saved: true,
        lineSent: true,
        requisition: {
          uid: "PICK-replacement",
          clientRequestId: data.clientRequestId,
          lineStatus: "pending",
          items: data.items
        },
        rev: "rev-replacement"
      });
    },
    restoreSubmitSnapshot: (snapshot) => restoredSnapshots.push({ ...snapshot }),
    markOptimisticFailed: () => {},
    clearPendingSubmit: (id) => clearedRequests.push(id),
    CACHE_KEYS: { REQUISITIONS: "requisitions" },
    setCache: () => {},
    shouldWatchRequisition: () => true,
    needsLineRecovery: () => false,
    scheduleNextPoll: () => {},
    REV_POLL_MIN_MS: 12000,
    toast: (message, type) => messages.push({ message, type }),
    renderHistory: () => {}
  };
  vm.createContext(conflictSandbox);
  vm.runInContext("async " + functionSource(frontend, "submitRequisition"), conflictSandbox);
  await conflictSandbox.submitRequisition({ preventDefault() {} });
  assert.strictEqual(conflictSandbox.state.requisitions.length, 0, "conflict must remove the unsaved optimistic ghost");
  assert.strictEqual(conflictSandbox.state.retryClientRequestId, "request-replacement", "conflict must rotate to a fresh request ID");
  assert.strictEqual(persistedSnapshots.at(-1).clientRequestId, "request-replacement", "fresh conflict identity must survive reload");
  assert.strictEqual(restoredSnapshots.at(-1).items[0].qty, 2, "changed form values must remain available for review");
  assert.strictEqual(messages.at(-1).type, "warning", "an ID conflict must be presented as a data warning");
  assert.match(formElements["form-status"].textContent, /ยังไม่ได้บันทึก/, "form status must not claim the edited payload was saved");

  await conflictSandbox.submitRequisition({ preventDefault() {} });
  assert.strictEqual(apiPayloads[1].clientRequestId, "request-replacement", "follow-up submit must use the rotated request ID");
  assert.strictEqual(apiPayloads[1].items[0].qty, 2, "follow-up submit must retain the restored edits");
  assert.strictEqual(conflictSandbox.state.retryClientRequestId, "", "successful follow-up must release the retry identity");
  assert.strictEqual(clearedRequests.at(-1), "request-replacement", "successful follow-up must clear durable pending state");
  assert.strictEqual(conflictSandbox.state.requisitions.length, 1, "successful follow-up must leave only the persisted bill");
  assert.strictEqual(conflictSandbox.state.requisitions[0].uid, "PICK-replacement");
}

async function verifyRejectedTerminalRetryReconciliation() {
  const original = {
    uid: "PICK-TERMINAL",
    timestamp: new Date().toISOString(),
    lineStatus: "pending_line"
  };
  const persisted = Object.assign({}, original, { lineStatus: "line_failed" });
  const messages = [];
  const retrySandbox = {
    state: { requisitions: [original], lastRev: "rev-before", pendingWatchUid: original.uid },
    CACHE_KEYS: { REQUISITIONS: "requisitions" },
    REV_POLL_MIN_MS: 30000,
    canRetryLine: () => true,
    createClientRequestId: () => "retry-terminal",
    apiCall: () => {
      const error = new Error("ต้องตรวจสอบเอง");
      error.result = {
        success: false,
        saved: true,
        lineSent: false,
        retryable: false,
        requisition: persisted,
        rev: "rev-terminal"
      };
      return Promise.reject(error);
    },
    shouldWatchRequisition: () => false,
    setCache: () => {},
    scheduleNextPoll: () => {},
    toast: (message, type) => messages.push({ message, type }),
    renderHistory: () => {}
  };
  vm.createContext(retrySandbox);
  vm.runInContext(functionSource(frontend, "replaceRequisition"), retrySandbox);
  vm.runInContext("async " + functionSource(frontend, "retryLine"), retrySandbox);
  await retrySandbox.retryLine(original.uid);
  assert.strictEqual(retrySandbox.state.requisitions[0].lineStatus, "line_failed", "a rejected saved retry must keep the backend terminal status");
  assert.strictEqual(retrySandbox.state.lastRev, "rev-terminal", "a rejected saved retry must reconcile the backend revision");
  assert.strictEqual(retrySandbox.state.pendingWatchUid, "", "terminal retry state must stop the fast watcher");
  assert.strictEqual(messages.at(-1).type, "warning", "persisted terminal retry failure is a warning, not a rolled-back transport error");
}

verifySubmitIdempotencyConflictRecovery()
  .then(verifyRejectedTerminalRetryReconciliation)
  .then(() => console.log("Picking regression contract: PASS"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
