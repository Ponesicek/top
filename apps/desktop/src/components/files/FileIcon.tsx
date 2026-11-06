import { File, FileCode, FileImage, FileMusic, FileSpreadsheet, FileText, FileVideoCamera, Globe } from "lucide-react";
import { type FileKind, kindOf } from "../../files.ts";

const ICONS: Record<FileKind, typeof File> = {
  html: Globe,
  markdown: FileText,
  image: FileImage,
  pdf: FileText,
  video: FileVideoCamera,
  audio: FileMusic,
  table: FileSpreadsheet,
  text: FileCode,
  other: File,
};

export function FileIcon({ path, size = 15, className }: { path: string; size?: number; className?: string }) {
  const Icon = ICONS[kindOf(path)];
  return <Icon size={size} strokeWidth={2} className={className} aria-hidden />;
}
