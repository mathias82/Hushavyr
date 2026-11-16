import { LocalOllama } from "./ollama";
import { ReviewResult, reviewPrompt, reviewSchema, validateReview } from "./review";
import { ReviewInput, reviewSources, validateContext } from "./context";
import { verifyReview } from "./verifyReview";

/** At most two local requests. Every attempt goes through the same evidence gate. */
async function collectFindings(
  client: Pick<LocalOllama, "generate">,
  instruction: string,
  source: ReviewInput,
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
      "\nReview the source again. Correct the response shape and choose a valid source path and line range. " +
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

/** Review + one possible repair + one separate verification pass; all local. */
export async function runLocalReview(
  client: Pick<LocalOllama, "generate">, instruction: string, source: ReviewInput,
  cancelled: () => boolean = () => false, verifier?: Pick<LocalOllama, "generate">
): Promise<ReviewResult | undefined> {
  validateContext(instruction, reviewSources(source));
  const result = await collectFindings(client, instruction, source, cancelled);
  if (!result || cancelled()) return;
  return verifier ? verifyReview(verifier, result, source, cancelled) : result;
}
