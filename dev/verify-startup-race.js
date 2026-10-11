#!/usr/bin/env node
/**
 * API4Kiro 启动竞态修复验证脚本（4.13.65）：kiro-agent 先激活、打到尚未绑定的 CPS 端口 → ECONNREFUSED toast。
 *
 * 覆盖三件事（见 .agents/pipeline/2026-10-11_01-23-07/02-design.md）：
 *   U  usage 重试钩子的纯变换（打 / 幂等 / 还原 / 漂移 / 重复锚点）
 *   B  注入后的重试逻辑真跑（桩 send / 日志 / toast）
 *   P  planKiroAgentBackend + syncGroupHeaderStyle 的状态、extras、提交日志
 *   R  真机 kiro-agent dist/extension.js 的只读副本：锚点命中、node --check、往返、再规划无变化
 *   G  激活闸    I  身份应答对密钥的懒等待    L  早绑端口时 PortHolder 不等密钥
 *
 * 用法：node dev/verify-startup-race.js [appRoot]    绝不改动真机文件：所有读写都在临时目录。
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const http = require("http");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const REAL_ROOT = process.argv[2] || "/Applications/Kiro.app/Contents/Resources/app";
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "a2k-race-"));
const BUILD = path.join(WORK, "build");
const ROOT = path.join(WORK, "root");
const EXT_FILE = path.join(ROOT, "extensions/kiro.kiro-agent/dist/extension.js");

let pass = 0;
let fail = 0;
/** 跳过的段落数（真机夹具不可用 / 带残留时）。与 AC-3 的 61 项分开记录。 */
let skippedSections = 0;

/**
 * 真机 `dist/extension.js` 的归一文本：优先取同名 `.kiroproxy-bak-*` 备份（该 Kiro 构建的出厂原文），
 * 否则用原文；原文仍含残留时返回 null（本段 SKIP —— 产品侧前置闸会拒绝对带残留的文件做任何写入）。
 * **不做文本清洗**：JS 里有未配对的行内 `/*kiroproxy-…*​/` 标记，按定界段剥离会漏掉或误吞后续代码。
 */
