/**
 * 多窗口握手（proxyIdentity.ts）用的共享密钥：每台机器每个用户一枚随机 32 字节，所有 Kiro 窗口共享。
 *
 * 存放在 `context.globalStorageUri` 下的 `identity.key`（各窗口同一路径；该目录本身只对当前用户可读，
 * 类 Unix 下文件再收紧到 0600）。创建用 `open(..., "wx")` 独占：两窗同时首次启动时只有一方能建成，
 * 另一方读胜者写入的内容；胜者「已 open 未 write」的空窗期里失败方会读到空文件，所以读取带短重试。
 *
 * 密钥本身与文件路径都不得进日志、不得进任何 HTTP 响应体（调用方只记 err.code）。
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { warn } from "./log";
import { setIdentityKey } from "./proxyIdentity";

export const IDENTITY_KEY_FILE = "identity.key";
const KEY_BYTES = 32;
const KEY_HEX_RE = /^[0-9a-f]{64}$/;
/** 失败方等胜者把内容写完：20ms × 50 = 1s 上限，正常几毫秒内就读到。 */
const READ_RETRIES = 50;
const READ_RETRY_MS = 20;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 读取或创建共享密钥。文件已存在则读取其内容；不存在则独占创建。
 * 抛错表示目录不可用或文件长期无效（例如内容被人改坏），由调用方降级。
 */
export async function ensureKey(dir: string): Promise<Buffer> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, IDENTITY_KEY_FILE);
  for (let attempt = 0; attempt <= READ_RETRIES; attempt++) {
    const created = tryCreate(file);
    if (created) {
      return created;
    }
    const existing = readKey(file);
    if (existing) {
      return existing;
    }
    await delay(READ_RETRY_MS);
  }
  throw new Error("identity key file exists but never held a valid key");
}

/** 独占创建并写入新密钥；已存在返回 undefined，其它错误抛出。 */
function tryCreate(file: string): Buffer | undefined {
  const key = crypto.randomBytes(KEY_BYTES);
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      return undefined;
    }
    throw e;
  }
  try {
    fs.writeSync(fd, key.toString("hex") + "\n");
  } finally {
    fs.closeSync(fd);
  }
  return key;
}

/** 读现有文件；不存在（刚被删）或内容尚不完整 / 无效时返回 undefined 让调用方重试。 */
function readKey(file: string): Buffer | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw e;
  }
  const hex = text.trim();
  return KEY_HEX_RE.test(hex) ? Buffer.from(hex, "hex") : undefined;
}

/**
 * 激活时调用：载入密钥并交给 proxyIdentity。失败不阻塞激活，只降级——本实例拒绝一切让位请求，
 * 探测对端时沿用旧的 token 判定（不比修复前更差）。返回是否载入成功。
 */
export async function initIdentityKey(context: { globalStorageUri: { fsPath: string } }): Promise<boolean> {
  try {
    setIdentityKey(await ensureKey(context.globalStorageUri.fsPath));
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // 只记错误码：fs 的报错文本带密钥文件路径，不进日志。
    warn("identity key unavailable; yield requests will be refused until it is:", err?.code || err?.name || "error");
    setIdentityKey(undefined);
    return false;
  }
}
