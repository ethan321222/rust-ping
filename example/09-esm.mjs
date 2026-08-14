/**
 * ESM 用法示例
 *
 * 演示 import 方式使用 rust-ping，适用于 Node.js 14+ 和 Bun。
 *
 * 运行：node example/09-esm.mjs
 */

import { session } from '../index.mjs';

async function main() {
  // 单次 ping
  const result = await session.ping('google.com');
  console.log('单次 ping:');
  console.log(`  ${result.host} (${result.addr}): ${result.time}ms, TTL=${result.ttl}`);

  // 批量并发 ping
  const targets = ['8.8.8.8', '1.1.1.1', '223.5.5.5'];
  const results = await session.pingBatch(targets);

  console.log('\n批量 ping:');
  for (const [target, r] of results) {
    console.log(`  ${target}: ${r.alive ? r.time + 'ms' : 'dead'}`);
  }

  session.close();
}

main();
