'use strict';

/**
 * 超时和重试演示
 *
 * ping 一个不存在的 IP，展示超时和重试行为。
 * 使用 createSession 自定义实例（不同测试需要不同配置）。
 *
 * 运行：node example/06-timeout-retry.js
 */

const { createSession, PingTimeoutError } = require('../index');

async function main() {
  console.log('=== 测试一：快速超时，无重试 ===\n');
  {
    const session = createSession({ timeout: 500, retries: 0 });
    const start = Date.now();

    try {
      await session.ping('10.255.255.1');
    } catch (err) {
      const elapsed = Date.now() - start;
      console.log(`  错误类型: ${err.constructor.name}`);
      console.log(`  消息: ${err.message}`);
      console.log(`  耗时: ${elapsed}ms（≈ timeout 500ms）`);
    }

    session.close();
  }

  console.log('\n=== 测试二：超时 + 2次重试 ===\n');
  {
    const session = createSession({ timeout: 500, retries: 2 });
    const start = Date.now();

    try {
      await session.ping('10.255.255.1');
    } catch (err) {
      const elapsed = Date.now() - start;
      console.log(`  错误类型: ${err.constructor.name}`);
      console.log(`  消息: ${err.message}`);
      console.log(`  耗时: ${elapsed}ms（≈ timeout × (1 + retries) = 1500ms）`);
      console.log(`  解释: 第1次超时后重试2次，共等待 3 × 500ms`);
    }

    session.close();
  }

  console.log('\n=== 测试三：区分错误类型 ===\n');
  {
    const session = createSession({ timeout: 2000, retries: 0 });

    const targets = ['127.0.0.1', '10.255.255.1'];

    for (const target of targets) {
      try {
        const result = await session.ping(target);
        console.log(`  ${target}: ✓ alive (${result.time}ms)`);
      } catch (err) {
        if (err instanceof PingTimeoutError) {
          console.log(`  ${target}: ✗ 超时 (PingTimeoutError)`);
        } else {
          console.log(`  ${target}: ✗ ${err.constructor.name}: ${err.message}`);
        }
      }
    }

    session.close();
  }
}

main();
