const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../js/supabase-picking-client.js');
const grants = ['viewRequisitions', 'createRequisition', 'retryLine'];
const user = { id: 'fixture', identityId: '10000000-0000-4000-8000-000000000001', apps: ['app-pick'], roles: ['WAREHOUSE'], perms: { 'app-pick': grants }, permissionCatalog: { 'app-pick': grants } };
const draft = { billType: 'บิลจัด', assigneeId: '10000000-0000-4000-8000-000000000001', assignee: 'Fixture', items: [{ name: 'A', qty: 2, unit: 'ชิ้น', isFreeText: true }] };
function fixture() {
  const values = new Map(), calls = []; let current = structuredClone(user), token = 'fixture-token', mode = 'ok', sequence = 0;
  const storage = { getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  const client = api.create({ storage, getUser: () => current, getToken: () => token, requestId: () => 'fixture-request-' + (++sequence),
    fetch: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      if (mode === 'timeout') throw Error('timeout');
      if (mode === 'switch') current = { ...user, id: 'second', identityId: '10000000-0000-4000-8000-000000000002' };
      if (mode === 'denied') return Response.json({ success: false, reason: 'permission_denied' }, { status: 403 });
      if (mode === 'invalid') return Response.json({ success: false, reason: 'invalid_picking_items' }, { status: 400 });
      return Response.json({ success: true, saved: mode !== 'unconfirmed', requisition: { uid: 'fixture-bill' } });
    } });
  return { client, values, calls, storage, setUser: v => current = v, setToken: v => token = v, mode: v => mode = v };
}
test('Preserve legacy roles but explicit catalog revocation, malformed catalog and absent app always deny', () => {
  assert.equal(api.can(user, 'createRequisition'), true);
  assert.equal(api.can({ ...user, permissionCatalog: undefined }, 'retryLine'), true);
  for (const value of [{ ...user, perms: { 'app-pick': [] } }, { ...user, permissionCatalog: null }, { ...user, apps: [] }, { ...user, roles: ['CUSTOM'], perms: {}, permissionCatalog: undefined }]) {
    assert.equal(api.can(value, 'createRequisition'), false);
  }
});
test('Unknown save retains exact request across reload and edits cannot allocate another ID', async () => {
  const f = fixture(); f.mode('timeout');
  const pending = f.client.prepare(draft);
  await assert.rejects(f.client.call('saveRequisition', pending), /ยังยืนยัน/);
  assert.deepEqual(f.client.pending(), pending);
  assert.deepEqual(f.client.prepare(structuredClone(draft)), pending);
  assert.throws(() => f.client.prepare({ ...draft, items: [{ ...draft.items[0], qty: 9 }] }), e => e.reason === 'pending_submission_mismatch');
  f.mode('ok'); const result = await f.client.call('saveRequisition', f.client.pending());
  assert.equal(result.saved, true); assert.equal(f.client.pending(), null);
  assert.deepEqual(f.calls[0].body.data, f.calls[1].body.data);
  assert.ok(![...f.values.values()].join('').includes('fixture-token'));
});
test('Storage quota, corruption and old unknown GAS submissions fail closed without network or expiry', () => {
  const f = fixture();
  f.storage.setItem = () => { throw Error('quota'); };
  assert.throws(() => f.client.prepare(draft), e => e.reason === 'pending_storage_unavailable');
  f.values.set(f.client.storageKey('pending'), '{');
  assert.throws(() => f.client.pending(), e => e.reason === 'pending_storage_corrupt');
  f.values.clear(); f.values.set('pick_pending_submit_v1:fixture', JSON.stringify({ ts: 1, snapshot: { clientRequestId: 'old-request' } }));
  assert.throws(() => f.client.prepare(draft), e => e.reason === 'legacy_pending_reconciliation_required');
  assert.equal(f.calls.length, 0); assert.equal(f.values.size, 1);
});
test('Per-user storage and confirmed cleanup never erase a different active request', () => {
  const f = fixture(); const a = f.client.prepare(draft);
  f.setUser({ ...user, id: 'second', identityId: '10000000-0000-4000-8000-000000000002' }); assert.equal(f.client.pending(), null);
  const b = f.client.prepare(draft); assert.notEqual(a.clientRequestId, b.clientRequestId);
  f.client.clear(a.clientRequestId); assert.deepEqual(f.client.pending(), b);
  f.setUser(user); assert.deepEqual(f.client.pending(), a);
});
test('Denied action and stale token have zero network; only explicit supported actions allowed', async () => {
  const f = fixture(); f.setUser({ ...user, perms: { 'app-pick': ['viewRequisitions'] } });
  await assert.rejects(f.client.call('retryLine', { uid: 'bill' }), e => e.reason === 'permission_denied');
  await assert.rejects(f.client.call('constructor'), e => e.reason === 'invalid_action');
  f.setToken(''); await assert.rejects(f.client.call('bootstrap'), e => e.reason === 'no_token');
  assert.equal(f.calls.length, 0);
});
test('No false save acknowledgement, cross-user response or fallback after server denial', async () => {
  for (const mode of ['unconfirmed', 'switch', 'denied']) {
    const f = fixture(); const pending = f.client.prepare(draft); f.mode(mode);
    await assert.rejects(f.client.call('saveRequisition', pending));
    assert.equal(f.calls.length, 1); assert.match(f.calls[0].url, /\/functions\/v1\/picking-api$/);
    assert.equal(f.calls[0].options.cache, 'no-store'); assert.ok(f.calls[0].options.signal);
    f.setUser(user); assert.deepEqual(f.client.pending(), pending);
  }
});
test('A write requires the durably stored unchanged draft; no direct call bypass', async () => {
  const f = fixture();
  await assert.rejects(f.client.call('saveRequisition', { ...draft, clientRequestId: 'unsafe-request' }), e => e.reason === 'pending_submission_mismatch');
  assert.equal(f.calls.length, 0);
});
test('Confirmed save is still success when cleanup fails; replay keeps original identity', async () => {
  const f = fixture(); const pending = f.client.prepare(draft);
  f.storage.removeItem = () => { throw Error('storage-disabled'); };
  assert.equal((await f.client.call('saveRequisition', pending)).saved, true);
  assert.deepEqual(f.client.pending(), pending);
});
test('An old tab cannot allocate a new bill when another tab confirmed and cleared its pending request', async () => {
  const f = fixture(); const pending = f.client.prepare(draft);
  await f.client.call('saveRequisition', pending);
  assert.throws(() => f.client.prepare(pending), e => e.reason === 'pending_submission_mismatch');
  assert.equal(f.calls.length, 1);
});
test('Confirmed validation rollback allows correction; uncertain outcomes never do', async () => {
  const f = fixture(); const pending = f.client.prepare(draft); f.mode('invalid');
  await assert.rejects(f.client.call('saveRequisition', pending), e => e.reason === 'invalid_picking_items' && e.notSaved === true);
  assert.equal(f.client.pending(), null);
  assert.notEqual(f.client.prepare(draft).clientRequestId, pending.clientRequestId);
});
