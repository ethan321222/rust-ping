# NPM 发布策略

## 背景

rust-ping 用 Rust 编写底层 ICMP 逻辑，通过 napi-rs 编译为 `.node` 原生二进制供 Node.js/Bun 调用。

项目在 Windows 上执行 `napi build` 后，根目录生成了 `ping.win32-x64-msvc.node`（约 1.2MB）。在考虑 `npm publish` 时自然产生了一个问题：

> **这个 `.node` 文件应该打包进 npm 吗？如果用户是 macOS 或 Linux 呢？**

答案是**不应该**。原生二进制是平台特定的 —— Windows 编译的 `.node` 在 macOS 上完全无法加载。如果把它塞进主包，macOS 用户会白白下载一个永远用不到的 1.2MB 文件；反过来，如果只打包 Windows 的二进制，macOS/Linux 用户安装后直接报错。

这就引出了原生模块发布的核心设计：**如何让不同平台的用户各自只下载自己需要的二进制？**

## 为什么不学 net-ping 让用户自己编译

net-ping 依赖 `raw-socket`，采用 `postinstall` 阶段调用 `node-gyp` 在用户机器上编译 C++ 源码。看似简单（不需要预编译多平台），实际上问题很多：

**net-ping 的方式：**
```
npm install net-ping
  → 下载源码
  → postinstall: node-gyp rebuild
  → 用户机器上现场编译 C++ → 生成 .node
```

**这个方案的痛点：**

| 问题 | 影响 |
|------|------|
| 用户必须有 C/C++ 编译工具链 | Windows 需要装 Visual Studio Build Tools（几 GB），macOS 需要 Xcode CLI，很多人没有 |
| Rust 工具链更重 | 如果我们也这样做，用户还得装 Rust + Cargo（~1GB），这比 C++ 工具链更不现实 |
| 安装耗时长 | Rust 编译一个 napi 项目需要 30 秒~2 分钟，C++ 也要十几秒，用户体验极差 |
| CI/CD 环境经常失败 | Docker alpine 没有编译器、AWS Lambda 构建层受限、GitHub Actions 缓存失效后重新编译 |
| node-gyp 本身不稳定 | Python 版本冲突、VS 版本不对、权限问题，是 Node.js 生态最大的痛点之一 |
| 无法交叉编译 | 用户在 x64 机器上无法为 ARM 部署环境构建 |

**net-ping 经常看到的 issue：**
```
gyp ERR! find VS msvs_version was set from command line or npm config
gyp ERR! find VS - willass for MSVS 2017
gyp ERR! find VS VCINSTALLDIR not set, not running in VS Command Prompt
```

**我们的方案：预编译 + 平台子包**
```
npm install rust-ping
  → 下载主包（20KB JS）
  → 下载当前平台子包（1.2MB 预编译 .node）
  → 完成，无编译步骤
```

| 对比 | net-ping (postinstall 编译) | rust-ping (预编译子包) |
|------|---------------------------|---------------------|
| 安装时间 | 30 秒~2 分钟 | 2~3 秒 |
| 用户前置依赖 | C++ 编译器 / Python | 无 |
| CI 环境兼容性 | 经常失败 | 100% 稳定 |
| 离线安装 | 不可能（需下载编译依赖） | 可以（.tgz 打包即可） |
| 安装成功率 | ~80%（因环境问题失败） | ~100% |

简而言之：**把编译的复杂度留给我们（CI 一次编译），而不是甩给每个用户。**

## 核心问题

rust-ping 是原生模块（`.node` 二进制），不同平台的编译产物完全不同：

| 平台 | 二进制文件 |
|------|-----------|
| Windows x64 | `ping.win32-x64-msvc.node` |
| macOS Intel | `ping.darwin-x64.node` |
| macOS Apple Silicon | `ping.darwin-arm64.node` |
| Linux x64 (glibc) | `ping.linux-x64-gnu.node` |
| Linux x64 (musl) | `ping.linux-x64-musl.node` |
| Linux ARM64 | `ping.linux-arm64-gnu.node` |

如果把所有平台的 `.node` 文件打进主包，用户会下载 ~7MB（6 个平台 × ~1.2MB），但实际只用到 1 个。

