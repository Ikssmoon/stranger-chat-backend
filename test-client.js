/**
 * Two-socket smoke test.
 * Run:  node test-client.js
 * Requires the server to be running:  npm run dev
 */
const { io } = require('socket.io-client');

const URL = 'http://localhost:3001';
let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── filter compatibility matrix ──────────────────────────────────────────────
// Each entry: [labelA, filterA, labelB, filterB, shouldMatch]
const COMPAT_CASES = [
  // iAm:'any' acts as a wildcard on both sides
  ['f→m',   { iAm: 'f', lookingFor: 'm'   }, 'any→any', { iAm: 'any', lookingFor: 'any' }, true ],
  ['m→f',   { iAm: 'm', lookingFor: 'f'   }, 'any→any', { iAm: 'any', lookingFor: 'any' }, true ],
  ['any→any', { iAm: 'any', lookingFor: 'any' }, 'any→any', { iAm: 'any', lookingFor: 'any' }, true ],
  // mutual gender match
  ['f→m',   { iAm: 'f', lookingFor: 'm'   }, 'm→f',   { iAm: 'm', lookingFor: 'f'   }, true ],
  // gender mismatch — should NOT match
  ['f→f',   { iAm: 'f', lookingFor: 'f'   }, 'm→any', { iAm: 'm', lookingFor: 'any' }, false],
  ['m→m',   { iAm: 'm', lookingFor: 'm'   }, 'f→any', { iAm: 'f', lookingFor: 'any' }, false],
];

async function testCompatibility() {
  console.log('\n=== Filter compatibility tests ===\n');

  for (const [labelA, filterA, labelB, filterB, shouldMatch] of COMPAT_CASES) {
    const a = io(URL, { autoConnect: false });
    const b = io(URL, { autoConnect: false });

    const gotA = {};
    const gotB = {};
    a.onAny((ev, data) => { gotA[ev] = data; });
    b.onAny((ev, data) => { gotB[ev] = data; });

    await new Promise(r => { a.connect(); a.on('connect', r); });
    await new Promise(r => { b.connect(); b.on('connect', r); });

    a.emit('set_filter', filterA);
    b.emit('set_filter', filterB);
    a.emit('start_search');
    b.emit('start_search');
    await delay(200);

    const matched = !!(gotA.matched && gotB.matched);
    const label = `${labelA} + ${labelB} → ${shouldMatch ? 'match' : 'no match'}`;
    assert(label, matched === shouldMatch);

    a.disconnect();
    b.disconnect();
    await delay(100);
  }
}

async function run() {
  await testCompatibility();
  console.log('\n=== Pass 1 smoke test ===\n');

  const alice = io(URL, { autoConnect: false });
  const bob   = io(URL, { autoConnect: false });

  const events = { alice: [], bob: [] };
  const collect = (name, sock) => {
    ['searching', 'matched', 'message', 'partner_left', 'error'].forEach(ev =>
      sock.on(ev, data => {
        events[name].push({ ev, data });
        console.log(`  [${name}] ${ev}`, data ?? '');
      })
    );
  };

  collect('alice', alice);
  collect('bob',   bob);

  // ── 1. Both connect and set filters ─────────────────────────────────────────
  console.log('1. Connect + set_filter');
  await new Promise(r => { alice.connect(); alice.on('connect', r); });
  await new Promise(r => { bob.connect();   bob.on('connect', r); });
  alice.emit('set_filter', { iAm: 'f', lookingFor: 'any' });
  bob.emit('set_filter',   { iAm: 'm', lookingFor: 'any' });
  await delay(100);

  // ── 2. Both search — should match ───────────────────────────────────────────
  console.log('\n2. start_search → expect matched');
  alice.emit('start_search');
  bob.emit('start_search');
  await delay(200);

  const aliceMatched = events.alice.find(e => e.ev === 'matched');
  const bobMatched   = events.bob.find(e => e.ev === 'matched');
  assert('alice received matched', !!aliceMatched);
  assert('bob received matched',   !!bobMatched);
  assert('same roomId', aliceMatched?.data?.roomId === bobMatched?.data?.roomId);

  // ── 3. Alice sends a message to Bob ─────────────────────────────────────────
  console.log('\n3. send_message alice→bob');
  alice.emit('send_message', { text: 'hello bob' });
  await delay(100);

  const bobMsg = events.bob.find(e => e.ev === 'message');
  assert('bob received message', bobMsg?.data?.text === 'hello bob');

  // ── 4. Bob sends a message to Alice ─────────────────────────────────────────
  console.log('\n4. send_message bob→alice');
  bob.emit('send_message', { text: 'hi alice' });
  await delay(100);

  const aliceMsg = events.alice.find(e => e.ev === 'message');
  assert('alice received message', aliceMsg?.data?.text === 'hi alice');

  // ── 5. Alice skips — bob should get partner_left + re-enter searching ───────
  console.log('\n5. alice skips');
  events.bob = [];
  alice.emit('skip');
  await delay(200);

  const bobLeft     = events.bob.find(e => e.ev === 'partner_left');
  const bobSearching = events.bob.find(e => e.ev === 'searching');
  assert('bob got partner_left { reason: skip }', bobLeft?.data?.reason === 'skip');
  assert('bob auto-requeued (searching)', !!bobSearching);

  // ── 6. Alice also re-entered searching ──────────────────────────────────────
  const aliceSearching = events.alice.find(e => e.ev === 'searching');
  assert('alice re-entered searching after skip', !!aliceSearching);

  // ── 7. Alice leaves to go idle, then bob disconnects cleanly ───────────────
  // After the skip both users re-matched (they are the only compatible pair).
  // Have alice leave first so she is idle, then bob disconnects.
  console.log('\n6. alice leaves → idle; bob disconnects (alice should NOT be notified)');
  alice.emit('leave');
  await delay(100);
  events.alice = [];
  await new Promise(r => { bob.on('disconnect', r); bob.disconnect(); });
  await delay(200);
  const aliceGotDisconnect = events.alice.some(e => e.ev === 'partner_left');
  assert('alice not notified of bob disconnect (not paired)', !aliceGotDisconnect);

  // ── 8. Clean up ─────────────────────────────────────────────────────────────
  alice.disconnect();

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
