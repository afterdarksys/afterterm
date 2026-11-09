import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  accessKeyError, bucketError, normalizeEndpoint, regionError, secretPathError, type Prefs, type SecretSource,
} from "./prefs.ts";
import { usePanel } from "./usePanel.ts";

type ObjectList = { keys: string[]; prefixes: string[]; truncated: boolean };

type SettingsProps = {
  prefs: Prefs;
  onCommit: (prefs: Prefs) => void;
};

/** Draft fields commit on blur only when every Drive validator accepts them. */
export function DriveSettings({ prefs, onCommit }: SettingsProps) {
  const [endpoint, setEndpoint] = useState(prefs.driveEndpoint);
  const [region, setRegion] = useState(prefs.driveRegion);
  const [bucket, setBucket] = useState(prefs.driveBucket);
  const [accessKey, setAccessKey] = useState(prefs.driveAccessKeyId);
  const [secretPath, setSecretPath] = useState(prefs.driveSecretPath);

  useEffect(() => {
    setEndpoint(prefs.driveEndpoint);
    setRegion(prefs.driveRegion);
    setBucket(prefs.driveBucket);
    setAccessKey(prefs.driveAccessKeyId);
    setSecretPath(prefs.driveSecretPath);
  }, [prefs.driveEndpoint, prefs.driveRegion, prefs.driveBucket, prefs.driveAccessKeyId, prefs.driveSecretPath]);

  const commit = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch };
    const stored = normalizeEndpoint(next.driveEndpoint);
    if (
      stored === null
      || regionError(next.driveRegion)
      || bucketError(next.driveBucket)
      || accessKeyError(next.driveAccessKeyId)
      || secretPathError(next.driveSecretPath)
    ) return;
    onCommit({ ...next, driveEndpoint: stored });
  };

  const endpointError = normalizeEndpoint(endpoint) === null ? "Endpoint is not valid" : null;
  const regionMessage = regionError(region);
  const bucketMessage = bucketError(bucket);
  const accessMessage = accessKeyError(accessKey);
  const pathMessage = secretPathError(secretPath);

  return (
    <>
      <p className="prefs-note">
        Drive speaks the S3 API of darkstorage.io, a fully S3-compatible storage
        system, using the saved settings. The secret access key stays in the environment
        (DARKSTORAGE_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY) or in a file you name.
        AfterTerm does not store the secret in preferences. Objects over 8 MiB are refused.
      </p>
      <label>
        Endpoint
        <input
          value={endpoint}
          spellCheck={false}
          placeholder="https://api.darkstorage.io/s3"
          aria-invalid={endpointError !== null}
          onChange={(event) => setEndpoint(event.target.value)}
          onBlur={() => {
            const stored = normalizeEndpoint(endpoint);
            if (stored === null) return;
            setEndpoint(stored);
            if (stored !== prefs.driveEndpoint) commit({ driveEndpoint: stored });
          }}
        />
        {endpointError && <small role="alert">{endpointError}</small>}
      </label>
      <label>
        Signing region
        <input
          value={region}
          spellCheck={false}
          aria-invalid={regionMessage !== null}
          onChange={(event) => setRegion(event.target.value)}
          onBlur={() => { if (!regionError(region) && region !== prefs.driveRegion) commit({ driveRegion: region }); }}
        />
        {regionMessage && <small role="alert">{regionMessage}</small>}
      </label>
      <label>
        Bucket
        <input
          value={bucket}
          spellCheck={false}
          aria-invalid={bucketMessage !== null}
          onChange={(event) => setBucket(event.target.value)}
          onBlur={() => { if (!bucketError(bucket) && bucket !== prefs.driveBucket) commit({ driveBucket: bucket }); }}
        />
        {bucketMessage && <small role="alert">{bucketMessage}</small>}
      </label>
      <label>
        Access key id
        <input
          value={accessKey}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={accessMessage !== null}
          onChange={(event) => setAccessKey(event.target.value)}
          onBlur={() => { if (!accessKeyError(accessKey) && accessKey !== prefs.driveAccessKeyId) commit({ driveAccessKeyId: accessKey }); }}
        />
        {accessMessage && <small role="alert">{accessMessage}</small>}
      </label>
      <label>
        Secret source
        <select
          value={prefs.driveSecretSource}
          onChange={(event) => {
            const source: SecretSource = event.target.value === "file" ? "file" : "env";
            if (source !== prefs.driveSecretSource) commit({ driveSecretSource: source });
          }}
        >
          <option value="env">Environment variable</option>
          <option value="file">File</option>
        </select>
      </label>
      <label>
        Secret file path
        <input
          value={secretPath}
          spellCheck={false}
          aria-invalid={pathMessage !== null}
          onChange={(event) => setSecretPath(event.target.value)}
          onBlur={() => { if (!secretPathError(secretPath) && secretPath !== prefs.driveSecretPath) commit({ driveSecretPath: secretPath }); }}
        />
        {pathMessage && <small role="alert">{pathMessage}</small>}
      </label>
    </>
  );
}

