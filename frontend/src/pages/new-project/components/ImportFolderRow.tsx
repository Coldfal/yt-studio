import { useState } from "react";
import { FolderOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import api from "@/lib/api";

/**
 * Server-side folder import row. The user types/pastes a local folder path
 * (e.g. ``D:/Music/Lofi``) and the backend walks it, copying every audio
 * file into the channel's asset library. Skips files already imported by
 * filename so re-running is safe and cheap.
 *
 * This avoids the browser-upload route entirely — no file bytes go through
 * HTTP, and arbitrarily large folders import in seconds.
 */
export function ImportFolderRow({
  channelId,
  onImported,
}: {
  channelId: number;
  onImported: (assetIds: number[]) => void;
}) {
  const [path, setPath] = useState("");
  const [recursive, setRecursive] = useState(true);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  const handleImport = async () => {
    const folder = path.trim();
    if (!folder) {
      toast.error("Enter a folder path");
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post("/assets/import-folder", {
        channel_id: channelId,
        asset_type: "music",
        folder_path: folder,
        recursive,
        skip_existing: true,
      });
      const imported = Number(data?.imported ?? 0);
      const skipped = Number(data?.skipped_existing ?? 0);
      const failed = Number(data?.failed ?? 0);
      const ids: number[] = data?.asset_ids ?? [];
      if (imported === 0 && skipped > 0) {
        toast.info(`All ${skipped} file(s) already imported.`);
      } else if (imported === 0) {
        toast.info(`Nothing imported (scanned ${data?.scanned ?? 0}).`);
      } else {
        toast.success(
          `Imported ${imported} track(s)` +
            (skipped > 0 ? ` · skipped ${skipped} duplicate(s)` : "") +
            (failed > 0 ? ` · ${failed} failed` : ""),
        );
      }
      await qc.invalidateQueries({ queryKey: ["assets"] });
      onImported(ids);
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "Folder import failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center gap-2">
          <FolderOpen className="size-4 text-primary" />
          <p className="text-sm font-medium">Import a folder from your disk</p>
        </div>
        <p className="text-xs text-muted-foreground">
          Server-side copy — instant, even for thousands of tracks. Files
          already in the channel library are skipped automatically.
        </p>
        <div className="flex gap-2">
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="D:/Music/Lofi"
            className="flex-1"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleImport();
            }}
          />
          <Button onClick={handleImport} disabled={busy || !path.trim()}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FolderOpen className="size-4" />
            )}
            Import
          </Button>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={recursive}
            onChange={(e) => setRecursive(e.target.checked)}
          />
          Include subfolders
        </label>
      </CardContent>
    </Card>
  );
}
