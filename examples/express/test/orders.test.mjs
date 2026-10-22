import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay, byStatus } from 'stubsmith';
import { getOrder, getUser } from '../orders.js';

// replay() finds .stubsmith/bundle.json by walking up from the working
// directory, so run these from the example directory (npm test does).

test('getOrder reads a recorded order over fetch', async () => {
  const r = replay();
  try {
    const order = await getOrder(5234);
    assert.equal(order.status, 'shipped');
    assert.equal(order.total_cents, 8799);
    assert.deepEqual(r.served().map((s) => s.endpoint), ['GET localhost:8081/api/orders/{id}']);
  } finally {
    r.restore();
  }
});

test('getUser reads a recorded user over axios', async () => {
  const r = replay();
  try {
    const user = await getUser(4821);
    assert.equal(user.plan, 'pro');
    assert.equal(user.active, true);
  } finally {
    r.restore();
  }
});

test('getUser returns null for the recorded 404', async () => {
  const r = replay({ select: byStatus(404) });
  try {
    assert.equal(await getUser(1), null);
  } finally {
    r.restore();
  }
});
