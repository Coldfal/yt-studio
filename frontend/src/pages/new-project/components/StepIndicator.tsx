import { Check, Settings2, Music, Film, Image as ImageIcon, Upload } from "lucide-react";
import { cn } from "@/lib/utils";

// Step indices: 0=Setup, 1=Music, 2=Compose, 3=Thumbnail, 4=Publish
// Images for the video are selected inside the Compose step (ImagesPanel
// in VisualizerEditor). The Thumbnail step is for the YouTube thumbnail
// only — a separate canvas-edited still that uploads alongside the video.
// Metadata and Upload are merged into the final Publish step.
export const STEPS = [
  { label: "Setup", icon: Settings2 },
  { label: "Music", icon: Music },
  { label: "Compose", icon: Film },
  { label: "Thumbnail", icon: ImageIcon },
  { label: "Publish", icon: Upload },
] as const;

export function StepIndicator({
  currentStep,
  steps = STEPS,
}: {
  currentStep: number;
  steps?: typeof STEPS;
}) {
  return (
    <div className="mb-8 flex items-center justify-center gap-1">
      {steps.map((step, i) => {
        const Icon = step.icon;
        const isActive = i === currentStep;
        const isCompleted = i < currentStep;
        return (
          <div key={step.label} className="flex items-center">
            <div
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                isActive && "bg-primary text-primary-foreground",
                isCompleted && "bg-primary/20 text-primary",
                !isActive && !isCompleted && "text-muted-foreground",
              )}
            >
              {isCompleted ? (
                <Check className="size-3.5" />
              ) : (
                <Icon className="size-3.5" />
              )}
              <span className="hidden sm:inline">{step.label}</span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={cn(
                  "mx-1 h-px w-6 sm:w-10",
                  i < currentStep ? "bg-primary" : "bg-border",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
