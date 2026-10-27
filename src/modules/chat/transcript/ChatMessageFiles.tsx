import { DownloadIcon, FileArchiveIcon, FileCodeIcon, FileIcon, FileTextIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { ChatAttachment } from '@/shared/types';

type ChatMessageFilesProps = {
  files: ChatAttachment[];
};

const formatFileSize = (size?: number) => {
  if (typeof size !== 'number') return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const getFileIcon = (file: ChatAttachment) => {
  const name = (file.name || file.path || '').toLowerCase();
  const mimeType = file.mimeType || '';
  if (mimeType.startsWith('text/') || /\.(md|txt|pdf|docx?)$/.test(name)) return FileTextIcon;
  if (/\.(zip|rar|7z|tar|gz)$/.test(name)) return FileArchiveIcon;
  if (/\.(js|jsx|ts|tsx|py|rb|go|rs|java|c|cpp|css|html|json|ya?ml)$/.test(name)) return FileCodeIcon;
  return FileIcon;
};

const AUDIO_FILE = /\.(m4a|mp3|wav|ogg|oga|opus|webm|aac)$/i;

const isAudioFile = (file: ChatAttachment) => (
  (file.mimeType || '').startsWith('audio/') || AUDIO_FILE.test(file.name || file.path || '')
);

/**
 * CloudCLI live: a voice message (or any audio attachment) plays in place.
 * The file is fetched with the session's credentials, so a plain src URL
 * would not do.
 */
function ChatMessageAudio({ file }: { file: ChatAttachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const storedName = file.path?.split(/[\\/]/).pop();
    if (!storedName) return undefined;
    let objectUrl: string | null = null;
    let cancelled = false;
    void api.assets.file(storedName)
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        objectUrl = URL.createObjectURL(await response.blob());
        if (!cancelled) setUrl(objectUrl);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.path]);

  if (failed) return <ChatMessageFile file={file} />;
  return (
    <div className="flex w-72 max-w-full items-center rounded-xl border border-border/50 bg-card px-2 py-1.5 shadow-sm">
      {url ? (
        <audio src={url} controls preload="metadata" className="h-9 w-full" aria-label={file.name || 'Voice message'} />
      ) : (
        <div className="h-9 w-full animate-pulse rounded-lg bg-muted" />
      )}
    </div>
  );
}

function ChatMessageFile({ file }: { file: ChatAttachment }) {
  const [isDownloading, setIsDownloading] = useState(false);
  const name = file.name || file.path?.split(/[\\/]/).pop() || 'Attached file';
  const FileTypeIcon = getFileIcon(file);
  const size = formatFileSize(file.size);

  const download = async () => {
    if (!file.path || isDownloading) return;
    const storedName = file.path.split(/[\\/]/).pop();
    if (!storedName) return;

    setIsDownloading(true);
    try {
      const response = await api.assets.file(storedName);
      if (!response.ok) return;
      const blobUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    } catch (error) {
      console.error(`Failed to download attachment "${name}":`, error);
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void download()}
      disabled={!file.path || isDownloading}
      className="group/file flex w-64 max-w-full items-center gap-3 rounded-xl border border-border/50 bg-card px-3 py-2.5 text-left shadow-sm transition-colors hover:bg-accent/60 disabled:cursor-default disabled:hover:bg-card"
      aria-label={`Download ${name}`}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <FileTypeIcon className="h-5 w-5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground" title={name}>{name}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{size || 'File attachment'}</p>
      </div>
      <DownloadIcon
        className={`h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover/file:text-foreground ${
          isDownloading ? 'animate-pulse' : ''
        }`}
        aria-hidden
      />
    </button>
  );
}

/**
 * Rendered by chat's MessageComponent to list the non-image file attachments
 * on a user turn as downloadable cards.
 */
export default function ChatMessageFiles({ files }: ChatMessageFilesProps) {
  if (!files?.length) return null;

  return (
    <div className="flex max-w-full flex-wrap justify-end gap-2">
      {files.map((file, index) => (
        isAudioFile(file)
          ? <ChatMessageAudio key={file.path || file.name || index} file={file} />
          : <ChatMessageFile key={file.path || file.name || index} file={file} />
      ))}
    </div>
  );
}
