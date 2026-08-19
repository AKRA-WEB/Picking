const assert = require('assert');
const pickClient = require('../js/supabase-picking-client.js');

async function runTests() {
  console.log('=== TESTING PICKING SUPABASE API CLIENT ADAPTER ===\n');

  // 1. Save Picking Requisition
  console.log('[1/3] Testing Save Requisition (Bill + Items)...');
  const reqRes = await pickClient.saveRequisition({
    billNumber: 'REQ-TEST-' + Date.now(),
    requisitionDate: '2026-08-19',
    requester: 'Test Requester',
    warehouse: 'W1',
    targetBranch: 'TRD',
    remark: 'เบิกสินค้าเติมหน้าร้าน',
    items: [
      {
        sku: 'FF21610104',
        productName: 'มายองเนส SE เบสท์ฟู้ดส์ (ลัง12x910g)',
        requestQty: 5,
        unit: 'ลัง'
      }
    ]
  });
  assert.strictEqual(reqRes.status, 'success');
  assert(reqRes.billId, 'Must return generated Bill ID');
  console.log(`  -> Created Requisition Bill [${reqRes.billNumber}] ID: ${reqRes.billId}`);

  // 2. Query Requisition History
  console.log('\n[2/3] Testing getRequisitions query...');
  const historyRes = await pickClient.getRequisitions(10);
  assert.strictEqual(historyRes.status, 'success');
  const foundBill = historyRes.bills.find(b => b.id === reqRes.billId);
  assert(foundBill, 'Must find created bill in history');
  assert.strictEqual(foundBill.items.length, 1, 'Must have 1 child line item');
  console.log(`  -> Found Requisition [${foundBill.bill_number}] with ${foundBill.items.length} items.`);

  // 3. Update Item Picked
  console.log('\n[3/3] Testing updateItemPicked...');
  const targetItem = foundBill.items[0];
  const updateRes = await pickClient.updateItemPicked(targetItem.id, 5);
  assert.strictEqual(updateRes.status, 'success');
  console.log(`  -> Updated item picked_qty to 5: status=${updateRes.item.status}`);

  console.log('\n🌟 PICKING SUPABASE API CLIENT ADAPTER TESTS PASSED 100%! 🌟');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
