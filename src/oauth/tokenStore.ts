/**
 * OAuth token 仓：按「provider id（首条凭证）」或「providerId/credentialId（key 池里其余账号）」
 * 存第三方账号登录拿到的 access/refresh token。键的构造见 providers.tokenKeyOf。
 *
 * 为什么不放 settings.json：
 *  - refresh 会频繁改写 access token，写 settings 会触发整套配置变更→重拉模型；
 *  - refresh token 等价于账号本身，不该和普通配置一起被同步/导出。
 * 所以用 VS Code 的 SecretStorage（系统钥匙串）；拿不到 secrets（老宿主 / 测试桩）时退到
 * globalState。整张表存成一个 JSON blob（SecretStorage 没有 list）。
 *
 * 多窗口：同一用户的每个 Kiro 窗口各有一份本模块，共用同一个钥匙串条目，所以
 *  - 读是同步的：内存视图 = 最近一次读到的整表（base）+ 本窗口尚未落盘的改动（pending）；
 *  - 写不是「把内存整表覆盖上去」：改动先进 pending，落盘时先从钥匙串重读最新整表，把 pending 按键
 *    回放到它上面再写回——只碰本次改动的键，别的窗口刚轮换的 refresh token 不会被本窗口的旧内存态盖掉；
 *  - 订阅 secrets.onDidChange：别的窗口写过就重读整表，本窗口缓存随之失效（自己写的回声只多一次读）；
 *  - SecretStorage 没有 CAS：两个窗口同时「读—改—写」时后写者会盖掉先写者的整个 blob（哪怕改的是不同键）。
 *    为此 blob 里带一条 `$meta`（本次写入的 stamp + 最近 8 个祖先 stamp）：写完立刻读回，读回的 stamp 不是自己的、
 *    祖先里也没有自己的 → 被人盖了 → 以最新表为底重放 pending 再写（最多 4 轮，之后转入定时重试）；
 *    onDidChange 读到的表若祖先里没有本窗口上一次提交的 stamp（对方从未见过我们那次写）→ 把上一次提交的改动
 *    重放上去再写一次。祖先满 8 条仍找不到（短时间内 ≥ 8 次写）视为不确定，不重放、只记一条 warn。
 *  残余竞态：两个窗口在同一毫秒级窗口内改**同一个键**时，最终值是最后一个重放者的；≥ 8 次连写的极端突发下
 *  不做重放；窗口已关闭则无人替它重放。见 docs/specs/provider-connect/design.md Dc6。
 *
 * 读失败不是空表：钥匙串读抛错 / 内容不是合法 JSON 对象 → 记 TokenStoreLoadError，读返回空，一切会改表的
 * 写入同步抛出该错误（登录 / 刷新的调用方按既有错误路径提示用户），钥匙串原文原样保留、不覆盖；
 * 只有明确读到「无条目」才视为空表。onDidChange、下一次写入尝试、reloadTokens() 都会再试一次读。
 */

import * as vscode from "vscode";
import { debug, error, warn } from "../log";

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  /** 绝对过期时刻（ms）。缺省=未知，不主动刷新，401 时再刷。 */
  expiresAt?: number;
  tokenType?: string;
  idToken?: string;
  /** 账号展示：邮箱 / 用户名。 */
  email?: string;
  /** 厂商侧账号 id（Codex 的 chatgpt_account_id 等）。 */
  accountId?: string;
  /** 订阅档位等附加展示信息（Codex 的 plus/pro/team）。 */
  plan?: string;
  /** 设备码流程用的设备 id（Kimi 要求请求头里的设备 id 与登录时一致）。 */
  deviceId?: string;
  /** 厂商私有附加字段（xAI 的 token_endpoint 等）。 */
  extra?: Record<string, string>;
  /** 上次成功刷新/登录的时刻。 */
  updatedAt: number;
}

const SECRET_KEY = "api4kiro.oauthTokens.v1";
const STATE_KEY = "oauthTokens.v1";
/** blob 里的版本元数据键（不是 provider id：`$` 不出现在 tokenKeyOf 生成的键里）。老版本读到会当作无 accessToken 的条目跳过。 */
const META_KEY = "$meta";
/** 祖先 stamp 保留条数；超过说明短时间内写得太密，冲突判定改为「不确定」。 */
const ANCESTRY_LEN = 8;
/** 一次落盘里「写—读回—被盖—重放」的最多轮数，之后转入定时重试。 */
const COMMIT_ROUNDS = 4;
/** 落盘失败（钥匙串读 / 写抛错）后的重试间隔：5s 起指数退避、封顶 60s；成功一次归零。 */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

