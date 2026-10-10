/**
 * GLSL ES 3.00 shaders for the develop pipeline.
 *
 *   src (camera linear) --input--> lin (linear ProPhoto, scene-referred)
 *   lin --nr--> den (optional noise reduction)
 *   den --luma+blur--> small (log luma, small radius; texture)
 *   preview lin --down+blur--> ctxMid / ctxLarge (log luma, dark channel; global context)
 *   den + small + ctx + masks + curve --main--> dev (gamma-encoded ProPhoto, display-referred)
 *   dev --final--> screen / export tile (geometry, sharpening, effects, output transform)
 *
 * Texture v=0 is the top row of the image everywhere except the default
 * framebuffer, which the final pass flips.
 */

export const VERT = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
in vec2 vUv;
out vec4 outColor;
const vec3 PRO_LUMA = vec3(0.2880402, 0.7118741, 0.0000857);
float luma(vec3 c) { return dot(c, PRO_LUMA); }
float srgbEnc(float x) { return x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1.0 / 2.4) - 0.055; }
float srgbDec(float x) { return x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4); }
vec3 srgbEnc(vec3 c) { return vec3(srgbEnc(c.r), srgbEnc(c.g), srgbEnc(c.b)); }
vec3 srgbDec(vec3 c) { return vec3(srgbDec(c.r), srgbDec(c.g), srgbDec(c.b)); }
float max3(vec3 c) { return max(c.r, max(c.g, c.b)); }
float min3(vec3 c) { return min(c.r, min(c.g, c.b)); }
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
`;

/** Camera RGB -> white balance -> linear ProPhoto, plus lens vignetting correction. */
export const INPUT_FRAG = HEADER + /* glsl */ `
uniform sampler2D uSrc;
uniform vec3 uWB;
uniform float uClip;
uniform mat3 uCamToPro;
uniform vec4 uRegion;
uniform vec2 uAspect;
uniform float uLensVig;
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  c = min(c * uWB, vec3(uClip));
  vec3 p = max(uCamToPro * c, vec3(0.0));
  if (uLensVig != 0.0) {
    vec2 suv = uRegion.xy + vUv * uRegion.zw;
    vec2 d = (suv - 0.5) * uAspect;
    float r2 = dot(d, d) / dot(uAspect * 0.5, uAspect * 0.5);
    p *= max(0.0, 1.0 + uLensVig * (0.8 * r2 + 0.5 * r2 * r2));
  }
  outColor = vec4(p, 1.0);
}`;

export const MAX_SPOTS = 32;

/**
 * Spot removal on scene-linear data. Clone copies the source circle; heal also
 * scales it by a correction that blends from the ring around the destination
 * (matched against the ring around the source) towards the center, which
 * approximates seamless (membrane) blending.
 */
export const SPOT_FRAG = HEADER + /* glsl */ `
uniform sampler2D uIn;
uniform vec4 uRegion;
uniform sampler2D uFallback;
uniform bool uHasFallback;
uniform vec2 uAspect;
uniform int uCount;
uniform vec4 uSpotA[${MAX_SPOTS}];
uniform vec4 uSpotB[${MAX_SPOTS}];

vec3 sampleSrc(vec2 suv) {
  vec2 t = (suv - uRegion.xy) / uRegion.zw;
  if (!uHasFallback || (t.x >= 0.0 && t.y >= 0.0 && t.x <= 1.0 && t.y <= 1.0)) return texture(uIn, t).rgb;
  return texture(uFallback, suv).rgb;
}

