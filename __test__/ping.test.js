'use strict';

/**
 * rust-ping 集成测试
 *
 * 运行方式：需要管理员权限（Windows）或 ping_group_range 配置（Linux）
 *   npm run build && npm test
 */

const { session, createSession, PingTimeoutError, DestinationUnreachableError } = require('../index');

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
  // DefaultSession 测试
  // ═══════════════════════════════════════════════════════════════════════════

  await test('defaultSession - lazy create on first ping', async () => {
    // 确保 session 是干净状态
    session.close();
    assert(session._session === null, 'session is null before ping');
    await session.ping('127.0.0.1');
    assert(session._session !== null, 'session created after ping');
    session.close();
  });

  await test('defaultSession - setConfig before activation', async () => {
    session.close();
    session.setConfig({ timeout: 3000, retries: 2 });
    // 不应抛错
    assert(true, 'setConfig succeeded');
    session.close();
  });

  await test('defaultSession - setConfig throws when active', async () => {
    session.close();
    await session.ping('127.0.0.1'); // 激活 session
    try {
      session.setConfig({ timeout: 5000 });
      assert(false, 'should have thrown');
    } catch (err) {
      assert(err.message.includes('Cannot setConfig'), 'throws correct error');
    }
    session.close();
  });

  await test('defaultSession - setConfig after close works', async () => {
    session.close();
    await session.ping('127.0.0.1'); // 激活
    session.close();                 // 关闭
    session.setConfig({ timeout: 1000 }); // 应该可以
    assert(true, 'setConfig after close succeeded');
    session.close();
  });

  await test('defaultSession - setConfig with keepAlive', async () => {
    session.close();
    session.setConfig({ keepAlive: 30000 });
    assert(true, 'setConfig with keepAlive succeeded');
    session.close();
  });

  await test('defaultSession - keepAlive auto close', async () => {
    session.close();
    session.setConfig({ keepAlive: 200 }); // 200ms 后自动关闭
    await session.ping('127.0.0.1');
    assert(session._session !== null, 'session active after ping');

    // 等待 keepAlive 到期
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert(session._session === null, 'session auto-closed after keepAlive');
    // 恢复默认 keepAlive
    session.setConfig({ keepAlive: 10000 });
  });

  await test('defaultSession - auto recreate after keepAlive close', async () => {
    session.close();
    session.setConfig({ keepAlive: 200 });
    await session.ping('127.0.0.1');

    // 等待自动关闭
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert(session._session === null, 'session closed');

    // 再次 ping 应自动重建
    const result = await session.ping('127.0.0.1');
    assert(result.alive === true, 'ping works after auto-recreate');
    assert(session._session !== null, 'session recreated');
    session.close();
    // 恢复默认 keepAlive
    session.setConfig({ keepAlive: 10000 });
  });

  await test('defaultSession - close resets state', () => {
    session.close();
    assert(session._session === null, '_session is null');
    assert(session._timer === null, '_timer is null');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // createSession (手动实例) 测试
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── Callback 风格 ──────────────────────────────────────────────────────

  await test('pingHost callback - localhost', () => {
    return new Promise((resolve) => {
      const s = createSession({ timeout: 3000 });
      s.pingHost('127.0.0.1', (error, target, sent, rcvd) => {
        assert(!error, 'no error');
        assert(target === '127.0.0.1', 'target matches');
        assert(sent instanceof Date, 'sent is Date');
        assert(rcvd instanceof Date, 'rcvd is Date');
        assert(rcvd - sent >= 0, 'rtt >= 0');
        s.close();
        resolve();
      });
    });
  });

  await test('pingHost callback - timeout', () => {
    return new Promise((resolve) => {
      const s = createSession({ timeout: 500, retries: 0 });
      s.pingHost('10.255.255.1', (error, target) => {
        assert(error !== null, 'has error');
        assert(error instanceof PingTimeoutError, 'is PingTimeoutError');
        assert(target === '10.255.255.1', 'target matches');
        s.close();
        resolve();
      });
    });
  });

  // ─── Promise 风格 ───────────────────────────────────────────────────────

  await test('ping promise - single', async () => {
    const s = createSession();
    const result = await s.ping('127.0.0.1');
    assert(result.alive === true, 'alive');
    assert(result.time >= 0, 'time >= 0');
    assert(result.ttl > 0 || result.ttl === 0, 'has ttl');
    assert(typeof result.addr === 'string', 'has addr');
    s.close();
  });

  await test('ping promise - multiple (count=3)', async () => {
    const s = createSession();
    const result = await s.ping('127.0.0.1', { count: 3, interval: 100 });
    assert(result.alive === true, 'alive');
    assert(result.replies.length === 3, '3 replies');
    assert(result.min <= result.avg, 'min <= avg');
    assert(result.avg <= result.max, 'avg <= max');
    assert(result.packetLoss === 0, 'no packet loss');
    s.close();
  });

  await test('ping promise - timeout rejects', async () => {
    const s = createSession({ timeout: 500, retries: 0 });
    try {
      await s.ping('10.255.255.1');
      assert(false, 'should have thrown');
    } catch (err) {
      assert(err instanceof PingTimeoutError, 'is PingTimeoutError');
    }
    s.close();
  });

  // ─── Batch 风格 ─────────────────────────────────────────────────────────

  await test('pingBatch - multiple targets', async () => {
    const s = createSession({ timeout: 3000 });
    const results = await s.pingBatch(['127.0.0.1'], { count: 1 });
    assert(results instanceof Map, 'returns Map');
    assert(results.has('127.0.0.1'), 'has localhost result');
    const r = results.get('127.0.0.1');
    assert(r.alive === true, 'localhost alive');
    s.close();
  });

  // ─── 并发压测 ───────────────────────────────────────────────────────────

  await test('concurrent - 10 simultaneous pings', async () => {
    const s = createSession({ timeout: 3000 });
    const targets = Array(10).fill('127.0.0.1');
    const results = await Promise.all(targets.map((t) => s.ping(t)));
    assert(results.length === 10, '10 results');
    assert(results.every((r) => r.alive), 'all alive');
    s.close();
  });

  // ─── Session 生命周期 ───────────────────────────────────────────────────

  await test('session close - emits close event', () => {
    return new Promise((resolve) => {
      const s = createSession();
      s.on('close', () => {
        assert(true, 'close event emitted');
        resolve();
      });
      s.close();
    });
  });

  await test('session close - rejects pending', async () => {
    const s = createSession({ timeout: 5000 });
    const promise = s.ping('10.255.255.1');
    s.close();
    try {
      await promise;
      assert(false, 'should have rejected');
    } catch (err) {
      assert(err !== null, 'rejected after close');
    }
  });

  // ─── 错误类型导出 ───────────────────────────────────────────────────────

  await test('error classes exported correctly', () => {
    assert(typeof PingTimeoutError === 'function', 'PingTimeoutError exported');
    assert(typeof DestinationUnreachableError === 'function', 'DestinationUnreachableError exported');
    const err = new PingTimeoutError('1.2.3.4');
    assert(err instanceof Error, 'PingTimeoutError extends Error');
    assert(err.target === '1.2.3.4', 'has target property');
    assert(err.name === 'PingTimeoutError', 'has correct name');
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
