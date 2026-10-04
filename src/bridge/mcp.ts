// MCP サーバ（stdio）。TOOL_DEFS の全ツールを登録し、runAt:"tab" のツールはローカル Hub 経由で
// 作業タブへ中継する。runAt:"worker" のツール（open_grid / list_skills / get_skill / save_skill /
// create_import_session）は橋渡しの中で完結させる。
// 会話（MCP のセッション）で最初のツール呼び出しの結果には、目次の Skill と、既定・利用者の Skill の一覧を添える（sessionGuide）。
// 読み込み・変更・取り込み・反映などの入口のツールの結果には、その段階で読む既定の Skill の名前を添える（skillHints.ts）。
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
import type { SkillEntry } from "./skills.ts";
import { skillHintText, skillsForCall } from "./skillHints.ts";
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
  "MX Stage is a local workbench for correcting IBM Maximo data in a work screen (a browser tab). Call get_status first; if no tab is open, give the user the URL from open_grid. " +
  "The result of your first tool call includes the MX Stage rules and the index of Skills (procedures for basic operations, standard Maximo objects and the user's own tasks). Read it and follow it; read the Skills it names with get_skill before those steps. " +
  "Always load Maximo data into work screen sheets (load_sheet, load_master, scope_options) and read it from the sheets (query_rows, aggregate), so that the user can see and check the same data in the work screen. " +
  "If the user wants to keep a procedure, show it to them, get their agreement, then save it as a user Skill with save_skill. " +
  "Maximo is written to only when the user approves in the work screen. If a commit is blocked because a license is needed, tell the user what the work screen says and do not retry. Never ask for API keys in the chat. " +
  "Reply to the user in the language they use.";

/**
 * 会話で最初のツール呼び出しの結果に添える案内: 基本手順の Skill の本文と、利用者の Skill の一覧。
 * Skill 機能の無いクライアント（Claude Desktop のチャット・Gemini など）にも、LLM がどのツールを最初に呼んでも届く。
 * Skill 機能のあるクライアント（Claude Code）には重なるが、1 回だけなので付ける（どのクライアントでも同じ決まりで動かすため）
 */
export function sessionGuide(userSkillsDir: string | null): string {
  const catalog = readSkillCatalog(userSkillsDir);
  const index = catalog.skills.find((s) => s.category === "index");
  const parts = [
    "[MX Stage rules and Skill index (Skill: " +
      (index?.name ?? "mxstage-workbench") +
      "). Attached only to the result of the first tool call in this conversation. Follow it for the rest of the work.]",
  ];
  if (index !== undefined) parts.push(index.body);
  parts.push(skillCatalogText(catalog.skills));
  return parts.join("\n\n");
}

/**
 * 目次の一覧: 既定の Skill を層ごとに（基本動作・標準オブジェクト）、続けて利用者の Skill。
 * 各 Skill の name と description から作る（目次の本文に手で二重に書かない）。最初の結果と、get_skill で目次を読んだときに添える
 */
export function skillCatalogText(skills: readonly SkillEntry[]): string {
  const line = (s: SkillEntry) => `- ${s.name}: ${s.description}`;
  const core = skills.filter((s) => s.category === "core");
  const objects = skills.filter((s) => s.category === "object");
  const users = skills.filter((s) => s.origin === "user");
  const parts = [
    "## Built-in Skills (read the matching ones with get_skill before that step; tool results also name them)",
    `### Basic operations (any object)\n\n${core.map(line).join("\n")}`,
    `### Standard Maximo objects\n\n${objects.map(line).join("\n")}`,
    users.length > 0
      ? "## User Skills on this PC (made for this customer's environment; read a matching one with get_skill before starting. " +
        `It may replace steps of the built-in Skills, never the rules)\n\n${users.map(line).join("\n")}`
      : "## User Skills on this PC\n\nNone yet. When a procedure is worth keeping, follow mxstage-core-skills.",
  ];
  return parts.join("\n\n");
}

/**
 * この呼び出しで知らせる既定の Skill。この会話でまだ読んでも知らせてもいないもので、同梱されているものだけ。
 * 知らせたものは hinted に足す
 */
export function nextSkillHints(tool: ToolName, args: Record<string, unknown>, hinted: Set<string>): string[] {
  const builtIn = new Set(readSkillCatalog(null).skills.map((s) => s.name));
  const names = skillsForCall(tool, args).filter((n) => builtIn.has(n) && !hinted.has(n));
  for (const n of names) hinted.add(n);
  return names;
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
        skills: catalog.skills.map((s) => ({ name: s.name, description: s.description, version: s.version, origin: s.origin, category: s.category })),
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
          problem ? `Skill "${String(args.name)}" could not be read: ${problem.message}` : `There is no Skill "${String(args.name)}". Check the name with list_skills.`,
          { available: catalog.skills.map((s) => s.name) },
        );
      }
      // 目次は、本文に Skill の一覧を足して返す（一覧は各 Skill の説明から作るので、本文には書いていない）
      const body = skill.category === "index" ? `${skill.body}\n\n${skillCatalogText(catalog.skills)}` : skill.body;
      return jsonResult({ name: skill.name, version: skill.version, description: skill.description, origin: skill.origin, category: skill.category, body });
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
          `${saved.created ? "Saved" : "Replaced"} the user Skill ${saved.name}. It can be read with list_skills and get_skill from the next conversation on. ` +
          "To make it available to the Skill feature of Claude Code, run the MX Stage setup again.",
      };
      if (saved.warnings.length > 0) value.warnings = saved.warnings;
      return jsonResult(value);
    }

    case "create_import_session": {
      let ticket: ImportTicket;
      try {
        ticket = await deps.tickets.create();
      } catch {
        return simpleError("Could not issue an upload URL. Check that the MX Stage bridge is running, then try again.");
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
          "Run curl with the file path after the @ of --data-binary (the work screen must be open; uploadUrl can be used once). If the result is ok: true, pass this importId to describe_import to check the contents. " +
          "If you do not know the file path or cannot send it, ask the user to drop the file on the open work screen and use the importId that appears in imports of get_status (do not reopen the work screen in a new tab: the new tab would become the target of the work).",
      });
    }

    default:
      return simpleError(`The tool ${name} cannot run in the bridge.`);
  }
}

export function buildBridgeMcpServer(deps: BridgeMcpDeps): McpServer {
  const server = new McpServer({ name: "mxstage", version: deps.version }, { instructions: SERVER_INSTRUCTIONS });
  // この会話（MCP のセッション。橋渡しのプロセス 1 つが 1 つを受け持つ）で、基本手順をもう添えたか
  let guided = false;
  // この会話で読んだ・知らせた既定の Skill（同じ Skill を何度も知らせない）
  const hinted = new Set<string>();
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
        if (first) result = withGuide(result, sessionGuide(deps.userSkillsDir ?? null));
        if (name === "get_skill" && typeof args.name === "string") hinted.add(args.name);
        const hint = skillHintText(nextSkillHints(name, args, hinted));
        return hint === null ? result : withGuide(result, hint);
      },
    );
  }
  return server;
}
