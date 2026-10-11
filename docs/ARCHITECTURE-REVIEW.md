# API4Kiro 架构 Review 与改进建议

> 生成时间：2026-10-11
> 版本：4.13.65

## 总体架构

API4Kiro 是一个 **N 渠道聚合代理型 VS Code / Kiro 扩展**，核心设计是：

```
Kiro IDE → (端点重定向) → 本地代理 :19810/:19811 → (路由+翻译) → 多家上游 API
                                                    ↓
                                              本地用量账本
                                                    ↓
                                              侧边栏面板
```

**关键设计决策：**
- 零运行时 npm 依赖 - 所有功能用 Node 标准库实现
- 双端口分离 - KRS (19810) 运行时 + CPS (19811) 控制面
- Key 存系统钥匙串 - 设置文件只留占位符 `__API4KIRO_KEYCHAIN__`
- 严格 opt-in 模型列表 - 只把用户勾选的模型暴露给 Kiro

## 核心模块划分

| 模块 | 职责 | 关键文件 |
|------|------|----------|
| 宿主层 | 激活、命令、配置监听、端口管理 | extension.ts, endpoints.ts, portBinder.ts |
| 本地代理 | 承接 Kiro 请求、路由、重试 | krsServer.ts, cpsServer.ts |
| 协议翻译 | CW ↔ 4种上游协议 | translate.ts, openaiTranslate.ts, responsesTranslate.ts, geminiTranslate.ts |
| 流式处理 | SSE → CW 事件回写 | anthropicStream.ts, openaiStream.ts 等 |
| 凭证管理 | Key 池调度、冷却、OAuth | credentialPool.ts, providers.ts, oauth/ |
| 模型管理 | 聚合、路由表、上下文窗口 | modelStore.ts, contextWindow.ts |
| 用量账本 | 本地记账、趋势、Sankey | usageStore.ts, turnLedger.ts, contextParser.ts |
| UI 面板 | 4 页 Webview | sidebar.ts |
| Kiro 补丁 | 前端文件注入 | selectorStyle.ts |

## 值得肯定的架构特点

1. **协议抽象层设计良好** - 4 种上游协议通过统一的 translate/stream 模式接入，新增协议只需加一对文件
2. **Key 池状态机清晰** - 冷却机制（15/30min）区分了 auth/quota/ratelimit 不同失败类型
3. **补丁可逆性设计** - 所有 Kiro 前端补丁带 `a2k` 标记，原文 base64 随身携带
4. **多窗口协商机制** - portBinder + proxyIdentity 握手协议处理并发问题
5. **上下文六桶解析** - contextParser.ts 把输入 token 按成分无损分配，支撑 Sankey 可视化

---

## 改进建议

### 🚨 P0 - 短期：降低补丁层脆弱性

#### 1. 补丁版本化 + 降级策略

```typescript
// 建议：在 selectorStyle.ts 中引入补丁版本协商
interface PatchVersion {
  kiroVersion: string;     // "1.1.14" | "1.2.56"
  patchVariant: "v1" | "v2" | "v3";
  targetChunk: string;     // 识别用的内容指纹
}

const PATCH_REGISTRY: PatchVersion[] = [
  { kiroVersion: "1.2.56", patchVariant: "v2", targetChunk: "ModelOptionRow" },
  { kiroVersion: "1.1.14", patchVariant: "v1", targetChunk: "chat-input-popup-option" },
];
```

**好处：** 新 Kiro 版本发布时，只需注册新的 patch variant，不影响旧版本支持。

#### 2. 补丁验证纳入 CI（不依赖 Kiro 编译产物）

```bash
# 建议：用真实 Kiro 安装目录的只读副本做 snapshot 测试
npm run test:patch
# 步骤：
# 1. 从 CI runner 下载最新 Kiro
# 2. 对靶文件做结构命中测试
# 3. 断言补丁可注入 + 可还原
```

**替代方案：** 如果 CI 无法下载 Kiro，至少把验证脚本输出（命中的正则、匹配数量）作为 artifact 上传，人工审查。

#### 3. 补丁失败时更好的用户反馈

```typescript
// 当前：补丁漂移时静默跳过，用户看到原生外观
// 建议：在侧边栏显示"补丁未应用"横幅

if (patchStatus !== "applied") {
  showPatchStatusBanner({
    status: "unavailable",
    missingPackages: patchStatus.missing,
    suggestion: "重载窗口或升级 API4Kiro"
  });
}
```

### 🔧 P1 - 中期：降低配置复杂度

