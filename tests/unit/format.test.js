import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatResult, formatError } from '../../src/format.js';

describe('formatResult', () => {
  it('should return content array with JSON-stringified text and details object', () => {
    const result = { msg_id: 'msg_main_123_abcd', status: 'queued' };
    const output = formatResult(result);

    assert.ok(Array.isArray(output.content), 'content should be an array');
    assert.equal(output.content.length, 1);
    assert.equal(output.content[0].type, 'text');
    assert.equal(output.content[0].text, JSON.stringify(result));
    assert.deepStrictEqual(output.details, result);
  });

  it('should not include error field in details for normal results', () => {
    const result = { msg_id: 'msg_ops_456_beef', status: 'delivered' };
    const output = formatResult(result);

    assert.equal(output.details.error, undefined);
  });
});

describe('formatError', () => {
  it('should return content array with error code and message in details', () => {
    const output = formatError('INVALID_PARAM', 'to is required');

    assert.ok(Array.isArray(output.content), 'content should be an array');
    assert.equal(output.content.length, 1);
    assert.equal(output.content[0].type, 'text');
    assert.deepStrictEqual(output.details, { error: 'INVALID_PARAM', message: 'to is required' });
    assert.equal(output.content[0].text, JSON.stringify(output.details));
  });

  it('should include error field in details', () => {
    const output = formatError('MSG_NOT_FOUND', 'message not found');

    assert.equal(output.details.error, 'MSG_NOT_FOUND');
    assert.equal(output.details.message, 'message not found');
  });
});
