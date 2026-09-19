const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp('^    (?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, name + ' exists');
  const after = html.slice(start + 1).search(/^    (?:async )?function |^    document.addEventListener/m);
  return html.slice(start, after < 0 ? undefined : start + 1 + after);
}
function fixture(names, extra = {}) {
  const nodes = new Map(), events = [], controls = [{ disabled: false }, { disabled: false }];
  const state = { session: { id: 'fixture', token: 'fixture-token' }, staff: [{ id: 'staff-id', name: 'Staff' }], items: [{ name: 'A', qty: 2, unit: 'ชิ้น' }], requisitions: [], billType: 'บิลจัด', localStatusByUid: {}, isSubmitting: false };
  const snapshot = { billType: 'บิลจัด', assigneeId: 'staff-id', assignee: 'Staff', items: state.items, clientRequestId: 'fixture-request' };
  const c = { state, console, window: { AkraModule: { embedded: true, getToken: () => 'fixture-token', runMutation: async fn => fn(), markDirty: () => events.push('dirty'), markSaved: () => events.push('saved') } },
    document: { querySelectorAll: () => controls },
    $: id => { if (!nodes.has(id)) nodes.set(id, { value: id === 'staff-select' ? 'staff-id' : '', textContent: '', disabled: false, classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => controls }); return nodes.get(id); },
    pickingClient: { can: () => true, prepare: () => snapshot, pending: () => snapshot, call: async () => ({ success: true }), clear() {} },
    isMockMode: () => false, AppVersionGuard: { blockIfStale: async () => false }, collectSubmitItems: () => state.items, validateSubmit: () => true,
    cloneSubmitItems: v => v, createClientRequestId: () => 'fixture-request', persistPendingSubmit() {}, clearPendingSubmit() {},
    createOptimisticRequisition: () => ({ uid: 'pending' }), replaceRequisition() {}, resetForm: () => { events.push('reset'); state.items = []; },
    restoreSubmitSnapshot: () => events.push('restored'), updateActionControls: () => events.push('controls'),
    needsLineRecovery: r => !r.lineSent, shouldWatchRequisition: () => false, toast: m => events.push(m), perfStart() {}, perfEnd() {},
    setCache() {}, CACHE_KEYS: {}, scheduleNextPoll() {}, REV_POLL_MIN_MS: 12000, markOptimisticFailed() {},
    showError: m => events.push('error:' + m), ...extra };
  vm.createContext(c); for (const name of names) vm.runInContext(source(name), c);
  return { c, nodes, events, controls, snapshot };
}
test('Submission keeps form until confirmation, freezes controls, clears dirty only after saved', async () => {
  let resolve; const response = new Promise(r => resolve = r);
  const { c, events, controls } = fixture(['submitRequisition', 'setFormBusy'], { apiCall: () => response });
  const operation = c.submitRequisition({ preventDefault() {} });
  assert.equal(c.state.isSubmitting, true); assert.equal(c.state.items.length, 1); assert.ok(!events.includes('reset')); assert.ok(controls.every(x => x.disabled));
  resolve({ success: true, saved: true, requisition: { uid: 'bill' }, lineSent: false }); await operation;
  assert.equal(c.state.isSubmitting, false); assert.ok(events.includes('reset')); assert.ok(events.includes('saved'));
});
test('Unknown save and idempotency conflict preserve request; never allocate replacement or clear form', async () => {
  for (const reason of ['picking_service_unavailable', 'idempotency_conflict']) {
    const { c, events } = fixture(['submitRequisition', 'setFormBusy'], { apiCall: async () => { throw Object.assign(Error('fixture failure'), { reason, result: { idempotencyConflict: true } }); },
      createClientRequestId: () => { throw Error('must not allocate replacement'); } });
    await c.submitRequisition({ preventDefault() {} });
    assert.equal(c.state.retryClientRequestId, 'fixture-request'); assert.ok(!events.includes('reset')); assert.ok(!events.includes('saved'));
  }
});
test('Storage failure blocks before network and leaves current form intact', async () => {
  let calls = 0;
  const { c, events } = fixture(['submitRequisition', 'setFormBusy'], { pickingClient: { can: () => true, prepare: () => { throw Error('quota'); } }, apiCall: async () => calls++ });
  await c.submitRequisition({ preventDefault() {} });
  assert.equal(calls, 0); assert.equal(c.state.items.length, 1); assert.ok(!events.includes('saved'));
});
test('Transport denial does not fall back; revision reads use authenticated transport', async () => {
  let calls = 0;
  const { c } = fixture(['transportApiCall', 'fetchDataRev'], { pickingClient: { call: async () => { calls++; throw Object.assign(Error('denied'), { reason: 'permission_denied' }); } },
    apiCall: async action => { assert.equal(action, 'getRev'); return { rev: 'fixture-revision' }; }, fetch: () => { throw Error('legacy network forbidden'); } });
  await assert.rejects(c.transportApiCall('bootstrap'), /denied/); assert.equal(calls, 1); assert.equal(await c.fetchDataRev(), 'fixture-revision');
});
test('History cannot acknowledge another actor request; explicit restore recovers pending form', () => {
  const { c, events, snapshot } = fixture(['reconcilePendingSubmit'], { readPendingSubmit: () => ({ clientRequestId: 'fixture-request' }), clearPendingSubmit: () => { throw Error('no history acknowledgement'); } });
  c.state.requisitions = [{ clientRequestId: snapshot.clientRequestId, uid: 'different-actor-bill' }];
  c.reconcilePendingSubmit(); assert.ok(events.includes('restored')); assert.equal(c.state.retryClientRequestId, snapshot.clientRequestId);
});
test('Retry control respects explicit denial and does not infer deadline from bill creation', () => {
  const { c } = fixture(['canRetryLine']);
  const req = { lineStatus: 'pending_line', timestamp: '2020-01-01', retryable: true };
  assert.equal(c.canRetryLine(req), true);
  c.pickingClient.can = () => false; assert.equal(c.canRetryLine(req), false);
});
test('Caches are verified-user scoped; deferred writes cannot cross a user switch', () => {
  const values = new Map([['history', JSON.stringify({ts:Date.now(),data:'unscoped-private-data'})]]), tasks=[];
  const {c} = fixture(['readCache','setCache','setCacheDeferred'], { localStorage: {getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},
    window:{setTimeout:fn=>tasks.push(fn)}, mockCache:{} });
  const first='10000000-0000-4000-8000-000000000001',second='10000000-0000-4000-8000-000000000002';
  c.state.session.identityId=first;
  c.pickingClient.storageKey = key => 'pick_v3:'+c.state.session.identityId+':'+key;
  assert.equal(c.readCache('history',10000),null);
  c.setCache('history',['first-user']); assert.deepEqual(Array.from(c.readCache('history',10000)),['first-user']);
  c.setCacheDeferred('staff',['first-user-staff']); c.state.session={id:'fixture',identityId:second}; tasks.forEach(fn=>fn());
  assert.equal(c.readCache('history',10000),null); assert.equal(values.has('pick_v3:'+second+':staff'),false);
  c.pickingClient.can=()=>false; c.setCache('history',['denied']); assert.equal(values.has('pick_v3:'+second+':history'),false);
});
test('Standalone and embedded boot verify current session before any cached data; denial shows no app', async () => {
  for (const embedded of [true,false]) {
    for (const denied of [true,false]) {
      const order=[];
      const {c}=fixture(['boot'],{ CURRENT_VERSION:'fixture', AppVersionGuard:{start(){}},checkAppVersion(){},bindEvents(){},setBillType(){},renderItemRows(){},renderPreview(){},showLoading(){},
        URLSearchParams,resolveBootSession:()=>({token:'fixture-token',fromUrl:false}),localStorage:{removeItem:()=>order.push('remove-old-session')},
        hydrateCachedData:()=>{order.push('cache');return false;},loadBootstrap:async()=>order.push('bootstrap'),setFormBusy(){},startRevPolling(){},
        persistPendingSsoToken:()=>order.push('standalone-session'),clearPendingSsoToken:()=>order.push('clear-session'),
        window:{location:{search:''},AkraModule:{embedded,getToken:()=> 'fixture-token',verifySession:async(app,token)=>{order.push('verify');assert.equal(app,'app-pick');assert.equal(token,'fixture-token');if(denied)throw Error('revoked');return{id:'verified-user'};}}}});
      await c.boot(); assert.equal(order[0],'verify');
      assert.equal(order.includes('cache'),!denied); assert.equal(order.includes('bootstrap'),!denied);
      if(!denied) assert.equal(order.includes('standalone-session'),!embedded);
    }
  }
});
test('Recovered request keeps its original unit and free-text identity after catalog changes', () => {
  const {c}=fixture(['collectSubmitItems'],{document:{querySelectorAll:()=>[],querySelector:()=>null},blankItemRow:()=>false,exactProductByName:()=>({name:'A',defaultUnit:'new-unit'})});
  c.state.retryClientRequestId='fixture-request'; c.state.items=[{name:'A',qty:2,unit:'old-unit',isFreeText:false}];
  const items=c.collectSubmitItems();
  assert.equal(items[0].unit,'old-unit'); assert.equal(items[0].isFreeText,false);
});
