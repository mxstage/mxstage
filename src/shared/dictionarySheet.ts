// 辞書のシートの列名（作業画面の辞書のタブ・ストアの当てはめ・ツールの説明が共に使う）。
// 列名は英字（AI が add_rows・patch_cells で使う）。画面では見出しを日本語で出し、列名は出さない。

/** 書き方（ファイルでの書き方。正規表現のときはパターン） */
export const DICT_FIND = "FIND";
/** 正しい名前 */
export const DICT_TO = "TO";
/** 合わせ方（text・regex） */
export const DICT_MODE = "MODE";
/** 根拠のメモ */
export const DICT_NOTE = "NOTE";
/** 最後に変えた人と日時（読み取り専用） */
export const DICT_UPDATED = "UPDATED";

export const DICT_COLUMNS = [DICT_FIND, DICT_TO, DICT_MODE, DICT_NOTE, DICT_UPDATED] as const;
