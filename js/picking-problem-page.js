(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const $ = id => document.getElementById(id);
  const state = { client:null, bill:null, items:[], busy:false, dirty:false, pending:null };
  function esc(value) { return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function show(name) { ['loading','form','done','error'].forEach(id => $(id).style.display = id === name ? 'block' : 'none'); }
  function status(message) { $('form-status').textContent = message; }
  function fail(error) { $('error-msg').textContent = error.message || 'โหลดบิลไม่สำเร็จ กรุณาลองใหม่'; show('error'); }
  function isPreview() { return ['localhost','127.0.0.1','::1'].includes(location.hostname) && params.get('mock') === '1'; }
  function rows() { return [...document.querySelectorAll('#items .item')]; }
  function controls() {
    const closed = state.bill?.lineStatus === 'sent';
    $('form').querySelectorAll('input,textarea,button').forEach(node => node.disabled = state.busy);
    if (closed) $('items').querySelectorAll('input,textarea,button').forEach(node => node.disabled = true);
    $('submit').disabled = state.busy || (closed && !state.pending);
    $('submit').textContent = state.busy ? 'กำลังตรวจผลบันทึก…' : state.pending ? 'ตรวจผล / ส่งคำขอเดิมอีกครั้ง' : 'บันทึก & แจ้งกลุ่ม';
    $('restore-pending').hidden = !state.pending;
  }
  function render(bill, pending) {
    state.bill = bill; state.items = bill.items; state.pending = pending;
    $('bill-meta').innerHTML = '<span>' + esc(bill.billType) + ' #' + esc(String(bill.billNo || '').padStart(3,'0')) + '</span><span>มอบให้ @' + esc(bill.assignee) + '</span>';
    $('reporter').textContent = bill.assignee || '-';
    $('items').innerHTML = '';
    state.items.forEach((item,index) => {
      const previous = pending?.items[index] || (bill.problemItems || []).find(row => row.index === index) || {};
      const actual = previous.actualQty ?? item.qty;
      const row = document.createElement('div'); row.className = 'item'; row.dataset.i = String(index);
      row.innerHTML = '<div class="top"><div><div class="nm"></div><div class="req">เบิก ' + esc(item.qty) + ' ' + esc(item.unit) + '</div></div><span class="badge ok" data-badge></span></div>' +
        '<div class="qbox"><label for="qty-' + index + '">ได้จริง</label><div class="stepper"><button type="button" data-d="-1" aria-label="ลดจำนวนรายการ ' + (index+1) + '">−</button>' +
        '<input id="qty-' + index + '" type="number" required min="0" max="99999999999.9999" step="0.0001" inputmode="decimal" data-q value="' + esc(actual) + '" aria-label="จำนวนจริงรายการ ' + (index+1) + '">' +
        '<button type="button" data-d="1" aria-label="เพิ่มจำนวนรายการ ' + (index+1) + '">+</button></div><span class="unit">' + esc(item.unit) + '</span></div>' +
        '<div class="note"><label class="nl" for="note-' + index + '">หมายเหตุรายการ ' + (index+1) + '</label><textarea id="note-' + index + '" rows="2" maxlength="500" data-note placeholder="เช่น ของเหลือไม่พอ รอเข้าใหม่">' + esc(previous.note || '') + '</textarea></div>';
      row.querySelector('.nm').textContent = (index+1) + '. ' + item.name;
      $('items').appendChild(row);
    });
    $('reload-latest').hidden = true;
    state.dirty = !!pending;
    status(pending ? 'พบคำขอค้าง · ตรวจผลด้วยข้อมูลและรหัสเดิมก่อนส่งรายการใหม่' : bill.lineStatus === 'sent' ? 'บิลนี้ส่งแล้ว แสดงข้อมูลเพื่อการตรวจสอบเท่านั้น' : 'ตรวจจำนวนจริงก่อนบันทึก');
    refresh(); controls(); show('form');
  }
  function refresh() {
    const short = []; let invalid = false;
    rows().forEach(row => {
      const item = state.items[Number(row.dataset.i)], input = row.querySelector('[data-q]');
      const qty = Number(input.value), valid = input.value !== '' && input.validity.valid && Number.isFinite(qty);
      const badge = row.querySelector('[data-badge]'), less = valid && qty < Number(item.qty);
      row.classList.toggle('short',less || !!row.querySelector('[data-note]').value);
      input.setAttribute('aria-invalid',String(!valid));
      badge.className = valid && !less ? 'badge ok' : 'badge lack';
      badge.textContent = !valid ? 'ตรวจจำนวน' : less ? 'ขาด ' + Number((Number(item.qty)-qty).toFixed(4)) : 'ครบ ✓';
      if (!valid) invalid = true;
      else if (less) short.push({name:item.name,unit:item.unit,requested:item.qty,actual:qty});
    });
    $('summary').innerHTML = invalid ? '<div>กรุณาตรวจจำนวนที่ไม่ถูกต้อง — ยังไม่ได้บันทึก</div>' : short.length ?
      '<div>สรุปของขาด ' + short.length + ' รายการ</div>' + short.map(item => '<div class="srow"><span>' + esc(item.name) + '</span><b>' + esc(item.actual) + '/' + esc(item.requested) + ' ' + esc(item.unit) + '</b></div>').join('') :
      '<div class="allok">ครบทุกรายการ — กดบันทึกเพื่อแจ้งสถานะ</div>';
  }
  function collect() {
    const items = rows().map(row => {
      const input = row.querySelector('[data-q]');
      if (!input.reportValidity()) throw new Error('กรุณาตรวจจำนวนจริงให้ถูกต้อง');
      return {index:Number(row.dataset.i),actualQty:input.value,note:row.querySelector('[data-note]').value};
    });
    return window.AkraPickingProblem.normalize(items,state.items.length);
  }
  async function submit() {
    if (state.busy || !state.client) return;
    let items;
    try { items = collect(); } catch (error) { status(error.message); return; }
    state.busy = true; state.dirty = true; controls(); status('กำลังตรวจผลบันทึก...');
    try {
      const result = await state.client.report(items);
      state.dirty = false; state.pending = null;
      $('done-title').textContent = 'บันทึกแล้ว';
      $('done-message').textContent = result.lineSent === true ? 'บันทึกจำนวนจริงแล้ว และ LINE รับคำขอแจ้งกลุ่มแล้ว' : 'บันทึกจำนวนจริงแล้ว แต่ยังยืนยันการแจ้ง LINE ไม่ได้ ระบบเก็บงานไว้ตรวจส่งต่อ กรุณาอย่าสร้างรายงานซ้ำ';
      show('done');
    } catch (error) {
      if (error.reason === 'invalid_bill_capability') { fail(error); return; }
      try { state.pending = state.client.pending(); } catch (_) { /* Keep current form; never clear an unknown request. */ }
      $('reload-latest').hidden = !['picking_version_conflict','invalid_picking_transition'].includes(error.reason);
      status(error.message);
    } finally { state.busy = false; controls(); }
  }
  async function load() {
    show('loading');
    try {
      if (!state.client) {
        if (isPreview()) {
          const bill = {uid:'preview-bill',version:1,billNo:1,billType:'บิลจัด',assignee:'พนักงานตัวอย่าง',lineStatus:'pending',items:[{name:'สินค้าตัวอย่าง',qty:2,unit:'ชิ้น'},{name:'สินค้าตัวอย่าง',qty:5,unit:'กล่อง'}],problemItems:[]};
          state.client = {load:async()=>bill,pending:()=>null,report:async items=>{window.AkraPickingProblem.normalize(items,bill.items.length);return{saved:true,lineSent:params.get('lineFail')!=='1'};}};
        } else {
          if (params.getAll('uid').length !== 1 || params.getAll('token').length !== 1) throw new Error('ลิงก์ไม่ถูกต้อง กรุณาเปิดจากบิล LINE อีกครั้ง');
          state.client = await window.AkraPickingProblem.create({uid:params.get('uid'),token:params.get('token').replace(/ /g,'+'),
            storage:{getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value),removeItem:key=>localStorage.removeItem(key)}});
        }
      }
      const bill = await state.client.load();
      render(bill,state.client.pending());
    } catch (error) { fail(error); }
  }
  $('submit').addEventListener('click',submit);
  $('reload-bill').addEventListener('click',load);
  $('restore-pending').addEventListener('click',() => {
    if (state.busy) return;
    try {
      const pending = state.client.pending();
      if (!pending) return status('ไม่พบคำขอค้าง อาจยืนยันจากหน้าจออื่นแล้ว กรุณาเปิดบิลใหม่เพื่อตรวจผล');
      render(state.bill,pending);
    } catch (error) { status(error.message); }
  });
  $('reload-latest').addEventListener('click',async () => {
    if (state.busy) return;
    state.busy = true; controls();
    try { const bill = await state.client.reviewLatest(); render(bill,null); status('โหลดข้อมูลล่าสุดแล้ว กรุณาตรวจใหม่ก่อนบันทึก'); }
    catch (error) { fail(error); }
    finally { state.busy = false; controls(); }
  });
  $('items').addEventListener('input',() => { state.dirty = true; refresh(); });
  $('items').addEventListener('click',event => {
    const button = event.target.closest('[data-d]'); if (!button || button.disabled || state.busy) return;
    const input = button.parentElement.querySelector('[data-q]');
    if (!input.reportValidity()) return;
    input.value = String(Math.max(0,Math.round((Number(input.value)+Number(button.dataset.d))*10000)/10000));
    state.dirty = true; refresh();
  });
  window.addEventListener('beforeunload',event => { if (state.dirty || state.busy) { event.preventDefault(); event.returnValue = ''; } });
  load();
}());
