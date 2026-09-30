// MCP サーバ（stdio）。TOOL_DEFS の全ツールを登録し、runAt:"tab" のツールはローカル Hub 経由で
// 作業タブへ中継する。runAt:"worker" のツール（open_grid / list_skills / get_skill / save_skill /
// create_import_session）は橋渡しの中で完結させる。
// 会話（MCP のセッション）で最初のツール呼び出しの結果には、基本手順の Skill と利用者の Skill の一覧を添える（sessionGuide）。
// get_status と最初のツール呼び出しの結果には、古くなっているもの（橋渡しのコード・作業画面のビルド・配った Skill の写し）と
// 直し方も添える（src/bridge/freshness.ts）。

import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { RELAY_TIMEOUTS, RelayErrorCode, relayErrorMessage } from "../shared/protocol.ts";
import type { HubInvokeRequest, HubInvokeResponse, HubRpc, InvokeProgress } from "../shared/protocol.ts";
import { TOOL_DEFS, TOOL_NAMES, isReadOnlyTool, publishedInputSchema } from "../shared/toolDefs.ts";
import type { ToolName } from "../shared/toolDefs.ts";
import { updatesText } from "./freshness.ts";
import type { UpdateNotice } from "./freshness.ts";
import { readSkillCatalog, saveUserSkill } from "./skills.ts";
import { createProgressForwarder, progressTokenOf } from "./progress.ts";
import { IMPORT_MAX_BYTES } from "./importUpload.ts";
import type { ImportTicket } from "./importUpload.ts";
import type { TicketIssuer } from "./peer.ts";

/**
 * どのクライアントにも届く案内。Skill の入らないクライアント（Claude Desktop のチャット・Gemini など）には、決まりはこれと
 * ツールの説明、最初のツール呼び出しに添える基本手順（sessionGuide）でしか届かない。
 * 「Maximo のデータは作業画面のシートに読み込み、シートから読む」はツールの作りでも守る（scope_options も走査した行をシートにする）。
 */
export const SERVER_INSTRUCTIONS =
  "MX Stage は Maximo のデータ整備を作業画面（ブラウザのタブ）で行うツールです。最初に get_status を呼び、タブが無ければ open_grid の URL を利用者に案内してください。" +
  "最初のツール呼び出しの結果に MX Stage の基本手順と禁止事項（Skill）を添えます。必ず読んで従ってください。業務ごとの手順（利用者の Skill）は list_skills・get_skill で読めます。" +
  "Maximo のデータは必ず作業画面のシートに読み込み（load_sheet・load_master・scope_options）、シートから読んでください（query_rows・aggregate）。利用者が作業画面で同じデータを見て確かめられるようにするためです。" +
  "利用者が手順を残したいと言ったら、内容を見せて了承を得てから save_skill で利用者の Skill として保存してください。" +
  "Maximo への書き込みは利用者が作業画面で承認したときだけ行われます。API キーをチャットで求めないでください。";

/**
 * 会話で最初のツール呼び出しの結果に添える案内: 基本手順の Skill の本文と、利用者の Skill の一覧。
 * Skill 機能の無いクライアント（Claude Desktop のチャット・Gemini など）にも、LLM がどのツールを最初に呼んでも届く。
 * Skill 機能のあるクライアント（Claude Code）には重なるが、1 回だけなので付ける（どのクライアントでも同じ決まりで動かすため）
 */
export function sessionGuide(userSkillsDir: string | null): string {
  const catalog = readSkillCatalog(userSkillsDir);
  const primary = catalog.skills.find((s) => s.origin === "default");
  const users = catalog.skills.filter((s) => s.origin === "user");
  const parts = [
    "【MX Stage の基本手順と禁止事項（Skill: " +
      (primary?.name ?? "mxstage-workbench") +
      "）。この会話で最初のツール呼び出しの結果にだけ付けています。以後の作業はこれに従ってください】",
  ];
  if (primary !== undefined) parts.push(primary.body);
  parts.push(
    users.length > 0
      ? `## この PC の利用者の Skill（該当する作業では、始める前に get_skill で本文を読んで従う）\n\n${users.map((u) => `- ${u.name}: ${u.description}`).join("\n")}`
      : "## この PC の利用者の Skill\n\nまだありません。利用者が手順を残したいと言ったら、内容を見せて了承を得てから save_skill で保存します。",
  );
  return parts.join("\n\n");
}

