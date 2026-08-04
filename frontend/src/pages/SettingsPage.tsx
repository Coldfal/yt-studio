import { useState, useEffect, lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Music,
  Brain,
  Mic2,
  Video,
  Sparkles,
  Loader2,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useSettings,
  useSaveSettings,
  useTestConnection,
} from "@/hooks/use-settings";
import type { SettingItem } from "@/types/index";

// Prompt library lives in Settings > Prompts tab
const PromptLibraryPage = lazy(() => import("@/pages/PromptLibraryPage"));

interface ProviderConfig {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
  fields: {
    key: string;
    label: string;
    placeholder: string;
    isSecret: boolean;
  }[];
  note?: string;
}

const PROVIDERS: ProviderConfig[] = [
  {
    key: "suno",
    label: "Suno",
    icon: Music,
    description: "AI music generation service",
    fields: [
      {
        key: "suno_api_key",
        label: "API Key",
        placeholder: "Enter your Suno API key",
        isSecret: true,
      },
      {
        key: "suno_api_url",
        label: "API URL",
        placeholder: "https://api.suno.ai/v1",
        isSecret: false,
      },
    ],
  },
  // Claude is no longer configured here — see the dedicated "Claude Code CLI"
  // status card below. We keep PROVIDERS focused on API-key-based services.
  {
    key: "elevenlabs",
    label: "ElevenLabs",
    icon: Mic2,
    description: "AI voice generation for narration",
    fields: [
      {
        key: "elevenlabs_api_key",
        label: "API Key",
        placeholder: "Enter your ElevenLabs API key",
        isSecret: true,
      },
    ],
  },
  {
    key: "openai",
    label: "OpenAI (DALL-E)",
    icon: Sparkles,
    description: "AI image generation with DALL-E 3",
    fields: [
      {
        key: "openai_api_key",
        label: "API Key",
        placeholder: "sk-...",
        isSecret: true,
      },
    ],
  },
  {
    key: "youtube",
    label: "YouTube",
    icon: Video,
    description: "YouTube Data API for uploading videos",
    fields: [
      {
        key: "youtube_client_id",
        label: "Client ID",
        placeholder: "your-app.apps.googleusercontent.com",
        isSecret: false,
      },
      {
        key: "youtube_client_secret",
        label: "Client Secret",
        placeholder: "GOCSPX-...",
        isSecret: true,
      },
      {
        key: "youtube_api_key",
        label: "Data API Key (server, optional)",
        placeholder: "AIzaSy...",
        isSecret: true,
      },
    ],
    note: "Requires a Google Cloud project with YouTube Data API v3 enabled. Set up OAuth 2.0 credentials (Client ID + Secret) for uploads, and optionally an 'API key' credential for keyword research (trending videos + tag harvesting). Quota is 10,000 units/day per project.",
  },
];

