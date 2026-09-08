import * as http from "http";
import { info, debug } from "./log";
import { getExtensionVersion } from "./config";
import { compareVersions, probeIdentity, registerYielder } from "./proxyIdentity";

const RETRY_MS = 2500;
/** 让位后等对方彻底松手再抢的时间。 */
const YIELD_SETTLE_MS = 300;

export type OwnershipListener = (owned: boolean) => void;

type BindResult = "ok" | "busy" | "error";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Owns a FIXED local port across multiple Kiro windows.
 *
 * 多实例模型：每个窗口都让 Kiro 指向同一个 127.0.0.1:<port>。第一个绑上端口的窗口
 * 成为 OWNER，服务所有窗口的请求；后来的窗口探到端口已被「自己人」持有就进入
 * STANDBY（自己不起服务，它的 Kiro 通过共享的 Global 端点配置访问 OWNER）。
 * STANDBY 会持续重试，OWNER 退出后端口释放，某个 STANDBY 无缝接管。端口固定，
 * 所以没人会去改那份共享的端点配置。
 *
 * **版本让位**：同版本按上面的先到先得。但如果持有者是**更旧的版本**，说明用户刚
 * 升级、旧扩展宿主还没死（常见于开着多个 Kiro 窗口时只重载了一个）。此时不能待机
 * ——那会导致升级后仍由旧代码应答且毫无提示。改为请求旧实例让位后接管。
 */
export class PortHolder {
  private server?: http.Server;
  private owned = false;
  private foreign = false;
  private stopped = false;
  private retryTimer?: NodeJS.Timeout;
  private readonly role: string;

  constructor(
    private readonly port: number,
    private readonly label: string,
    private readonly createServer: () => http.Server,
    private readonly onChange?: OwnershipListener
  ) {
    this.role = label.toLowerCase();
  }

  isOwner(): boolean {
    return this.owned;
  }

  /** True when the port is held by a NON-API2Kiro process (can't share). */
  hadForeignConflict(): boolean {
    return this.foreign;
  }

  getPort(): number {
    return this.port;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.tryAcquire();
    if (!this.owned) {
      this.scheduleRetry();
    }
  }

  /** One bind attempt. Does not probe or negotiate. */
  private bindOnce(): Promise<BindResult> {
    return new Promise((resolve) => {
      const server = this.createServer();
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("error", onError);
        try {
          server.close();
        } catch {
          /* ignore */
        }
        if (err.code === "EADDRINUSE") {
          resolve("busy");
        } else {
          info(`${this.label} bind error:`, err.message);
          resolve("error");
        }
      };
      server.once("error", onError);
      server.listen(this.port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        server.on("error", (e) => info(`${this.label} server error:`, (e as Error).message));
        this.server = server;
        this.owned = true;
        this.foreign = false;
        // 允许更新版本的实例把本实例顶下去（与我们顶掉旧实例是同一套协议的两端）。
        // 在真正持有端口时才登记：同一进程里同角色的待机实例不能顶掉持有者的登记。
        registerYielder(this.role, () => void this.release());
        info(`${this.label} OWNER on 127.0.0.1:${this.port}`);
        resolve("ok");
      });
    });
  }

  private async tryAcquire(): Promise<void> {
    const first = await this.bindOnce();
    if (first === "ok") {
      return;
    }
    if (first === "error") {
      this.owned = false;
      this.foreign = false;
      return;
    }

    // 身份验签与让位签名都绑定本端口的角色（krs / cps）：把探测中转给另一角色的合法实例换不来能用的签名。
    const holder = await probeIdentity(this.port, this.role);
    if (!holder) {
      // 端口被外部进程占着（包括 4.13.53 起「自称自己人但身份签名不过」的冒占者），无法共享，也不该去动它。
      this.owned = false;
      this.foreign = true;
      debug(`${this.label} port ${this.port} held by a foreign process`);
      return;
    }

    const mine = getExtensionVersion();
    const cmp = compareVersions(mine, holder.version);

    if (cmp > 0) {
      info(
        `${this.label} 端口 ${this.port} 被旧版本 v${holder.version} (pid ${holder.pid}) 占用，请求让位…`
      );
      // 4.13.53 起对方应答里带一次性 nonce，让位请求要对它签名（共享密钥）；更旧的对端不给 nonce，
      // 请求就不带签名头，对方也不看——升级路径与之前一致。
      const answer = await probeIdentity(this.port, this.role, mine, holder.nonce);
      if (answer?.yielding) {
        await delay(YIELD_SETTLE_MS);
        if ((await this.bindOnce()) === "ok") {
          info(`${this.label} 已从 v${holder.version} 接管`);
          return;
        }
      } else {
        info(
          `${this.label} 旧实例 v${holder.version} (pid ${holder.pid}) 不支持让位（早于本机制的版本）。` +
            `请**完全退出所有 Kiro 窗口**后重开，否则请求仍由旧代码应答。`
        );
      }
    } else if (cmp < 0) {
      info(`${this.label} 端口由更新的 v${holder.version} 持有，本实例待机`);
    } else {
      debug(`${this.label} port ${this.port} shared with same-version pid ${holder.pid}`);
    }

    this.owned = false;
    this.foreign = false;
  }

  /** 让出端口给更新版本的实例，随后继续重试（对方若退出，我们再接回来）。 */
  private async release(): Promise<void> {
    if (!this.server) {
      return;
    }
    info(`${this.label} 让位给更新版本，释放 127.0.0.1:${this.port}`);
    const server = this.server;
    this.server = undefined;
    this.owned = false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.onChange?.(false);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.owned) {
      return;
    }
    this.retryTimer = setTimeout(async () => {
      if (this.stopped || this.owned) {
        return;
      }
      await this.tryAcquire();
      if (this.owned) {
        info(`${this.label} took over as OWNER`);
        this.onChange?.(true);
      } else {
        this.scheduleRetry();
      }
    }, RETRY_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
    this.owned = false;
  }
}
