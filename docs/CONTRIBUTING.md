# 协作开发指南

本文档面向 rust-ping 的协作开发者，涵盖日常开发、测试、构建和发布流程。

## 环境准备

### 必需工具

| 工具 | 版本要求 | 用途 |
|------|---------|------|
| Node.js | >= 16 | JS 运行时 |
| Rust | stable (latest) | 编译原生模块 |
| @napi-rs/cli | ^2.18.0 | 构建 .node 文件 |

### 平台额外要求

| 平台 | 要求 |
|------|------|
| Windows | 管理员权限运行（ICMP raw socket 需要） |
| Linux | `sysctl net.ipv4.ping_group_range="0 2147483647"` 或 `sudo` |
| macOS | 无额外要求 |

### 首次克隆

```bash
git clone <repo-url>
cd rust-ping
npm install
```

## 项目结构

```
rust-ping/
├── index.js                 # JS 封装层（Session 类，不要手动修改 binding.js）
├── index.mjs                # ESM 入口
├── index.d.ts               # TypeScript 类型（手动维护）
├── binding.js               # ⚠️ napi-rs 自动生成的平台加载器
├── package.json
├── Cargo.toml               # Rust workspace 根
├── crates/
│   ├── ping-core/           # 纯 Rust 逻辑（ICMP、socket、超时）
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── icmp.rs      # ICMP 包构造/解析
│   │       ├── socket.rs    # 跨平台 socket
│   │       ├── session.rs   # PingSession 核心引擎
│   │       ├── error.rs     # 错误类型
│   │       ├── utils.rs     # 通用工具（checksum、DNS 等）
│   │       └── platform/    # 平台特化代码
│   └── ping-napi/           # napi-rs 绑定（薄层，调用 ping-core）
│       └── src/
│           └── lib.rs
├── __test__/                # 集成测试
├── example/                 # 使用示例
```

## 日常开发流程

### 1. 修改 Rust 代码

```bash
# 编辑 crates/ping-core/src/ 或 crates/ping-napi/src/ 下的文件
# 然后编译：
npm run build:debug    # 开发用，编译快，不优化
npm run build          # release 模式，用于最终测试
```

### 2. 修改 JS 封装层

直接编辑 `index.js`，无需重新编译 Rust。

### 3. 运行测试

```bash
npm test               # 运行集成测试（需要管理员/网络权限）
```

### 4. 手动验证

```bash
node example/02-promise.js      # 单次 ping
node example/04-batch.js        # 并发多目标
node example/05-concurrent-100.js  # 压测
node example/06-timeout-retry.js   # 超时重试
```

## 构建说明

### 命令解析

```bash
# debug 构建（快，适合开发迭代）
npm run build:debug
# 实际执行: napi build --platform --js binding.js --cargo-cwd crates/ping-napi

# release 构建（慢，有优化，用于发布）
npm run build
# 实际执行: napi build --platform --release --js binding.js --cargo-cwd crates/ping-napi
```

### 文件分层设计

napi-rs 默认会生成一个平台加载器到 `index.js`，这会和我们的 JS 封装层冲突。主流 napi-rs 项目（如 `@swc/core`、`@napi-rs/canvas`）的做法是把**自动生成的加载器和手写封装分离到不同文件**。

我们通过 `--js binding.js` 参数让 napi-rs 输出到 `binding.js` 而非 `index.js`：

```
binding.js   ← napi-rs 自动生成（平台加载器，每次 build 会覆盖，这是正常的）
index.js     ← 手写封装层（Session 类），require('./binding') 获取原生绑定
index.mjs    ← ESM 入口
```

**这个设计保证了：**
- `npm run build` 只会覆盖 `binding.js`（它本来就是自动生成的，覆盖无害）
- `index.js` 永远不会被构建命令触碰
- 开发者无需记忆任何"注意事项"，构建流程天然安全

**⚠️ 不要直接用 `npx napi build --platform ...`（不带 `--js binding.js`），那会覆盖 `index.js`。始终用 `npm run build`。**

### 构建产物

