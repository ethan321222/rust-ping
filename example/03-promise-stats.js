'use strict';

/**
 * Promise 风格：多次 ping 带统计
 *
 * 使用默认 session + setConfig 自定义参数。
 *
 * 运行：node example/03-promise-stats.js
 */

const { session } = require('../index');

async function main() {
  session.setConfig({ timeout: 3000, retries: 2 });

  console.log('Ping 8.8.8.8, count=5, interval=500ms ...\n');

  const result = await session.ping('8.8.8.8', {
    count: 5,
    interval: 500,
  });

  // 逐条打印回复
  result.replies.forEach((reply) => {
    console.log(
      `  seq=${reply.seq} addr=${reply.addr} time=${reply.time}ms ttl=${reply.ttl}`
    );
  });

  // 打印统计
  console.log('\n--- 统计 ---');
  console.log(`  发送: 5, 接收: ${result.replies.length}, 丢包: ${result.packetLoss * 100}%`);
  console.log(`  RTT min/avg/max = ${result.min}/${result.avg}/${result.max} ms`);

  session.close();
}

main();
