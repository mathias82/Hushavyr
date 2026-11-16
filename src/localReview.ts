import { LocalOllama } from "./ollama";
import { ReviewResult, reviewPrompt, reviewSchema, validateReview } from "./review";

/** At most two local requests. Every attempt goes through the same evidence gate. */
export async function runLocalReview(
  client: Pick<LocalOllama, "generate">,
  instruction: string,
  source: string,
  cancelled: () => boolean = () => false
): Promise<ReviewResult | undefined> {
  if (cancelled()) return;
  const prompt = reviewPrompt(instruction, source);
  const raw = await client.generate(prompt, {schema: reviewSchema});
  if (cancelled()) return;
  const first = validateReview(raw, source);
  // Preserve useful, validated findings. An empty valid review needs no repair.
  if (first.findings.length || (!first.error && !first.rejected)) return first;
  const feedback = first.error ?? first.rejectionReasons?.join("; ") ?? "Invalid finding";
  try {
    const repaired = await client.generate(prompt +
      "\n\nLOCAL VALIDATOR FEEDBACK: " + feedback +
      "\nReview the source again. Correct the response shape or quote the exact source expression. " +
      "Discard any unsupported claim; return an empty findings array if no concrete issue is supported.",
      {schema: reviewSchema});
    if (cancelled()) return;
    const second = validateReview(repaired, source);
    // Do not hide the original useful validation feedback behind a new parser error.
    return second.error ? {...first, retryFailed: true} : second;
  } catch {
    if (!cancelled()) return {...first, retryFailed: true};
  }
}
