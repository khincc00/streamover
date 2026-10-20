// Perspektif 3D untuk overlay. Nilainya datang dari URL (rx, ry, pd), jadi OBS dan pratinjau di panel sama.
export const PERSPECTIVE_LIMITS = {
  tilt: { min: -60, max: 60 },
  depth: { min: 300, max: 3000 },
};

export const DEFAULT_PERSPECTIVE = { rx: 0, ry: 0, depth: 1200 };

const clamp = (value, { min, max }) => Math.min(max, Math.max(min, value));

export function perspectiveFromParams(params) {
  return {
    rx: clamp(Number(params.get('rx')) || 0, PERSPECTIVE_LIMITS.tilt),
    ry: clamp(Number(params.get('ry')) || 0, PERSPECTIVE_LIMITS.tilt),
    depth: clamp(Number(params.get('pd')) || DEFAULT_PERSPECTIVE.depth, PERSPECTIVE_LIMITS.depth),
  };
}

// Without tilt the element is left flat, so the default overlay looks exactly as before.
export function applyPerspective(target, { rx, ry, depth }) {
  if (!rx && !ry) return;
  target.style.transformOrigin = '50% 50%';
  target.style.transform = `perspective(${depth}px) rotateX(${rx}deg) rotateY(${ry}deg)`;
}
