// Whether the tutor's language model looks usable, from the last real call (no paid probe is ever made).
// Reads the environment directly instead of requiring tutorLlm, which would be a circular import.
let observation = null;
const env = (name) => (process.env[name] || '').trim();
function configured() {
  const provider = env('TUTOR_LLM_PROVIDER').toLowerCase();
  if (provider === 'local') return env('LOCAL_LLM_MODEL') || 'local';
  if (provider === 'openrouter' && env('OPENROUTER_API_KEY') && env('OPENROUTER_MODEL')) return env('OPENROUTER_MODEL');
  return null;
}
// A health observation belongs to the setup it was made under.
const signature = () => `${env('TUTOR_LLM_PROVIDER')}|${configured()}|${env('OPENROUTER_API_KEY')}`;
let keyAtObservation = null;
function recordSuccess() { keyAtObservation = signature(); observation = { state: 'available', available: true, reason: null, checkedAt: new Date().toISOString() }; }
function recordFailure(error) {
  keyAtObservation = signature();
  observation = { state: 'unavailable', available: false,
    reason: error.upstreamStatus === 429 ? 'quota' : error.upstreamStatus === 401 || error.upstreamStatus === 403 || error.upstreamStatus === 400 ? 'configuration'
      : error.name === 'AbortError' || /timed out|timeout/i.test(error.message || '') ? 'timeout' : 'provider_error', checkedAt: new Date().toISOString() };
}
function status() {
  if (!configured()) return { state: 'unconfigured', available: false, reason: 'not_configured', checkedAt: null };
  if (keyAtObservation !== signature()) return { state: 'unknown', available: null, reason: 'not_checked', checkedAt: null };
  return observation || { state: 'unknown', available: null, reason: 'not_checked', checkedAt: null };
}
module.exports = { recordSuccess, recordFailure, status };