type Table = Record<string, OAuthToken>;
/** 一次改动：对任何一张表按键回放（内存视图回放一次，落盘时对钥匙串上的最新表再回放一次）。 */
type Op = (table: Table) => void;
/** blob 版本：本次写入的 stamp 与最近若干祖先（最新在前）。老版本写的 blob 没有它。 */
interface Meta {
  stamp: string;
  ancestry: string[];
}
interface Snapshot {
  table: Table;
  source: Source;
  meta?: Meta;
}

export type TokenStoreLoadErrorCode = "keychain_read_failed" | "corrupt";

/** 钥匙串读不到 / 数据非法。可识别（instanceof + code），message 直接面向用户。 */
export class TokenStoreLoadError extends Error {
  readonly code: TokenStoreLoadErrorCode;
  /** 底层原因（钥匙串错误文本 / 数据来源与长度），不含 token。 */
  readonly detail: string;
  constructor(code: TokenStoreLoadErrorCode, message: string, detail: string) {
    super(message);
    this.name = "TokenStoreLoadError";
    this.code = code;
    this.detail = detail;
  }
}

const REFUSED = "为避免覆盖已保存的账号，本次改动未写入";

function toLoadError(e: unknown): TokenStoreLoadError {
  if (e instanceof TokenStoreLoadError) {
    return e;
  }
  const detail = (e as Error)?.message || String(e);
  return new TokenStoreLoadError("keychain_read_failed", `登录 token 存储不可用：读取系统钥匙串失败（${detail}）。${REFUSED}；请重启 Kiro 后重试。`, detail);
}

function normalize(raw: unknown): OAuthToken | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const accessToken = typeof o.accessToken === "string" ? o.accessToken : "";
  if (!accessToken) {
    return undefined;
  }
  const str = (k: string) => (typeof o[k] === "string" && (o[k] as string) ? (o[k] as string) : undefined);
  const extra =
    o.extra && typeof o.extra === "object"
      ? Object.fromEntries(Object.entries(o.extra as Record<string, unknown>).filter(([, v]) => typeof v === "string"))
      : undefined;
  return {
    accessToken,
    refreshToken: str("refreshToken"),
    expiresAt: typeof o.expiresAt === "number" && isFinite(o.expiresAt) ? o.expiresAt : undefined,
    tokenType: str("tokenType"),
    idToken: str("idToken"),
    email: str("email"),
    accountId: str("accountId"),
    plan: str("plan"),
    deviceId: str("deviceId"),
    extra: extra as Record<string, string> | undefined,
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : Date.now(),
  };
}

/**
 * 严格解析整表：不是合法 JSON 对象 → corrupt（不吞成空表；JSON.parse 的报错文本可能带原文片段，不外传）。
 * 条目级别仍宽松：缺 accessToken 的条目跳过。
 */
function parseStrict(text: string, where: string): { table: Table; meta?: Meta } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TokenStoreLoadError("corrupt", `登录 token 存储不可用：${where}里保存的 token 数据不是合法的 JSON 对象。${REFUSED}；请查看「API4Kiro」输出日志。`, `${where} blob is not a JSON object (${text.length} chars)`);
  }
  const table: Table = {};
  let meta: Meta | undefined;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === META_KEY) {
      meta = parseMeta(v);
      continue;
    }
    const t = normalize(v);
    if (t) {
      table[k] = t;
    }
  }
  return { table, meta };
}

function parseMeta(v: unknown): Meta | undefined {
  if (!v || typeof v !== "object") {
    return undefined;
  }
  const o = v as Record<string, unknown>;
  if (typeof o.stamp !== "string" || !o.stamp) {
    return undefined;
  }
  const ancestry = Array.isArray(o.ancestry) ? o.ancestry.filter((s): s is string => typeof s === "string" && !!s).slice(0, ANCESTRY_LEN) : [];
  return { stamp: o.stamp, ancestry };
}

