import { DragEvent, useState } from "react";

interface Props {
  accept: string; // e.g. ".pdf,application/pdf"
  multiple?: boolean;
  disabled?: boolean;
  maxBytes?: number;
  title: string;
  subtitle?: string;
  onFiles: (files: File[]) => void;
  onError?: (message: string) => void;
}

export function Dropzone({ accept, multiple, disabled, maxBytes, title, subtitle, onFiles, onError }: Props) {
  const [over, setOver] = useState(false);

  const accepted = (file: File) => {
    const tokens = accept.split(",").map((t) => t.trim().toLowerCase());
    return tokens.some((t) =>
      t.startsWith(".") ? file.name.toLowerCase().endsWith(t) : file.type.toLowerCase().startsWith(t.replace("*", "")),
    );
  };

  const handle = (list: FileList | null) => {
    if (!list || disabled) return;
    const files = Array.from(list);
    if (!multiple && files.length > 1) return onError?.("Choose one file at a time.");
    const bad = files.find((f) => !accepted(f));
    if (bad) return onError?.(`"${bad.name}" is not an accepted file type (${accept}).`);
    const big = maxBytes ? files.find((f) => f.size > maxBytes) : undefined;
    if (big) return onError?.(`"${big.name}" is over ${(maxBytes! / 1024 / 1024).toFixed(1)} MB.`);
    if (files.length > 0) onFiles(files);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    handle(e.dataTransfer.files);
  };

  return (
    <label
      className={`dropzone ${over ? "over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(e) => {
          handle(e.target.files);
          e.target.value = ""; // allow choosing the same file again
        }}
      />
      <strong>{title}</strong>
      {subtitle && <div className="muted">{subtitle}</div>}
    </label>
  );
}
