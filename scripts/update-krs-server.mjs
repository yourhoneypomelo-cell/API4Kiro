import fs from 'fs';

const filePath = 'E:/AI项目/反代项目/Gemini-3.8-flash 旁路 api2kiro/api2kiro-dual/src/krsServer.ts';
let text = fs.readFileSync(filePath, 'utf-8');

// 1. 导入 contextParser 相关函数与接口
if (!text.includes('import { extractRawContextBreakdown, allocateContextTokens, RawContextBreakdown } from "./contextParser";')) {
  text = 'import { extractRawContextBreakdown, allocateContextTokens, RawContextBreakdown } from "./contextParser";\n' + text;
}

// 2. 扩展 DispatchOpts
const oldDispatchOpts = `interface DispatchOpts {
  /** 发送前已剥图时给用户的提示（紧跟 messageMetadataEvent 之后输出）。 */
  notice?: string;
  fallback?: ImageFallback;
  /** 本次请求选中的凭证（key 池里的一把；单凭证 provider 就是它唯一的那把）。 */
  credential: Credential;
  /** 带图发出，且图片支持是用户手动钉成「支持」的（被拒时提示里要点明）。 */
  forcedImage?: boolean;
  /** Kiro 发来的原始请求头（Kiro 官方直通要整套镜像过去）。 */
  inHeaders?: http.IncomingHttpHeaders;
}`;

const newDispatchOpts = `interface DispatchOpts {
  /** 发送前已剥图时给用户的提示（紧跟 messageMetadataEvent 之后输出）。 */
  notice?: string;
  fallback?: ImageFallback;
  /** 本次请求选中的凭证（key 池里的一把；单凭证 provider 就是它唯一的那把）。 */
  credential: Credential;
  /** 带图发出，且图片支持是用户手动钉成「支持」的（被拒时提示里要点明）。 */
  forcedImage?: boolean;
  /** Kiro 发来的原始请求头（Kiro 官方直通要整套镜像过去）。 */
  inHeaders?: http.IncomingHttpHeaders;
  /** 提取的原始上下文成分字符数，供结束时按真实 inputTokens 严格无损分配。 */
  rawContextBreakdown?: RawContextBreakdown;
}`;

text = text.replace(oldDispatchOpts, newDispatchOpts);

// 3. 扩展 UsageMeta
const oldUsageMeta = `interface UsageMeta {
  provider: ProviderConfig;
  /** 本次实际用的凭证（key 池里的哪一把）；换 key 重发时会被更新。 */
  credential: Credential;
  /** Kiro 选中的模型（去 effort 后缀）。 */
  kiroModel: string;
  /** 实际发给上游的模型 id。 */
  upstreamModel: string;
  convId: string;
  startedAt: number;
}`;

const newUsageMeta = `interface UsageMeta {
  provider: ProviderConfig;
  /** 本次实际用的凭证（key 池里的哪一把）；换 key 重发时会被更新。 */
  credential: Credential;
  /** Kiro 选中的模型（去 effort 后缀）。 */
  kiroModel: string;
  /** 实际发给上游的模型 id。 */
  upstreamModel: string;
  convId: string;
  startedAt: number;
  rawContextBreakdown?: RawContextBreakdown;
}`;

text = text.replace(oldUsageMeta, newUsageMeta);

// 4. 在 handleGenerate 入口提取 rawContextBreakdown
const oldHandleGen = `    const version = this.context.extension.packageJSON.version || "0.0.0";
    const dispatch: DispatchOpts = { notice, fallback, credential, forcedImage, inHeaders };`;

const newHandleGen = `    const rawContextBreakdown = extractRawContextBreakdown(parsed);
    const version = this.context.extension.packageJSON.version || "0.0.0";
    const dispatch: DispatchOpts = { notice, fallback, credential, forcedImage, inHeaders, rawContextBreakdown };`;

text = text.replace(oldHandleGen, newHandleGen);

// 5. 在 retryOpts 中将 rawContextBreakdown 注入 meta
const oldRetryOpts = `meta: { provider, credential: opts.credential, kiroModel: baseModelId(kiroModel), upstreamModel, convId, startedAt: Date.now() },`;
const newRetryOpts = `meta: { provider, credential: opts.credential, kiroModel: baseModelId(kiroModel), upstreamModel, convId, startedAt: Date.now(), rawContextBreakdown: opts.rawContextBreakdown },`;
text = text.replace(oldRetryOpts, newRetryOpts);

