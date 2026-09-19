/* Bill-capability boundary; separate from Main identity and the creation client. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AkraPickingProblem = factory();
}(typeof window === 'undefined' ? {} : window, function () {
  'use strict';
  const endpoint = 'https://hgxrrskztbpejirrdpbq.supabase.co/functions/v1/picking-api';
  function message(reason) {
    if (reason === 'invalid_bill_capability') return 'ลิงก์นี้ไม่มีสิทธิ์เข้าถึงบิล กรุณาเปิดลิงก์จากบิลที่ต้องการอีกครั้ง';
    if (reason === 'picking_version_conflict') return 'มีผู้ปรับสถานะบิลแล้ว รายการนี้ยังไม่ถูกบันทึก กรุณาโหลดข้อมูลล่าสุดและตรวจอีกครั้ง';
    if (reason === 'invalid_picking_transition') return 'บิลนี้ส่งแล้ว จึงบันทึกการจัดสินค้าเพิ่มเติมไม่ได้ กรุณาตรวจข้อมูลล่าสุด';
    if (reason === 'invalid_picking_problem') return 'กรุณากรอกจำนวนจริงตั้งแต่ 0 และทศนิยมไม่เกิน 4 ตำแหน่ง หมายเหตุไม่เกิน 500 ตัวอักษร';
    if (reason === 'pending_submission_mismatch') return 'มีคำขอที่ยังไม่ทราบผล กรุณากู้คืนและตรวจผลคำขอเดิมก่อนแก้ข้อมูลหรือส่งใหม่';
    if (reason === 'picking_event_conflict') return 'รหัสคำขอนี้ตรงกับข้อมูลอื่น กรุณาให้ผู้ดูแลตรวจสอบ ห้ามส่งเป็นคำขอใหม่แทน';
    if (reason.startsWith('pending_storage_')) return 'เก็บข้อมูลป้องกันการบันทึกซ้ำไม่ได้ จึงยังไม่ได้ส่ง กรุณาตรวจพื้นที่จัดเก็บของเบราว์เซอร์';
    if (['invalid_bill_response','bill_not_verified'].includes(reason)) return 'ยังตรวจสอบข้อมูลบิลไม่ได้ กรุณาลองโหลดอีกครั้ง';
    return 'ยังยืนยันผลบันทึกไม่ได้ ข้อมูลเดิมยังอยู่ กรุณากู้คืนแล้วส่งคำขอเดิมอีกครั้งเมื่อเชื่อมต่อได้';
  }
  function fail(reason, status) { return Object.assign(new Error(message(reason)), { reason, status }); }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function normalize(items, count) {
    if (!Array.isArray(items) || items.length !== count || count < 1 || count > 200) throw fail('invalid_picking_problem');
    return items.map((item, index) => {
      const raw = String(item?.actualQty ?? '');
      if (item?.index !== index || !['number','string'].includes(typeof item.actualQty) || raw.length > 20 ||
        !/^[0-9]+(?:\.[0-9]{1,4})?$/.test(raw) || !Number.isFinite(Number(raw)) || Number(raw) >= 100000000000 ||
        (item.note !== undefined && typeof item.note !== 'string') || (item.note || '').length > 500) throw fail('invalid_picking_problem');
      return { index, actualQty: Number(raw), note: (item.note || '').trim() };
    });
  }
  async function create(options) {
    const uid = String(options.uid || ''), token = String(options.token || '');
    if (!uid || uid.length > 200 || token.length < 16 || token.length > 512) throw fail('invalid_bill_capability');
    const cryptoApi = options.crypto || crypto;
    const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const storageKey = 'pick_problem_v2:' + encodeURIComponent(uid) + ':' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('');
    const storage = options.storage, fetcher = options.fetch || fetch;
    const requestId = options.requestId || (() => cryptoApi.randomUUID());
    let bill = null, verified = false, expectedId = '', reviewId = '', busy = false;
    function checkVerified() { if (!verified) throw fail('bill_not_verified'); }
    function pending() {
      checkVerified();
      let raw;
      try { raw = storage.getItem(storageKey); } catch (_) { throw fail('pending_storage_unavailable'); }
      if (!raw) return null;
      try {
        const value = JSON.parse(raw), request = value?.request;
        if (value?.schema !== 1 || !/^[A-Za-z0-9_-]{8,100}$/.test(request?.clientRequestId || '') || !Number.isSafeInteger(request?.version) || request.version < 1) throw Error('corrupt');
        request.items = normalize(request.items, bill.items.length);
        if (!expectedId) expectedId = request.clientRequestId;
        return request;
      } catch (_) { throw fail('pending_storage_corrupt'); }
    }
    function clear(id) {
      try {
        const value = JSON.parse(storage.getItem(storageKey) || 'null');
        if (value?.request?.clientRequestId === id) storage.removeItem(storageKey);
      } catch (_) { /* Keep the receipt replayable if cleanup is unavailable. */ }
    }
    async function call(body) {
      try {
        const response = await fetcher(endpoint, { method: 'POST', headers: { 'Content-Type':'application/json' },
          body: JSON.stringify({ ...body, uid, token }), cache:'no-store', referrerPolicy:'no-referrer', signal:AbortSignal.timeout(65000) });
        const result = await response.json();
        if (!response.ok || result?.success !== true) {
          if (response.status === 403 && result?.reason === 'invalid_bill_capability') verified = false;
          throw fail(String(result?.reason || 'picking_service_unavailable'),response.status);
        }
        return result;
      } catch (error) { if (error.reason) throw error; throw fail('picking_service_unavailable'); }
    }
    async function load() {
      verified = false;
      const result = await call({action:'getBill'});
      if (result.bill?.uid !== uid || !Number.isSafeInteger(result.bill?.version) || result.bill.version < 1 || !Array.isArray(result.bill.items) || !result.bill.items.length) throw fail('invalid_bill_response');
      bill = copy(result.bill); verified = true;
      return copy(bill);
    }
    async function report(items) {
      checkVerified();
      if (busy) throw fail('request_in_progress');
      const normalized = normalize(items,bill.items.length);
      let request = pending();
      if (expectedId && request?.clientRequestId !== expectedId) throw fail('pending_submission_mismatch');
      if (request) {
        if (JSON.stringify(request.items) !== JSON.stringify(normalized)) throw fail('pending_submission_mismatch');
      } else {
        if (bill.lineStatus === 'sent') throw fail('invalid_picking_transition');
        request = {version:bill.version,clientRequestId:requestId(),items:normalized};
        const raw = JSON.stringify({schema:1,request});
        try { storage.setItem(storageKey,raw); if (storage.getItem(storageKey) !== raw) throw Error('not-persisted'); }
        catch (_) { throw fail('pending_storage_unavailable'); }
      }
      expectedId = request.clientRequestId; reviewId = ''; busy = true;
      try {
        const result = await call({action:'reportProblem',...request});
        if (result.saved !== true || result.requisition?.uid !== uid) throw fail('picking_confirmation_missing');
        clear(request.clientRequestId); expectedId = ''; bill = copy(result.requisition);
        return result;
      } catch (error) {
        // A version/terminal-state rejection happens only after receipt lookup.
        // An explicit user review can safely replace this rejected request.
        if (error.status === 409 && ['picking_version_conflict','invalid_picking_transition'].includes(error.reason)) reviewId = request.clientRequestId;
        if (error.status === 400 && error.reason === 'invalid_picking_problem') { clear(request.clientRequestId); expectedId = ''; error.notSaved = true; }
        throw error;
      } finally { busy = false; }
    }
    async function reviewLatest() {
      checkVerified();
      const rejected = pending();
      if (!reviewId || rejected?.clientRequestId !== reviewId || busy) throw fail('pending_outcome_unknown');
      const current = await load();
      clear(reviewId);
      if (pending()) throw fail('pending_storage_unavailable');
      expectedId = ''; reviewId = '';
      return current;
    }
    return Object.freeze({load,report,pending,reviewLatest,storageKey});
  }
  return Object.freeze({create,normalize,message});
}));
