/**
 * Multi-file asset upload dialog (Phase 2 extract from
 * ``AssetsPage.tsx``).
 *
 * Self-contained: takes ``open``, ``onOpenChange``, and the channel
 * list as props. Handles channel + asset-type pickers, single or
 * batch file selection, and an optional title. When multiple files
 * are picked the per-file title is auto-derived from the filename
 * (sans extension) so the user doesn't have to retype each one.
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUploadAsset } from "@/hooks/use-assets";

interface UploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channels: { id: number; name: string }[];
}

export function UploadDialog({
  open,
  onOpenChange,
  channels,
}: UploadDialogProps) {
  const [channelId, setChannelId] = useState("");
  const [assetType, setAssetType] = useState("");
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<FileList | null>(null);
  const uploadAsset = useUploadAsset();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!files || files.length === 0 || !channelId || !assetType) {
      toast.error("Channel, type, and at least one file are required");
      return;
    }
    try {
      for (let i = 0; i < files.length; i++) {
        const formData = new FormData();
        formData.append("file", files[i]);
        formData.append("channel_id", channelId);
        formData.append("asset_type", assetType);
        if (files.length === 1 && title.trim()) {
          formData.append("title", title.trim());
        } else if (files.length > 1) {
          const name = files[i].name.replace(/\.[^.]+$/, "");
          formData.append("title", name);
        }
        await uploadAsset.mutateAsync(formData);
      }
      toast.success(
        files.length === 1 ? "Asset uploaded" : `${files.length} assets uploaded`,
      );
      onOpenChange(false);
      setFiles(null);
      setChannelId("");
      setAssetType("");
      setTitle("");
    } catch {
      toast.error("Failed to upload asset");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Upload Asset</DialogTitle>
            <DialogDescription>
              Upload media files to your library. You can select multiple files.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label>Channel</Label>
              <Select value={channelId} onValueChange={setChannelId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select channel" />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((ch) => (
                    <SelectItem key={ch.id} value={String(ch.id)}>
                      {ch.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Asset Type</Label>
              <Select value={assetType} onValueChange={setAssetType}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="music">Music</SelectItem>
                  <SelectItem value="video">Video Clip</SelectItem>
                  <SelectItem value="image">Image</SelectItem>
                  <SelectItem value="thumbnail">Thumbnail</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="asset-file">
                File{assetType === "music" ? "s (MP3, WAV, etc.)" : "s"}
              </Label>
              <Input
                id="asset-file"
                type="file"
                multiple
                accept={
                  assetType === "music"
                    ? "audio/*"
                    : assetType === "video"
                      ? "video/*"
                      : assetType === "image" || assetType === "thumbnail"
                        ? "image/*"
                        : undefined
                }
                onChange={(e) => setFiles(e.target.files)}
              />
              {files && files.length > 1 && (
                <p className="text-xs text-muted-foreground">
                  {files.length} files selected — filenames will be used as titles
                </p>
              )}
            </div>
            {(!files || files.length <= 1) && (
              <div className="space-y-2">
                <Label htmlFor="asset-title">Title</Label>
                <Input
                  id="asset-title"
                  placeholder="e.g. Rainy Cafe Lofi Beat"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
            )}
          </div>
          <DialogFooter className="mt-6">
            <Button type="submit" disabled={uploadAsset.isPending}>
              {uploadAsset.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Uploading...
                </>
              ) : files && files.length > 1 ? (
                `Upload ${files.length} Files`
              ) : (
                "Upload"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