function newStamp(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/** 读到的表（meta）是否已经包含了我们的某次写入 `stamp`：等于它、或祖先里有它。 */
function includesStamp(meta: Meta | undefined, stamp: string | undefined): boolean {
  if (!stamp) {
    return true;
  }
  if (!meta) {
    return false;
  }
  return meta.stamp === stamp || meta.ancestry.includes(stamp);
}

function cloneToken(t: OAuthToken): OAuthToken {
  return t.extra ? { ...t, extra: { ...t.extra } } : { ...t };
}

function secretsOf(c: vscode.ExtensionContext | undefined): vscode.SecretStorage | undefined {
  const s = (c as { secrets?: vscode.SecretStorage } | undefined)?.secrets;
  return s && typeof s.get === "function" && typeof s.store === "function" ? s : undefined;
}

type Source = "secrets" | "state" | "none";

/**
 * 一个窗口里的 token 仓实例。生产代码只用文件末尾的默认实例；导出类是为了让测试造两个实例共用一份
 * SecretStorage 来模拟两个窗口。
 */
export class TokenStore {
  private ctx: vscode.ExtensionContext | undefined;
  /** 最近一次成功读到 / 写入的整表（我们所知的钥匙串最新状态）。 */
  private base: Table = {};
  /** 本窗口已应用到视图、尚未落盘的改动，按发生顺序。 */
  private pending: Op[] = [];
  /** 同步读用的视图：base 回放 pending。 */
  private view: Table = {};
  /** 所有异步步骤（加载 / 落盘 / 重读 / 测试清空）串成一条链，天然互斥。 */
  private chain: Promise<void> = Promise.resolve();
  /** init / reset 递增；跨 await 的步骤据此丢弃过期结果。 */
  private generation = 0;
  /** 本窗口上一次成功提交：写入的 stamp 与那批改动。别的窗口若从没见过这个 stamp 的底稿写入，就把这批改动重放回去。 */
  private lastCommitStamp: string | undefined;
  private lastCommitted: Op[] = [];
  private loadError: TokenStoreLoadError | undefined;
  private subscription: vscode.Disposable | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private retryMs = 0;
  private readonly listeners = new Set<() => void>();

  /** 启动时调用；从 SecretStorage（或 globalState）加载整表并订阅变更。读失败不抛，记 loadError。 */
  async init(context: vscode.ExtensionContext): Promise<void> {
    this.subscription?.dispose();
    this.subscription = undefined;
    this.generation++;
    this.clearRetry();
    this.ctx = context;
    this.base = {};
    this.pending = [];
    this.lastCommitStamp = undefined;
    this.lastCommitted = [];
    this.loadError = undefined;
    this.rebuildView();
    this.enqueue(() => this.load(context));
    await this.chain;
    this.subscribe(context);
  }

  /** token 表变化时通知（UI 刷新登录状态）；别的窗口改过并被本窗口读到时也会通知。 */
  onChanged(l: () => void): vscode.Disposable {
    this.listeners.add(l);
    return { dispose: () => this.listeners.delete(l) };
  }

  getToken(key: string): OAuthToken | undefined {
    return this.view[key];
  }

  hasToken(key: string): boolean {
    return !!this.view[key]?.accessToken;
  }

  setToken(key: string, token: OAuthToken): void {
    const value = cloneToken({ ...token, updatedAt: token.updatedAt || Date.now() });
    this.mutate((t) => {
      t[key] = cloneToken(value);
    });
  }

  deleteToken(key: string): void {
    if (!this.view[key]) {
      return;
    }
    this.mutate((t) => {
      delete t[key];
    });
  }

  /** 删掉某 provider 的全部 token（裸键 + 所有 providerId/cN 键，含别的窗口刚加进来的）。删 provider 时用。 */
  deleteProviderTokens(providerId: string): void {
    const matches = (k: string) => k === providerId || k.startsWith(providerId + "/");
    if (!Object.keys(this.view).some(matches)) {
      return;
    }
    this.mutate((t) => {
      for (const k of Object.keys(t)) {
        if (matches(k)) {
          delete t[k];
        }
      }
    });
  }

  /** 复制一份 token（「创建副本」时新 provider 共用同一账号）。 */
  copyToken(fromKey: string, toKey: string): void {
    if (!this.view[fromKey]) {
      return;
    }
    this.mutate((t) => {
      const s = t[fromKey];
      if (s) {
        t[toKey] = cloneToken(s);
      }
    });
  }

  /** 把 token 从一个键挪到另一个键（删 c1 时把下一把提升为首条；源键没有 token 则目标键也清掉）。 */
  moveToken(fromKey: string, toKey: string): void {
    this.mutate((t) => {
      const s = t[fromKey];
      delete t[fromKey];
      if (s) {
        t[toKey] = s;
      } else {
        delete t[toKey];
      }
    });
  }

  /** 等待未完成的落盘（测试 / 停用时用）；有积压的改动就再试一次。 */
  flush(): Promise<void> {
    if (this.pending.length) {
      this.enqueue(() => this.persistPending());
    }
    return this.chain;
  }

  /** 主动重读钥匙串（onDidChange 之外的补救入口）。 */
  reload(): Promise<void> {
    this.enqueue(() => this.reloadNow());
    return this.chain;
  }

  /** 加载失败（钥匙串读错 / 数据非法）时的错误；非空期间一切会改表的写入都抛同样的错误。 */
  loadFailure(): TokenStoreLoadError | undefined {
    return this.loadError;
  }

  /** 仅测试用：清内存，并把持久层里的整表一起清掉（否则下一次落盘会把上一条用例的账号合并回来）。 */
  resetForTest(): void {
    this.generation++;
    this.clearRetry();
    this.base = {};
    this.pending = [];
    this.lastCommitStamp = undefined;
    this.lastCommitted = [];
    this.loadError = undefined;
    this.rebuildView();
    const c = this.ctx;
    if (c) {
      this.enqueue(async () => {
        const sec = secretsOf(c);
        if (sec) {
          if (typeof sec.delete === "function") {
            await sec.delete(SECRET_KEY);
          } else {
            await sec.store(SECRET_KEY, "{}");
          }
        }
        await c.globalState.update(STATE_KEY, undefined);
      });
    }
  }

  // ------------------------------------------------------------------ 内部

  private mutate(op: Op): void {
    this.assertWritable();
    op(this.view);
    if (this.ctx) {
      this.pending.push(op);
      this.enqueue(() => this.persistPending());
    } else {
      // 没有 ExtensionContext（未 init 的测试）：没有落盘目标，内存即全部
      op(this.base);
    }
    this.emit();
  }

  private assertWritable(): void {
    const le = this.loadError;
    if (!le) {
      return;
    }
    // 顺手再试一次读：钥匙串若只是暂时性故障，用户下一次重试就能成功
    this.enqueue(() => this.reloadNow());
    throw new TokenStoreLoadError(le.code, le.message, le.detail);
  }

  private enqueue(step: () => Promise<void>): void {
    const safe = () => step().catch((e) => error("oauth token store: step failed:", (e as Error)?.message || String(e)));
    this.chain = this.chain.then(safe, safe);
  }

  private async load(c: vscode.ExtensionContext): Promise<void> {
    const gen = this.generation;
    let snap: Snapshot = { table: {}, source: "none" };
    let le: TokenStoreLoadError | undefined;
    try {
      snap = await this.readStorage(c);
    } catch (e) {
      le = toLoadError(e);
    }
    if (gen !== this.generation) {
      return;
    }
    if (le) {
      this.base = {};
      this.loadError = le;
      this.rebuildView();
      error("oauth token store: load failed, token writes are refused until a reload succeeds:", le.code, le.detail);
      return;
    }
    this.adopt(snap);
    debug("oauth token store loaded", { providers: Object.keys(snap.table), source: snap.source });
    if (snap.source === "state" && secretsOf(c)) {
      // 老数据 / 回退存储里的明文迁进钥匙串；写成功后 writeStorage 会顺手清掉 globalState
      try {
        await this.writeStorage(c, snap.table, undefined);
      } catch (e) {
        warn("oauth token store: migrating globalState to secrets failed, staying on globalState:", (e as Error)?.message || String(e));
      }
    }
  }

  /**
   * 读—改—写—读回：以钥匙串上的最新整表为底，只回放本窗口积压的改动，整体写回，再读回确认自己的 stamp 还在
   * （被别的窗口在这几毫秒内盖掉就换最新底稿重来，最多 COMMIT_ROUNDS 轮）。读不到最新表就不写。
   */
  private async persistPending(): Promise<void> {
    const c = this.ctx;
    if (!c || this.pending.length === 0) {
      return;
    }
    const gen = this.generation;
    try {
      for (let round = 1; round <= COMMIT_ROUNDS; round++) {
        const fresh = await this.readStorage(c);
        if (gen !== this.generation) {
          return;
        }
        const ops = this.pending.slice();
        for (const op of ops) {
          op(fresh.table);
        }
        const written = await this.writeStorage(c, fresh.table, fresh.meta);
        if (gen !== this.generation) {
          return;
        }
        // 读回：钥匙串里是我们刚写的（或别人已经基于它再写了一版）→ 提交成功
        const back = await this.readStorage(c);
        if (gen !== this.generation) {
          return;
        }
        if (includesStamp(back.meta, written.stamp)) {
          this.pending.splice(0, ops.length);
          this.lastCommitStamp = written.stamp;
          this.lastCommitted = ops;
          this.retryMs = 0;
          this.adopt(back);
          return;
        }
        warn(`oauth token store: another window overwrote the token blob during commit (round ${round}/${COMMIT_ROUNDS}), replaying ${ops.length} change(s) on the newest table`);
      }
      // 连续被盖：改动留在内存，稍后再试（视图里一直可见）
      this.armRetry();
    } catch (e) {
      if (gen !== this.generation) {
        return;
      }
      const why = e instanceof TokenStoreLoadError ? `${e.code}: ${e.detail}` : (e as Error)?.message || String(e);
      error("oauth token store: persist deferred, changes stay in memory and will be retried:", why);
      this.armRetry();
    }
  }

  /**
   * 别的窗口改过（onDidChange）/ 主动重读：整表换成钥匙串上的最新版，本窗口积压的改动照旧叠在上面。
   * 若最新版的祖先里没有本窗口上一次提交的 stamp（对方写入时的底稿从没见过我们那次写，我们的改动被盖了）→
   * 把那批改动重放进 pending 再落盘一次。祖先已满仍找不到 → 不确定，不重放，只记 warn。
   */
  private async reloadNow(): Promise<void> {
    const c = this.ctx;
    if (!c) {
      return;
    }
    const gen = this.generation;
    let snap: Snapshot;
    try {
      snap = await this.readStorage(c);
    } catch (e) {
      if (gen !== this.generation) {
        return;
      }
      const le = toLoadError(e);
      if (this.loadError) {
        this.loadError = le;
      }
      warn("oauth token store: reload failed, keeping the in-memory table:", le.code, le.detail);
      return;
    }
    if (gen !== this.generation) {
      return;
    }
    const mine = this.lastCommitStamp;
    if (mine && this.lastCommitted.length && !includesStamp(snap.meta, mine)) {
      const ancestryFull = !!snap.meta && snap.meta.ancestry.length >= ANCESTRY_LEN;
      if (ancestryFull) {
        warn("oauth token store: token blob changed by another window with a long history; cannot tell whether our last commit survived, not replaying");
      } else {
        warn(`oauth token store: another window wrote the token blob from a base that never saw our last commit; replaying ${this.lastCommitted.length} change(s)`);
        this.pending = [...this.lastCommitted, ...this.pending];
        this.lastCommitted = [];
        this.lastCommitStamp = undefined;
        this.enqueue(() => this.persistPending());
      }
    }
    this.adopt(snap);
  }

  private adopt(snap: Snapshot): void {
    const before = JSON.stringify(this.view);
    const hadError = !!this.loadError;
    this.base = snap.table;
    this.loadError = undefined;
    this.rebuildView();
    if (hadError || JSON.stringify(this.view) !== before) {
      this.emit();
    }
  }

  private rebuildView(): void {
    const v: Table = {};
    for (const [k, t] of Object.entries(this.base)) {
      v[k] = cloneToken(t);
    }
    for (const op of this.pending) {
      op(v);
    }
    this.view = v;
  }

  /**
   * 读整表。钥匙串抛错 → keychain_read_failed；有条目但不是合法 JSON 对象 → corrupt；
   * 钥匙串明确没有条目（undefined / 空串）→ 看 globalState（老数据 / 迁移未完成）；都没有 → 空表。
   */
  private async readStorage(c: vscode.ExtensionContext): Promise<Snapshot> {
    const sec = secretsOf(c);
    if (sec) {
      let text: string | undefined;
      try {
        text = await sec.get(SECRET_KEY);
      } catch (e) {
        throw toLoadError(e);
      }
      if (typeof text === "string" && text !== "") {
        return { ...parseStrict(text, "钥匙串"), source: "secrets" };
      }
    }
    const state = c.globalState.get<string>(STATE_KEY);
    if (typeof state === "string" && state !== "") {
      return { ...parseStrict(state, "globalState"), source: "state" };
    }
    return { table: {}, source: "none" };
  }

  /** 整体写回：blob = 表 + `$meta`（新 stamp，祖先 = 底稿的 stamp 及其祖先）。返回写入的 meta。 */
  private async writeStorage(c: vscode.ExtensionContext, table: Table, base: Meta | undefined): Promise<Meta> {
    const meta: Meta = { stamp: newStamp(), ancestry: base ? [base.stamp, ...base.ancestry].slice(0, ANCESTRY_LEN) : [] };
    const text = JSON.stringify({ ...table, [META_KEY]: meta });
    const sec = secretsOf(c);
    if (!sec) {
      await c.globalState.update(STATE_KEY, text);
      return meta;
    }
    await sec.store(SECRET_KEY, text);
    if (c.globalState.get(STATE_KEY) !== undefined) {
      // 钥匙串里已有正本，globalState 里的明文清掉（清不掉也不影响使用）
      try {
        await c.globalState.update(STATE_KEY, undefined);
      } catch {
        /* ignore */
      }
    }
    return meta;
  }

  private subscribe(c: vscode.ExtensionContext): void {
    const sec = secretsOf(c);
    if (!sec || typeof sec.onDidChange !== "function") {
      return;
    }
    try {
      const d = sec.onDidChange((e) => {
        if (!e || e.key === SECRET_KEY) {
          this.enqueue(() => this.reloadNow());
        }
      });
      if (d && typeof d.dispose === "function") {
        this.subscription = d;
        if (Array.isArray(c.subscriptions)) {
          c.subscriptions.push(d);
        }
      }
    } catch (e) {
      debug("oauth token store: secrets.onDidChange unavailable:", (e as Error)?.message || String(e));
    }
  }

  private armRetry(): void {
    if (this.retryTimer) {
      return;
    }
    this.retryMs = Math.min(this.retryMs ? this.retryMs * 2 : RETRY_BASE_MS, RETRY_MAX_MS);
    const t = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.pending.length) {
        this.enqueue(() => this.persistPending());
      }
    }, this.retryMs);
    if (typeof t.unref === "function") {
      t.unref();
    }
    this.retryTimer = t;
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.retryMs = 0;
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------------------
// 默认实例：生产代码与既有调用方都走这些函数
// ---------------------------------------------------------------------------------------

