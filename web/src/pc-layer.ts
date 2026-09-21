// The point cloud on the map: a MapLibre custom layer that draws every point as a coloured dot with WebGL, and a line layer for the
// outlines of the areas loaded. Points are coloured by height along the ramp in `pc-ramp.ts`. Positions arrive relative to a per-load
// origin (see `pc-decode.ts`); the layer folds that origin into the matrix in double precision, so points do not jitter when zoomed in.

import type { CustomLayerInterface, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { Chunk } from './pc-decode.ts';
import type { LonLat } from './pc-aoi.ts';
import { RAMP } from './pc-ramp.ts';
import type { Sink } from './pc-session.ts';

const FEET_TO_METRES = 0.3048006096;
const VERTEX = `#version 300 es
uniform mat4 u_matrix;
uniform float u_zMin;
uniform float u_zMax;
uniform float u_size;
in vec3 a_pos;
out float v_t;
void main() {
  // Flat on the map: a point drawn at its real height (about 130 m up) would be magnified by the camera's perspective and drift off the
  // imagery under it, more the closer the map is zoomed. Height is only used for the colour.
  gl_Position = u_matrix * vec4(a_pos.xy, 0.0, 1.0);
  gl_PointSize = u_size;
  v_t = clamp((a_pos.z - u_zMin) / (u_zMax - u_zMin), 0.0, 1.0);
}`;
const FRAGMENT = `#version 300 es
precision mediump float;
uniform vec3 u_ramp[5];
in float v_t;
out vec4 outColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25) discard;
  float x = v_t * 4.0;
  int i = int(min(floor(x), 3.0));
  outColor = vec4(mix(u_ramp[i], u_ramp[i + 1], x - float(i)), 1.0);
}`;

interface Drawn { chunk: Pick<Chunk, 'origin' | 'count' | 'spacingFt'>; buffer: WebGLBuffer }

export class PointCloudLayer implements CustomLayerInterface {
  readonly id = 'pointcloud';
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;
  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private drawn: Drawn[] = [];
  /** Chunks that arrived before the layer had a GL context (or after it was lost) and have not been uploaded. */
  private pending: Chunk[] = [];
  private range: [number, number] = [0, 1];
  /** Draw the points as big as this many times their spacing, at most. */
  sizeScale = 1.15;

  get pointCount(): number {
    return this.drawn.reduce((s, d) => s + d.chunk.count, 0) + this.pending.reduce((s, c) => s + c.count, 0);
  }

  setRange(range: [number, number] | null): void {
    if (range) this.range = range;
    this.map?.triggerRepaint();
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`point cloud shader: ${gl.getShaderInfoLog(shader)}`);
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`point cloud program: ${gl.getProgramInfoLog(program)}`);
    this.program = program;
    for (const name of ['u_matrix', 'u_zMin', 'u_zMax', 'u_size', 'u_ramp']) this.uniforms[name] = gl.getUniformLocation(program, name);
    this.vao = gl.createVertexArray();
    const queued = this.pending;
    this.pending = [];
    for (const chunk of queued) this.upload(chunk);
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    for (const d of this.drawn) gl.deleteBuffer(d.buffer);
    this.drawn = [];
    if (this.program) gl.deleteProgram(this.program);
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.program = null;
    this.gl = null;
  }

  /** Put a block of points on the map. */
  add(chunk: Chunk): void {
    if (!this.gl) { this.pending.push(chunk); return; }
    this.upload(chunk);
    this.map?.triggerRepaint();
  }

  private upload(chunk: Chunk): void {
    const gl = this.gl!;
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, chunk.positions, gl.STATIC_DRAW);
    this.drawn.push({ chunk: { origin: chunk.origin, count: chunk.count, spacingFt: chunk.spacingFt }, buffer });
    // The finest points are drawn last so they lie over the coarse ones' larger dots.
    this.drawn.sort((a, b) => b.chunk.spacingFt - a.chunk.spacingFt);
  }

  clear(): void {
    if (this.gl) for (const d of this.drawn) this.gl.deleteBuffer(d.buffer);
    this.drawn = [];
    this.pending = [];
    this.map?.triggerRepaint();
  }

  render(gl: WebGL2RenderingContext, args: { defaultProjectionData: { mainMatrix: ArrayLike<number> } }): void {
    if (!this.program || this.drawn.length === 0 || !this.map) return;
    const map = this.map;
    // MapLibre 6 hands over two matrices: `modelViewProjectionMatrix` takes world-pixel coordinates, and `defaultProjectionData.mainMatrix` takes
    // Web Mercator units (0 to 1 round the world), which is what positions here are in. Both are in double precision.
    const mvp = args.defaultProjectionData.mainMatrix;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform1f(this.uniforms['u_zMin']!, this.range[0]);
    gl.uniform1f(this.uniforms['u_zMax']!, this.range[1]);
    gl.uniform3fv(this.uniforms['u_ramp']!, new Float32Array(RAMP.flatMap((c) => [c[0] / 255, c[1] / 255, c[2] / 255])));
    const lat = map.getCenter().lat;
    // Metres a screen pixel covers at the map's centre (MapLibre's zoom counts 512 px tiles).
    const metresPerPixel = (78271.51696 * Math.cos((lat * Math.PI) / 180)) / 2 ** map.getZoom();
    const dpr = window.devicePixelRatio || 1;
    const matrix = new Float32Array(16);
    for (const d of this.drawn) {
      // The origin is folded into the matrix in double precision: matrix = mvp * translate(origin).
      const [ox, oy] = d.chunk.origin;
      for (let i = 0; i < 16; i++) matrix[i] = mvp[i]!;
      for (let r = 0; r < 4; r++) matrix[12 + r] = mvp[12 + r]! + mvp[r]! * ox + mvp[4 + r]! * oy;
      gl.uniformMatrix4fv(this.uniforms['u_matrix']!, false, matrix);
      // A dot is a bit wider than the spacing of its points, so the ground is covered, but never a speck or a blob.
      const px = Math.min(Math.max(((d.chunk.spacingFt * FEET_TO_METRES) / metresPerPixel) * this.sizeScale, 1.6), 14) * dpr;
      gl.uniform1f(this.uniforms['u_size']!, px);
      gl.bindBuffer(gl.ARRAY_BUFFER, d.buffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
      gl.drawArrays(gl.POINTS, 0, d.chunk.count);
    }
    gl.bindVertexArray(null);
  }
}

