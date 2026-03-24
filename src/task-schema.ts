import { z } from "zod";

export const TaskSchema = z.object({
  type: z.enum(["plan", "code", "diagnose", "execute", "review"]),
  objective: z.string().min(4),
  contextPaths: z.array(z.string()).default([]),
  tools: z
    .array(z.enum(["git", "terraform", "kubernetes", "docker", "shell", "openclaw", "ansible", "helm", "flux", "observability", "github"]))
    .default([]),
  approvalRequired: z.boolean().default(false),
  dryRun: z.boolean().default(true),
  metadata: z.record(z.any()).optional(),
});

export type TaskRequest = z.infer<typeof TaskSchema>;