void main() {
  vec2 suv = uRegion.xy + vUv * uRegion.zw;
  vec3 c = texture(uIn, vUv).rgb;
  for (int i = 0; i < ${MAX_SPOTS}; i++) {
    if (i >= uCount) break;
    vec4 A = uSpotA[i];
    vec4 B = uSpotB[i];
    vec2 d = (suv - A.xy) * uAspect;
    float dist = length(d) / B.x;
    if (dist >= 1.0) continue;
    vec3 s = sampleSrc(suv + (A.zw - A.xy));
    if (B.w < 0.5) {
      // log-ratio corrections at 12 ring positions, interpolated by angle
      const int N = 12;
      vec3 ring[N];
      vec3 mean = vec3(0.0);
      for (int k = 0; k < N; k++) {
        float a = float(k) * 6.2831853 / float(N);
        vec2 o = vec2(cos(a), sin(a)) * B.x * 1.1 / uAspect;
        vec3 rd = sampleSrc(A.xy + o);
        vec3 rs = sampleSrc(A.zw + o);
        ring[k] = clamp(log2((rd + 1e-4) / (rs + 1e-4)), -3.0, 3.0);
        mean += ring[k];
      }
      mean /= float(N);
      float ang = atan(d.y, d.x);
      if (ang < 0.0) ang += 6.2831853;
      float f = ang / 6.2831853 * float(N);
      int k0 = int(floor(f)) % N;
      int k1 = (k0 + 1) % N;
      vec3 edge = mix(ring[k0], ring[k1], fract(f));
      vec3 corr = mix(mean, edge, smoothstep(0.0, 1.0, dist));
      s *= exp2(corr);
    }
    float w = (1.0 - smoothstep(1.0 - max(B.y, 0.001), 1.0, dist)) * B.z;
    c = mix(c, s, w);
  }
  outColor = vec4(c, 1.0);
}`;

/** Edge-aware luminance and chroma noise reduction. */
export const NR_FRAG = HEADER + /* glsl */ `
uniform sampler2D uIn;
uniform vec2 uTexel;
uniform float uLuma;
uniform float uLumaDetail;
uniform float uColor;
uniform float uColorDetail;
void main() {
  vec3 c0 = texture(uIn, vUv).rgb;
  float y0 = luma(c0);
  float s0 = sqrt(max(y0, 0.0));
  float sigR = mix(0.004, 0.06, uLuma) * mix(1.6, 0.4, uLumaDetail);
  float wsum = 0.0, ysum = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec3 c = texture(uIn, vUv + vec2(float(i), float(j)) * uTexel).rgb;
      float s = sqrt(max(luma(c), 0.0));
      float w = exp(-float(i * i + j * j) / 4.5) * exp(-(s - s0) * (s - s0) / (2.0 * sigR * sigR));
      wsum += w;
      ysum += w * luma(c);
    }
  }
  float y = uLuma > 0.0 ? mix(y0, ysum / wsum, min(1.0, uLuma * 1.5)) : y0;
  vec3 chroma0 = c0 / (y0 + 1e-5);
  vec3 chroma = chroma0;
  if (uColor > 0.0) {
    float stride = 1.0 + 3.0 * uColor;
    float sigL = mix(0.25, 0.05, uColorDetail);
    vec3 csum = vec3(0.0);
    float cw = 0.0;
    for (int j = -3; j <= 3; j++) {
      for (int i = -3; i <= 3; i++) {
        vec3 c = texture(uIn, vUv + vec2(float(i), float(j)) * uTexel * stride).rgb;
        float yc = luma(c);
        float dl = sqrt(max(yc, 0.0)) - s0;
        float w = exp(-float(i * i + j * j) / 8.0) * exp(-dl * dl / (2.0 * sigL * sigL));
        csum += w * (c / (yc + 1e-5));
        cw += w;
      }
    }
    chroma = mix(chroma0, csum / cw, min(1.0, uColor * 1.2));
  }
  outColor = vec4(max(chroma * y, vec3(0.0)), 1.0);
}`;

/** Log luminance (R), dark channel (G) and squared log luminance (B, for local variance), with an optional 4-tap box filter. */
export const LUMA_FRAG = HEADER + /* glsl */ `
uniform sampler2D uIn;
uniform vec2 uTexel;
uniform float uBox;
void main() {
  vec3 c;
  if (uBox > 0.0) {
    vec2 o = uTexel * 0.5;
    c = 0.25 * (texture(uIn, vUv + vec2(-o.x, -o.y)).rgb + texture(uIn, vUv + vec2(o.x, -o.y)).rgb +
                texture(uIn, vUv + vec2(-o.x, o.y)).rgb + texture(uIn, vUv + vec2(o.x, o.y)).rgb);
  } else {
    c = texture(uIn, vUv).rgb;
  }
  float l = log2(luma(c) + 1e-5);
  outColor = vec4(l, min3(c), l * l, 1.0);
}`;

/** Separable Gaussian blur. */
export const BLUR_FRAG = HEADER + /* glsl */ `
uniform sampler2D uIn;
uniform vec2 uDir;
uniform float uSigma;
void main() {
  vec4 s = texture(uIn, vUv);
  float w = 1.0;
  int r = int(ceil(uSigma * 3.0));
  float k = 1.0 / (2.0 * uSigma * uSigma);
  for (int i = 1; i <= 96; i++) {
    if (i > r) break;
    float wi = exp(-float(i * i) * k);
    s += wi * (texture(uIn, vUv + uDir * float(i)) + texture(uIn, vUv - uDir * float(i)));
    w += 2.0 * wi;
  }
  outColor = s / w;
}`;

export const MAX_MASKS = 8;

/** The develop pass: tone, presence, curves, color, local adjustments. */
export const MAIN_FRAG = HEADER + /* glsl */ `
uniform sampler2D uLin;
uniform sampler2D uSmall;
uniform sampler2D uCtxMid;
uniform sampler2D uCtxLarge;
uniform sampler2DArray uMasks;
uniform sampler2D uCurve;
uniform vec4 uRegion;
uniform bool uIsRaw;
uniform float uExposure;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float uTexture;
uniform float uClarity;
uniform float uDehaze;
uniform float uVibrance;
uniform float uSaturation;
uniform float uAirlight;
uniform bool uCurveOn;
uniform bool uBW;
uniform bool uHslOn;
uniform float uHslHue[8];
uniform float uHslSat[8];
uniform float uHslLum[8];
uniform float uBwMix[8];
uniform vec4 uGradeS;
uniform vec4 uGradeM;
uniform vec4 uGradeH;
uniform vec4 uGradeG;
uniform vec2 uGradeParams;
uniform bool uGradeOn;
uniform int uMaskCount;
uniform vec4 uMaskInfo[${MAX_MASKS}];
uniform vec4 uMaskRange[${MAX_MASKS}];
uniform vec4 uMaskRange2[${MAX_MASKS}];
uniform vec4 uMaskA[${MAX_MASKS}];
uniform vec4 uMaskB[${MAX_MASKS}];
uniform vec4 uMaskC[${MAX_MASKS}];

