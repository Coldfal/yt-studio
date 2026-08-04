/**
 * Voice profiles dropdown — Save current voice as a profile, Apply a
 * saved profile to this channel. Cross-channel reuse without copy-
 * pasting seven textareas.
 *
 * Apply snapshots the pre-state on the backend so the operator can
 * roll back via the History drawer if the new voice flops.
 */
import { useState } from "react";
import { toast } from "sonner";
import {
  ChevronDown,
  Library,
  Loader2,
  Save,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  useVoiceProfiles,
  useCreateVoiceProfile,
  useApplyVoiceProfile,
  useDeleteVoiceProfile,
} from "@/hooks/use-voice-profiles";
import type { Channel } from "@/types/index";

interface Props {
  channel: Channel;
}

export function VoiceProfilesMenu({ channel }: Props) {
  const profiles = useVoiceProfiles();
  const create = useCreateVoiceProfile();
  const apply = useApplyVoiceProfile();
  const del = useDeleteVoiceProfile();

  const [saveOpen, setSaveOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newNotes, setNewNotes] = useState("");

  const handleApply = async (profileId: number, profileName: string) => {
    try {
      await apply.mutateAsync({ channelId: channel.id, profileId });
      toast.success(`Applied "${profileName}" to ${channel.name}`);
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "Apply failed");
    }
  };

  const handleSave = async () => {
    if (!newName.trim()) {
      toast.error("Profile name required");
      return;
    }
    try {
      const profile = await create.mutateAsync({
        name: newName.trim(),
        notes: newNotes.trim() || undefined,
        source_channel_id: channel.id,
      });
      toast.success(`Profile "${profile.name}" saved`);
      setSaveOpen(false);
      setNewName("");
      setNewNotes("");
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "Save failed");
    }
  };

  const handleDelete = async (profileId: number, profileName: string) => {
    if (!window.confirm(`Delete profile "${profileName}"? This can't be undone.`)) {
      return;
    }
    try {
      await del.mutateAsync(profileId);
      toast.success(`Deleted "${profileName}"`);
    } catch {
      toast.error("Delete failed");
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm">
              <Library className="size-3.5" />
              Profiles
              <ChevronDown className="size-3" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Save current voice</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => setSaveOpen(true)}>
              <Save className="size-3.5" />
              Save as profile…
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>
              Apply profile to {channel.name}
            </DropdownMenuLabel>
            {profiles.isLoading && (
              <DropdownMenuItem disabled>
                <Loader2 className="size-3.5 animate-spin" />
                Loading…
              </DropdownMenuItem>
            )}
            {profiles.data && profiles.data.length === 0 && (
              <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                No saved profiles yet.
              </DropdownMenuItem>
            )}
            {(profiles.data ?? []).map((p) => (
              <DropdownMenuItem
                key={p.id}
                onClick={() => handleApply(p.id, p.name)}
                className="flex items-start gap-2"
              >
                <div className="flex-1 min-w-0">
                  <p className="truncate text-sm">{p.name}</p>
                  {p.notes && (
                    <p className="truncate text-[10px] text-muted-foreground">
                      {p.notes}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(p.id, p.name);
                  }}
                  className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title="Delete profile"
                >
                  <Trash2 className="size-3" />
                </button>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Save-as dialog */}
      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save voice as profile</DialogTitle>
            <DialogDescription>
              Captures the CURRENTLY SAVED voice on {channel.name}. Apply it
              to other channels with one click later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="profile-name" className="text-xs">Name</Label>
              <Input
                id="profile-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. yomi-v3, lofi-base, fantasy-narrative"
                className="h-8"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-notes" className="text-xs">
                Notes (optional)
              </Label>
              <Textarea
                id="profile-notes"
                rows={2}
                value={newNotes}
                onChange={(e) => setNewNotes(e.target.value)}
                placeholder="One-liner so you remember what this voice is for."
                className="text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setSaveOpen(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={create.isPending || !newName.trim()}
            >
              {create.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <Save className="size-4" />
                  Save profile
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