function ProviderSection({
  provider,
  values,
  onChange,
  onTest,
  testResult,
  isTesting,
}: {
  provider: ProviderConfig;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onTest: () => void;
  testResult: { success: boolean; message: string } | null;
  isTesting: boolean;
}) {
  const [visibleFields, setVisibleFields] = useState<Record<string, boolean>>(
    {}
  );
  const Icon = provider.icon;

  const toggleVisibility = (fieldKey: string) => {
    setVisibleFields((prev) => ({
      ...prev,
      [fieldKey]: !prev[fieldKey],
    }));
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-muted">
              <Icon className="size-4" />
            </div>
            <div>
              <CardTitle className="text-base">{provider.label}</CardTitle>
              <p className="text-xs text-muted-foreground">
                {provider.description}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onTest}
            disabled={isTesting}
          >
            {isTesting ? (
              <>
                <Loader2 className="size-3 animate-spin" />
                Testing...
              </>
            ) : (
              "Test Connection"
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {provider.fields.map((field) => (
          <div key={field.key} className="space-y-2">
            <Label htmlFor={field.key}>{field.label}</Label>
            <div className="relative">
              <Input
                id={field.key}
                type={
                  field.isSecret && !visibleFields[field.key]
                    ? "password"
                    : "text"
                }
                placeholder={field.placeholder}
                value={values[field.key] ?? ""}
                onChange={(e) => onChange(field.key, e.target.value)}
              />
              {field.isSecret && (
                <button
                  type="button"
                  onClick={() => toggleVisibility(field.key)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {visibleFields[field.key] ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </button>
              )}
            </div>
          </div>
        ))}

        {provider.note && (
          <p className="text-xs text-muted-foreground">{provider.note}</p>
        )}

        {testResult && (
          <div
            className={`flex items-center gap-2 rounded-lg p-2 text-xs ${
              testResult.success
                ? "bg-green-500/10 text-green-500"
                : "bg-destructive/10 text-destructive"
            }`}
          >
            {testResult.success ? (
              <CheckCircle2 className="size-3.5" />
            ) : (
              <XCircle className="size-3.5" />
            )}
            {testResult.message}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i}>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="size-9 animate-pulse rounded-lg bg-muted" />
              <div className="space-y-2">
                <div className="h-4 w-24 animate-pulse rounded bg-muted" />
                <div className="h-3 w-40 animate-pulse rounded bg-muted" />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-8 w-full animate-pulse rounded bg-muted" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function IntegrationsTab() {
  const { data: settings, isLoading } = useSettings();
  const saveSettings = useSaveSettings();
  const testConnection = useTestConnection();

  const [values, setValues] = useState<Record<string, string>>({});
  const [testResults, setTestResults] = useState<
    Record<string, { success: boolean; message: string }>
  >({});
  const [testingProvider, setTestingProvider] = useState<string | null>(null);

  useEffect(() => {
    if (settings) {
      const initialValues: Record<string, string> = {};
      settings.forEach((setting) => {
        initialValues[setting.key] = setting.value;
      });
      setValues(initialValues);
    }
  }, [settings]);

  const handleChange = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleTest = async (providerKey: string) => {
    setTestingProvider(providerKey);
    try {
      const result = await testConnection.mutateAsync(providerKey);
      setTestResults((prev) => ({ ...prev, [providerKey]: result }));
      if (result.success) {
        toast.success(`${providerKey} connection successful`);
      } else {
        toast.error(result.message);
      }
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [providerKey]: {
          success: false,
          message: "Connection test failed",
        },
      }));
      toast.error("Connection test failed");
    }
    setTestingProvider(null);
  };

  const handleSaveAll = async () => {
    const settingsDict: Record<string, string> = {};

    PROVIDERS.forEach((provider) => {
      provider.fields.forEach((field) => {
        const value = values[field.key];
        if (value !== undefined && value !== "" && !value.startsWith("****")) {
          settingsDict[field.key] = value;
        }
      });
    });

    if (Object.keys(settingsDict).length === 0) {
      toast.info("No changes to save");
      return;
    }

    try {
      await saveSettings.mutateAsync(settingsDict);
      toast.success("Settings saved successfully");
    } catch {
      toast.error("Failed to save settings");
    }
  };

  return (
    <div className="space-y-4">
      {isLoading && <LoadingSkeleton />}

      {!isLoading && (
        <div className="space-y-4">
          <ClaudeCliStatusCard />
          {PROVIDERS.map((provider) => (
            <ProviderSection
              key={provider.key}
              provider={provider}
              values={values}
              onChange={handleChange}
              onTest={() => handleTest(provider.key)}
              testResult={testResults[provider.key] ?? null}
              isTesting={testingProvider === provider.key}
            />
          ))}
        </div>
      )}

      {!isLoading && (
        <div className="flex justify-end">
          <Button
            onClick={handleSaveAll}
            disabled={saveSettings.isPending}
            size="lg"
          >
            {saveSettings.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="size-4" />
                Save All Settings
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Default export: Settings page with Integrations + Prompts tabs ─────────

export default function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") ?? "integrations";

  const handleTabChange = (value: string) => {
    if (value === "integrations") {
      searchParams.delete("tab");
    } else {
      searchParams.set("tab", value);
    }
    setSearchParams(searchParams, { replace: true });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            API integrations, Claude Code CLI status, and prompt library.
          </p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="prompts">Prompts</TabsTrigger>
        </TabsList>
        <TabsContent value="integrations" className="mt-4">
          <IntegrationsTab />
        </TabsContent>
        <TabsContent value="prompts" className="mt-4">
          <Suspense fallback={<div className="flex h-40 items-center justify-center text-muted-foreground">Loading…</div>}>
            <PromptLibraryPage />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Claude Code CLI status card ────────────────────────────────────────
//
// Replaces the Anthropic API-key card. The CLI uses the user's interactive
// Claude Code subscription credits when invoked without --bare, so all the
// app needs from this surface is "is the binary reachable?".

function ClaudeCliStatusCard() {
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
      const data = await res.json();
      setStatus(data);
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
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Brain className="size-4 text-primary" />
            Claude Code CLI
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={refresh}
            disabled={refreshing}
          >
            {refreshing ? <Loader2 className="size-3 animate-spin" /> : null}
            Refresh
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Used to generate video metadata (title, description, tags). Runs
          against your Claude Code subscription credits — no API key needed.
        </p>
      </CardHeader>
      <CardContent>
        {!status ? (
          <p className="text-sm text-muted-foreground">Checking…</p>
        ) : status.available ? (
          <div className="flex items-center gap-2 rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm">
            <CheckCircle2 className="size-4 text-green-500" />
            <div className="flex-1">
              <p className="font-medium text-green-400">{status.version}</p>
              <p className="text-xs text-muted-foreground">{status.path}</p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <XCircle className="mt-0.5 size-4 text-destructive" />
            <div className="space-y-1">
              <p className="font-medium text-destructive">
                Claude CLI not found on PATH.
              </p>
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
                , or set the <code>YTS_CLAUDE_CLI_PATH</code> env var to point
                at the binary.
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
