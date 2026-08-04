import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Sparkles,
  Tv,
  ExternalLink,
  ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { useChannels, useCreateChannel } from "@/hooks/use-channels";
import api from "@/lib/api";

const STORAGE_KEY = "yt-studio:setup-completed";

/**
 * First-run setup wizard. Gates the app on first launch when there are no
 * channels — walks the user through verifying the Claude CLI, creating a
 * channel, and connecting YouTube. Persists a localStorage flag so the
 * wizard never re-shows.
 */
export function SetupWizard() {
  const { data: channels, isLoading } = useChannels();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (isLoading) return;
    const completed = localStorage.getItem(STORAGE_KEY) === "1";
    const hasChannels = (channels?.length ?? 0) > 0;
    // Show the wizard if (a) the user hasn't dismissed it AND (b) they don't
    // have any channels yet. Once they have a channel we trust they've done
    // the manual flow and stay out of the way.
    if (!completed && !hasChannels) setOpen(true);
  }, [isLoading, channels]);

  const close = () => {
    localStorage.setItem(STORAGE_KEY, "1");
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-primary" />
            Welcome — let's set you up
          </DialogTitle>
        </DialogHeader>
        <SetupSteps onDone={close} />
      </DialogContent>
    </Dialog>
  );
}

type Step = 0 | 1 | 2 | 3;

function SetupSteps({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>(0);
  const total = 4;

  return (
    <div className="space-y-4">
      <Progress value={((step + 1) / total) * 100} />
      <p className="text-xs text-muted-foreground">
        Step {step + 1} of {total}
      </p>

      {step === 0 && <WelcomeStep onNext={() => setStep(1)} />}
      {step === 1 && <CliStep onNext={() => setStep(2)} onSkip={() => setStep(2)} />}
      {step === 2 && <ChannelStep onNext={() => setStep(3)} />}
      {step === 3 && <YoutubeStep onDone={onDone} />}
    </div>
  );
}

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="space-y-4">
      <p className="text-sm">
        This studio automates the full pipeline: pick music, render a visualizer
        video, generate metadata with AI, and upload to YouTube — optionally
        on a schedule.
      </p>
      <ul className="ml-4 list-disc space-y-1 text-sm text-muted-foreground">
        <li>Verify the Claude Code CLI (used for AI metadata)</li>
        <li>Create your first channel</li>
        <li>Connect YouTube for uploads</li>
      </ul>
      <p className="text-xs text-muted-foreground">
        Takes about 3 minutes. Skip any step you don't need yet.
      </p>
      <div className="flex justify-end">
        <Button onClick={onNext}>
          Let's go
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function CliStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const [status, setStatus] = useState<{
    available: boolean;
    version: string | null;
    path: string | null;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/settings/claude-cli-status");
      setStatus(await res.json());
    } catch {
      setStatus({ available: false, version: null, path: null });
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">Claude Code CLI</h3>
      <p className="text-sm text-muted-foreground">
        We use the Claude Code CLI for AI metadata so you spend subscription
        credits instead of API tokens. Make sure it's installed.
      </p>

      {!status ? (
        <p className="text-xs text-muted-foreground">Checking…</p>
      ) : status.available ? (
        <div className="flex items-center gap-2 rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm">
          <CheckCircle2 className="size-4 text-green-500" />
          <div className="flex-1">
            <p className="font-medium text-green-400">{status.version}</p>
            <p className="text-xs text-muted-foreground">{status.path}</p>
          </div>
        </div>
      ) : (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <div className="flex items-center gap-2">
            <XCircle className="size-4 text-destructive" />
            <p className="font-medium text-destructive">CLI not found on PATH.</p>
          </div>
          <p className="text-xs text-muted-foreground">
            Install Claude Code from{" "}
            <a
              href="https://code.claude.com"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              code.claude.com
            </a>
            , then refresh.
          </p>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onSkip}>
          Skip
        </Button>
        <Button variant="outline" onClick={refresh} disabled={refreshing}>
          {refreshing && <Loader2 className="size-3 animate-spin" />}
          Refresh
        </Button>
        <Button onClick={onNext}>
          Next
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function ChannelStep({ onNext }: { onNext: () => void }) {
  const create = useCreateChannel();
  const [name, setName] = useState("");
  const [niche, setNiche] = useState("");
  const [description, setDescription] = useState("");

  const submit = async () => {
    if (!name.trim() || !niche.trim()) {
      toast.error("Channel name and niche are required");
      return;
    }
    try {
      await create.mutateAsync({
        name: name.trim(),
        niche: niche.trim(),
        description: description.trim(),
      });
      toast.success("Channel created");
      onNext();
    } catch {
      toast.error("Failed to create channel");
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Tv className="size-4" />
        Create your first channel
      </h3>
      <p className="text-sm text-muted-foreground">
        A channel is a brand identity — it groups projects, presets, music
        assets, and YouTube credentials.
      </p>

      <div className="space-y-2">
        <div className="space-y-1">
          <Label className="text-xs">Channel name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Lofi Beats Studio"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Niche</Label>
          <Input
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
            placeholder="lofi music"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Brief description (optional)</Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="What this channel is about — used as context for AI metadata."
          />
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button onClick={submit} disabled={create.isPending}>
          {create.isPending && <Loader2 className="size-3 animate-spin" />}
          Create channel
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function YoutubeStep({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const { data: channels } = useChannels();
  const channel = channels?.[0];

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">Connect YouTube</h3>
      <p className="text-sm text-muted-foreground">
        Connect your channel's YouTube account so the studio can upload videos
        and manage live streams. You can do this later from the channel page.
      </p>

      <div className="rounded-md border border-border/50 bg-card/40 p-3 text-sm">
        <p className="font-medium">{channel?.name ?? "Your channel"}</p>
        <p className="text-xs text-muted-foreground">
          {channel
            ? "Click below to open the channel and connect YouTube."
            : "No channel found. Go back and create one first."}
        </p>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          I'll do this later
        </Button>
        {channel && (
          <Button
            onClick={() => {
              navigate(`/channels/${channel.id}`);
              onDone();
            }}
          >
            Open channel
            <ExternalLink className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
