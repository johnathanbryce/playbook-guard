// Shared Anthropic client + model tiers for the flag / firewall / escalate services.
// Official @anthropic-ai/sdk (see DECISIONS: the Vercel AI SDK path is broken here —
// @ai-sdk/anthropic@1 sends a `temperature` that claude-sonnet-5 rejects with a 400).
// The constructor reads ANTHROPIC_API_KEY from the environment (durable in root .env,
// compose-interpolated, confirmed present in the running container).
import Anthropic from "@anthropic-ai/sdk";

export const anthropic = new Anthropic();

// Two tiers (see DECISIONS: stronger flagger, cheaper firewall judge).
export const FLAGGER_MODEL = "claude-sonnet-5";
