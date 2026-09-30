// 改名前（mxstudio）の置き場所からの移行。0.2.0 で mxstudio を MX Stage（mxstage）に改名した。
// 導入（scripts/setup-local.mjs の migrateLegacy）をやり直さずに更新した人のために、橋渡しの起動のときに
// 利用者の Skill（~/.config/mxstudio/skills/<名前>）と公開前の検査の語の一覧（publish-terms.txt）を
// 新しい置き場所（~/.config/mxstage）へ写す。
// - 写すのは、新しい置き場所にまだ無いものだけ。中身は書き換えない（写したあとの編集を上書きしない）。
// - 写し終えたら印（migrated-from-mxstudio.json）を書き、次からは何もしない（写したあとに消したものを写し直さない）。
//   導入も同じ印を見て、同じ印を書く。
// - 古い置き場所は消さない（利用者が確かめてから消す）。
// - 状態フォルダを環境変数で差し替えているとき（試験など）は、呼び出し側が enabled: false にする。

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { USER_SKILLS_DIR_NAME, userSkillsDirOf } from "./skills.ts";

/** 改名前の状態フォルダの名前（~/.config/mxstudio） */
export const LEGACY_STATE_DIR_NAME = "mxstudio";
/** 写し終えた印（新しい状態フォルダに置く。scripts/setup-local.mjs の LEGACY.migratedMarker と同じ） */
export const LEGACY_MIGRATED_MARKER = "migrated-from-mxstudio.json";
/** 公開前の検査の語の一覧（scripts/check-publish.mjs が読む） */
export const PUBLISH_TERMS_FILE = "publish-terms.txt";

export interface LegacyMigration {
  /** 新しい状態フォルダ（~/.config/mxstage） */
  stateDir: string;
  /** false なら何もしない（状態フォルダを差し替えているとき） */
  enabled: boolean;
  /** 省くと OS のホーム */
  home?: string;
  log?: (line: string) => void;
}

export interface LegacyMigrationResult {
  copied: string[];
  failed: string[];
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 改名前の状態フォルダ */
export function legacyStateDir(home: string = homedir()): string {
  return join(home, ".config", LEGACY_STATE_DIR_NAME);
}

/** 改名前の利用者の Skill のフォルダ */
export function legacyUserSkillsDir(home: string = homedir()): string {
  return join(legacyStateDir(home), USER_SKILLS_DIR_NAME);
}

/** 改名前の置き場所にだけある利用者の Skill と語の一覧を、新しい置き場所へ写す（1 回だけ） */
export function migrateLegacyFiles(opts: LegacyMigration): LegacyMigrationResult {
  const result: LegacyMigrationResult = { copied: [], failed: [] };
  if (!opts.enabled) return result;
  const from = legacyStateDir(opts.home ?? homedir());
  const marker = join(opts.stateDir, LEGACY_MIGRATED_MARKER);
  if (!isDir(from) || existsSync(marker)) return result;

  const skillsFrom = join(from, USER_SKILLS_DIR_NAME);
  const skillsTo = userSkillsDirOf(opts.stateDir);
  let names: string[] = [];
  try {
    names = isDir(skillsFrom) ? readdirSync(skillsFrom) : [];
  } catch (err) {
    result.failed.push(`${skillsFrom}（${message(err)}）`);
  }
  for (const name of names) {
    const source = join(skillsFrom, name);
    const target = join(skillsTo, name);
    if (!isDir(source) || existsSync(target)) continue;
    try {
      cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
      result.copied.push(name);
    } catch (err) {
      result.failed.push(`${name}（${message(err)}）`);
    }
  }
  const terms = join(from, PUBLISH_TERMS_FILE);
  if (isFile(terms) && !existsSync(join(opts.stateDir, PUBLISH_TERMS_FILE))) {
    try {
      mkdirSync(opts.stateDir, { recursive: true });
      copyFileSync(terms, join(opts.stateDir, PUBLISH_TERMS_FILE));
      result.copied.push(PUBLISH_TERMS_FILE);
    } catch (err) {
      result.failed.push(`${PUBLISH_TERMS_FILE}（${message(err)}）`);
    }
  }

  // 写せなかったものがあれば印を書かない（次の起動でもう一度写す）
  if (result.failed.length === 0) {
    try {
      mkdirSync(opts.stateDir, { recursive: true });
      writeFileSync(marker, `${JSON.stringify({ from, copied: result.copied, at: new Date().toISOString() }, null, 2)}\n`, "utf8");
    } catch {
      // 書けなくても困らない（新しい置き場所に既にあるものは写さない）
    }
  }
  if (result.copied.length > 0) opts.log?.(`改名前の置き場所（${from}）から写しました: ${result.copied.join(", ")}`);
  if (result.failed.length > 0) opts.log?.(`改名前の置き場所から写せませんでした: ${result.failed.join(" / ")}`);
  return result;
}