function normalizedRealText(srcFile, fallbackText) {
  const dir = path.dirname(srcFile);
  const base = path.basename(srcFile);
  const backup = fs.readdirSync(dir).find((f) => f.startsWith(base + ".kiroproxy-bak-"));
  const text = backup ? fs.readFileSync(path.join(dir, backup), "utf8") : fallbackText;
  if (text.includes("kiroproxy-")) {
    return null;
  }
  if (backup) {
    console.log(`      · 已用备份替换：${backup}`);
  }
  return text;
}
const check = (name, ok, extra) => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra === undefined ? "" : `\n        ${extra}`}`);
  }
};
const section = (t) => console.log(`\n== ${t}`);
const count = (s, sub) => s.split(sub).length - 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

function build() {
  execFileSync(path.join(REPO, "node_modules/.bin/tsc"), ["-p", path.join(REPO, "tsconfig.json"), "--outDir", BUILD, "--noEmit", "false", "--sourceMap", "false"], { stdio: "pipe" });
  const stubDir = path.join(BUILD, "node_modules/vscode");
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, "package.json"), JSON.stringify({ name: "vscode", version: "0.0.0", main: "index.js" }));
  fs.writeFileSync(
    path.join(stubDir, "index.js"),
    `module.exports={env:{appRoot:process.env.A2K_APP_ROOT,appName:"Kiro"},` +
      `workspace:{getConfiguration:()=>({get:()=>undefined})},` +
      `window:{createOutputChannel:()=>({appendLine(){},append(){},show(){},dispose(){}})},` +
      `Uri:{file:(p)=>({fsPath:p,toString:()=>String(p)})},commands:{executeCommand:async()=>undefined}};\n`
  );
  fs.writeFileSync(
    path.join(BUILD, "log.js"),
    `const j=(a)=>a.map((x)=>typeof x==="string"?x:JSON.stringify(x)).join(" ");` +
      `module.exports={info(...a){(globalThis.__a2kInfo||(globalThis.__a2kInfo=[])).push(j(a));},debug(){},` +
      `warn(...a){(globalThis.__a2kWarn||(globalThis.__a2kWarn=[])).push(j(a));},error(){},showLog(){},initLog(){return{appendLine(){},dispose(){}}},` +
      `redactText:(s)=>s,maskSecretForLog:(s)=>s,maskKey:(s)=>s,MAX_LINE_BYTES:65536};\n`
  );
}

// ---------------------------------------------------------------- 夹具
/** 复刻真机处理函数形态（名字取自 1.2.56 的压缩名；位置、标签、catch 头、尾部三元式都按真实结构）。 */
const USAGE_FACTORY =
  "const handlers={};function reg(n,f){handlers[n]=f}function WEf(t){T.toasts.push(t)}c(WEf,\"showErrorToastRateLimited\");" +
  'reg("kiro.usageLimits.getUsageLimits",async r=>QEf.callWithTrace("GetUsageLimits",async()=>{let n=1,s=2,a=await Zd(),{provider:l}=Tr.readToken()??{},u=await TW(),' +
  'd=new uga.GetUsageLimitsCommand({origin:"AI_EDITOR",isEmailRequired:r}),p;' +
  'try{let f=await xW("GetUsageLimits",l,()=>u.send(d)),h=GEf(f,l);p={data:h,error:null},y7.clear()}' +
  "catch(f){let h=`Unable to fetch account usage data${f instanceof Error?`: ${f.message}`:\"\"}`,m=f instanceof Error&&\"$metadata\"in f,g=f;" +
  "p={data:null,error:{apiError:f,message:h,statusCode:m?g.$metadata.httpStatusCode:void 0}},HEf(f)?(y7.setIsUsageEnabled(!1),y7.setCachedErrorResponse(p)):VEf(f)?X.warn(h):(X.error(h),WEf(h))}" +
  "return p}));";
/** 后端 modelConfigProvider setter 的出厂结构（findBackendHook 的结构锚点）。 */
const MAIN_FACTORY = "function QPe(t){Oue=t}function Zue(){return Oue}var qq=Oue.getAvailableModels();";

function loadHandler(src, hooks) {
  const stubs = {
    QEf: { callWithTrace: (_n, f) => f() },
    Zd: async () => "arn",
    Tr: { readToken: () => ({ provider: "p" }) },
    TW: async () => ({ send: hooks.send }),
    uga: { GetUsageLimitsCommand: class {} },
    xW: (_n, _l, f) => f(),
    GEf: (f) => f,
    HEf: () => false,
    VEf: () => false,
    y7: { clear() {}, setIsUsageEnabled() {}, setCachedErrorResponse() {} },
    X: { warn: (m) => hooks.warns.push(m), error: (m) => hooks.errors.push(m) },
    T: { toasts: hooks.toasts },
    c: () => {},
  };
  const names = Object.keys(stubs);
  const fn = new Function(...names, src + "\nreturn handlers;");
  return fn(...names.map((n) => stubs[n]))["kiro.usageLimits.getUsageLimits"];
}

const refused = (addr) =>
  Object.assign(new Error(`connect ECONNREFUSED ${addr}`), { code: "ECONNREFUSED", address: addr.split(":")[0], port: Number(addr.split(":")[1]) });

async function main() {
  build();
  fs.mkdirSync(path.dirname(EXT_FILE), { recursive: true });
  fs.mkdirSync(path.join(ROOT, "extensions/kiro.kiro-agent/packages"), { recursive: true });
  process.env.A2K_APP_ROOT = ROOT;
  const S = require(path.join(BUILD, "selectorStyle.js"));
  const M = S.__selectorStyleInternals.matchers;
  const read = (p) => fs.readFileSync(p, "utf8");
  const infoLog = () => (globalThis.__a2kInfo ||= []);
  const factoryNormalize = (t) => M.restoreUsageHook(M.restoreCtxHostHook(M.restoreBackendHook(t)));

  // ------------------------------------------------------------ U
  section("U1–U6 usage 钩子变换");
  const retry = M.renderUsageRetry();
  check("U1 渲染出的重试函数不含 */", !retry.includes("*/"));
  check("U1 夹具命中 findUsageHook", !!M.findUsageHook(USAGE_FACTORY));
  const patched = M.applyUsageHook(USAGE_FACTORY);
  check("U1 打补丁后出现 3 段定界（start/end 各 3）", count(patched, M.USAGE_START) === 3 && count(patched, M.USAGE_END) === 3, `${count(patched, M.USAGE_START)}/${count(patched, M.USAGE_END)}`);
  check("U1 补丁含重试函数与标记分支", patched.includes("a2kRun") && patched.includes("__a2kLocalRefused?X.warn(h):"));
  check("U2 再打一次不变（已打补丁内容 apply 为空操作）", M.applyUsageHook(patched) === patched);
  check("U2 restore→apply 与首次逐字相同", M.applyUsageHook(M.restoreUsageHook(patched)) === patched);
  check("U3 还原后与出厂逐字相同", M.restoreUsageHook(patched) === USAGE_FACTORY);
  const drift1 = USAGE_FACTORY.replace("Unable to fetch account usage data", "Unable to fetch usage");
  check("U4 错误文案字面量缺失 → 不变且 find 为 null", M.applyUsageHook(drift1) === drift1 && M.findUsageHook(drift1) === null);
  const drift2 = USAGE_FACTORY.replace("u.send(d)", "u.call(d)");
  check("U4 thunk 形态变化 → 不变且 find 为 null", M.applyUsageHook(drift2) === drift2 && M.findUsageHook(drift2) === null);
  const dup = USAGE_FACTORY + 'x("kiro.usageLimits.getUsageLimits",async r=>0);';
  check("U5 注册串重复 → 不变", M.applyUsageHook(dup) === dup && M.findUsageHook(dup) === null);
  const drift3 = USAGE_FACTORY.replace('"showErrorToastRateLimited"', '"somethingElse"');
  check("U6 toast 标签不符 → 不变", M.applyUsageHook(drift3) === drift3 && M.findUsageHook(drift3) === null);
  const drift4 = USAGE_FACTORY.replace("d=new uga.GetUsageLimitsCommand(", "d=makeCmd(");
  check("U6 命令变量非 new 出来的 GetUsageLimitsCommand（3a）→ 不变", M.applyUsageHook(drift4) === drift4);

  // ------------------------------------------------------------ B
  section("B1–B3 注入后的重试逻辑（renderUsageRetry(20,200)）");
  const fast = patched.split(retry).join(M.renderUsageRetry(20, 200));
  const run = async (src, sendImpl) => {
    const h = { sends: 0, warns: [], errors: [], toasts: [], send: undefined };
    h.send = async () => {
      h.sends++;
      return sendImpl(h.sends);
    };
    const handler = loadHandler(src, h);
    const p = await handler(false);
    return { h, p };
  };
  {
    const { h, p } = await run(fast, (n) => {
      if (n <= 3) throw refused("127.0.0.1:19811");
      return { ok: 1 };
    });
    check("B1 本地 ECONNREFUSED×3 后成功：走成功路径", p.data && p.data.ok === 1 && p.error === null, JSON.stringify(p));
    check("B1 共 4 次 send、无 toast、无 error 日志", h.sends === 4 && h.toasts.length === 0 && h.errors.length === 0, `sends=${h.sends} toasts=${h.toasts.length}`);
  }
  {
    const t0 = Date.now();
    const { h, p } = await run(fast, () => {
      throw refused("127.0.0.1:19811");
    });
    check("B2 持续 ECONNREFUSED：不弹 toast，仅一条 warn，返回 data:null", h.toasts.length === 0 && h.warns.length === 1 && h.errors.length === 0 && p.data === null && !!p.error && p.error.message.includes("ECONNREFUSED"), JSON.stringify({ toasts: h.toasts, warns: h.warns }));
    check("B2 在预算内放弃（>1 次重试且 <2s）", h.sends > 2 && Date.now() - t0 < 2000, `sends=${h.sends} ms=${Date.now() - t0}`);
  }
  {
    const { h } = await run(fast, () => {
      throw refused("10.0.0.1:443");
    });
    check("B3 非回环 ECONNREFUSED：一次 send、一次 toast（原行为）", h.sends === 1 && h.toasts.length === 1 && h.errors.length === 1, `sends=${h.sends} toasts=${h.toasts.length}`);
  }
  {
    const { h } = await run(fast, () => {
      throw Object.assign(new Error("Internal Server Error"), { $metadata: { httpStatusCode: 500 } });
    });
    check("B3 HTTP 500：一次 send、一次 toast", h.sends === 1 && h.toasts.length === 1, `sends=${h.sends} toasts=${h.toasts.length}`);
  }
  {
    const { h } = await run(fast, () => {
      throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", address: "127.0.0.1" });
    });
    check("B3 回环但非 ECONNREFUSED（ECONNRESET）：不重试", h.sends === 1 && h.toasts.length === 1, `sends=${h.sends}`);
  }
  {
    const { h } = await run(USAGE_FACTORY, () => {
      throw refused("127.0.0.1:19811");
    });
    check("B0 对照：未打补丁时同一错误立即 toast（即用户看到的现象）", h.sends === 1 && h.toasts.length === 1);
  }
  {
    const { h, p } = await run(fast, () => {
      throw Object.freeze(refused("127.0.0.1:19811"));
    });
    check("B4 错误对象被冻结（标记打不上）：退回原行为弹 toast", h.toasts.length === 1 && p.data === null, `toasts=${h.toasts.length}`);
  }

  // ------------------------------------------------------------ P
  section("P 计划 / 状态 / 提交日志（syncGroupHeaderStyle）");
  {
    // 读文件失败（非 Kiro 宿主）：不报漂移
    const st = await S.syncGroupHeaderStyle(true);
    check("P0 文件不存在：usageRetry=unchanged、无漂移日志", st.extras.usageRetry === "unchanged" && !infoLog().some((l) => l.includes("usage-limits retry hook (optional)")), JSON.stringify(st.extras));
  }
  const F1 = MAIN_FACTORY + USAGE_FACTORY;
  fs.writeFileSync(EXT_FILE, F1, "utf8");
  let st = await S.syncGroupHeaderStyle(true);
  const onDisk1 = read(EXT_FILE);
  check("P1 首次：backend=applied、usageRetry=applied", st.targets.backend === "applied" && st.extras.usageRetry === "applied", JSON.stringify({ t: st.targets, e: st.extras }));
  check("P1 文件含主钩子与 usage 段", onDisk1.includes("__kiroModelConfigProvider=t") && count(onDisk1, M.USAGE_START) === 3);
  check("P1 提交日志合并两项", infoLog().some((l) => l.includes("hooked kiroAgent modelConfigProvider bridge + hooked kiroAgent usage-limits retry")));
  const logsBefore = infoLog().length;
  st = await S.syncGroupHeaderStyle(true);
  check("P2 再次同步：backend=unchanged、usageRetry=unchanged、文件不变、不再写", st.targets.backend === "unchanged" && st.extras.usageRetry === "unchanged" && read(EXT_FILE) === onDisk1 && !infoLog().slice(logsBefore).some((l) => l.includes("hooked kiroAgent")));
  // 主钩子已在位 + usage 新增：targets.backend 不被 usage 翻动
  fs.writeFileSync(EXT_FILE, M.restoreUsageHook(onDisk1), "utf8");
  infoLog().length = 0;
  st = await S.syncGroupHeaderStyle(true);
  check("P3 主钩子在位 + usage 新增：backend=unchanged、usageRetry=applied、整体 status 不被翻成 applied", st.targets.backend === "unchanged" && st.extras.usageRetry === "applied" && st.status !== "applied", JSON.stringify({ s: st.status, t: st.targets, e: st.extras }));
  check("P3 文件已写成目标态", read(EXT_FILE) === onDisk1);
  check("P3 提交日志只报 usage", infoLog().some((l) => l.includes("hooked kiroAgent usage-limits retry")) && !infoLog().some((l) => l.includes("modelConfigProvider bridge")));
  st = await S.syncGroupHeaderStyle(false);
  check("P4 关闭：usageRetry=removed、backend=removed、文件逐字回到出厂", st.extras.usageRetry === "removed" && st.targets.backend === "removed" && read(EXT_FILE) === F1, JSON.stringify({ t: st.targets, e: st.extras }));
  // 主钩子漂移 + usage 能打
  fs.writeFileSync(EXT_FILE, USAGE_FACTORY, "utf8");
  st = await S.syncGroupHeaderStyle(true);
  const d = read(EXT_FILE);
  check("P5 主钩子漂移 + usage 可打：写文件、backend=unavailable、usageRetry=applied", st.targets.backend === "unavailable" && st.extras.usageRetry === "applied" && d.includes(M.USAGE_START) && !d.includes("__kiroModelConfigProvider"), JSON.stringify({ t: st.targets, e: st.extras }));
  st = await S.syncGroupHeaderStyle(false);
  check("P5 关闭后回到出厂", st.extras.usageRetry === "removed" && read(EXT_FILE) === USAGE_FACTORY);
  // usage 漂移：只跳过自己，且只记一次
  fs.writeFileSync(EXT_FILE, MAIN_FACTORY, "utf8");
  infoLog().length = 0;
  st = await S.syncGroupHeaderStyle(true);
  check("P6 usage 锚点漂移：usageRetry=unavailable，主钩子照常 applied", st.extras.usageRetry === "unavailable" && st.targets.backend === "applied", JSON.stringify({ t: st.targets, e: st.extras }));
  await S.syncGroupHeaderStyle(true);
  check("P6 漂移日志每宿主只一条", infoLog().filter((l) => l.includes("usage-limits retry hook (optional): unavailable")).length === 1);
  await S.syncGroupHeaderStyle(false);

  // ------------------------------------------------------------ R
  section("R1 真机 kiro-agent dist/extension.js 只读副本");
  const realFile = path.join(REAL_ROOT, "extensions/kiro.kiro-agent/dist/extension.js");
  if (!fs.existsSync(realFile)) {
    console.log(`  SKIP  ${realFile} 不存在`);
  } else {
    const realText = read(realFile);
    const factory = factoryNormalize(realText);
    const hit = M.findUsageHook(factory);
    check("R1 锚点在真机文件上唯一命中（含 3a 命令变量检查）", !!hit, "findUsageHook 返回 null");
    const real2 = M.applyUsageHook(factory);
    check("R1 打补丁后 3 段定界", count(real2, M.USAGE_START) === 3 && count(real2, M.USAGE_END) === 3);
    const tmpJs = path.join(WORK, "patched-kiro-agent.js");
    fs.writeFileSync(tmpJs, real2, "utf8");
    let parses = true;
    try {
      execFileSync(process.execPath, ["--check", tmpJs], { stdio: "pipe" });
    } catch (e) {
      parses = false;
    }
    check("R1 打过补丁的 extension.js 通过 node --check", parses);
    check("R1 restore 与出厂归一内容逐字相同", M.restoreUsageHook(real2) === factory);
    check("R1 再打一次无变化（幂等）", M.applyUsageHook(M.restoreUsageHook(real2)) === real2);
    // 整条规划链路：真机副本放进沙箱，开 → 再开 → 关。
    // 写进沙箱的那一份要归一：本机真实 Kiro 的 extension.js 带 kiro-proxy 残留，产品侧新增的
    // 「检测到 kiroproxy- 就不写任何文件」前置闸会让本段整体 unavailable。JS 不能文本清洗
    // （有未配对的行内标记），所以优先取同名 .kiroproxy-bak-* 备份；仍带残留就本段 SKIP。
    const sandboxText = normalizedRealText(realFile, realText);
    if (sandboxText === null) {
      console.log(`  SKIP  ${realFile} 带 kiro-proxy 残留且无 .kiroproxy-bak-* 备份可用（本段会撞前置闸）`);
      skippedSections++;
    } else {
    fs.writeFileSync(EXT_FILE, sandboxText, "utf8");
    const s1 = await S.syncGroupHeaderStyle(true);
    const afterOn = read(EXT_FILE);
    check("R1 sync(true)：usageRetry 为 applied 或 unchanged，且文件含 usage 段", (s1.extras.usageRetry === "applied" || s1.extras.usageRetry === "unchanged") && count(afterOn, M.USAGE_START) === 3, JSON.stringify(s1.extras));
    const s2 = await S.syncGroupHeaderStyle(true);
    check("R1 再规划无变化", s2.extras.usageRetry === "unchanged" && read(EXT_FILE) === afterOn, JSON.stringify(s2.extras));
    const s3 = await S.syncGroupHeaderStyle(false);
    check("R1 sync(false) 后与出厂归一内容逐字相同", factoryNormalize(read(EXT_FILE)) === read(EXT_FILE) && factoryNormalize(read(EXT_FILE)) === factoryNormalize(sandboxText), JSON.stringify(s3.extras));
    }
    // U7：真机文件上三个钩子（主 / ctx 宿主 / usage）共存并往返
    const withAll = M.applyUsageHook(M.applyCtxHostHook(M.applyBackendHook ? M.applyBackendHook(factory) : factory));
    check("U7 三钩子叠加后 usage 段仍是 3 段", count(withAll, M.USAGE_START) === 3);
    check("U7 三钩子叠加后整体还原到出厂", factoryNormalize(withAll) === factory);
  }

  // ------------------------------------------------------------ K
  section("K1 kiro-proxy 前置闸：带残留 ⇒ 整轮不写任何文件（三步顺序固定）");
  {
    const marks = () => read(EXT_FILE).includes("__kiroModelConfigProvider=t");
    const stamp = () => {
      const s = fs.statSync(EXT_FILE);
      return `${s.size}:${s.mtimeMs}`;
    };
    const proxyBytes = () => (read(EXT_FILE).match(/kiroproxy-[A-Za-z0-9:_-]*/g) || []).join(",");
    // ① 出厂后端文件 → 开补丁 → 钩子必须真的写进去（否则第 ② 步的「一个字都没写」是空转）
    fs.writeFileSync(EXT_FILE, MAIN_FACTORY, "utf8");
    const s1 = await S.syncGroupHeaderStyle(true);
    check("K1① 开补丁未被挡住（blockedBy 为空）", s1.blockedBy === undefined, JSON.stringify(s1));
    check("K1① 后端钩子已写入", marks(), JSON.stringify(s1.targets));
    // ② 在同一份已打补丁的文件上注入 kiroproxy- 残留 → 整轮不写任何文件
    const residue = "/*kiroproxy-toolcard:r1*/var kiroproxyProbe=1;/*kiroproxy-toolcard:end*/";
    fs.appendFileSync(EXT_FILE, residue, "utf8");
    const before = read(EXT_FILE);
    const stamp2 = stamp();
    const proxy2 = proxyBytes();
    const s2 = await S.syncGroupHeaderStyle(true);
    check("K1② status=unavailable 且 blockedBy=kiro-proxy", s2.status === "unavailable" && s2.blockedBy === "kiro-proxy", JSON.stringify(s2));
    check("K1② 三个靶点都报 unavailable", s2.targets.style === "unavailable" && s2.targets.selectorScript === "unavailable" && s2.targets.backend === "unavailable", JSON.stringify(s2.targets));
    check("K1② 文件 bytes 与 mtime 逐字一致", read(EXT_FILE) === before && stamp() === stamp2, `${stamp()} vs ${stamp2}`);
    // ③ 关闭路径不跑闸门：只删自己的段，kiroproxy- 的字节一个都不碰
    const s3 = await S.syncGroupHeaderStyle(false);
    check("K1③ 后端 a2k 段已消失", !marks() && !read(EXT_FILE).includes("a2kRun"), read(EXT_FILE).slice(0, 160));
    check("K1③ kiroproxy- 的字节与第 ② 步逐字一致", proxyBytes() === proxy2, `${proxyBytes()} vs ${proxy2}`);
    check("K1③ 关闭路径不报 blockedBy", s3.blockedBy === undefined, JSON.stringify(s3));
    check("K1③ 注入的残留原文仍在", read(EXT_FILE).includes(residue));
    // 收尾：回到出厂态
    fs.writeFileSync(EXT_FILE, MAIN_FACTORY, "utf8");
  }

  // ------------------------------------------------------------ G
  section("G 激活闸");
  const G = require(path.join(BUILD, "activationGate.js"));
  const mkRes = () => ({ destroyed: false, writableEnded: false, status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.writableEnded = true; this.body = b || ""; } });
  const mkReq = () => ({ socket: { destroyed: false }, resume() { this.resumed = true; } });
  {
    let dispatched = 0;
    G.holdUntilReady(mkReq(), mkRes(), () => dispatched++);
    check("G4 默认开：同步派发", dispatched === 1 && G.isActivationReady());
  }
  {
    G.beginActivationGate();
    let dispatched = 0;
    const res = mkRes();
    G.holdUntilReady(mkReq(), res, () => dispatched++);
    await sleep(20);
    check("G1 闸 pending 期间不派发", dispatched === 0 && res.status === 0 && !G.isActivationReady());
    G.settleActivationGate(true);
    await sleep(20);
    check("G1 settle(true) 后派发", dispatched === 1 && G.isActivationReady());
  }
  {
    G.beginActivationGate();
    let dispatched = 0;
    const res = mkRes();
    const req = mkReq();
    G.holdUntilReady(req, res, () => dispatched++);
    G.settleActivationGate(false);
    await sleep(20);
    check("G2 settle(false)：503 + Retry-After、不派发、请求体被消耗", dispatched === 0 && res.status === 503 && req.resumed === true && JSON.parse(res.body).message.includes("initializing"));
    const res2 = mkRes();
    G.holdUntilReady(mkReq(), res2, () => dispatched++);
    await sleep(20);
    check("G2 失败态下后续请求同样 503", dispatched === 0 && res2.status === 503);
  }
  {
    G.beginActivationGate();
    const t0 = Date.now();
    const ok = await G.whenActivationReady(60);
    check("G3 超时返回 false（约 60ms）", ok === false && Date.now() - t0 >= 50 && Date.now() - t0 < 1000, `ok=${ok} ms=${Date.now() - t0}`);
    let dispatched = 0;
    const res = mkRes();
    G.holdUntilReady(mkReq(), res, () => dispatched++);
    const realClear = global.clearTimeout;
    let cleared = 0;
    global.clearTimeout = (...a) => {
      cleared++;
      return realClear(...a);
    };
    const waiting = G.whenActivationReady(60_000);
    G.settleActivationGate(true);
    const ok2 = await waiting;
    await sleep(20);
    global.clearTimeout = realClear;
    check("G3 settle 后计时器被清掉、结果为 true、排队请求被派发", ok2 === true && cleared >= 1 && dispatched === 1, `ok2=${ok2} cleared=${cleared} dispatched=${dispatched}`);
    const gone = mkRes();
    G.beginActivationGate();
    let d2 = 0;
    G.holdUntilReady(mkReq(), gone, () => d2++);
    gone.destroyed = true;
    G.settleActivationGate(true);
    await sleep(20);
    check("G3 客户端中途断开：不派发也不写响应", d2 === 0 && gone.status === 0);
  }

  // ------------------------------------------------------------ I
  section("I 身份应答对密钥的懒等待");
  const P = require(path.join(BUILD, "proxyIdentity.js"));
  const K = crypto.randomBytes(32);
  {
    const key = deferred();
    P.setIdentityKey(undefined);
    P.setIdentityKeyPending(key.promise);
    const res = mkRes();
    const nonce = "a".repeat(32);
    const handled = P.serveIdentity(`${P.PROXY_ID_PATH}?nonce=${nonce}`, res, "krs", {});
    await sleep(20);
    check("I1 密钥 pending：路径判定同步返回 true，但尚未应答", handled === true && res.status === 0);
    P.setIdentityKey(K);
    key.resolve();
    await sleep(20);
    const body = res.status === 200 ? JSON.parse(res.body) : {};
    check("I1 密钥就绪后应答 200 且带有效 sig", res.status === 200 && body.sig === P.identitySignature("krs", nonce, body.version), res.body);

    // I2：pending 期间到达的合法签名让位，密钥落地后得到 200 / yielding:true
    const serverNonce = body.nonce;
    const auth = P.yieldSignature("krs", serverNonce, "9.9.9");
    let yielded = false;
    P.registerYielder("krs", () => (yielded = true));
    const k2 = deferred();
    P.setIdentityKey(undefined);
    P.setIdentityKeyPending(k2.promise);
    const res2 = mkRes();
    P.serveIdentity(`${P.PROXY_ID_PATH}?yieldTo=9.9.9&nonce=${"b".repeat(32)}`, res2, "krs", { [P.YIELD_NONCE_HEADER]: serverNonce, [P.YIELD_AUTH_HEADER]: auth });
    await sleep(20);
    check("I2 pending 期间的签名让位请求不被 403，也还没应答", res2.status === 0);
    P.setIdentityKey(K);
    k2.resolve();
    await sleep(20);
    const b2 = res2.status === 200 ? JSON.parse(res2.body) : {};
    check("I2 密钥落地后：200 / yielding:true", res2.status === 200 && b2.yielding === true, `${res2.status} ${res2.body}`);
    await sleep(120);
    check("I2 随后确实触发让位回调", yielded === true);

    const k3 = deferred();
    P.setIdentityKeyPending(k3.promise);
    const res3 = mkRes();
    P.serveIdentity(`${P.PROXY_ID_PATH}`, res3, "krs", {});
    res3.destroyed = true;
    k3.resolve();
    await sleep(20);
    check("I3 等密钥期间客户端已走：不再写响应", res3.status === 0);

    // probeIdentity 在探测前等密钥
    const k4 = deferred();
    P.setIdentityKeyPending(k4.promise);
    let probed = false;
    const probe = P.probeIdentity(1, "krs").then((r) => {
      probed = true;
      return r;
    });
    await sleep(80);
    check("I4 probeIdentity 在密钥 pending 时不发出探测", probed === false);
    k4.resolve();
    const r = await probe;
    check("I4 密钥就绪后探测继续（端口无人时返回 null）", probed === true && r === null);
  }

  // ------------------------------------------------------------ L
  section("L 早绑端口：PortHolder.start 不等身份密钥");
  {
    const B = require(path.join(BUILD, "portBinder.js"));
    const port = await new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    const key = deferred();
    P.setIdentityKeyPending(key.promise);
    const holder = new B.PortHolder(port, "CPS", () => http.createServer((_q, s) => s.end("ok")));
    const t0 = Date.now();
    await holder.start();
    check("L1 密钥仍 pending 时 bindOnce 直接成为 OWNER", holder.isOwner() && Date.now() - t0 < 1000, `owner=${holder.isOwner()} ms=${Date.now() - t0}`);
    await holder.stop();
    key.resolve();
    await sleep(10);
  }
}

// 激活闸的超时计时器是 unref 的（产品里不该拖住宿主退出）；脚本里没有别的句柄时进程会在 G3 悄悄退出，所以自己占住事件循环。
const keepAlive = setInterval(() => {}, 1000);

main()
  .catch((e) => {
    fail++;
    console.log(`  FAIL  脚本异常: ${e && e.stack ? e.stack : e}`);
  })
  .finally(() => {
    clearInterval(keepAlive);
    console.log(`\n${pass} passed, ${fail} failed, ${skippedSections} section(s) skipped  (workdir ${WORK})`);
    try {
      fs.rmSync(WORK, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    process.exit(fail === 0 ? 0 : 1);
  });