const float CENTERS[9] = float[9](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0, 360.0);

void bandWeights(float hue, out int i0, out int i1, out float w1) {
  i0 = 7;
  for (int i = 0; i < 8; i++) {
    if (hue >= CENTERS[i] && hue < CENTERS[i + 1]) { i0 = i; break; }
  }
  float t = (hue - CENTERS[i0]) / (CENTERS[i0 + 1] - CENTERS[i0]);
  w1 = smoothstep(0.0, 1.0, clamp(t, 0.0, 1.0));
  i1 = i0 == 7 ? 0 : i0 + 1;
}

float contrastCurve(float x, float k) {
  const float p = 0.46;
  if (x <= 0.0) return x;
  if (x >= 1.0) return x;
  return x < p ? p * pow(x / p, k) : 1.0 - (1.0 - p) * pow((1.0 - x) / (1.0 - p), k);
}

float curveLookup(float x, int ch) {
  float xc = clamp(x, 0.0, 1.0);
  float u = xc * (1023.0 / 1024.0) + 0.5 / 1024.0;
  float v = texture(uCurve, vec2(u, 0.5))[ch];
  return v + max(x - 1.0, 0.0);
}

void main() {
  vec2 suv = uRegion.xy + vUv * uRegion.zw;
  vec3 rgb = texture(uLin, vUv).rgb;

  // ---------------- local adjustment weights ----------------
  float lExp = 0.0, lCon = 0.0, lHi = 0.0, lSh = 0.0, lWh = 0.0, lBl = 0.0;
  float lTemp = 0.0, lTint = 0.0, lSat = 0.0, lCla = 0.0, lDeh = 0.0, lTex = 0.0;
  if (uMaskCount > 0) {
    vec3 gq = srgbEnc(clamp(rgb * exp2(uExposure), 0.0, 1.0));
    float lumG = luma(gq);
    vec3 hsvq = rgb2hsv(gq);
    for (int i = 0; i < ${MAX_MASKS}; i++) {
      if (i >= uMaskCount) break;
      vec4 info = uMaskInfo[i];
      if (info.w < 0.5) continue;
      float w = texture(uMasks, vec3(suv, float(i))).r;
      if (info.y > 0.5) w = 1.0 - w;
      vec4 rg = uMaskRange[i];
      if (info.z > 0.5 && info.z < 1.5) {
        w *= smoothstep(rg.x - rg.z, rg.x, lumG) * (1.0 - smoothstep(rg.y, rg.y + rg.z, lumG));
      } else if (info.z > 1.5) {
        vec4 r2 = uMaskRange2[i];
        float dh = abs(mod(hsvq.x * 360.0 - r2.x + 180.0, 360.0) - 180.0) / 180.0;
        float ds = abs(hsvq.y - r2.y);
        float tol = rg.w;
        w *= 1.0 - smoothstep(tol * 0.6, tol * 1.2 + 0.02, dh * 1.6 + ds * 0.6);
        w *= smoothstep(0.02, 0.12, hsvq.y);
      }
      w *= info.x;
      vec4 a = uMaskA[i];
      vec4 b = uMaskB[i];
      vec4 c = uMaskC[i];
      lExp += w * a.x; lCon += w * a.y; lHi += w * a.z; lSh += w * a.w;
      lWh += w * b.x; lBl += w * b.y; lTemp += w * b.z; lTint += w * b.w;
      lSat += w * c.x; lCla += w * c.y; lDeh += w * c.z; lTex += w * c.w;
    }
    if (lTemp != 0.0 || lTint != 0.0) {
      rgb *= vec3(exp2(0.35 * lTemp + 0.15 * lTint), exp2(-0.25 * lTint), exp2(-0.35 * lTemp + 0.15 * lTint));
    }
  }

  // ---------------- dehaze (scene-linear) ----------------
  float dehaze = clamp(uDehaze + lDeh, -1.0, 1.0);
  vec4 ctxL = texture(uCtxLarge, suv);
  if (dehaze != 0.0) {
    float A = uAirlight;
    if (dehaze > 0.0) {
      float haze = clamp(ctxL.g / A, 0.0, 0.95);
      float t = max(1.0 - dehaze * 0.9 * haze, 0.15);
      rgb = max((rgb - A * (1.0 - t)) / t, vec3(0.0));
    } else {
      rgb = mix(rgb, vec3(A * 0.9), -dehaze * 0.45);
    }
  }

  // ---------------- exposure ----------------
  float ev = uExposure + lExp;
  rgb *= exp2(ev);

  // ---------------- highlights / shadows / clarity / texture (log luma domain) ----------------
  float Y = luma(rgb);
  float L = log2(Y + 1e-5);
  // Edge-preserving local base (self-guided filter): in flat areas use the
  // blurred neighbourhood, near strong edges fall back to the pixel itself so
  // highlight/shadow changes don't leave halos.
  float var = max(ctxL.b - ctxL.r * ctxL.r, 0.0);
  float ga = var / (var + 0.3);
  float b = ga * L + (1.0 - ga) * (ctxL.r + ev);
  b = mix(b, L, smoothstep(1.5, 3.0, abs(L - b)));
  float sh = clamp(uShadows + lSh, -1.0, 1.0);
  float hi = clamp(uHighlights + lHi, -1.0, 1.0);
  float ws = 1.0 - smoothstep(-6.5, -1.5, b);
  float wh = smoothstep(-2.8, 0.4, b);
  float gain = sh * (sh > 0.0 ? 2.4 : 1.6) * ws + hi * (hi < 0.0 ? 1.7 : 1.0) * wh;
  float cla = clamp(uClarity + lCla, -1.0, 1.0);
  if (cla != 0.0) {
    float Lmid = texture(uCtxMid, suv).r + ev;
    float detail = clamp(L - Lmid, -3.0, 3.0);
    float wm = exp(-pow((b + 2.4) / 2.6, 2.0));
    gain += cla * 0.6 * detail * mix(0.35, 1.0, wm);
  }
  float tex = clamp(uTexture + lTex, -1.0, 1.0);
  if (tex != 0.0) {
    float Ls = texture(uSmall, vUv).r + ev;
    gain += tex * 0.9 * clamp(L - Ls, -2.0, 2.0);
  }
  rgb *= exp2(gain);

  // ---------------- base rendering for raw files: highlight shoulder ----------------
  if (uIsRaw) {
    float m = max3(rgb);
    const float knee = 0.72;
    if (m > knee) {
      float mm = knee + (1.0 - knee) * (1.0 - exp(-(m - knee) / (1.0 - knee)));
      rgb *= mm / m;
      // desaturate towards white as we approach the top
      float t = smoothstep(0.85, 1.0, mm);
      rgb = mix(rgb, vec3(luma(rgb)), t * 0.6);
    }
  }

  // ---------------- to display gamma ----------------
  vec3 g = srgbEnc(max(rgb, vec3(0.0)));

  // whites / blacks
  float wht = clamp(uWhites + lWh, -1.0, 1.0);
  float blk = clamp(uBlacks + lBl, -1.0, 1.0);
  if (wht != 0.0) g *= 1.0 + wht * 0.3 * smoothstep(0.45, 1.0, luma(g));
  if (blk != 0.0) g += blk * 0.07 * (1.0 - smoothstep(0.0, 0.35, luma(g)));

  // contrast
  float con = clamp(uContrast + lCon, -1.0, 1.0);
  float k = exp2(con * 0.85) * (uIsRaw ? 1.18 : 1.0);
  if (k != 1.0) g = vec3(contrastCurve(g.r, k), contrastCurve(g.g, k), contrastCurve(g.b, k));

  // tone curve
  if (uCurveOn) g = vec3(curveLookup(g.r, 0), curveLookup(g.g, 1), curveLookup(g.b, 2));

  // ---------------- color mixer / B&W ----------------
  vec3 hsv = rgb2hsv(max(g, vec3(0.0)));
  float hue = hsv.x * 360.0;
  int i0, i1;
  float w1;
  bandWeights(hue, i0, i1, w1);
  float w0 = 1.0 - w1;
  float chromaW = smoothstep(0.0, 0.18, hsv.y);
  if (uBW) {
    float mixv = (w0 * uBwMix[i0] + w1 * uBwMix[i1]) * hsv.y;
    float gray = luma(g) * max(0.0, 1.0 + 0.9 * mixv);
    g = vec3(gray);
  } else if (uHslOn) {
    float hs = w0 * uHslHue[i0] + w1 * uHslHue[i1];
    float ss = w0 * uHslSat[i0] + w1 * uHslSat[i1];
    float ls = w0 * uHslLum[i0] + w1 * uHslLum[i1];
    vec3 h2 = hsv;
    h2.x = fract(h2.x + hs * chromaW * (30.0 / 360.0) + 1.0);
    h2.y = clamp(h2.y * max(0.0, 1.0 + ss * chromaW), 0.0, 1.0);
    vec3 g2 = hsv2rgb(h2);
    g2 *= exp2(ls * 0.9 * chromaW * hsv.y);
    g = g2;
  }

  // ---------------- color grading ----------------
  if (uGradeOn) {
    float yl = clamp(luma(g) - uGradeParams.y * 0.25, 0.0, 1.0);
    float p = uGradeParams.x;
    float gs = pow(1.0 - yl, p);
    float gh = pow(yl, p);
    float gm = max(0.0, 1.0 - gs - gh);
    vec4 tint = gs * uGradeS + gm * uGradeM + gh * uGradeH + uGradeG;
    g += tint.rgb + tint.a * 0.2;
  }

  // ---------------- vibrance / saturation ----------------
  float sat = clamp(uSaturation + lSat, -1.0, 1.0);
  if (uVibrance != 0.0 || sat != 0.0) {
    float yv = luma(g);
    float mx = max3(g);
    float s = mx > 1e-4 ? (mx - min3(g)) / mx : 0.0;
    float skin = smoothstep(5.0, 20.0, hue) * (1.0 - smoothstep(40.0, 60.0, hue));
    float vf = uVibrance > 0.0 ? 1.0 + uVibrance * (1.0 - s) * (1.0 - s) * (1.0 - 0.5 * skin) : 1.0 + uVibrance * 0.8;
    float f = max(0.0, vf * (1.0 + sat));
    g = yv + (g - yv) * f;
  }

  outColor = vec4(g, 1.0);
}`;

/** Final pass: geometry, sharpening, effects, output transform, overlays. */
export const FINAL_FRAG = HEADER + /* glsl */ `
uniform sampler2D uDev;
uniform vec4 uDevRegion;
uniform vec2 uDevSize;
uniform sampler2D uDetail;
uniform vec4 uDetailRegion;
uniform vec4 uDetailSafe;
uniform vec2 uDetailSize;
uniform bool uHasDetail;
uniform sampler2DArray uMasks;
uniform vec2 uFrame;
uniform vec4 uCrop;
uniform float uAngle;
uniform int uRot;
uniform bvec2 uFlip;
uniform vec2 uViewOrigin;
uniform float uViewScale;
uniform vec2 uCropPx;
uniform float uTargetH;
uniform bool uFlipY;
uniform float uDistortion;
uniform float uCaR;
uniform float uCaB;
uniform vec4 uSharp;
uniform vec4 uVig;
uniform vec3 uGrain;
uniform mat3 uProToOut;
uniform int uOutTRC;
uniform bool uShowClip;
uniform int uOverlayMask;
uniform bool uOverlayInvert;
uniform vec3 uBg;
uniform bool uDither;
uniform bool uEncode;