## 解决方案：平台子包 + optionalDependencies

napi-rs 社区的标准做法（与 `@swc/core`、`esbuild`、`@napi-rs/canvas` 一致）：

```
rust-ping                          ← 主包，纯 JS，~20KB
├── rust-ping-win32-x64-msvc       ← 各平台子包，只含 .node
├── rust-ping-darwin-x64
├── rust-ping-darwin-arm64
├── rust-ping-linux-x64-gnu
├── rust-ping-linux-x64-musl
└── rust-ping-linux-arm64-gnu
```

### 工作原理

1. 主包 `package.json` 的 `optionalDependencies` 列出所有平台包
2. `npm install` 时，npm 只安装与当前平台匹配的那个 optional 包（其余跳过）
3. `binding.js`（napi-rs 自动生成的加载器）按 `process.platform` + `process.arch` 选择 require 对应的包

```
用户在 macOS ARM 执行 npm install rust-ping：
  → 下载 rust-ping（主包，20KB）
  → 下载 rust-ping-darwin-arm64（平台包，1.2MB）
  → 跳过其他 5 个平台包
  → 总下载量：~1.2MB
```

## 主包内容

```
rust-ping/
├── index.js        Session 封装（callback / promise / batch）
├── index.mjs       ESM 入口
├── index.d.ts      TypeScript 类型定义
├── binding.js      平台加载器（napi-rs 生成，按 os/arch require 对应子包）
├── package.json
└── README.md
```

通过 `package.json` 的 `files` 字段精确控制：

```json
{
  "files": [
    "index.js",
    "index.mjs",
    "index.d.ts",
    "binding.js",
    "binding.d.ts"
  ]
}
```

**不进主包的：**
- `*.node` — 二进制走平台子包
- `crates/` — Rust 源码
- `Cargo.toml` / `Cargo.lock` — Rust 工作区配置
- `target/` — 编译产物
- `__test__/` — 测试
- `example/` — 示例
- `docs/` — 内部文档（DESIGN.md / RESEARCH.md / PUBLISH.md 等）
- `.github/` — CI 配置

## 平台子包结构

每个子包极简，只包含一个 `.node` 文件：

```
rust-ping-darwin-arm64/
├── package.json
└── ping.darwin-arm64.node
```

子包的 `package.json`：

```json
{
  "name": "rust-ping-darwin-arm64",
  "version": "1.0.0",
  "os": ["darwin"],
  "cpu": ["arm64"],
  "main": "ping.darwin-arm64.node",
  "files": ["ping.darwin-arm64.node"]
}
```

`os` 和 `cpu` 字段告诉 npm：这个包只适用于指定平台，其他平台跳过。

## 构建输出与文件分层设计

### 问题：napi-rs 默认覆盖 index.js

napi-rs 的 `napi build --platform` 命令默认行为：
1. 编译 Rust → 生成 `.node` 二进制
2. **自动生成 `index.js`** — 平台加载器（按 os/arch require 对应的 `.node`）
3. **自动生成 `index.d.ts`** — 导出原生层类型

这个默认行为导致一个严重问题：我们的 `index.js` 是手写的 Session 封装层（callback / promise / batch），每次构建都会被 napi-rs 生成的加载器覆盖。

### 主流项目怎么解决

| 项目 | 方案 |
|------|------|
| `@swc/core` | 生成的加载器和手写封装分离到不同文件 |
| `@napi-rs/canvas` | `--js` 参数指定生成文件名 |
| `esbuild` | 不用 napi-rs，自己写加载逻辑 |
| `@parcel/css` | wrapper 在独立文件，main 指向 wrapper |

核心思路一致：**把自动生成的代码和手写代码物理隔离，消除覆盖风险。**

### 我们的方案

通过 `--js binding.js` 参数，让 napi-rs 输出加载器到 `binding.js` 而非 `index.js`：

```json
{
  "scripts": {
    "build": "napi build --platform --release --js binding.js --dts binding.d.ts --cargo-cwd crates/ping-napi",
    "build:debug": "napi build --platform --js binding.js --dts binding.d.ts --cargo-cwd crates/ping-napi"
  }
}
```