构建成功后根目录会出现平台对应的 `.node` 文件：

```
ping.win32-x64-msvc.node      # Windows x64
ping.darwin-arm64.node         # macOS Apple Silicon
ping.linux-x64-gnu.node        # Linux x64
```

这些文件已在 `.gitignore` 中，不要提交到 git。

## 测试规范

### 运行测试

```bash
npm test
```

测试需要网络访问和 ICMP 权限。在 Windows 上请用**管理员终端**运行。

### 测试覆盖范围

当前测试 (`__test__/ping.test.js`) 覆盖：

- Callback 风格（pingHost）
- Promise 单次 / 多次
- Batch 并发
- 超时和错误处理
- Session 生命周期（close 事件、reject pending）
- 并发压测（10 路）

### 新增功能时

1. 在 `__test__/ping.test.js` 中添加对应测试用例
2. 如果是新的调用模式，在 `example/` 中添加示例文件
3. 更新 `index.d.ts` 中的类型定义

### Rust 单元测试

```bash
cd crates/ping-core
cargo test
```

ping-core 有独立的单元测试（ICMP 包构造、checksum 计算、解析逻辑），不依赖网络。

## 发布流程

### 前置检查

```bash
# 1. 确保代码编译通过（零 warning）
npm run build

# 2. 运行测试
npm test

# 3. Rust 单元测试
cd crates/ping-core && cargo test && cd ../..

# 4. 检查打包内容
npm pack --dry-run
```

### 版本号

主包和所有平台子包版本号必须一致。修改版本时：

```bash
# 更新 package.json 中的 version
# 同时更新 optionalDependencies 中所有子包的版本号
```

### CI 发布（推荐）

正式发布应通过 CI 完成（GitHub Actions 矩阵构建所有平台），而非本地手动发布。参考 `PUBLISH.md` 中的 CI 配置。

### 本地发布（仅测试用）

```bash
# 只能发布当前平台的子包
npx napi prepublish --skip-gh-release
# 把 Rust 写的 Node 原生插件，按当前版本同步各平台子包的版本号、写好 optionalDependencies、并发布这些平台包到 npm，但不创建 GitHub Release。主要用于非 GitHub Actions 环境下的 napi-rs 项目发布。
npm publish
```

## 常见问题

### Q: 编译报错 `linker 'link.exe' not found`

Windows 需要安装 Visual Studio Build Tools，确保勾选 "C++ 桌面开发" 工作负载。

### Q: 运行时报错 `Access denied` 或 `Permission denied`

ICMP raw socket 需要权限：
- Windows: 用管理员终端
- Linux: 配置 `ping_group_range` 或用 `sudo`

### Q: `npm test` 部分用例超时失败

网络环境影响，某些外部 IP（如 `1.1.1.1`）在特定网络可能不通。本地超时不代表代码有 bug，检查是否是网络问题。


### Q: 修改了 Rust 代码但行为没变

确认执行了 `npm run build:debug` 或 `npm run build` 重新编译。JS 层缓存的是文件路径，不会自动感知 Rust 代码变化。

## 代码规范

### Rust 侧

- 通用工具逻辑放 `utils.rs`
- 平台特化代码放 `platform/` 目录，通过 `cfg` 条件编译
- 错误统一用 `thiserror` 定义在 `error.rs`
- ping-napi 是薄层，只做类型转换和 ThreadsafeFunction 桥接，业务逻辑在 ping-core

### JS 侧

- `index.js` 是唯一对外封装层，提供 `session`（默认实例）、`createSession`、`Session`、`DefaultSession`
- `binding.js` 由 napi-rs 生成，**不要手动修改**
- 错误类型（`PingTimeoutError`、`DestinationUnreachableError`）定义在 `index.js` 中并导出
- 类型定义手动维护在 `index.d.ts`（napi-rs 自动生成的 Native 类型 + 手写的 JS 层类型）

### 命名约定

- Rust: snake_case（标准 Rust 风格）
- JS: camelCase（标准 JS 风格）
- 文件名: kebab-case（平台文件除外）
