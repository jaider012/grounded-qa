import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeBedrockError } from '../src/bedrock-error.js';

function withName(message: string, name: string): Error {
  return Object.assign(new Error(message), { name });
}

test('describeBedrockError explains AccessDeniedException with the model, region, and a fix', () => {
  const message = describeBedrockError(withName('not authorized', 'AccessDeniedException'), {
    modelId: 'some.chat-model',
    region: 'us-east-1',
  });

  assert.equal(
    message,
    'Bedrock denied access to some.chat-model in us-east-1: enable model access in the Bedrock console or add bedrock:InvokeModel for this model to the IAM role.',
  );
});

test('describeBedrockError explains ValidationException including the original message', () => {
  const message = describeBedrockError(withName('bad request: unknown field "foo"', 'ValidationException'), {
    modelId: 'model-x',
    region: 'eu-west-1',
  });

  assert.equal(
    message,
    'Bedrock rejected the request for model-x: bad request: unknown field "foo". Check the model id and region.',
  );
});

test('describeBedrockError explains ThrottlingException as a clear throttling message naming the model and region', () => {
  const message = describeBedrockError(withName('Rate exceeded', 'ThrottlingException'), {
    modelId: 'model-x',
    region: 'us-east-1',
  });

  assert.match(message, /throttl/i);
  assert.match(message, /model-x/);
  assert.match(message, /us-east-1/);
});

test('describeBedrockError falls back to the original message for an unrecognized error', () => {
  const message = describeBedrockError(new Error('totally unexpected failure'), {
    modelId: 'model-x',
    region: 'us-east-1',
  });

  assert.match(message, /totally unexpected failure/);
});

test('describeBedrockError never includes credential-like fields even if present on the error', () => {
  const error = Object.assign(new Error('denied'), {
    name: 'AccessDeniedException',
    accessKeyId: 'AKIAFAKEFAKEFAKEFAKE',
  });
  const message = describeBedrockError(error, { modelId: 'model-x', region: 'us-east-1' });

  assert.doesNotMatch(message, /AKIA/);
});
