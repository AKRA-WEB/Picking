/* Current Main identity + service-only Picking API. No GAS or anonymous data fallback. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AkraSupabasePicking = factory();
}(typeof window === 'undefined' ? {} : window, function () {
  'use strict';
  const endpoint = 'https://hgxrrskztbpejirrdpbq.supabase.co/functions/v1/picking-api';
  const actions = { bootstrap: 'viewRequisitions', getInitialData: 'viewRequisitions', getRequisitions: 'viewRequisitions', getRev: 'viewRequisitions', saveRequisition: 'createRequisition', retryLine: 'retryLine' };
  function can(user, key) {
    if (!user?.id || !Array.isArray(user.apps) || !user.apps.includes('app-pick') || user.mustChangePassword === true) return false;
    const legacy = (Array.isArray(user.roles) && user.roles.some(role => ['ADMIN', 'SUPERVISOR', 'AKRA', 'WAREHOUSE'].includes(role))) ||
      (Array.isArray(user.perms?.['app-pick']) && user.perms['app-pick'].length > 0);
    const catalog = user.permissionCatalog;
    if (catalog === undefined) return legacy;
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return false;
    const defined = catalog['app-pick'];
    if (defined === undefined) return legacy;
    if (!Array.isArray(defined)) return false;
    return !defined.includes(key) ? legacy : Array.isArray(user.perms?.['app-pick']) && user.perms['app-pick'].includes(key);
  }
  function message(reason) {
    if (reason === 'permission_denied') return 'ไม่มีสิทธิ์ดำเนินการนี้ กรุณาตรวจสิทธิ์ใน Main';
    if (['no_token', 'identity_required', 'shell_session_unavailable', 'invalid_or_expired_token', 'session_changed'].includes(reason)) return 'เซสชันเปลี่ยนหรือหมดอายุ กรุณาเข้าใหม่จาก Main';
    if (reason === 'pending_submission_mismatch') return 'มีคำขอที่ยังไม่ทราบผล กรุณากู้คืนคำขอค้างแล้วส่งข้อมูลเดิม ห้ามสร้างบิลใหม่แทน';
    if (reason === 'legacy_pending_reconciliation_required') return 'มีคำขอค้างจากระบบเดิม กรุณาให้ผู้ดูแลตรวจบิลเดิมก่อน ห้ามส่งใหม่เพื่อเลี่ยงบิลซ้ำ';
    if (reason.startsWith('pending_storage_')) return 'เก็บข้อมูลป้องกันบิลซ้ำไม่ได้ จึงยังไม่ได้ส่ง กรุณาตรวจพื้นที่จัดเก็บของเบราว์เซอร์';
    if (reason === 'idempotency_conflict') return 'รหัสคำขอตรงกับข้อมูลที่ต่างจากเดิม กรุณาตรวจบิลเดิมกับผู้ดูแลก่อนส่งใหม่';
    if (reason.startsWith('invalid_picking_')) return 'ข้อมูลไม่ถูกต้อง กรุณาตรวจผู้รับ จำนวนสินค้า และข้อความในแต่ละรายการ';
    return 'ยังยืนยันผลไม่ได้ กรุณาส่งซ้ำด้วยคำขอเดิมเมื่อเชื่อมต่อได้';
  }
  function error(reason, result, status) { return Object.assign(new Error(message(reason)), { reason, result, status }); }
  function business(snapshot) {
    return { billType: snapshot.billType, assigneeId: snapshot.assigneeId, items: (snapshot.items || []).map(item => ({ name: item.name, qty: Number(item.qty), unit: item.unit, isFreeText: item.isFreeText === true })) };
  }
  function create(options) {
    const storage = options.storage;
    const fetcher = options.fetch || fetch;
    const requestId = options.requestId || (() => crypto.randomUUID());
    function userId() { const id = String(options.getUser()?.id || ''); if (!id) throw error('no_token'); return id; }
    function ownerId() {
      const id = options.getUser()?.identityId;
      if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw error('identity_required');
      return id;
    }
    function storageKey(key) { return 'pick_v3:' + ownerId() + ':' + key; }
    function read(key) { try { return storage.getItem(key); } catch (_) { throw error('pending_storage_unavailable'); } }
    function pending() {
      const key = storageKey('pending');
      // Legacy outcomes must be reconciled/imported, never expired or blindly replayed on a new backend.
      if (read('pick_pending_submit_v1:' + encodeURIComponent(userId())) || read('pick_v2:' + encodeURIComponent(userId()) + ':pending')) throw error('legacy_pending_reconciliation_required');
      const raw = read(key);
      if (!raw) return null;
      try {
        const value = JSON.parse(raw);
        if (value.version !== 2 || !/^[A-Za-z0-9_-]{8,100}$/.test(value.snapshot?.clientRequestId || '') || !value.snapshot?.assigneeId || !Array.isArray(value.snapshot.items)) throw Error('corrupt');
        return value.snapshot;
      } catch (_) { throw error('pending_storage_corrupt'); }
    }
    function prepare(snapshot) {
      if (!can(options.getUser(), 'createRequisition')) throw error('permission_denied');
      const old = pending();
      if (snapshot.clientRequestId && snapshot.clientRequestId !== old?.clientRequestId) throw error('pending_submission_mismatch');
      if (old) {
        if (JSON.stringify(business(old)) !== JSON.stringify(business(snapshot))) throw error('pending_submission_mismatch');
        return old;
      }
      const copy = JSON.parse(JSON.stringify({ ...business(snapshot), assignee: snapshot.assignee || '', clientRequestId: requestId() }));
      const key = storageKey('pending'), raw = JSON.stringify({ version: 2, snapshot: copy });
      try { storage.setItem(key, raw); if (storage.getItem(key) !== raw) throw Error('not-persisted'); }
      catch (_) { throw error('pending_storage_unavailable'); }
      return copy;
    }
    function clear(id, key = storageKey('pending')) {
      try {
        const current = JSON.parse(storage.getItem(key) || 'null');
        if (current?.snapshot?.clientRequestId === id) storage.removeItem(key);
      } catch (_) { /* A confirmed save stays confirmed; a retained request replays safely. */ }
    }
    async function call(action, data = {}) {
      const owner = ownerId();
      if (!Object.hasOwn(actions, action)) throw error('invalid_action');
      if (!can(options.getUser(), actions[action])) throw error('permission_denied');
      let token;
      try { token = options.getToken(); } catch (e) { throw error(e.message); }
      if (!token) throw error('no_token');
      let key = '';
      if (action === 'saveRequisition') {
        const saved = pending(); key = storageKey('pending');
        if (!saved || saved.clientRequestId !== data.clientRequestId || JSON.stringify(business(saved)) !== JSON.stringify(business(data))) throw error('pending_submission_mismatch');
        data = { ...business(saved), clientRequestId: saved.clientRequestId };
      }
      try {
        const response = await fetcher(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ action, data }), cache: 'no-store', signal: AbortSignal.timeout(65000) });
        const result = await response.json();
        if (owner !== options.getUser()?.identityId || !options.getToken()) throw error('session_changed');
        if (!response.ok || result?.success !== true) {
          const reason = String(result?.reason || 'picking_service_unavailable');
          // These creation validations run before the atomic insert. Do not clear
          // a request for a dispatch error or any uncertain/409/5xx outcome.
          const notSaved = action === 'saveRequisition' && response.status === 400 &&
            ['invalid_picking_actor','invalid_picking_request_id','invalid_picking_payload','invalid_picking_items','invalid_picking_item','invalid_picking_quantity','invalid_picking_staff'].includes(reason);
          if (notSaved) clear(data.clientRequestId, key);
          throw Object.assign(error(reason, result, response.status), { notSaved });
        }
        if (action === 'saveRequisition') {
          if (result.saved !== true || !result.requisition?.uid) throw error('picking_confirmation_missing');
          clear(data.clientRequestId, key);
        }
        return result;
      } catch (e) { if (e.reason) throw e; throw error('picking_service_unavailable'); }
    }
    return Object.freeze({ can: key => can(options.getUser(), key), call, pending, prepare, clear, storageKey });
  }
  return Object.freeze({ create, can, message });
}));
