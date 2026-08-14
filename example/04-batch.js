'use strict';

/**
 * Batch 风格：并发 ping 多个目标
 *
 * 使用默认 session。
 *
 * 运行：node example/04-batch.js
 */

const { session } = require('../index');

async function main() {
  const targets = [
    '8.8.8.8',       // Google DNS
    '1.1.1.1',       // Cloudflare DNS
    '114.114.114.114', // 国内 DNS
    '208.67.222.222',  // OpenDNS
    '9.9.9.9',       // Quad9
  ];

  console.log(`并发 ping ${targets.length} 个目标...\n`);
  const startTime = Date.now();

  const results = await session.pingBatch(targets, { count: 1 });

  const elapsed = Date.now() - startTime;

  // 打印结果
  results.forEach((result, target) => {
    if (result.alive) {
      console.log(`  ${target.padEnd(18)} alive  ${result.time}ms`);
    } else {
      console.log(`  ${target.padEnd(18)} dead   ${result.error || 'timeout'}`);
    }
  });

  console.log(`\n总耗时: ${elapsed}ms（并发执行，不是串行）`);

  session.close();
}

main();