文件职责明确分层：

```
binding.js   ← napi-rs 自动生成（每次 build 覆盖，正常且无害）
             │  职责：按 process.platform + process.arch 加载对应 .node 文件
             │  导出：NativePingSession（原生类）
             │
index.js     ← 手写封装层（永远不会被构建命令触碰）
             │  职责：Session 类 + createSession() + 错误类型
             │  依赖：require('./binding') 获取 NativePingSession
             │
index.mjs    ← ESM 入口
             │  职责：re-export index.js 的所有导出
             │
index.d.ts   ← 类型定义（napi-rs 自动生成的 Native 类型 + 手写的 JS 层类型）
                职责：NativePingSession / Session / PingResult / PingStats 等完整类型
```

### 为什么这个设计优于"靠文档警告"

| 方案 | 安全性 | 开发者心智负担 |
|------|--------|--------------|
| 文档警告"构建后检查 index.js" | 依赖人的记忆力 | 每次构建都要想一下 |
| `--js false` 跳过生成 | 安全，但新平台支持时需手动更新 binding | 需要理解何时该重新生成 |
| **`--js binding.js`（本方案）** | 天然安全 | 零负担，`npm run build` 就够了 |

开发者只需要记一个规则：**用 `npm run build`，不要直接调 `npx napi build`。**

## binding.js 加载逻辑

napi-rs 自动生成的 `binding.js` 核心逻辑：

```js
switch (platform) {
  case 'win32':
    switch (arch) {
      case 'x64':
        // 优先尝试本地文件（开发时）
        nativeBinding = require('./ping.win32-x64-msvc.node')
        // 回退到 npm 包（发布后）
        nativeBinding = require('rust-ping-win32-x64-msvc')
        break
      case 'arm64':
        nativeBinding = require('rust-ping-win32-arm64-msvc')
        break
    }
    break
  case 'darwin':
    switch (arch) {
      case 'x64':
        nativeBinding = require('rust-ping-darwin-x64')
        break
      case 'arm64':
        nativeBinding = require('rust-ping-darwin-arm64')
        break
    }
    break
  case 'linux':
    // 还需区分 glibc vs musl
    ...
}
```

**双重查找策略：**
1. 先找本地 `./ping.xxx.node` 文件（开发/测试用）
2. 找不到再 require npm 子包名（生产环境）

这样开发者本地 `napi build` 后直接可用，发布后用户通过 npm 子包加载。

## CI 发布流程

完整配置见 `.github/workflows/ci.yml`。

### 流水线结构

```
push/PR → Build (6 平台并行) → Test (3 平台) → Publish (仅 tag)
```

| 阶段 | 触发条件 | 做什么 |
|------|---------|--------|
| Build | 每次 push/PR | 6 个平台矩阵编译，上传 `.node` 产物 |
| Test | Build 完成后 | 下载产物，跑集成测试 + Rust 单元测试 |
| Publish | 推送 `v*` tag | 下载所有产物 → napi prepublish → npm publish |

### 矩阵构建（6 个平台）

```yaml
matrix:
  include:
    - os: windows-latest    target: x86_64-pc-windows-msvc
    - os: macos-latest      target: x86_64-apple-darwin
    - os: macos-latest      target: aarch64-apple-darwin
    - os: ubuntu-latest     target: x86_64-unknown-linux-gnu
    - os: ubuntu-latest     target: x86_64-unknown-linux-musl
    - os: ubuntu-latest     target: aarch64-unknown-linux-gnu
```

每个 job 产出一个 `ping.<platform>.node` 文件，通过 `upload-artifact` 传递给下游。

### 发布触发方式

```bash
# 1. 更新 package.json 版本号
npm version patch  # 或 minor / major，自动修改 package.json 并创建 commit

# 2. 打 tag
git tag v1.0.0

# 3. 推送代码和 tag
git push origin main --tags

# 4. CI 自动：Build → Test → Publish 到 npm
```

**`git push origin main --tags` vs `git push origin v1.0.0` 的区别：**

