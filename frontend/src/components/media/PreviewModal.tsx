import { useEffect } from "react";
import { X, ExternalLink, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Asset } from "@/types/index";

interface PreviewModalProps {
  asset: Asset | null;
  onClose: () => void;
}

export default function PreviewModal({ asset, onClose }: PreviewModalProps) {
  // Close on Escape
  useEffect(() => {
    if (!asset) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [asset, onClose]);

  if (!asset) return null;

  const isImage =
    asset.asset_type === "image" || asset.asset_type === "thumbnail";
  const isVideo =
    asset.asset_type === "video" || asset.asset_type === "composed";

  if (!isImage && !isVideo) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const openExternal = () => {
    window.open(asset.file_url, "_blank");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      {/* Toolbar */}
      <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          className="gap-1.5"
          onClick={openExternal}
        >
          <ExternalLink className="size-3.5" />
          Open
        </Button>
        <a href={asset.file_url} download={asset.filename}>
          <Button variant="secondary" size="sm" className="gap-1.5">
            <Download className="size-3.5" />
            Download
          </Button>
        </a>
        <Button variant="secondary" size="icon" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      {/* Title bar */}
      <div className="absolute left-4 top-4 z-10 max-w-[50%]">
        <p className="truncate text-sm font-medium text-white">
          {asset.title || asset.filename}
        </p>
        {asset.title && (
          <p className="truncate text-xs text-white/60">{asset.filename}</p>
        )}
      </div>

      {/* Content */}
      <div className="max-h-[85vh] max-w-[90vw]">
        {isImage && (
          <img
            src={asset.file_url}
            alt={asset.filename}
            className="max-h-[85vh] max-w-[90vw] rounded-lg object-contain"
          />
        )}
        {isVideo && (
          <video
            src={asset.file_url}
            controls
            autoPlay
            className="max-h-[85vh] max-w-[90vw] rounded-lg"
          >
            Your browser does not support the video tag.
          </video>
        )}
      </div>
    </div>
  );
}