const AREAS = 'pc-areas';
const PREVIEW = 'pc-preview';

/** The layer and the outlines together, as the sink a load writes to. */
export class PointCloudMap implements Sink {
  readonly layer = new PointCloudLayer();
  private map: MapLibreMap | null = null;

  /** Add the layers, under the footprint layers. Call once the style has loaded. */
  init(map: MapLibreMap, before: string): void {
    this.map = map;
    map.addSource(AREAS, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource(PREVIEW, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer(this.layer, before);
    map.addLayer({ id: 'pc-preview-fill', type: 'fill', source: PREVIEW, paint: { 'fill-color': '#ffb300', 'fill-opacity': 0.12 } }, before);
    map.addLayer({ id: 'pc-preview-line', type: 'line', source: PREVIEW, paint: { 'line-color': '#ffb300', 'line-width': 2, 'line-dasharray': [2.5, 2] } }, before);
    map.addLayer({ id: 'pc-areas-line', type: 'line', source: AREAS, layout: { 'line-join': 'round' }, paint: { 'line-color': ['case', ['get', 'active'], '#ffb300', '#ffffff'], 'line-width': ['case', ['get', 'active'], 2.5, 1.5], 'line-opacity': ['case', ['get', 'active'], 1, 0.7], 'line-dasharray': [3, 2] } }, before);
  }

  add(chunk: Chunk): void {
    this.layer.add(chunk);
  }

  clear(): void {
    this.layer.clear();
  }

  /** The rectangle being drawn. */
  setPreview(ring: LonLat[] | null): void {
    const source = this.map?.getSource<GeoJSONSource>(PREVIEW);
    if (!source) return;
    source.setData({ type: 'FeatureCollection', features: ring ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]!]] } }] : [] } as Parameters<GeoJSONSource['setData']>[0]);
  }

  setAreas(rings: readonly LonLat[][], active: LonLat[] | null): void {
    const source = this.map?.getSource<GeoJSONSource>(AREAS);
    if (!source) return;
    const feature = (ring: LonLat[], isActive: boolean) => ({ type: 'Feature', properties: { active: isActive }, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]!]] } });
    source.setData({ type: 'FeatureCollection', features: [...rings.map((r) => feature(r, false)), ...(active ? [feature(active, true)] : [])] } as Parameters<GeoJSONSource['setData']>[0]);
  }
}
