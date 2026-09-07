/**
 * 在系统默认浏览器里打开一个 http(s) 链接，绕开 Kiro 的「是否要打开外部网站」确认框。
 *
 * 面板里点链接时我们自己已经弹过一次确认（面板内的「打开外部网站」框），再让 Kiro 对没信任过的域名
 * 问第二遍就多余了；vscode.env.openExternal 的那道询问扩展关不掉，所以这里直接交给操作系统：
 *  - Windows：rundll32 url.dll,FileProtocolHandler <url>（不经 cmd 解析，url 里的 & 不会被拆成命令）
 *  - macOS：open <url>
 *  - Linux：xdg-open <url>
 * 起不来（没有桌面环境 / 远程会话等）就退回 openExternal。只放 http / https，别的协议一律不开。
 */
import { spawn } from "child_process";
import * as vscode from "vscode";

export function isHttpUrl(url: string): boolean {
  return /^https?:\/\/[^\s"'<>]+$/i.test(url);
}

export async function openInBrowser(url: string): Promise<boolean> {
  if (!isHttpUrl(url)) {
    return false;
  }
  const launched = await new Promise<boolean>((resolve) => {
    let cmd: string;
    let args: string[];
    if (process.platform === "win32") {
      cmd = "rundll32.exe";
      args = ["url.dll,FileProtocolHandler", url];
    } else if (process.platform === "darwin") {
      cmd = "open";
      args = [url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
  if (launched) {
    return true;
  }
  try {
    return await vscode.env.openExternal(vscode.Uri.parse(url));
  } catch {
    return false;
  }
}
