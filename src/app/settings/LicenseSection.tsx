// 設定の「ライセンス」。この PC のライセンスキー（1 本番環境に 1 つ）を見る・追加する・外す。
// キーは貼り付けて追加する（ドロップでは受けない）。確かめるのは橋渡しで、キーそのものは画面に出さない。

import { Button, Layer, Tag, TextArea } from "@carbon/react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { LicenseEntry } from "../../shared/license";
import type { LicenseClient } from "../license/client";
import { PRICING_URL, licenseMessages as m } from "../license/messages";
import { Notice } from "../ui/Notice";

function formatDate(iso: string | undefined): string {
  if (iso === undefined) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

function LicenseItem({ entry, onRemove }: { entry: LicenseEntry; onRemove: (() => void) | null }) {
  const s = m().section;
  return (
    <li className="license-item">
      <div className="license-head">
        <strong>{entry.org ?? entry.licenseId}</strong>
        <Tag type={entry.state === "valid" ? "green" : "red"} size="sm">
          {s.state[entry.state]}
        </Tag>
        {entry.test && (
          <Tag type="purple" size="sm">
            {s.test}
          </Tag>
        )}
        {entry.bundled && (
          <Tag type="cool-gray" size="sm">
            {s.bundled}
          </Tag>
        )}
      </div>
      {entry.state === "invalid" && entry.problem !== undefined && <p className="muted small">{m().problem[entry.problem]}</p>}
      <dl className="kv">
        <dt>{s.hosts}</dt>
        <dd>
          {(entry.hosts ?? []).map((h) => (
            <code key={h} className="mono license-host">
              {h}
            </code>
          ))}
        </dd>
        <dt>{s.expires}</dt>
        <dd>{formatDate(entry.expiresAt)}</dd>
        <dt>{s.licenseId}</dt>
        <dd>
          <code className="mono">{entry.licenseId}</code>
        </dd>
      </dl>
      {onRemove && (
        <Button kind="ghost" size="sm" onClick={onRemove}>
          {s.remove}
        </Button>
      )}
    </li>
  );
}

export function LicenseSection({ license, confirm }: { license: LicenseClient; confirm?: (message: string) => boolean }) {
  const s = m().section;
  const snapshot = useSyncExternalStore(
    useCallback((l: () => void) => license.subscribe(l), [license]),
    useCallback(() => license.snapshot(), [license]),
  );
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const confirmFn = confirm ?? ((q: string) => window.confirm(q));

  useEffect(() => {
    void license.refresh();
  }, [license]);

  const add = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await license.save(text);
      if (res.ok) {
        setText("");
        setNotice({ kind: "success", text: s.saved(res.license.org ?? res.license.licenseId) });
      } else {
        setNotice({ kind: "error", text: m().problem[res.problem] });
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: LicenseEntry) => {
    if (!confirmFn(`${s.remove}: ${entry.org ?? entry.licenseId}（${(entry.hosts ?? []).join(", ")}）`)) return;
    if (await license.remove(entry.licenseId)) setNotice({ kind: "success", text: s.removed });
  };

  return (
    <section className="card license">
      <h2>{s.title}</h2>
      <p className="muted">{s.intro}</p>
      {snapshot.status === "unavailable" && <Notice kind="warning">{s.unavailable}</Notice>}
      {snapshot.status === "ready" && snapshot.licenses.length === 0 && <p className="muted small">{s.none}</p>}
      {snapshot.licenses.length > 0 && (
        <ul className="plain license-list">
          {snapshot.licenses.map((entry) => (
            <LicenseItem key={`${entry.licenseId}${entry.bundled ? ":bundled" : ""}`} entry={entry} onRemove={entry.bundled ? null : () => void remove(entry)} />
          ))}
        </ul>
      )}
      <Layer>
        <TextArea
          id="license-key"
          labelText={s.pasteLabel}
          placeholder={s.pastePlaceholder}
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </Layer>
      {notice && (
        <Notice kind={notice.kind} role={notice.kind === "error" ? "alert" : "status"}>
          {notice.text}
        </Notice>
      )}
      <div className="actions">
        <Button kind="primary" onClick={() => void add()} disabled={busy || text.trim() === ""}>
          {busy ? s.saving : s.save}
        </Button>
        <Button kind="tertiary" href={PRICING_URL} target="_blank" rel="noopener noreferrer">
          {s.buy}
        </Button>
      </div>
      <p className="muted small">{s.share}</p>
    </section>
  );
}
