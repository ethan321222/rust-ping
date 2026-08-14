'use strict';

/**
 * Promise 风格：async/await 单次 ping
 *
 * 使用默认 session，keepAlive 到期后自动关闭。
 *
 * 运行：node example/02-promise.js
 */

const { session } = require('../index');

async function main() {
  try {
    const result = await session.ping('baidu.com');
    console.log('单次 ping 结果:');
    console.log(`  主机: ${result.host}`);
    console.log(`  地址: ${result.addr}`);
    console.log(`  存活: ${result.alive}`);
    console.log(`  延迟: ${result.time}ms`);
    console.log(`  TTL:  ${result.ttl}`);
    console.log(`  字节: ${result.bytes}`);
  } catch (err) {
    console.error('Ping 失败:', err.message);
  }

  session.close();
}

main();
