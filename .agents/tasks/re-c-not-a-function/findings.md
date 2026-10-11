# `re.c is not a function` 调查结论

## 根因

4.13.64 的 Context Usage 弹层补丁把 React Compiler 运行时的名字写死成了 `re`。

- 补丁模板 `PATCHED_POPOVER_CODE` 以 1.0.411 的压缩名书写，开头是 `function Bde(t){const e=re.c(30),[a2kCfg]=l0(),…`。
- 改名表 `POPOVER_PATCH_CANON` 只有 `["Bde","Pde","l0"]` 三项，没有 `re`。写盘时 `re` 原样落地。
- Kiro 1.2.56 的 agent-chat chunk 里，这个运行时的实际名字是 `ne`（出厂弹层写的是 `ne.c(30)`）。
- 同一个 chunk 的顶层另有一个无关函数叫 `re`：`function re(t){const e=C.useContext(rg);if(!e)throw new Error("Missing SessionContext.Provid…`。补丁里的 `re.c(30)` 于是指向这个函数。函数没有 `.c` 属性，调用时抛 `re.c is not a function`。
- 弹层渲染时抛错，被 webview 的错误边界接住，显示 "Something went wrong" 和 "Retry"。这和用户在跑 workflow 时看到的现象一致：弹层在聊天输入区的上下文用量指示器里，一进入会话就会渲染。

这不是 workflow 相关的数据结构问题，和 `run_workflow` 通知、workflow 列表没有关系。

## 证据

1. 已安装的 `/Applications/Kiro.app/.../kiro-ui-agent-chat/dist/assets/mermaid-GHXKKRXX-CSjtlRpj.js`（mtime Oct 11 01:14）中 `re.c(` 恰好 1 处，位于补丁后的弹层：`function Ake(t){/*a2k-orig:…*/const e=re.c(30),[a2kCfg]=zg()`。
2. 同一个文件的出厂备份 `….kiroproxy-bak-1.2.56` 里 `re.c(` 为 0 处，`ne.c(` 有 174 处。弹层头部是 `function Ake(t){const e=ne.c(30),{livePercentage:n,…`。
3. session-details 的 chunk 里 `re.c(` 为 0 处，因为该 chunk 的弹层在 1.2.56 上不会被注入（jsx 运行时名是 `x`，守卫放行不了）。
4. 补丁文件里顶层 `;function re(t){const e=C.useContext(rg);…` 就是被误指的那个 `re`。
5. 源码里 `ORIG_POPOVER_PATTERN` 和 `PATCHED_POPOVER_CODE` 各有一处 `re.c(30)`。用编译后的内部函数扫描，两条模板里只有这一处裸 `re`。
6. 这是遗漏，不是陈旧产物：4.13.64 源码本身就有这个缺陷，装进 Kiro 的补丁与源码一致。

为什么 4.13.64 的验证没发现：`dev/verify-selector-patch.js` 的 P15 用桩 jsx 和桩 hook 跑 Ctx 下拉，但没有执行弹层函数，也没有断言补丁里的 `.c(30)` 运行时名等于出厂的名字。模板按 1.0.411 的压缩名书写，那里运行时名就是 `re`，所以当时碰巧正确。P23 用的 1.1.14 改名表里这个名字已经是 `ne`，也就是说 1.1.14 上同样会写出 `re.c(30)`；它是否会炸，取决于那个 bundle 里 `re` 是否恰好是另一个顶层函数，本机没有 1.1.14，未核实。

## 修改的文件（未提交）

- `src/selectorStyle.ts`
  - `POPOVER_PATCH_CANON` 增加第 4 项 `"re"`。
  - `applyPopover` 从弹层命中段的映射读出真机运行时名（`fac.span.map.get("re")`），传给 `renderTemplate`。读不出就返回 null，不打补丁，弹层退回原生外观。
  - `patchedPopoverWritten` 增加 `runtime` 参数，`restorePatchedPopover` 从补丁命中段映射读出它，保证还原侧期望的形态和写盘形态一致。
- `dev/verify-selector-patch.js`：在 P16 加一条回归断言，要求打补丁后弹层里 `.c(30)` 前面的运行时名等于出厂弹层使用的名字。

没有升版本号，没有提交，没有重新打包，没有动已有 vsix。

## 验证

- `npm run compile`：通过。
- `node dev/verify-selector-patch.js /tmp/kiro-1.2.56-factory`：176 passed, 0 failed（4.13.64 时是 175，新增 1 条）。
- `node dev/verify-selector-patch.js`（真机只读副本）：176 passed, 0 failed。
- `node dev/verify-opencode-session.js`：VERIFY OK。
- 回归断言有效性：在未修的源码上跑，这条新断言失败，输出 `factory=ne patched=re`；修后通过。
- 对现装的坏补丁 chunk（拷贝到 /tmp，真机文件没写）做了 restore 再 apply：
  - restore 后 chunk 中不再有 `a2k` 痕迹，只剩 kiro-proxy 扩展自己的注入（出厂对照文件取自 kiro-proxy 注入前的备份，所以逐字比对有差异，差异全在 `kiroproxy-*` 注入段）。
  - 重新 apply 后弹层是 `const e=ne.c(30),[a2kCfg]=zg()`，不再含 `re.c(30)`。
  - `restore(apply(x)) === x`，再次 apply 幂等。

## 没有验证到的部分

- 没有在运行中的 Kiro 里加载弹层，也没有在浏览器里复现错误边界。Kiro 的 webview 依赖宿主消息，无法用静态服务驱动。证据来自安装文件里的 bundle 文本、顶层 `re` 的定义，以及补丁往返测试。
- 用户的真机文件目前仍是坏补丁。需要打包安装含本修复的版本并重载窗口，扩展启动时会先 restore 再 apply，把 `re.c(30)` 换成 `ne.c(30)`。这条路径只在副本上模拟过。
- 修复后的弹层渲染没有用真实 React Compiler 运行时执行过。
- 用户提示该错误出现在跑 workflow 时。我没有找到 workflow 专属代码路径与这个错误相关，只有"弹层在会话里必然渲染"这一解释。如果修复后仍报同样错误，需要再查是否有其它补丁段写死了压缩名。

## 自查

- 修的是根因（写死运行时名），没有掩盖错误：没有加 try/catch，也没有改错误边界。
- 读不出运行时名时选择不打补丁，和现有"宁可退回原生"的取向一致。
- 改名表新增的 `re` 只匹配代码里的裸标识符，`.c` 属性名由 `codeTokens` 当字面量处理，不会被误改。
- 同类风险：模板里其它写死的外部名，用扫描检查过，只有 `re` 这一处未列入改名表。
