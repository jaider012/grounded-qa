export interface BedrockErrorContext {
  modelId: string;
  region: string;
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Turns a raw AWS SDK error from a Bedrock call into a clear, actionable
 * message naming the failing model and region. Never includes credentials:
 * it only ever reads `name` and `message` off the original error.
 */
export function describeBedrockError(error: unknown, context: BedrockErrorContext): string {
  const { modelId, region } = context;
  const name = errorName(error);

  if (name === 'AccessDeniedException') {
    return `Bedrock denied access to ${modelId} in ${region}: enable model access in the Bedrock console or add bedrock:InvokeModel for this model to the IAM role.`;
  }

  if (name === 'ThrottlingException') {
    return `Bedrock throttled the request for ${modelId} in ${region} after retrying: ${errorMessage(error)}. Try again in a moment or request a quota increase.`;
  }

  if (name === 'ValidationException') {
    return `Bedrock rejected the request for ${modelId}: ${errorMessage(error)}. Check the model id and region.`;
  }

  return `Bedrock request for ${modelId} in ${region} failed: ${errorMessage(error)}`;
}
