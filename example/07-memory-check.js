'use strict';

/**
 * 内存泄露验证
 *
 * 反复 ping 大量次数，观察内存是否持续增长。
 * 使用 createSession 手动管理（避免 keepAlive 干扰测试）。
 *
 * 运行：node --expose-gc example/07-memory-check.js
 */

const { createSession } = require('../index');

async function main() {
  const session = createSession({ timeout: 2000, retries: 0 });

  console.log('内存泄露检测：每轮 100 个并发 ping，共 10 轮\n');

  for (let round = 1; round <= 10; round++) {
    // 强制 GC（需要 --expose-gc 启动参数）
    if (global.gc) global.gc();

    const before = process.memoryUsage();

    // 并发 100 个 ping
    await Promise.all(
      Array(100)
        .fill('127.0.0.1')
        .map((t) => session.ping(t).catch(() => null))
    );

    if (global.gc) global.gc();

    const after = process.memoryUsage();
    const heapMB = (after.heapUsed / 1024 / 1024).toFixed(2);
    const pendingCount = session._pending.size;

    console.log(
      `  第 ${String(round).padStart(2)} 轮: ` +
        `heap=${heapMB}MB, ` +
        `pending=${pendingCount}, ` +
        `rss=${(after.rss / 1024 / 1024).toFixed(2)}MB`
    );
  }

  console.log('\n验证 pending Map 是否清空:', session._pending.size === 0 ? '✓ 已清空' : '✗ 有残留');
  session.close();

  console.log('\n如果 heap 在各轮之间保持稳定（波动 < 1MB），则无内存泄露。');
  console.log('如果线性增长，则存在泄露。');
}

main();
