/**
 * ============================================================================
 * AKRA PICKING SUPABASE API CLIENT
 * Status: DEACTIVATED / CONTAINED for Security Hardening (Plan 20260820-004)
 * Requisitions and product loading execute via authoritative backend (GAS).
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
        KEY: ''
    };

    return {
        getProducts: async () => [],
        getStaff: async () => [],
        getRequisitions: async () => { throw new Error('Supabase Picking client deactivated. Falling back to GAS.'); },
        saveRequisition: async () => { throw new Error('Supabase Picking client deactivated. Falling back to GAS.'); }
    };
}));