type PanelProps = SettingsProps & {
  onClose: () => void;
  onStatus: (message: string) => void;
};

export function DrivePanel({ prefs, onCommit, onClose, onStatus }: PanelProps) {
  const panelRef = usePanel<HTMLElement>(onClose);
  const [prefix, setPrefix] = useState("");
  const [flat, setFlat] = useState(false);
  const [key, setKey] = useState("");
  const [text, setText] = useState("");
  const [confirm, setConfirm] = useState("");
  const [buckets, setBuckets] = useState<string[]>([]);
  const [objects, setObjects] = useState<ObjectList | null>(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<string | void>) => {
    if (busy) return;
    setBusy(true);
    try {
      const message = await work();
      if (message) onStatus(message);
    } catch (error) {
      onStatus(String(error));
    } finally {
      setBusy(false);
    }
  };

  const chooseBucket = (name: string) => {
    if (bucketError(name)) { onStatus("Bucket name is not valid"); return; }
    onCommit({ ...prefs, driveBucket: name });
    onStatus(`Bucket ${name}`);
  };

  return (
    <aside ref={panelRef} className="prefs drive" role="dialog" aria-labelledby="drive-title">
      <header>
        <h2 id="drive-title" tabIndex={-1}>Drive</h2>
        <button type="button" onClick={onClose}>Close</button>
      </header>
      <DriveSettings prefs={prefs} onCommit={onCommit} />
      <label>
        Prefix
        <input value={prefix} spellCheck={false} onChange={(event) => setPrefix(event.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={flat} onChange={(event) => setFlat(event.target.checked)} />
        Flat list
      </label>
      <div className="drive-actions">
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          const names = await invoke<string[]>("drive_list_buckets");
          setBuckets(names);
          return names.length ? `${names.length} buckets` : "No buckets";
        })}>List buckets</button>
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          const listed = await invoke<ObjectList>("drive_list_objects", { prefix, flat });
          setObjects(listed);
          const count = listed.keys.length + listed.prefixes.length;
          return count ? `${count} objects${listed.truncated ? ", list truncated" : ""}` : "No objects";
        })}>List objects</button>
      </div>
      {buckets.length > 0 && (
        <ul className="drive-list">
          {buckets.map((name) => (
            <li key={name}>
              <button type="button" onClick={() => chooseBucket(name)}>{name}</button>
            </li>
          ))}
        </ul>
      )}
      {objects && (
        <>
          {objects.truncated && <p className="prefs-note">The list is truncated.</p>}
          <ul className="drive-list">
            {objects.prefixes.map((name) => (
              <li key={`p-${name}`}>
                <button type="button" onClick={() => setPrefix(name)}>{name}</button>
              </li>
            ))}
            {objects.keys.map((name) => (
              <li key={`k-${name}`}>
                <button type="button" onClick={() => setKey(name)}>{name}</button>
              </li>
            ))}
          </ul>
        </>
      )}
      <label>
        Object key
        <input value={key} spellCheck={false} onChange={(event) => setKey(event.target.value)} />
      </label>
      <div className="drive-actions">
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          const body = await invoke<string>("drive_preview", { key });
          setPreview(body);
          return "Object preview loaded";
        })}>Preview</button>
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          const saved = await invoke<string | null>("drive_put_file", { key });
          return saved ?? "Upload cancelled";
        })}>Upload file</button>
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          const saved = await invoke<string | null>("drive_download", { key });
          return saved ?? "Download cancelled";
        })}>Download</button>
      </div>
      {preview && <pre className="drive-preview">{preview}</pre>}
      <label>
        Object text
        <textarea rows={4} value={text} spellCheck={false} onChange={(event) => setText(event.target.value)} />
      </label>
      <button type="button" disabled={busy} onClick={() => void run(async () => {
        await invoke("drive_put_text", { key, text });
        return "Object saved";
      })}>Save text</button>
      <label>
        Type the object key to delete it
        <input value={confirm} spellCheck={false} onChange={(event) => setConfirm(event.target.value)} />
      </label>
      <button type="button" className="danger" disabled={busy} onClick={() => void run(async () => {
        await invoke("drive_delete", { key, confirm });
        setConfirm("");
        return "Object deleted";
      })}>Delete object</button>
    </aside>
  );
}
