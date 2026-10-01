// 1 つのファイルにまとめて配る形（.mcpb。scripts/build-bridge.mjs が作る）で動いているか。
// まとめるときに esbuild の define で __MXSTAGE_BUNDLE_VERSION__ を版の文字列に置き換える。
// リポジトリから node --experimental-strip-types で動かすときは置き換わらないので null。
// 同梱のときは、版を package.json から読まず、画面は隣の app/ から配り、git を前提にした更新の知らせを出さない。

declare const __MXSTAGE_BUNDLE_VERSION__: string | undefined;

export interface BundleInfo {
  version: string;
}

export const BUNDLE: BundleInfo | null = typeof __MXSTAGE_BUNDLE_VERSION__ === "string" ? { version: __MXSTAGE_BUNDLE_VERSION__ } : null;