const store = new TokenStore();

/** 启动时调用；从 SecretStorage（或 globalState）加载整张表。读失败不抛：记错、读为空、写入拒绝。 */
export function initTokenStore(context: vscode.ExtensionContext): Promise<void> {
  return store.init(context);
}

/** token 表变化时通知（UI 刷新登录状态）。 */
export function onTokensChanged(l: () => void): vscode.Disposable {
  return store.onChanged(l);
}

export function getToken(providerId: string): OAuthToken | undefined {
  return store.getToken(providerId);
}

export function hasToken(providerId: string): boolean {
  return store.hasToken(providerId);
}

/** 写入一把 token。存储未能加载（钥匙串读错 / 数据非法）时抛 TokenStoreLoadError，不落盘。 */
export function setToken(providerId: string, token: OAuthToken): void {
  store.setToken(providerId, token);
}

export function deleteToken(key: string): void {
  store.deleteToken(key);
}

/** 删掉某 provider 的全部 token（裸键 + 所有 providerId/cN 键）。删 provider 时用。 */
export function deleteProviderTokens(providerId: string): void {
  store.deleteProviderTokens(providerId);
}

/** 复制一份 token（「创建副本」时新 provider 共用同一账号）。 */
export function copyToken(fromKey: string, toKey: string): void {
  store.copyToken(fromKey, toKey);
}

/** 把 token 从一个键挪到另一个键（删 c1 时把下一把提升为首条）。 */
export function moveToken(fromKey: string, toKey: string): void {
  store.moveToken(fromKey, toKey);
}

/** 等待未完成的落盘（测试 / 停用时用）。 */
export function flushTokens(): Promise<void> {
  return store.flush();
}

/** 加载失败（钥匙串读错 / 数据非法）时的错误；非空期间一切会改表的写入都抛同样的错误。 */
export function tokenStoreLoadError(): TokenStoreLoadError | undefined {
  return store.loadFailure();
}

/** 主动重读钥匙串（onDidChange 之外的补救入口）。 */
export function reloadTokens(): Promise<void> {
  return store.reload();
}

/** 仅测试用。 */
export function _resetTokenStoreForTest(): void {
  store.resetForTest();
}
