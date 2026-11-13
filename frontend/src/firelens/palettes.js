// Colour ramps for the burning calendar. "fire" is FireLens' own ramp; viridis and cividis are perceptually uniform
// and readable with the common forms of colour-vision deficiency (cividis is optimised for red–green deficiency).
// All three rise steadily in lightness, so low → high reads correctly even in greyscale or print.
export const PALETTES = {
  fire: { label: 'Fire', stops: [[0, [18, 26, 61]], [.18, [31, 43, 107]], [.35, [90, 42, 122]], [.5, [176, 40, 63]], [.65, [229, 64, 42]], [.8, [255, 122, 26]], [1, [255, 208, 74]]] },
  viridis: { label: 'Viridis · colour-blind safe', stops: [[0, [68, 1, 84]], [.17, [70, 50, 127]], [.33, [54, 92, 141]], [.5, [39, 127, 142]], [.67, [31, 161, 135]], [.83, [74, 194, 109]], [1, [253, 231, 37]]] },
  cividis: { label: 'Cividis · colour-blind safe', stops: [[0, [0, 32, 77]], [.17, [35, 62, 108]], [.33, [87, 92, 109]], [.5, [124, 123, 120]], [.67, [163, 156, 114]], [.83, [207, 191, 95]], [1, [255, 234, 70]]] },
};

export const rampOf = (stops, t) => {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i], k = (t - a) / (b - a);
      return 'rgb(' + ca.map((v, j) => Math.round(v + (cb[j] - v) * k)).join(',') + ')';
    }
  }
  return 'rgb(' + stops[stops.length - 1][1].join(',') + ')';
};

export const cssGradient = stops => 'linear-gradient(90deg,' + stops.map(([p, c]) => 'rgb(' + c.join(',') + ') ' + Math.round(p * 100) + '%').join(',') + ')';

// Values at evenly spaced positions of a log1p colour scale (for numeric legend ticks).
export const logTicks = (max, n = 5, lo = 0) => Array.from({ length: n }, (_, i) => Math.expm1(Math.log1p(lo) + i / (n - 1) * (Math.log1p(Math.max(1, max)) - Math.log1p(lo))));
