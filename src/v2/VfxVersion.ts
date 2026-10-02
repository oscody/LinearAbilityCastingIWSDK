/** Opt-in only. Plain URLs continue using the untouched original effects. */
const params = new URLSearchParams(location.search);
export const V2_ENABLED = params.get('vfx') === 'v2'
  || params.get('bench') === 'v2' || params.get('bench') === 'remaining';
export const V2_MANUAL = params.get('bench') === 'off';
