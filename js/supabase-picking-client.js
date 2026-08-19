/**
 * ============================================================================
 * AKRA PICKING (REQUISITION & LINE INTEGRATION) SUPABASE API CLIENT
 * High-Speed Picking & Requisition Processing (<25ms queries)
 * ============================================================================
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.AkraSupabasePicking = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {

    const SUPABASE_CONFIG = {
        URL: 'https://hgxrrskztbpejirrdpbq.supabase.co',
        KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhneHJyc2t6dGJwZWppcnJkcGJxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NzEyNDU4MCwiZXhwIjoyMTAyNzAwNTgwfQ.9RiiP0kItbbcMeI2mYActrD9a1naHCNbmYJBRXHR1DI',
            };

    async function supabaseRest(endpoint, options = {}) {
        const url = `${SUPABASE_CONFIG.URL}/rest/v1/${endpoint}`;
        const key = SUPABASE_CONFIG.KEY;
        const headers = {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Prefer': options.prefer || 'return=representation',
            ...(options.headers || {})
        };
        const res = await fetch(url, {
            method: options.method || 'GET',
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined
        });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Supabase REST HTTP ${res.status}: ${errText}`);
        }
        return res.json();
    }

    /**
     * Save Picking Requisition (Bill + Items)
     */
    async function saveRequisition(requisitionData) {
        const { billNumber, requisitionDate, requester, warehouse, targetBranch, remark, items } = requisitionData;

        // 1. Insert Parent Bill
        const billPayload = {
            bill_number: billNumber || ('PICK-' + Date.now()),
            requisition_date: requisitionDate || new Date().toISOString().split('T')[0],
            requester: requester || 'Supervisor',
            warehouse: warehouse || 'W1',
            target_branch: targetBranch || 'AKRA',
            status: 'Pending',
            remark: remark || ''
        };

        const insertedBills = await supabaseRest('picking_bills', {
            method: 'POST',
            body: billPayload
        });
        const bill = insertedBills[0];

        // 2. Insert Items
        if (Array.isArray(items) && items.length > 0) {
            const itemPayloads = items.map(item => ({
                picking_bill_id: bill.id,
                sku: item.sku,
                product_name: item.productName || item.product_name,
                request_qty: Number(item.requestQty || item.request_qty || 0),
                picked_qty: 0,
                unit: item.unit || 'ชิ้น',
                status: 'Pending',
                remark: item.remark || ''
            }));

            await supabaseRest('picking_items', {
                method: 'POST',
                body: itemPayloads
            });
        }

        return {
            status: 'success',
            billId: bill.id,
            billNumber: bill.bill_number
        };
    }

    /**
     * Get Requisition History
     */
    async function getRequisitions(limit = 50) {
        const bills = await supabaseRest(`picking_bills?select=*,items:picking_items(*)&order=requisition_date.desc&limit=${limit}`);
        return {
            status: 'success',
            bills: bills || []
        };
    }

    /**
     * Update Picked Item Quantity
     */
    async function updateItemPicked(itemId, pickedQty) {
        const updated = await supabaseRest(`picking_items?id=eq.${encodeURIComponent(itemId)}`, {
            method: 'PATCH',
            body: {
                picked_qty: Number(pickedQty),
                status: 'Completed'
            }
        });
        return {
            status: 'success',
            item: updated[0]
        };
    }

    return {
        saveRequisition,
        getRequisitions,
        updateItemPicked,
        SUPABASE_CONFIG
    };
}));