#### 4. 配置项分组 + 智能默认值

```typescript
// 建议：把 41 项配置分成用户可见 vs 高级 vs 内部
interface ConfigTier {
  basic: string[];     // enabled, providers, modelListStyle
  advanced: string[];  // effortMode, openaiThoughtDedupe, ...
  internal: string[];  // codewhisperer.config.*Endpoints
}

// 面板 UI 只展示 basic，高级选项藏在"高级设置"折叠区
```

#### 5. 配置向导

```typescript
// 建议：首次激活时弹出配置向导
// 步骤：选渠道 → 填 Key → 选模型 → 启用代理
// 避免用户直接面对 41 项配置
```

#### 6. 配置项影响分析

```typescript
// 建议：记录每个配置项的"影响范围"
const CONFIG_IMPACT = {
  "api2kiroDual.modelListStyle": "requiresReload",
  "api2kiroDual.effortMode": "immediate",
  "api2kiroDual.thinkingBudget": "immediate",
};

// 在面板里标注：哪些改完立即生效，哪些需要重载
```

### 📐 P2 - 中期：代码组织

#### 7. 协议翻译层的统一接口

```typescript
// 建议：定义统一的 ProtocolAdapter 接口
interface ProtocolAdapter {
  translateRequest(cwRequest: CWRequest): UpstreamRequest;
  translateStream(upstreamStream: Readable): AsyncIterable<CWEvent>;
  supportsThinking(): boolean;
  supportsImages(): boolean;
}

// 每个协议实现这个接口，而不是散落的 translate.ts/stream.ts 对
```

#### 8. 错误分类标准化

```typescript
// 建议：定义统一的 UpstreamError 类型
enum UpstreamErrorType {
  AUTH = "auth",           // 401
  QUOTA = "quota",         // 402
  FORBIDDEN = "forbidden", // 403
  NOT_FOUND = "not_found", // 404
  RATE_LIMIT = "rate_limit", // 429
  CONTEXT_OVERFLOW = "context_overflow",
  NETWORK = "network",
  UNKNOWN = "unknown"
}

// 所有协议翻译层都返回这个类型，credentialPool 统一处理
```

#### 9. 用量账本的存储抽象

```typescript
// 建议：把 globalState 存储抽象成接口
interface UsageStoreBackend {
  write(entry: UsageEntry): Promise<void>;
  readRange(start: Date, end: Date): Promise<UsageEntry[]>;
  aggregate(modelId: string): Promise<UsageSummary>;
}

// 未来可以轻松切换到 SQLite 或远程存储
```

### 🚀 P3 - 长期：扩展性

#### 10. 插件化的 Provider 支持

```typescript
// 建议：允许第三方通过 JSON manifest 注册新 provider
// 例如：{"id": "my-custom", "baseUrl": "...", "protocol": "openai"}
// 而不需要修改代码
```

#### 11. Webview 与后端通信的契约化

```typescript
// 建议：定义 Webview 消息的 TypeScript 类型
interface WebviewMessage {
  type: "provider-add" | "model-toggle" | "usage-query" | ...;
  payload: any;
}

// 用消息总线模式，而不是在 sidebar.ts 里硬编码
```

#### 12. 多用户配置隔离

```typescript
// 建议：支持按用户隔离配置（目前全部共享）
// 对团队共享工作区很有用
```

---

## 建议的实施顺序

```
第 1 周：  P0-1（补丁版本化）+ P0-2（CI 验证）
第 2-3 周： P1-4（配置分组）+ P2-7（统一接口）
第 4 周：  P1-5（配置向导）+ P2-8（错误分类）
持续：    P3-10（插件化 provider）
```

---

## ⚠️ 不建议改的部分

1. **零 npm 依赖策略** - 这是优点，不要引入运行时依赖
2. **双端口分离设计** - KRS/CPS 分离很合理
3. **Key 存钥匙串** - 安全性好，不要改
4. **严格 opt-in 模型列表** - 用户控制感强

---

## 潜在风险点回顾

| 风险 | 严重性 | 缓解措施 |
|------|--------|----------|
| Kiro 前端补丁脆弱 | 高 | P0-1, P0-2, P0-3 |
| 41 个配置项复杂 | 中 | P1-4, P1-5, P1-6 |
| 端点重定向单点故障 | 高 | 保持现状，文档说明 |
| 补丁验证不在 CI | 中 | P0-2 |
| 多窗口竞态 | 低 | 已有 portBinder 处理 |