| 命令 | 推送内容 | 适用场景 |
|------|---------|---------|
| `git push origin main --tags` | 代码 + 所有本地 tag | 推荐：一次性把代码和 tag 都推上去，CI 能拿到最新代码 |
| `git push origin v1.0.0` | 仅这一个 tag | 风险：如果忘了先 `git push` 代码，CI checkout 到的是旧代码，发布的是旧版本 |

推荐始终用 `git push origin main --tags`，避免代码和 tag 不同步。

### 需要配置的 Secret

CI 发布**不需要你的 npm 密码**，用的是 Access Token（专为自动化设计的令牌）。

**获取 NPM_TOKEN：**

1. 登录 [npmjs.com](https://www.npmjs.com)
2. 头像 → Access Tokens → Generate New Token
3. 选择 **Automation** 类型（专为 CI 设计，不受 2FA 限制）
4. 复制生成的 token

**配置到 GitHub：**

1. 仓库 Settings → Secrets and variables → Actions
2. 点 "New repository secret"
3. Name 填 `NPM_TOKEN`，Value 粘贴 token
4. Save

CI 中通过手动写 `.npmrc` 注入 token：

```yaml
env:
  NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

```bash
echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" >> ~/.npmrc
```

> **推荐改进：** 更主流的做法是配合 `setup-node` 的 `registry-url` 参数，使用 `NODE_AUTH_TOKEN` 环境变量，无需手动写 `.npmrc`：
>
> ```yaml
> - uses: actions/setup-node@v7
>   with:
>     node-version: 24
>     registry-url: https://registry.npmjs.org
>
> - run: npm publish --access public
>   env:
>     NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
> ```
>
> 这种方式由 `setup-node` 自动生成 `.npmrc`，更简洁且不易出错。

**安全说明：**
- Token 只在 GitHub Actions 的加密环境中使用，日志中不会打印
- 可随时在 npmjs.com 上撤销（Access Tokens → Delete）
- 建议为每个项目单独生成 token，出问题时只撤销一个

### 平台特殊处理

| 平台 | 额外依赖 |
|------|---------|
| linux-musl | `musl-tools`（apt 安装） |
| linux-arm64 | `gcc-aarch64-linux-gnu`（交叉编译器） |
| Windows/macOS | 无额外依赖 |

### 发布产物

CI 完成后 npm 上会出现：

```
rust-ping@1.0.0                    ← 主包（JS 代码）
rust-ping-win32-x64-msvc@1.0.0    ← 平台子包
rust-ping-darwin-x64@1.0.0
rust-ping-darwin-arm64@1.0.0
rust-ping-linux-x64-gnu@1.0.0
rust-ping-linux-x64-musl@1.0.0
rust-ping-linux-arm64-gnu@1.0.0
```

同时创建 GitHub Release，附带所有 `.node` 二进制文件。

## 本地开发 vs 发布的区别

| 场景 | .node 文件来源 | binding.js 行为 |
|------|---------------|----------------|
| 本地开发 | `napi build` 生成在根目录 | require(`./ping.win32-x64-msvc.node`) |
| npm 安装 | 在 `node_modules/rust-ping-xxx/` | require(`rust-ping-win32-x64-msvc`) |

两种场景 `binding.js` 都能正确处理，开发者和用户无感知差异。

## 版本同步

主包和所有平台子包必须**同步发版**，版本号一致：

```json
// 主包
{
  "version": "1.0.0",
  "optionalDependencies": {
    "rust-ping-win32-x64-msvc": "1.0.0",
    "rust-ping-darwin-x64": "1.0.0",
    "rust-ping-darwin-arm64": "1.0.0",
    "rust-ping-linux-x64-gnu": "1.0.0",
    "rust-ping-linux-x64-musl": "1.0.0",
    "rust-ping-linux-arm64-gnu": "1.0.0"
  }
}

// 子包
{
  "name": "rust-ping-darwin-arm64",
  "version": "1.0.0"
}
```

CI 通过 `napi create-npm-dir` + `napi artifacts` + `sed` 手动同步版本号，而非使用 `napi prepublish` / `napi publish` 一站式命令，以获得更细粒度的控制（容错、npmrc 配置、provenance 等）。

> **补充：`napi prepublish` / `napi publish`**
>
> 这是 napi-rs CLI 提供的一站式发布命令：
> - `napi prepublish`：创建 `npm/<platform>/` 目录 + 从 `artifacts/` 移动 `.node` 文件（由各平台 build job 编译后通过 GitHub Actions artifacts 下载得到）+ 自动同步版本号，一条命令完成三步
> - `napi publish`：遍历 `npm/*/` 逐个 `npm publish` 子包，再发布主包
>
> 等价于我们 CI 中手写的 `create-npm-dir` → `artifacts` → `sed` → `for` 循环发布的全部逻辑，只是封装成了黑盒。

## 对比其他方案

| 方案 | 优点 | 缺点 |
|------|------|------|
| **所有 .node 打进主包** | 简单 | 用户下载 8MB 只用 1MB |
| **postinstall 脚本编译** | 不需预编译 | 用户需要 Rust 工具链，安装慢 |
| **平台子包 (本方案)** | 下载量最小，安装快 | CI 配置稍复杂 |
| **CDN 下载 (node-pre-gyp)** | 灵活 | 依赖外部服务，可能被墙 |

平台子包是 2024+ 原生模块的主流做法，npm 原生支持 `os`/`cpu` 过滤，不依赖任何外部服务。

## Electron 中使用

rust-ping 可以直接在 Electron 中使用，且**无需针对 Electron 重新编译**。

### 为什么不需要 electron-rebuild（重要澄清）

> **常见误解：** "原生模块发布到 npm 后，Electron 环境还是要重新编译。"
>
> 这个说法对**传统 native addon（node-gyp / NAN）是对的**，但对 **N-API 模块（napi-rs）不适用**。

#### 传统方案为什么需要重编译

传统 native addon 直接链接 V8 引擎和 Node.js 内部头文件，编译时绑定了特定的 **Node.js ABI 版本号**：

```
Node.js v18.17  → ABI 108
Node.js v20.9   → ABI 115
Electron 28     → 内置 Node 18.17，但 ABI 号是 Electron 自己的 "electron.abi"
```

同一个 `.node` 文件，在纯 Node.js 能正常加载，放到 Electron 里直接 crash：

```
编译时:  gcc/cl → 链接 Node v18 的 V8 头文件 → 生成 addon.node (ABI=108)
Node.js: dlopen(addon.node) → ABI=108 ✓ → 正常运行
Electron: dlopen(addon.node) → ABI≠electron.abi → 💥 symbol mismatch → crash
```

所以传统项目（如 `better-sqlite3`、`sharp` 旧版、`node-sass`）需要 `electron-rebuild` 或 `@electron/rebuild` 针对 Electron 的 ABI 重新编译。

#### N-API 为什么不需要

N-API 是 Node.js 官方在 2017 年引入的 **ABI 稳定抽象层**，设计目标就是 "compile once, run anywhere"：

```
传统:    你的代码 → V8 API (不稳定) → 绑定特定 ABI → 换版本就炸
N-API:   你的代码 → N-API 稳定层 → 任何支持该版本的运行时都能加载
```

**技术原理：**
- N-API 定义了一组 C 函数指针表（类似 vtable），版本号独立于 Node.js 版本
- `.node` 文件只依赖 N-API version（如 version 9），不依赖 V8 ABI
- 运行时（Node.js / Electron / Bun）加载时通过函数指针表桥接，不关心内部 V8 版本
- 这就是为什么同一个 `.node` 可以在 Node 18、Node 22、Electron 25-33 上都能跑

**Electron 官方文档明确说明：**

> Native Node.js modules are supported by Electron, but since Electron has a different application binary interface (ABI) from a given Node.js binary, you will need to manually specify the Electron headers when building native modules. **However, modules that use Node-API don't need to be recompiled, because the ABI is stable across Node.js and Electron versions.**
>
> — [Electron Docs: Using Native Node Modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)

#### rust-ping 的具体保证

我们的 `crates/ping-napi/Cargo.toml`：

```toml
napi = { version = "2", features = ["napi9"] }
```

这意味着：
- 编译产物只依赖 N-API version 9
- 任何支持 N-API 9 的运行时都可以直接加载

支持矩阵：

| 运行时 | 最低版本 | 是否需要重编译 |
|--------|---------|--------------|
| Node.js | >= 18.17 | 不需要 |
| Electron | >= 25 | **不需要** |
| Bun | >= 1.0 | 不需要 |

#### 一图总结

```
┌─── 传统 native addon (node-gyp / NAN) ───┐
│                                            │
│  编译 → 绑定 Node v18 ABI 108             │
│                                            │
│  Node.js v18: ✓                            │
│  Node.js v20: ✗ (ABI 115, 需要重编译)      │
│  Electron 28: ✗ (ABI 不同, 需要 rebuild)   │
│  Bun:         ✗ (完全不兼容)               │
│                                            │
└────────────────────────────────────────────┘

┌─── N-API addon (napi-rs) ← 我们用的 ─────┐
│                                            │
│  编译 → 绑定 N-API version 9 (稳定层)      │
│                                            │
│  Node.js v18+:  ✓ 直接加载                 │
│  Node.js v22+:  ✓ 直接加载                 │
│  Electron 25+:  ✓ 直接加载                 │
│  Electron 33+:  ✓ 直接加载                 │
│  Bun 1.0+:      ✓ 直接加载                 │
│                                            │
│  同一个 .node 文件，零重编译               │
│                                            │
└────────────────────────────────────────────┘
```

**结论：rust-ping 发布到 npm 的预编译 `.node` 文件，在 Electron 中可以直接使用，不需要任何额外的编译步骤。这是选择 napi-rs 的核心收益之一。**

### 使用限制

| 事项 | 说明 |
|------|------|
| 只能在主进程使用 | ICMP socket 需要系统权限，渲染进程的沙箱无法创建原始套接字 |
| 渲染进程通过 IPC 调用 | preload 暴露接口，renderer 通过 `ipcRenderer.invoke` 间接调用 |
| 打包需要 asarUnpack | `.node` 文件不能压进 asar 归档，需要解压到文件系统供 `dlopen` 加载 |
| Windows 仍需管理员权限 | Electron 应用需要以管理员身份运行（可在 manifest 中声明） |

### 代码示例

```js
// ─── main.js（主进程）─────────────────────────────────────
const { ipcMain } = require('electron');
const { createSession } = require('rust-ping');

const session = createSession({ timeout: 3000 });

// 暴露 ping 能力给渲染进程
ipcMain.handle('ping', async (event, target) => {
  return session.ping(target);
});

ipcMain.handle('ping-batch', async (event, targets) => {
  const results = await session.pingBatch(targets);
  // Map 不能直接序列化，转为对象
  return Object.fromEntries(results);
});

app.on('before-quit', () => {
  session.close();
});
```

```js
// ─── preload.js ──────────────────────────────────────────
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nativePing', {
  ping: (target) => ipcRenderer.invoke('ping', target),
  pingBatch: (targets) => ipcRenderer.invoke('ping-batch', targets),
});
```

```js
// ─── renderer.js（渲染进程）───────────────────────────────
// 通过 preload 暴露的安全接口调用
const result = await window.nativePing.ping('8.8.8.8');
console.log(`${result.addr}: ${result.time}ms`);

const batch = await window.nativePing.pingBatch(['8.8.8.8', '1.1.1.1']);
console.log(batch);
```

### electron-builder 打包配置

```json
{
  "build": {
    "asarUnpack": [
      "node_modules/rust-ping-*/**/*.node"
    ]
  }
}
```

**为什么需要 `asarUnpack`：**

Electron 默认把 `node_modules` 打包成 asar 归档（一种只读压缩包）。但 `.node` 文件是动态链接库，操作系统需要通过 `dlopen()` 直接加载磁盘上的文件，无法从 asar 内部加载。`asarUnpack` 告诉打包工具把匹配的文件解压到 `app.asar.unpacked/` 目录，Electron 运行时会自动从解压目录加载。

### 对比传统方案

| 对比项 | net-ping (node-gyp) | rust-ping (napi-rs) |
|--------|--------------------|--------------------|
| Electron 兼容 | 需要 electron-rebuild | 直接可用 |
| 编译依赖 | VS Build Tools + Python | 无 |
| Electron 升级时 | 可能需要重新编译 | 无需任何操作 |
| 打包体积 | 类似 | 类似 |
| 稳定性 | ABI 可能断裂 | N-API 保证稳定 |

# 本地验证发布流程

在推送 CI 之前，可以在本地验证发布逻辑是否正确。

## 方式一：简单验证（快速检查）

验证 `napi create-npm-dir` 能否正常创建目录结构：

```bash
# 1. 创建 npm 目录结构
npx napi create-npm-dir -t .

# 2. 直接拷贝 .node 文件到对应目录
cp ping.win32-x64-msvc.node npm/win32-x64-msvc/

# 3. 验证目录结构和文件
ls -la npm/*/
cat npm/win32-x64-msvc/package.json

# 4. dry-run 发布
npm publish npm/win32-x64-msvc/ --dry-run

# 5. 清理
rm -rf npm/
```

## 方式二：模拟 CI 完整流程

完整模拟 CI 的 build → artifacts → publish 流程：

```bash
# 1. 构建当前平台的 .node 文件
npm run build

# 2. 模拟 CI 的 artifacts 目录结构
mkdir -p artifacts/bindings-x86_64-pc-windows-msvc
cp ping.win32-x64-msvc.node artifacts/bindings-x86_64-pc-windows-msvc/

# 3. 创建 npm 目录结构
npx napi create-npm-dir -t .

# 4. 移动 .node 文件到对应目录
npx napi artifacts

# 5. 同步平台子包版本号（与主包一致）
VERSION=$(node -p "require('./package.json').version")
for pkg in npm/*/package.json; do
  sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" "$pkg"
done

# 6. 验证目录结构
ls -la npm/*/
cat npm/win32-x64-msvc/package.json

# 7. dry-run 发布平台子包
npm publish npm/win32-x64-msvc/ --dry-run

# 8. dry-run 发布主包
npm publish --dry-run

# 9. 清理
rm -rf npm/ artifacts/
```

**关键命令说明：**

| 命令 | 作用 |
|------|------|
| `npx napi create-npm-dir -t .` | 创建 `npm/<platform>/` 目录和 `package.json` |
| `npx napi artifacts` | 从 `artifacts/` 复制 `.node` 文件到 `npm/<platform>/` |
| `npm publish --dry-run` | 模拟发布，检查打包内容但不真正上传 |

## Artifacts 机制：跨 Job 传递文件

CI 的 build 和 publish 是**不同的 job**，运行在**不同的机器**上。artifacts 是 GitHub Actions 的临时存储，用于在不同 job 之间传递文件。

```
Job 1: Build (Windows)    → 生成 ping.win32-x64-msvc.node → 上传到 GitHub
Job 2: Build (macOS)      → 生成 ping.darwin-arm64.node   → 上传到 GitHub
Job 3: Build (Linux)      → 生成 ping.linux-x64-gnu.node  → 上传到 GitHub
          ↓
Job 4: Publish (Ubuntu)   → 下载所有 artifacts → 发布到 npm
```

**上传（Build job）：**
```yaml
- name: Upload artifact
  uses: actions/upload-artifact@v7
  with:
    name: bindings-x86_64-pc-windows-msvc
    path: "*.node"
```

**下载（Publish job）：**
```yaml
- name: Download all artifacts
  uses: actions/download-artifact@v8
  with:
    path: artifacts  # 下载到 artifacts/ 目录
```

下载后的目录结构：
```
artifacts/
├── bindings-x86_64-pc-windows-msvc/
│   └── ping.win32-x64-msvc.node
├── bindings-aarch64-apple-darwin/
│   └── ping.darwin-arm64.node
└── bindings-x86_64-unknown-linux-gnu/
    └── ping.linux-x64-gnu.node
```

**Publish job 的处理流程：**
1. `npx napi create-npm-dir -t .` — 创建 `npm/<platform>/` 目录和 `package.json`
2. 同步平台子包版本号 — 将主包版本写入各 `npm/*/package.json`
3. `npx napi artifacts` — 从 `artifacts/` 复制 `.node` 文件到 `npm/<platform>/`
4. `npm publish npm/*/` — 发布平台子包
5. `npm publish` — 发布主包

