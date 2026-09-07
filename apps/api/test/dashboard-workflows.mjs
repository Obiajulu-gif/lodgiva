// Run after dashboard-fixture.mjs against the isolated local QA API.
import assert from 'node:assert/strict';
const base = process.env.DASHBOARD_QA_API ?? 'http://127.0.0.1:4012/api/v1';
let token;
async function call(path, body, method = body ? 'POST' : 'GET', expected) {
  const response = await fetch(base+path, { method, headers: { 'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {}) }, body: body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(90000) });
  const data = await response.json();
  if (expected) assert.equal(response.status,expected,`${path}: ${JSON.stringify(data)}`);
  else assert.ok(response.ok,`${path}: ${JSON.stringify(data)}`);
  return data;
}
const login = await call('/auth/login',{email:'dashboard-qa-20260907@lodgiva.test',password:'Dashboard-QA-Only-2026!'});
token=login.accessToken; assert.ok(token);
const me=await call('/auth/me');
const propertyId=me.properties.find(p=>p.code==='QA1').id;
const other=me.properties.find(p=>p.code==='QA2').id;
for(const endpoint of ['/properties/'+propertyId+'/room-rack','/reservations','/guests','/housekeeping/tasks','/payments','/pos/outlets','/pos/orders','/cashiering/shifts','/reports/daily-flash','/reports/audit-trail','/analytics/revenue','/analytics/exports','/properties/'+propertyId+'/settings']) {
  await call(endpoint+'?propertyId='+propertyId+'&from=2026-09-01&to=2026-09-07');
  console.log('PASS: '+endpoint);
}
console.log('PASS: all dashboard data endpoints');
let reservation;
if (process.argv.includes('--resume-after-checkin')) {
  reservation=(await call('/reservations?propertyId='+propertyId)).find(r=>r.status==='CHECKED_IN');
  assert.ok(reservation, 'Expected checked-in QA reservation');
  reservation.folioId=reservation.folios[0].id;
} else {
const type=await call('/config/room-types',{propertyId,code:'QASMOKE',name:'QA suite',baseRateMinor:10000,baseOccupancy:1,maxOccupancy:2});
const room=await call('/config/rooms',{propertyId,roomTypeId:type.id,roomNumber:'QA101',floor:1});
assert.ok((await call('/properties/'+propertyId+'/room-rack')).some(r=>r.id===room.id));
assert.ok(!(await call('/properties/'+other+'/room-rack')).some(r=>r.id===room.id));
const guest=await call('/guests',{firstName:'Disposable',lastName:'Workflow',email:'workflow@lodgiva.test'});
await call('/guests/'+guest.id,{vip:true,notes:'Verified persistence'},'PATCH');
assert.equal((await call('/guests/'+guest.id)).vip,true);
reservation=await call('/reservations',{propertyId,guestId:guest.id,roomTypeId:type.id,arrivalDate:'2026-09-07',departureDate:'2026-09-08',adults:1,source:'DIRECT'});
await call('/rooms/'+room.id+'/status',{status:'INSPECTED'},'PATCH');
await call('/reservations/'+reservation.id+'/check-in',{roomId:room.id});
assert.equal((await call('/reservations?propertyId='+propertyId)).find(r=>r.id===reservation.id).status,'CHECKED_IN');
console.log('PASS: room creation, property isolation, guest edits, reservation creation and check-in persist');
}
// Checkout computes unposted room charges and refuses an unpaid departure.
const quote=await call('/reservations/'+reservation.id+'/check-out',{},'POST',409);
assert.equal(quote.error.code,'OUTSTANDING_BALANCE');
const amount=Number(quote.error.details.balanceMinor);
assert.ok(Number.isSafeInteger(amount)&&amount>0);
const payment={folioId:reservation.folioId,method:'CASH',amountMinor:amount,idempotencyKey:'dashboard-qa-payment-'+reservation.id};
await call('/payments',payment);await call('/payments',payment);
assert.equal(Number((await call('/folios/'+reservation.folioId)).balanceMinor),-amount);
await call('/reservations/'+reservation.id+'/check-out',{});
assert.equal(Number((await call('/folios/'+reservation.folioId)).balanceMinor),0);
assert.equal((await call('/reservations?propertyId='+propertyId)).find(r=>r.id===reservation.id).status,'CHECKED_OUT');
console.log('PASS: folio charges, payment idempotency and checkout');
const tasks=await call('/housekeeping/tasks?propertyId='+propertyId);
assert.ok(tasks.length,'checkout creates housekeeping work');
await call('/housekeeping/tasks/'+tasks[0].id+'/advance',{});
assert.notEqual((await call('/housekeeping/tasks?propertyId='+propertyId)).find(t=>t.id===tasks[0].id).status,tasks[0].status);
const shift=await call('/cashiering/shifts',{propertyId,openingFloatMinor:10000});
await call('/cashiering/shifts/'+shift.id+'/close',{countedMinor:10000});
console.log('PASS: housekeeping transitions and cashier shift opening/closing');
