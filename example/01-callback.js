'use strict';

/**
 * 基础用法：Callback 风格（兼容 net-ping）
 *
 * 使用默认 session，无需手动创建/关闭。
 *
 * 运行：node example/01-callback.js
 */

const { session } = require('../index');

const targets = ['127.0.0.1', '8.8.8.8', '1.1.1.1'];

let completed = 0;

targets.forEach((target) => {
  session.pingHost(target, (error, target, sent, rcvd) => {
    if (error) {
      console.log(`${target}: ${error.message}`);
    } else {
      const ms = rcvd - sent;
      console.log(`${target}: alive, RTT=${ms}ms`);
    }

    completed++;
    if (completed === targets.length) {
      session.close();
    }
  });
});