/** 結果に案内を足す（structuredContent は変えず、文字の内容の後ろに足す） */
export function withGuide(result: CallToolResult, guide: string): CallToolResult {
  return { ...result, content: [...(result.content ?? []), { type: "text", text: guide }] };
}

/**
 * get_status の結果に更新の知らせを足す。structuredContent には updates（空なら載せない）、文字の内容には読む文を足す。
 * 知らせが無ければ結果をそのまま返す。
 */
export function withUpdates(result: CallToolResult, notices: readonly UpdateNotice[]): CallToolResult {
  const text = updatesText(notices);
  if (text === null) return result;
  const structured = result.structuredContent;
  return {
    ...result,
    ...(structured !== undefined && structured !== null && typeof structured === "object" ? { structuredContent: { ...structured, updates: notices } } : {}),
    content: [...(result.content ?? []), { type: "text", text }],
  };
}

/** 知らせを集める。失敗しても呼び出しは止めない（知らせは添え物） */
async function collectUpdates(deps: BridgeMcpDeps): Promise<UpdateNotice[]> {
  if (deps.checkUpdates === undefined) return [];
  try {
    return await deps.checkUpdates();
  } catch {
    return [];
  }
}

const RELAY_ERROR_NAMES = new Map<number, string>(Object.entries(RelayErrorCode).map(([name, code]) => [code, name]));

export interface BridgeMcpDeps {
  /** http://127.0.0.1:<port> */
  origin: string;
  hub: HubRpc;
  /** primary ではローカルの ImportTickets、client では primary での発行（src/bridge/coordinator.ts） */
  tickets: TicketIssuer;
  /** 橋渡しの版（MCP の serverInfo に載せる） */
  version: string;
  /** 利用者の Skill のフォルダ（~/.config/mxstage/skills）。null なら既定の Skill だけ */
  userSkillsDir?: string | null;
  /** 古くなっているものを調べる（src/bridge/freshness.ts の checkUpdates）。省くと知らせを添えない */
  checkUpdates?: () => Promise<UpdateNotice[]>;
}

export function jsonResult(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

export function relayErrorResult(code: RelayErrorCode, origin: string, detail?: string): CallToolResult {
  const error: Record<string, unknown> = { code, name: RELAY_ERROR_NAMES.get(code) ?? "ERROR", message: relayErrorMessage(code, origin) };
  if (detail) error.detail = detail;
  const value = { error };
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: true };
}

function simpleError(message: string, extra?: Record<string, unknown>): CallToolResult {
  const value = { error: { message, ...extra } };
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: true };
}

type ProgressCallback = (progress: InvokeProgress) => unknown;

/** Hub の呼び出し自体が失敗した場合: 読み取りは再試行できる切断、書き込みは結果不明として扱う */
async function invokeSafely(hub: HubRpc, req: HubInvokeRequest, onProgress?: ProgressCallback): Promise<HubInvokeResponse> {
  try {
    return await (onProgress ? hub.invoke(req, onProgress) : hub.invoke(req));
  } catch {
    return req.readOnly
      ? { ok: false, code: RelayErrorCode.TAB_DISCONNECTED, message: "", retryable: true }
      : { ok: false, code: RelayErrorCode.UNKNOWN_OUTCOME, message: "", retryable: false };
  }
}

/** タブの詳細メッセージを添える価値があるエラー（引数や列名の誤りなど） */
const DETAIL_CODES = new Set<number>([RelayErrorCode.TOOL_ERROR, RelayErrorCode.INVALID_ARGS, RelayErrorCode.FORBIDDEN, RelayErrorCode.STALE_REVISION, RelayErrorCode.TOO_LARGE]);

export interface TabToolOptions {
  onProgress?: ProgressCallback;
  now?: () => number;
}

/** 再試行にこれだけ残っていなければ送り直さない */
export const MIN_RETRY_BUDGET_MS = 1_000;

