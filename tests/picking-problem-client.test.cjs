const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../js/picking-problem-client.js');
const token = 'fixture-capability-secret-not-a-real-token';
const bill = { uid: 'fixture-bill', version: 1, lineStatus: 'pending', items: [{ name: 'Same', qty: 2, unit: 'ชิ้น' }, { name: 'Same', qty: 5, unit: 'กล่อง' }], problemItems: [] };
const items = [{ index: 0, actualQty: '1.5', note: 'first' }, { index: 1, actualQty: '5', note: '' }];
async function fixture(shared) {
  const values = shared || new Map(), calls = []; let mode = 'ok', current = structuredClone(bill), sequence = 0;
  const storage = { getItem: k => values.get(k) || null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
  const options = { uid: bill.uid, token, storage, requestId: () => 'fixture-request-' + (++sequence), fetch: async (url, init) => {
    const body = JSON.parse(init.body); calls.push({url,init,body});
    if (body.action === 'getBill') return Response.json(mode === 'denied' ? {success:false,reason:'invalid_bill_capability'} : {success:true,bill:current}, {status:mode === 'denied' ? 403 : 200});
    if (mode === 'timeout') throw Error('lost reply');
    if (mode === 'revoked') return Response.json({success:false,reason:'invalid_bill_capability'}, {status:403});
    if (mode === 'conflict') return Response.json({success:false,reason:'picking_version_conflict'}, {status:409});
    if (mode === 'event-conflict') return Response.json({success:false,reason:'picking_event_conflict'}, {status:409});
    return Response.json({success:true,saved:mode !== 'unconfirmed',lineSent:mode !== 'line-pending',requisition:{...current,version:current.version+1,lineStatus:'problem'}});
  } };
  const client = await api.create(options);
  return { client, values, calls, storage, options, mode: v => mode = v, current: v => current = v };
}
test('Capability is verified before any draft access and travels only in POST body, never URL/cache', async () => {
  const f = await fixture(); assert.throws(() => f.client.pending(), e => e.reason === 'bill_not_verified');
  assert.equal((await f.client.load()).uid,bill.uid); assert.equal(f.calls[0].body.token,token);
  assert.equal(new URL(f.calls[0].url).search,''); assert.equal(f.calls[0].init.method,'POST'); assert.equal(f.calls[0].init.referrerPolicy,'no-referrer');
  assert.equal(f.calls[0].init.cache,'no-store');
  f.mode('timeout'); await assert.rejects(f.client.report(items));
  assert.ok(![...f.values.keys(),...f.values.values()].join('').includes(token));
});
test('Unknown result survives new client/current version; retry preserves original ID/version/indexed items', async () => {
  const f = await fixture(); await f.client.load(); f.mode('timeout'); await assert.rejects(f.client.report(items));
  const original = f.client.pending(); assert.equal(original.version,1);
  f.current({...bill,version:2,lineStatus:'problem'}); f.mode('ok');
  const reopened = await api.create(f.options); await reopened.load(); await reopened.report(items);
  const requests=f.calls.filter(c=>c.body.action==='reportProblem'); assert.deepEqual(requests[0].body,requests[1].body);
  assert.equal(requests[1].body.items[0].index,0); assert.equal(requests[1].body.items[1].index,1); assert.equal(reopened.pending(),null);
});
test('Editing unknown request, another tab clearing it, and uncertain confirmation cannot create a replacement', async () => {
  const f=await fixture(); await f.client.load(); f.mode('timeout'); await assert.rejects(f.client.report(items));
  await assert.rejects(f.client.report([{...items[0],actualQty:0},items[1]]),e=>e.reason==='pending_submission_mismatch');
  f.values.clear(); await assert.rejects(f.client.report(items),e=>e.reason==='pending_submission_mismatch');
  assert.equal(f.calls.filter(c=>c.body.action==='reportProblem').length,1);
  const g=await fixture(); await g.client.load(); g.mode('unconfirmed'); await assert.rejects(g.client.report(items)); assert.ok(g.client.pending());
});
test('Drafts are separate per bill capability and denied/cross-bill loads expose none', async () => {
  const f=await fixture(); await f.client.load(); f.mode('timeout'); await assert.rejects(f.client.report(items));
  const other=await api.create({...f.options,token:token+'-different'}); await other.load(); assert.equal(other.pending(),null);
  f.mode('denied'); const denied=await api.create(f.options); await assert.rejects(denied.load(),e=>e.reason==='invalid_bill_capability');
  assert.throws(()=>denied.pending(),e=>e.reason==='bill_not_verified');
  f.mode('ok'); f.current({...bill,uid:'different-bill'}); const wrong=await api.create(f.options); await assert.rejects(wrong.load(),e=>e.reason==='invalid_bill_response');
});
test('Storage failure/corruption prevents writes and pending records never expire', async () => {
  const f=await fixture(); await f.client.load(); f.storage.setItem=()=>{throw Error('quota');};
  await assert.rejects(f.client.report(items),e=>e.reason==='pending_storage_unavailable'); assert.equal(f.calls.length,1);
  f.values.set(f.client.storageKey,'{'); assert.throws(()=>f.client.pending(),e=>e.reason==='pending_storage_corrupt');
});
test('Invalid quantities, missing/duplicate positions and oversized notes are never coerced to zero or sent', async () => {
  const f=await fixture(); await f.client.load();
  for (const invalid of [[{...items[0],actualQty:''},items[1]],[{...items[0],actualQty:-1},items[1]],[{...items[0],actualQty:'NaN'},items[1]],[{...items[0],actualQty:'1.23456'},items[1]],
    [{...items[0],actualQty:'100000000000'},items[1]],[{...items[0],note:'x'.repeat(501)},items[1]],[items[1],items[1]],[items[0]]]) {
    await assert.rejects(f.client.report(invalid),e=>e.reason==='invalid_picking_problem');
  }
  assert.equal(f.calls.length,1); assert.equal(f.values.size,0);
});
test('Version conflict requires explicit latest-data review, never silently rebases or discards uncertain requests', async () => {
  const f=await fixture(); await f.client.load(); f.mode('conflict'); await assert.rejects(f.client.report(items),e=>e.reason==='picking_version_conflict');
  assert.ok(f.client.pending()); f.mode('ok'); f.current({...bill,version:3});
  assert.equal((await f.client.reviewLatest()).version,3); assert.equal(f.client.pending(),null);
  await f.client.report(items); assert.equal(f.calls.at(-1).body.version,3);
  const g=await fixture(); await g.client.load(); g.mode('timeout'); await assert.rejects(g.client.report(items));
  await assert.rejects(g.client.reviewLatest(),e=>e.reason==='pending_outcome_unknown'); assert.ok(g.client.pending());
});
test('Sent bill disallows a new report but an unknown original report can still recover its receipt', async () => {
  const f=await fixture(); f.current({...bill,lineStatus:'sent'}); await f.client.load();
  await assert.rejects(f.client.report(items),e=>e.reason==='invalid_picking_transition'); assert.equal(f.calls.length,1);
  const g=await fixture(); await g.client.load(); g.mode('timeout'); await assert.rejects(g.client.report(items));
  g.current({...bill,version:4,lineStatus:'sent'}); g.mode('ok'); const reopened=await api.create(g.options); await reopened.load();
  assert.equal((await reopened.report(items)).saved,true);
});
test('Saved-but-LINE-pending is not a failure or a new report, even if storage cleanup fails', async () => {
  const f=await fixture(); await f.client.load(); f.mode('line-pending'); f.storage.removeItem=()=>{throw Error('quota');};
  const response=await f.client.report(items); assert.equal(response.saved,true); assert.equal(response.lineSent,false); assert.ok(f.client.pending());
});
test('A reopened draft cannot become a fresh report when another tab clears it before submission', async () => {
  const f=await fixture(); await f.client.load(); f.mode('timeout'); await assert.rejects(f.client.report(items));
  const reopened=await api.create(f.options); await reopened.load(); assert.ok(reopened.pending());
  f.values.clear(); f.mode('ok');
  await assert.rejects(reopened.report(items),e=>e.reason==='pending_submission_mismatch');
});
test('Capability revoked during a report invalidates local access but retains the unconfirmed durable request', async () => {
  const f=await fixture(); await f.client.load(); f.mode('revoked');
  await assert.rejects(f.client.report(items),e=>e.reason==='invalid_bill_capability');
  assert.throws(()=>f.client.pending(),e=>e.reason==='bill_not_verified'); assert.equal(f.values.size,1);
});
