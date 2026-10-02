/** Signed 2D value noise and its analytic gradient (no derivative extensions). */
export const cheapNoiseV2 = /* glsl */ `
float hashValueV2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z) * 2.0 - 1.0;
}

// x = noise value; yz = derivative with respect to p.xy.
vec3 valueNoiseV2(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = hashValueV2(cell);
  float b = hashValueV2(cell + vec2(1.0, 0.0));
  float c = hashValueV2(cell + vec2(0.0, 1.0));
  float d = hashValueV2(cell + vec2(1.0, 1.0));
  float k = a - b - c + d;
  return vec3(a + (b-a)*u.x + (c-a)*u.y + k*u.x*u.y,
              ((b-a) + k*u.y)*du.x,
              ((c-a) + k*u.x)*du.y);
}
`;
