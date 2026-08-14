'use strict';

/**
 * DefaultSession 完整用法演示
 *
 * 展示默认 session 的懒加载、setConfig、keepAlive 自动关闭与重建。
 *
 * 运行：node example/08-default-session.js
 */

const { session } = require('../index');

async function main() {
  // ─── 1. 直接用，无需 createSession ─────────────────────
  console.log('=== 1. 直接使用默认 session ===\n');

  const r1 = await session.ping('127.0.0.1');
  console.log(`  127.0.0.1: ${r1.time}ms (session 懒加载创建)\n`);

  // ─── 2. 手动 close → 重新配置 ─────────────────────────
  console.log('=== 2. close 后 setConfig ===\n');

  session.close();
  session.setConfig({ timeout: 5000, retries: 2, keepAlive: 2000 });
  console.log('  已设置 timeout=5000, retries=2, keepAlive=2000ms');

  const r2 = await session.ping('127.0.0.1');
  console.log(`  127.0.0.1: ${r2.time}ms (用新参数自动重建)\n`);

  // ─── 3. setConfig 激活时会报错 ─────────────────────────
  console.log('=== 3. setConfig 激活时报错 ===\n');

  try {
    session.setConfig({ timeout: 1000 });
  } catch (err) {
    console.log(`  预期错误: ${err.message}\n`);
  }

  // ─── 4. 等待 keepAlive 自动关闭 ────────────────────────
  console.log('=== 4. 等待 keepAlive 自动关闭 ===\n');
  console.log('  等待 2.5 秒...');

  await new Promise((resolve) => setTimeout(resolve, 2500));
  console.log(`  session 已自动关闭: ${session._session === null}\n`);

  // ─── 5. 自动关闭后可重新配置并使用 ────────────────────
  console.log('=== 5. 自动关闭后重新配置 ===\n');

  session.setConfig({ timeout: 1000, retries: 0, keepAlive: 10000 });
  console.log('  已设置 timeout=1000, keepAlive=10000ms');

  const r3 = await session.ping('127.0.0.1');
  console.log(`  127.0.0.1: ${r3.time}ms (新配置生效)\n`);

  // ─── 清理 ─────────────────────────────────────────────
  session.close();
  console.log('=== 完成 ===');
}

main();
