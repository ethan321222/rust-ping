'use strict';

/**
 * 并发压力测试：100 个并发 ping 共享 1 个 socket
 *
 * 演示单 socket 多路复用的高性能。
 * 使用默认 session + setConfig。
 *
 * 运行：node example/05-concurrent-100.js
 */

const { session } = require('../index');

async function main() {
  session.setConfig({ timeout: 5000, retries: 1 });

  // 生成 100 个目标（重复 localhost 用于测试）
  const targets = Array.from({ length: 100 }, () => '127.0.0.1');

  console.log(`并发 ${targets.length} 个 ping 请求（共享 1 个 socket）...\n`);
  const startTime = Date.now();

  const results = await Promise.all(
    targets.map((t) => session.ping(t, { count: 1 }))
  );

  const elapsed = Date.now() - startTime;
  const alive = results.filter((r) => r.alive).length;
  const times = results.filter((r) => r.alive).map((r) => r.time);
  const avgTime = times.reduce((a, b) => a + b, 0) / times.length;

  console.log(`结果:`);
  console.log(`  总请求: ${targets.length}`);
  console.log(`  成功:   ${alive}`);
  console.log(`  失败:   ${targets.length - alive}`);
  console.log(`  平均 RTT: ${avgTime.toFixed(2)}ms`);
  console.log(`  总耗时: ${elapsed}ms`);
  console.log(`\n  （对比 node-ping：100个进程 ≈ 几十秒）`);
  console.log(`  （本方案：1个socket ≈ 几百毫秒）`);

  session.close();
}

main();
