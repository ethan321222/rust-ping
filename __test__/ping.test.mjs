/**
 * rust-ping ESM 集成测试
 *
 * 验证 ESM 导入方式下所有 API 正常工作。
 *
 * 运行方式：需要管理员权限（Windows）或 ping_group_range 配置（Linux）
 *   node __test__/ping.test.mjs
 */

import { session, createSession, PingTimeoutError, DestinationUnreachableError } from '../index.mjs';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

async function test(name, fn) {
  console.log(`\n▸ ${name}`);
  try {
    await fn();
  } catch (err) {
    failed++;
    console.log(`  ✗ Exception: ${err.message}`);
  }
}

// ─── 测试用例 ─────────────────────────────────────────────────────────────────

async function run() {
  // ═══════════════════════════════════════════════════════════════════════════
  // ESM 导出验证
  // ═══════════════════════════════════════════════════════════════════════════

  await test('ESM exports - all named exports available', () => {
    assert(typeof session === 'object', 'session exported');
    assert(typeof createSession === 'function', 'createSession exported');
    assert(typeof PingTimeoutError === 'function', 'PingTimeoutError exported');
    assert(typeof DestinationUnreachableError === 'function', 'DestinationUnreachableError exported');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DefaultSession 测试
  // ═══════════════════════════════════════════════════════════════════════════

  await test('defaultSession - ping localhost', async () => {
    session.close();
    const result = await session.ping('127.0.0.1');
    assert(result.alive === true, 'alive');
    assert(result.time >= 0, 'time >= 0');
    assert(typeof result.addr === 'string', 'has addr');
    session.close();
  });

  await test('defaultSession - setConfig and keepAlive', async () => {
    session.close();
    session.setConfig({ timeout: 3000, keepAlive: 200 });
    await session.ping('127.0.0.1');
    assert(session._session !== null, 'session active');

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert(session._session === null, 'session auto-closed after keepAlive');
    session.setConfig({ keepAlive: 10000 });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // createSession 测试
  // ═══════════════════════════════════════════════════════════════════════════

  await test('createSession - ping promise', async () => {
    const s = createSession();
    const result = await s.ping('127.0.0.1');
    assert(result.alive === true, 'alive');
    assert(result.time >= 0, 'time >= 0');
    assert(result.ttl >= 0, 'has ttl');
    s.close();
  });

  await test('createSession - pingBatch', async () => {
    const s = createSession({ timeout: 3000 });
    const results = await s.pingBatch(['127.0.0.1']);
    assert(results instanceof Map, 'returns Map');
    assert(results.get('127.0.0.1').alive === true, 'localhost alive');
    s.close();
  });

  await test('createSession - pingHost callback', () => {
    return new Promise((resolve) => {
      const s = createSession({ timeout: 3000 });
      s.pingHost('127.0.0.1', (error, target, sent, rcvd) => {
        assert(!error, 'no error');
        assert(target === '127.0.0.1', 'target matches');
        assert(rcvd - sent >= 0, 'rtt >= 0');
        s.close();
        resolve();
      });
    });
  });

  await test('createSession - timeout rejects with PingTimeoutError', async () => {
    const s = createSession({ timeout: 500, retries: 0 });
    try {
      await s.ping('10.255.255.1');
      assert(false, 'should have thrown');
    } catch (err) {
      assert(err instanceof PingTimeoutError, 'is PingTimeoutError');
      assert(err.target === '10.255.255.1', 'has target');
    }
    s.close();
  });

  await test('createSession - concurrent pings', async () => {
    const s = createSession({ timeout: 3000 });
    const results = await Promise.all(
      Array(10).fill('127.0.0.1').map((t) => s.ping(t))
    );
    assert(results.length === 10, '10 results');
    assert(results.every((r) => r.alive), 'all alive');
    s.close();
  });

  // ─── 结果 ───────────────────────────────────────────────────────────────

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