vec2 cropToSource(vec2 cuv) {
  vec2 p = uCrop.xy + cuv * uCrop.zw;
  vec2 P = (p - 0.5) * uFrame;
  float c = cos(uAngle), s = sin(uAngle);
  vec2 F = vec2(c * P.x + s * P.y, -s * P.x + c * P.y);
  vec2 fuv = F / uFrame + 0.5;
  if (uDistortion != 0.0) {
    vec2 d = (fuv - 0.5) * uFrame;
    float r2 = dot(d, d) / dot(uFrame * 0.5, uFrame * 0.5);
    fuv = 0.5 + (fuv - 0.5) * (1.0 + uDistortion * r2);
  }
  if (uFlip.x) fuv.x = 1.0 - fuv.x;
  if (uFlip.y) fuv.y = 1.0 - fuv.y;
  if (uRot == 1) return vec2(fuv.y, 1.0 - fuv.x);
  if (uRot == 2) return 1.0 - fuv;
  if (uRot == 3) return vec2(1.0 - fuv.y, fuv.x);
  return fuv;
}

bool useDetail(vec2 suv) {
  return uHasDetail && suv.x >= uDetailSafe.x && suv.y >= uDetailSafe.y && suv.x <= uDetailSafe.z && suv.y <= uDetailSafe.w;
}

