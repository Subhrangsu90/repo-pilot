import { describeFailure } from './ollama';

describe('describeFailure', () => {
  it('turns llama.cpp allocation failures into actionable advice', () => {
    for (const body of [
      '{"error":"llama-server process has terminated: exit status 1: error: Failed to load CLIP model"}',
      '{"error":"ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 1362493440"}',
      'std::bad_alloc',
    ]) {
      const msg = describeFailure('gemma4:e2b', 500, body);
      expect(msg).toContain('not enough free memory');
      expect(msg).toContain('LLM_PROVIDER=gemini');
    }
  });

  it('keeps other errors as they are', () => {
    expect(describeFailure('x', 400, 'bad request')).toBe('ollama/x: HTTP 400 bad request');
  });
});
