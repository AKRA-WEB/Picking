const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const assert=require('node:assert/strict');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const start=html.indexOf('    async function loadBootstrap('),end=html.indexOf('    async function refreshRequisitions(',start);assert.ok(start>=0&&end>start);
const nodes=new Map();const calls=[];let shown=0,applied=0,denied=false,cached=false,mock=false,storageAttempts=0;
const c={state:{session:{token:'fixture'}},APP_CONFIG:{STORAGE_KEY:'session'},CACHE_KEYS:{PRODUCTS:'products',REQUISITIONS:'history'},CACHE_TTL_MS:{},
 $:id=>{if(!nodes.has(id))nodes.set(id,{classList:{add(){}},textContent:''});return nodes.get(id);},
 readCache:key=>cached?(key==='products'?[{id:'product'}]:{rev:'fixture-revision'}):null,
 apiCall:async(action,data)=>{calls.push({action,data});if(denied)throw Object.assign(Error('permission_denied'),{status:403});return {success:true,products:[{id:'product'}]};},
 applyBootstrapData:()=>applied++,isMockMode:()=>mock,localStorage:{setItem:()=>{storageAttempts++;throw Error('quota');}},
 clearPendingSsoToken(){},showApp:()=>shown++,reconcilePendingSubmit(){},updateActionControls(){},console:{warn(){}}};
vm.createContext(c);vm.runInContext(html.slice(start,end),c);
(async()=>{
 await c.loadBootstrap(false);assert.equal(shown,1);assert.equal(applied,1);assert.equal(nodes.get('form-status').textContent,'พร้อมทำรายการ');
 assert.equal(calls[0].data.includeProducts,true);assert.equal(calls[0].data.includeRequisitions,true);
 cached=true;await c.loadBootstrap(true);assert.equal(calls[1].data.includeProducts,false);assert.equal(calls[1].data.includeRequisitions,false);assert.equal(calls[1].data.historyRev,'fixture-revision');
 await c.loadBootstrap(false,{allowCachedData:false});assert.equal(calls[2].data.includeProducts,true);assert.equal(calls[2].data.includeRequisitions,true);
 assert.equal(storageAttempts,0,'bootstrap never persists a JWT or full session in localStorage');
 console.log('PASS authenticated bootstrap has no persistent JWT; cached/forced read flags preserved');
 mock=true;const beforeMock=storageAttempts;await c.loadBootstrap(false);assert.equal(storageAttempts,beforeMock,'mock bootstrap does not write real session');
 denied=true;const oldShown=shown,oldApplied=applied;await assert.rejects(c.loadBootstrap(false),/permission_denied/);assert.equal(shown,oldShown);assert.equal(applied,oldApplied);
 console.log('PASS authorization denial never applies or shows fetched data');
})().catch(e=>{console.error(e);process.exitCode=1;});
