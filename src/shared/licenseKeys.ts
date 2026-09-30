// ライセンスキーの署名を確かめる公開鍵と、取り消したライセンスの一覧。
// 秘密鍵は製品にも、このリポジトリにも入れない（販売サイトの Secret と、開発者のパスワードマネージャーだけにある）。

export interface LicensePublicKey {
  /** Ed25519 の公開鍵（JWK の x。base64url で 32 バイト） */
  x: string;
  /** 決済の試験用の鍵。試験の設定（MXSTAGE_LICENSE_TEST=1）のときだけ受け付ける */
  test: boolean;
}

export const LICENSE_PUBLIC_KEYS: Readonly<Record<string, LicensePublicKey>> = {
  p1: { x: "qMbG0EI8QjUBHlu2jvc5f4o_yl90bfzgam4LYPa2XIs", test: false },
  s1: { x: "xnFjv-71c5ytMWqhvHazXxVt4xHzYF7oRLWHZzr0CJY", test: true },
};

/**
 * 取り消したライセンス（返金・不正）の ID。次の版から受け付けなくなる。
 * 期限は長くても請求期間 + 30 日なので、ここに載せるのは期限の前に止める必要があるものだけ。
 */
export const REVOKED_LICENSES: ReadonlySet<string> = new Set<string>([]);