export async function runTabTool(deps: BridgeMcpDeps, name: ToolName, args: unknown, opts: TabToolOptions = {}): Promise<CallToolResult> {
  const def = TOOL_DEFS[name];
  const readOnly = isReadOnlyTool(name);
  const now = opts.now ?? (() => Date.now());
  const budgetMs = "long" in def && def.long ? RELAY_TIMEOUTS.maxDeadlineMs : RELAY_TIMEOUTS.readDeadlineMs;
  const req: HubInvokeRequest = {
    tool: name,
    args,
    readOnly,
    deadlineMs: budgetMs,
    idempotencyKey: crypto.randomUUID(),
  };
  const startedAt = now();
  let res = await invokeSafely(deps.hub, req, opts.onProgress);
  if (!res.ok && readOnly && res.retryable) {
    // 送り直しに 1 回目で使った分を差し引いた予算を与える（合計がクライアントのツールタイムアウトを超えないように）
    const remainingMs = budgetMs - (now() - startedAt);
    if (remainingMs >= MIN_RETRY_BUDGET_MS) res = await invokeSafely(deps.hub, { ...req, deadlineMs: remainingMs }, opts.onProgress);
  }
  if (res.ok) return res.result as CallToolResult;

  if (name === "get_status" && res.code === RelayErrorCode.NO_TAB) {
    return jsonResult({ tabConnected: false, appUrl: `${deps.origin}/app`, message: relayErrorMessage(RelayErrorCode.NO_TAB, deps.origin) });
  }
  const detail = DETAIL_CODES.has(res.code) && res.message && res.message !== relayErrorMessage(res.code, deps.origin) ? res.message.slice(0, 2000) : undefined;
  return relayErrorResult(res.code, deps.origin, detail);
}

/** MCP の呼び出し文脈のうち使う部分（試験で差し替えられるように） */
export interface ToolCallContext {
  mcpReq: Pick<ServerContext["mcpReq"], "_meta" | "notify">;
}

/** progressToken 付きの呼び出しでは、タブの進捗を notifications/progress にして送る */
export async function runTabToolWithProgress(deps: BridgeMcpDeps, name: ToolName, args: unknown, ctx: ToolCallContext): Promise<CallToolResult> {
  const token = progressTokenOf(ctx.mcpReq._meta);
  if (token === undefined) return runTabTool(deps, name, args);
  const forwarder = createProgressForwarder(token, (notification) => ctx.mcpReq.notify(notification));
  try {
    return await runTabTool(deps, name, args, { onProgress: forwarder.onProgress });
  } finally {
    await forwarder.close();
  }
}

async function tabConnected(hub: HubRpc): Promise<boolean> {
  try {
    const status = await hub.status();
    return status.tabs.length > 0;
  } catch {
    return false;
  }
}