vec3 sampleAt(vec2 suv, bool detail) {
  if (detail) return texture(uDetail, (suv - uDetailRegion.xy) / uDetailRegion.zw).rgb;
  return texture(uDev, (suv - uDevRegion.xy) / uDevRegion.zw).rgb;
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

void main() {
  vec2 px = gl_FragCoord.xy;
  if (uFlipY) px.y = uTargetH - px.y;
  vec2 cuv = (px - uViewOrigin) / uViewScale / uCropPx;
  if (cuv.x < 0.0 || cuv.y < 0.0 || cuv.x > 1.0 || cuv.y > 1.0) { outColor = vec4(uBg, 1.0); return; }
  vec2 suv = cropToSource(cuv);
  if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) { outColor = vec4(uBg, 1.0); return; }

  bool det = useDetail(suv);
  vec3 g = sampleAt(suv, det);
  if (uCaR != 0.0 || uCaB != 0.0) {
    g.r = sampleAt(0.5 + (suv - 0.5) * (1.0 + uCaR), det).r;
    g.b = sampleAt(0.5 + (suv - 0.5) * (1.0 + uCaB), det).b;
  }

  // sharpening (luminance unsharp mask): uSharp = amount, radius(px), detail, masking
  if (uSharp.x > 0.0) {
    vec4 region = det ? uDetailRegion : uDevRegion;
    vec2 size = det ? uDetailSize : uDevSize;
    vec2 t = region.zw / size * uSharp.y;
    float l0 = luma(g);
    float n = luma(sampleAt(suv + vec2(0.0, -t.y), det));
    float s = luma(sampleAt(suv + vec2(0.0, t.y), det));
    float e = luma(sampleAt(suv + vec2(t.x, 0.0), det));
    float w = luma(sampleAt(suv + vec2(-t.x, 0.0), det));
    float ne = luma(sampleAt(suv + vec2(t.x, -t.y), det));
    float nw = luma(sampleAt(suv + vec2(-t.x, -t.y), det));
    float se = luma(sampleAt(suv + vec2(t.x, t.y), det));
    float sw = luma(sampleAt(suv + vec2(-t.x, t.y), det));
    float blur = (4.0 * l0 + 2.0 * (n + s + e + w) + (ne + nw + se + sw)) / 16.0;
    float d = l0 - blur;
    float lim = mix(0.015, 0.25, uSharp.z);
    d = clamp(d, -lim, lim);
    float grad = abs(e - w) + abs(n - s);
    float m = uSharp.w > 0.0 ? smoothstep(uSharp.w * 0.12, uSharp.w * 0.12 + 0.04, grad) : 1.0;
    g += uSharp.x * 2.2 * d * m;
  }

  // post-crop vignette: uVig = amount, midpoint, roundness, feather
  if (uVig.x != 0.0) {
    float aspect = uCropPx.x / uCropPx.y;
    vec2 q = (cuv - 0.5) * 2.0;
    vec2 qc = vec2(q.x * aspect, q.y) / max(aspect, 1.0);
    float rnd = uVig.z;
    vec2 qq = mix(q, qc, max(rnd, 0.0));
    float pw = mix(2.0, 8.0, max(-rnd, 0.0));
    float d = pow(pow(abs(qq.x), pw) + pow(abs(qq.y), pw), 1.0 / pw);
    float start = mix(0.15, 1.25, uVig.y);
    float width = mix(0.08, 1.4, uVig.w);
    float v = smoothstep(start, start + width, d);
    if (uVig.x < 0.0) g *= 1.0 + uVig.x * v;
    else g = mix(g, vec3(1.0), uVig.x * v * 0.85);
  }

  // grain: uGrain = amount, cell size (fraction of long edge), roughness
  if (uGrain.x > 0.0) {
    float longEdge = max(uCropPx.x, uCropPx.y);
    vec2 gp = cuv * uCropPx / longEdge / uGrain.y;
    float n1 = vnoise(gp);
    float n2 = vnoise(gp * 2.7 + 17.0);
    float n = mix(n1, 0.55 * n1 + 0.45 * n2, uGrain.z) - 0.5;
    float lg = luma(g);
    g += n * uGrain.x * 0.32 * (1.0 - pow(abs(2.0 * clamp(lg, 0.0, 1.0) - 1.0), 2.0) * 0.7);
  }

  vec3 lin = srgbDec(max(g, vec3(0.0)));
  vec3 o = uProToOut * lin;
  bool hiClip = max3(o) >= 0.999;
  bool loClip = max3(o) <= 0.0015;
  o = clamp(o, 0.0, 1.0);
  if (uEncode) {
    if (uOutTRC == 1) o = pow(o, vec3(1.0 / 1.8));
    else o = srgbEnc(o);
  }
  if (uShowClip) {
    if (hiClip) o = vec3(1.0, 0.1, 0.1);
    else if (loClip) o = vec3(0.15, 0.35, 1.0);
  }
  if (uOverlayMask >= 0) {
    float w = texture(uMasks, vec3(suv, float(uOverlayMask))).r;
    if (uOverlayInvert) w = 1.0 - w;
    o = mix(o, vec3(1.0, 0.2, 0.25), w * 0.55);
  }
  if (uDither) o += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(o, 1.0);
}`;
