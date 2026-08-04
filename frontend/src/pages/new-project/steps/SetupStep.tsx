import { useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import api from "@/lib/api";

export function SetupStep({
  channelId,
  setChannelId,
  title,
  setTitle,
  channels,
}: {
  channelId: string;
  setChannelId: (v: string) => void;
  title: string;
  setTitle: (v: string) => void;
  channels: { id: number; name: string }[];
}) {
  // Auto-generate a placeholder title (Channel name + sequential number)
  // whenever the channel changes, unless the user has typed something.
  const titleEditedRef = useRef(false);
  useEffect(() => {
    if (titleEditedRef.current) return;
    if (!channelId) return;
    const ch = channels.find((c) => String(c.id) === channelId);
    if (!ch) return;
    // Fetch existing project count for the channel to pick a stable next number
    api
      .get("/projects", { params: { channel_id: channelId } })
      .then(({ data }) => {
        if (titleEditedRef.current) return;
        const count = Array.isArray(data) ? data.length : 0;
        setTitle(`${ch.name} #${count + 1}`);
      })
      .catch(() => {
        if (!titleEditedRef.current) setTitle(`${ch.name} #1`);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div className="text-center">
        <h2 className="text-xl font-semibold">Project Setup</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a channel — the title is auto-generated. Edit it later if you
          want.
        </p>
      </div>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label>Channel</Label>
          <Select value={channelId} onValueChange={setChannelId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a channel" />
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
          <Label htmlFor="project-title" className="text-xs text-muted-foreground">
            Project title (optional, auto-filled)
          </Label>
          <Input
            id="project-title"
            placeholder="My video"
            value={title}
            onChange={(e) => {
              titleEditedRef.current = true;
              setTitle(e.target.value);
            }}
          />
        </div>
      </div>
    </div>
  );
}