export async function runWorkerTool(deps: BridgeMcpDeps, name: ToolName, args: Record<string, unknown>): Promise<CallToolResult> {
  const { origin } = deps;
  switch (name) {
    case "open_grid":
      return jsonResult({ appUrl: `${origin}/app`, settingsUrl: `${origin}/settings`, tabConnected: await tabConnected(deps.hub) });

    case "list_skills": {
      // origin: default（アプリ既定）/ user（利用者の Skill）。読み込めなかった利用者の Skill は problems に出す
      const catalog = readSkillCatalog(deps.userSkillsDir ?? null);
      const value: Record<string, unknown> = {
        skills: catalog.skills.map((s) => ({ name: s.name, description: s.description, version: s.version, origin: s.origin })),
      };
      if (catalog.userDir !== null) value.userSkillsDir = catalog.userDir;
      if (catalog.problems.length > 0) value.problems = catalog.problems;
      return jsonResult(value);
    }

    case "get_skill": {
      const catalog = readSkillCatalog(deps.userSkillsDir ?? null);
      const skill = catalog.skills.find((s) => s.name === args.name);
      if (!skill) {
        const problem = catalog.problems.find((p) => p.name === args.name && p.level === "error");
        return simpleError(
          problem ? `Skill "${String(args.name)}" は読み込めませんでした: ${problem.message}` : `Skill "${String(args.name)}" はありません。list_skills で名前を確認してください。`,
          { available: catalog.skills.map((s) => s.name) },
        );
      }
      return jsonResult({ name: skill.name, version: skill.version, description: skill.description, origin: skill.origin, body: skill.body });
    }

    case "save_skill": {
      const input = {
        name: String(args.name ?? ""),
        description: String(args.description ?? ""),
        body: String(args.body ?? ""),
        ...(typeof args.version === "string" ? { version: args.version } : {}),
        ...(args.overwrite === true ? { overwrite: true } : {}),
      };
      const saved = saveUserSkill(deps.userSkillsDir ?? null, input);
      if (!saved.ok) return simpleError(saved.message, saved.errors !== undefined ? { errors: saved.errors } : undefined);
      const value: Record<string, unknown> = {
        saved: saved.name,
        version: saved.version,
        created: saved.created,
        path: saved.path,
        message:
          `利用者の Skill ${saved.name} を${saved.created ? "保存" : "書き換え"}しました。次の会話から list_skills・get_skill で読めます。` +
          "Claude Code の Skill 機能に載せるには、MX Stage の導入をもう一度実行してください。",
      };
      if (saved.warnings.length > 0) value.warnings = saved.warnings;
      return jsonResult(value);
    }

    case "create_import_session": {
      let ticket: ImportTicket;
      try {
        ticket = await deps.tickets.create();
      } catch {
        return simpleError("アップロード URL を発行できませんでした。MX Stage の橋渡しが動いているか確かめてから、もう一度実行してください。");
      }
      const uploadUrl = `${origin}/import/${ticket.importId}`;
      const fileName = typeof args.fileName === "string" && args.fileName ? args.fileName : "file.xlsx";
      const safeName = fileName.replace(/["\\`$\r\n]/g, "_");
      return jsonResult({
        importId: ticket.importId,
        uploadUrl,
        expiresAt: new Date(ticket.expiresAt).toISOString(),
        maxBytes: IMPORT_MAX_BYTES,
        singleUse: true,
        curl: `curl -sS -X POST "${uploadUrl}" -H "X-File-Name: ${encodeURIComponent(safeName)}" -H "Content-Type: application/octet-stream" --data-binary "@${safeName}"`,
        instructions:
          "curl の --data-binary の @ の後をファイルのパスにして実行する（作業画面を開いておくこと。uploadUrl は 1 回だけ使える）。結果が ok: true なら describe_import にこの importId を渡して中身を確かめる。" +
          "ファイルのパスが分からない・送れないときは、利用者に開いている作業画面へファイルをドロップしてもらい、get_status の imports に出た importId を使う（作業画面を新しいタブで開き直すと、そちらが作業の対象に替わるので開き直さない）。",
      });
    }

    default:
      return simpleError(`ツール ${name} は橋渡しでは実行できません。`);
  }
}

export function buildBridgeMcpServer(deps: BridgeMcpDeps): McpServer {
  const server = new McpServer({ name: "mxstage", version: deps.version }, { instructions: SERVER_INSTRUCTIONS });
  // この会話（MCP のセッション。橋渡しのプロセス 1 つが 1 つを受け持つ）で、基本手順をもう添えたか
  let guided = false;
  for (const name of TOOL_NAMES) {
    const def = TOOL_DEFS[name];
    // 既定値を外した形で公開する（既定値は作業タブが入れる。src/shared/toolDefs.ts の publishedInputSchema）
    const inputSchema: z.ZodObject = publishedInputSchema(def.inputSchema);
    server.registerTool(
      name,
      { title: def.title, description: def.description, inputSchema, annotations: def.annotations },
      async (args: Record<string, unknown>, ctx: ServerContext) => {
        let result = def.runAt === "tab" ? await runTabToolWithProgress(deps, name, args, ctx) : await runWorkerTool(deps, name, args);
        const first = !guided;
        guided = true;
        // 更新の知らせは get_status のたびと、会話で最初の呼び出しに添える（最初が get_status なら 1 回だけ）。
        // get_status 以外の結果の structuredContent は変えず、文だけを足す
        if (name === "get_status") result = withUpdates(result, await collectUpdates(deps));
        else if (first) {
          const text = updatesText(await collectUpdates(deps));
          if (text !== null) result = withGuide(result, text);
        }
        return first ? withGuide(result, sessionGuide(deps.userSkillsDir ?? null)) : result;
      },
    );
  }
  return server;
}