// 6. 在 streamWithRetry 的正常结束落账点注入 contextBreakdown
const oldNormalRecord = `        // 用量页记账：每个上游 HTTP 请求一行。客户端中途取消也记（token 是上游已经
        // 算了钱的），只是标成非 ok；流内报错同理。
        const u = converter.meteringUsage();
        const now = Date.now();
        recordUsage({
          ts: now,
          providerId: meta.provider.id,
          providerName: meta.provider.name,
          credentialId: hasPool(meta.provider) ? meta.credential.id : undefined,
          model: meta.kiroModel,
          upstreamModel: meta.upstreamModel !== meta.kiroModel ? meta.upstreamModel : undefined,
          protocol,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheWriteTokens: u.cacheCreationTokens,
          latencyMs: now - meta.startedAt,
          firstTokenMs: firstTokenAt !== undefined ? firstTokenAt - meta.startedAt : undefined,
          status: statusCode,
          ok: !streamError && !clientClosed,
          error: streamError || (clientClosed ? "客户端取消" : undefined),
          conversationId: meta.convId,
        });`;

const newNormalRecord = `        // 用量页记账：每个上游 HTTP 请求一行。客户端中途取消也记（token 是上游已经
        // 算了钱的），只是标成非 ok；流内报错同理。
        const u = converter.meteringUsage();
        const now = Date.now();
        const cb = meta.rawContextBreakdown ? allocateContextTokens(meta.rawContextBreakdown, u.inputTokens) : undefined;
        recordUsage({
          ts: now,
          providerId: meta.provider.id,
          providerName: meta.provider.name,
          credentialId: hasPool(meta.provider) ? meta.credential.id : undefined,
          model: meta.kiroModel,
          upstreamModel: meta.upstreamModel !== meta.kiroModel ? meta.upstreamModel : undefined,
          protocol,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheWriteTokens: u.cacheCreationTokens,
          contextBreakdown: cb,
          latencyMs: now - meta.startedAt,
          firstTokenMs: firstTokenAt !== undefined ? firstTokenAt - meta.startedAt : undefined,
          status: statusCode,
          ok: !streamError && !clientClosed,
          error: streamError || (clientClosed ? "客户端取消" : undefined),
          conversationId: meta.convId,
        });`;

text = text.replace(oldNormalRecord, newNormalRecord);

// 7. 在 pumpKiroPassthrough 的落账点注入 contextBreakdown
const oldKiroRecord = `        debug(\`kiro passthrough: \${frames} frames, in=\${inputTokens} out=\${outputTokens} cacheRead=\${cacheRead}\`);
        const now = Date.now();
        recordUsage({
          ts: now,
          providerId: meta.provider.id,
          providerName: meta.provider.name,
          credentialId: hasPool(meta.provider) ? meta.credential.id : undefined,
          model: meta.kiroModel,
          upstreamModel: meta.upstreamModel !== meta.kiroModel ? meta.upstreamModel : undefined,
          protocol: "kiro",
          inputTokens,
          outputTokens,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          latencyMs: now - meta.startedAt,
          firstTokenMs: firstTokenAt !== undefined ? firstTokenAt - meta.startedAt : undefined,
          status: statusCode,
          ok: !streamError && !clientClosed,
          error: streamError || (clientClosed ? "客户端取消" : undefined),
          conversationId: meta.convId,
        });`;

const newKiroRecord = `        debug(\`kiro passthrough: \${frames} frames, in=\${inputTokens} out=\${outputTokens} cacheRead=\${cacheRead}\`);
        const now = Date.now();
        const cb = meta.rawContextBreakdown ? allocateContextTokens(meta.rawContextBreakdown, inputTokens) : undefined;
        recordUsage({
          ts: now,
          providerId: meta.provider.id,
          providerName: meta.provider.name,
          credentialId: hasPool(meta.provider) ? meta.credential.id : undefined,
          model: meta.kiroModel,
          upstreamModel: meta.upstreamModel !== meta.kiroModel ? meta.upstreamModel : undefined,
          protocol: "kiro",
          inputTokens,
          outputTokens,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          contextBreakdown: cb,
          latencyMs: now - meta.startedAt,
          firstTokenMs: firstTokenAt !== undefined ? firstTokenAt - meta.startedAt : undefined,
          status: statusCode,
          ok: !streamError && !clientClosed,
          error: streamError || (clientClosed ? "客户端取消" : undefined),
          conversationId: meta.convId,
        });`;

text = text.replace(oldKiroRecord, newKiroRecord);

fs.writeFileSync(filePath, text, 'utf-8');
console.log('krsServer.ts successfully updated with context breakdown extraction & allocation!');
