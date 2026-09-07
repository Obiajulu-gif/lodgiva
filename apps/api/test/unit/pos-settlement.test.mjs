import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PosService } from '../../dist/modules/pos.module.js';

const auth = { tenantId: 'tenant', userId: 'cashier' };
function setup(folio = { propertyId: 'other', status: 'OPEN' }) {
  const writes = [];
  const tx = {
    posOrder: {
      findFirst: async () => ({ id: 'order', propertyId: 'hotel', status: 'OPEN', lines: [], outlet: {} }),
      update: async () => { writes.push('order'); },
    },
    cashierShift: { findFirst: async ({ where }) => {
      assert.equal(where.propertyId, 'hotel');
      return null;
    } },
    cashMovement: { create: async () => { writes.push('cash'); } },
  };
  const service = new PosService({ $transaction: fn => fn(tx) }, {}, {}, {
    getFolioOrThrow: async () => folio,
    postChargeTx: async () => { writes.push('charge'); },
  }, {});
  return { service, writes };
}
for (const [name, body, code] of [
  ['cash requires a shift', { settlement: 'CASH' }, 'SHIFT_REQUIRED'],
  ['cash shift must be open in the order property', { settlement: 'CASH', shiftId: 'other-shift' }, 'SHIFT_NOT_OPEN'],
  ['room posting cannot cross properties', { settlement: 'ROOM_POSTING', folioId: 'other-folio' }, 'PROPERTY_MISMATCH'],
]) {
  test(name, async () => {
    const { service, writes } = setup();
    await assert.rejects(service.settle(auth, 'order', body), error => error.getResponse().error.code === code);
    assert.deepEqual(writes, []);
  });
}
