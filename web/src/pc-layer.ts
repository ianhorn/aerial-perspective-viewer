// The point cloud on the map: a MapLibre custom layer that draws every point as a coloured dot with WebGL, and a line layer for the
// outlines of the areas loaded. Points are coloured by height along the ramp in `pc-ramp.ts`. Positions arrive relative to a per-load
// origin (see `pc-decode.ts`); the layer folds that origin into the matrix in double precision, so points do not jitter when zoomed in.

import type { CustomLayerInterface, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { Chunk } from './pc-decode.ts';
import type { LonLat } from './pc-aoi.ts';
import { RAMP } from './pc-ramp.ts';
import { lonLatToMercator, metreInMercator } from './pc-warp.ts';
import { chunkId, type Sink } from './pc-session.ts';

const FEET_TO_METRES = 0.3048006096;
/**
 * The vertex shader. For the depth shading (`targets`) it also works out how far the camera's distance to the ground changes across a pixel, at this point:
 * each dot is then given the depth of a small patch of ground under it, tilted as the ground is, and not one flat depth. Without that the dots of smooth
 * ground would show as steps from one to the next, and the shading would draw every dot's rim.
 */
const vertexSource = (targets: boolean): string => `#version 300 es
${targets ? '#define TARGETS' : ''}
uniform mat4 u_matrix;
uniform float u_zMin;
uniform float u_zMax;
uniform float u_zRef;
uniform float u_zScale;
uniform float u_wRef;
uniform float u_size;
uniform vec2 u_viewport;
uniform float u_gradStep;
in vec3 a_pos;
out float v_t;
out float v_w;
#ifdef TARGETS
out vec2 v_gradW;
out float v_size;
#endif
void main() {
  // Height above the lowest ground of what is loaded, in Web Mercator units (zero when the cloud is flat on the map). Measured from that
  // ground and not from the sea: a point drawn 130 m up would be magnified by the camera's perspective and drift off the imagery under it.
  float up = (a_pos.z - u_zRef) * u_zScale;
  vec4 clip = u_matrix * vec4(a_pos.xy, up, 1.0);
  gl_Position = clip;
  // The dot is u_size pixels at the middle of the view and gets smaller with distance (and larger when near) as the ground does when tilted.
  gl_PointSize = clamp(u_size * u_wRef / clip.w, 1.0, 40.0);
  v_t = clamp((a_pos.z - u_zMin) / (u_zMax - u_zMin), 0.0, 1.0);
  v_w = clip.w;
#ifdef TARGETS
  // Move a little east and a little north on the ground (about a pixel each) and see where that lands on the screen and how much w changes: from
  // those, how much w changes for a pixel right and a pixel up the screen.
  vec4 cx = u_matrix * vec4(a_pos.xy + vec2(u_gradStep, 0.0), up, 1.0);
  vec4 cy = u_matrix * vec4(a_pos.xy + vec2(0.0, u_gradStep), up, 1.0);
  vec2 s0 = clip.xy / clip.w * 0.5 * u_viewport;
  vec2 sx = cx.xy / cx.w * 0.5 * u_viewport - s0;
  vec2 sy = cy.xy / cy.w * 0.5 * u_viewport - s0;
  float det = sx.x * sy.y - sx.y * sy.x;
  float wx = cx.w - clip.w;
  float wy = cy.w - clip.w;
  v_gradW = abs(det) > 1e-6 ? vec2(sy.y * wx - sx.y * wy, -sy.x * wx + sx.x * wy) / det : vec2(0.0);
  v_size = gl_PointSize;
#endif
}`;
const VERTEX = vertexSource(false);
const VERTEX_TARGETS = vertexSource(true);
const RAMP_FRAGMENT = `
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25) discard;
  float x = v_t * 4.0;
  int i = int(min(floor(x), 3.0));
  vec3 colour = mix(u_ramp[i], u_ramp[i + 1], x - float(i));`;
const FRAGMENT = `#version 300 es
precision mediump float;
uniform vec3 u_ramp[5];
in float v_t;
in float v_w;
out vec4 outColor;
void main() {${RAMP_FRAGMENT}
  outColor = vec4(colour, 1.0);
}`;
// The same, drawing into two targets for the depth shading: the colour, and how far from the camera the point is (log2 of w, so that a step in depth
// is the same size near and far).
const FRAGMENT_TARGETS = `#version 300 es
precision highp float;
uniform vec3 u_ramp[5];
in float v_t;
in float v_w;
in vec2 v_gradW;
in float v_size;
layout(location = 0) out vec4 outColor;
layout(location = 1) out float outDepth;
void main() {${RAMP_FRAGMENT}
  outColor = vec4(colour, 1.0);
  // The depth of the ground patch under the dot at this pixel (the point's own w, changed by how far this pixel is from the middle of the dot).
  vec2 offset = (gl_PointCoord - 0.5) * v_size * vec2(1.0, -1.0);
  outDepth = log2(max(v_w + dot(v_gradW, offset), 1e-9));
}`;
// A triangle that covers the screen, and the shading: eye-dome lighting. A pixel is darkened by how much nearer its neighbours are, so the ground beside
// a building or under a tree is shaded and the edges of things stand out, however the points are coloured.
const QUAD_VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const QUAD_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_colour;
uniform sampler2D u_depth;
uniform vec2 u_texel;
uniform float u_strength;
uniform float u_radius;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec4 c = texture(u_colour, v_uv);
  if (c.a == 0.0) { outColor = vec4(0.0); return; }
  float d0 = texture(u_depth, v_uv).r;
  vec2 step = u_texel * u_radius;
  // Along each axis: how much nearer the two neighbours are than this pixel, added. On a flat slope one is nearer by as much as the other is farther, and
  // that adds to nothing; at the foot of a step (a wall, a tree) one is nearer and the other is level, and it adds to the step. A neighbour with no point
  // in it counts as level. Only a pixel that is farther than its neighbours' average is darkened.
  float sum = 0.0;
  for (int axis = 0; axis < 2; axis++) {
    vec2 o = axis == 0 ? vec2(step.x, 0.0) : vec2(0.0, step.y);
    float a = texture(u_colour, v_uv + o).a > 0.0 ? d0 - texture(u_depth, v_uv + o).r : 0.0;
    float b = texture(u_colour, v_uv - o).a > 0.0 ? d0 - texture(u_depth, v_uv - o).r : 0.0;
    sum += max(0.0, a + b);
  }
  float shade = exp(-(sum / 2.0) * 700.0 * u_strength);
  outColor = vec4(c.rgb * shade, c.a);
}`;

const UNIFORMS = ['u_matrix', 'u_zMin', 'u_zMax', 'u_zRef', 'u_zScale', 'u_wRef', 'u_size', 'u_ramp', 'u_viewport', 'u_gradStep'];

/** The colour and depth of the points, drawn off screen for the shading. */
interface Target { fbo: WebGLFramebuffer; colour: WebGLTexture; depth: WebGLTexture; renderbuffer: WebGLRenderbuffer; width: number; height: number }

interface Drawn { id: string; chunk: Pick<Chunk, 'origin' | 'count' | 'spacingFt'>; buffer: WebGLBuffer }

export class PointCloudLayer implements CustomLayerInterface {
  readonly id = 'pointcloud';
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;
  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  /** Drawn straight to the map; drawn into `target` for the shading; and the pass that puts `target` on the map, shaded. */
  private program: WebGLProgram | null = null;
  private targetsProgram: WebGLProgram | null = null;
  private quadProgram: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private targetUniforms: Record<string, WebGLUniformLocation | null> = {};
  private quadUniforms: Record<string, WebGLUniformLocation | null> = {};
  private target: Target | null = null;
  /** Whether this frame's points were drawn into `target` (by `prerender`) and only the shading is left for `render`. */
  private shadedThisFrame = false;
  /** The strength of the depth shading, 0 for none; and whether the graphics card can do it (it needs float textures to draw into). */
  private shading = 0;
  private canShade = false;
  private drawn: Drawn[] = [];
  /** Chunks that arrived before the layer had a GL context (or after it was lost) and have not been uploaded. */
  private pending: Chunk[] = [];
  private range: [number, number] = [0, 1];
  /** How big a dot is against the gap between points, and the biggest it may be on the screen (pixels). */
  private sizeScale = 1.15;
  private maxSizePx = 14;
  /** Whether points stand up at their height (true) or lie flat on the map (false), and how much the height is stretched. */
  private threeD = true;
  private exaggeration = 1;

  get pointCount(): number {
    return this.drawn.reduce((s, d) => s + d.chunk.count, 0) + this.pending.reduce((s, c) => s + c.count, 0);
  }

  /** How the dots look: their size against the spacing of the points, and the biggest they may be. */
  setLook(sizeScale: number, maxSizePx: number): void {
    this.sizeScale = sizeScale;
    this.maxSizePx = maxSizePx;
    this.map?.triggerRepaint();
  }

  /** The depth shading: 0 for none, and up from there for stronger. It is left off on a graphics card that cannot do it. */
  setShading(strength: number): void {
    this.shading = strength;
    this.map?.triggerRepaint();
  }

  /** Whether the depth shading is being drawn. */
  get shaded(): boolean {
    return this.canShade && this.shading > 0;
  }

  /** Show the cloud in 3D, its points standing up at their height above the lowest ground loaded (stretched by `exaggeration`), or flat on the map. */
  setHeight(threeD: boolean, exaggeration = 1): void {
    this.threeD = threeD;
    this.exaggeration = exaggeration;
    this.map?.triggerRepaint();
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
    const link = (vertex: string, fragment: string): WebGLProgram => {
      const program = gl.createProgram()!;
      gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`point cloud program: ${gl.getProgramInfoLog(program)}`);
      return program;
    };
    const locate = (program: WebGLProgram, names: readonly string[]): Record<string, WebGLUniformLocation | null> =>
      Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(program, n)]));
    this.program = link(VERTEX, FRAGMENT);
    this.uniforms = locate(this.program, UNIFORMS);
    // Depth shading needs to draw into a float texture; without that extension the cloud is drawn plainly.
    this.canShade = gl.getExtension('EXT_color_buffer_float') !== null;
    if (this.canShade) {
      try {
        this.targetsProgram = link(VERTEX_TARGETS, FRAGMENT_TARGETS);
        this.targetUniforms = locate(this.targetsProgram, UNIFORMS);
        this.quadProgram = link(QUAD_VERTEX, QUAD_FRAGMENT);
        this.quadUniforms = locate(this.quadProgram, ['u_colour', 'u_depth', 'u_texel', 'u_strength', 'u_radius']);
      } catch (error) {
        console.warn('the point cloud depth shading is not available', error);
        this.canShade = false;
      }
    }
    this.vao = gl.createVertexArray();
    const queued = this.pending;
    this.pending = [];
    for (const chunk of queued) this.upload(chunk);
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    for (const d of this.drawn) gl.deleteBuffer(d.buffer);
    this.drawn = [];
    for (const p of [this.program, this.targetsProgram, this.quadProgram]) if (p) gl.deleteProgram(p);
    this.freeTarget(gl);
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.program = this.targetsProgram = this.quadProgram = null;
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
    this.drawn.push({ id: chunkId(chunk), chunk: { origin: chunk.origin, count: chunk.count, spacingFt: chunk.spacingFt }, buffer });
    // The finest points are drawn last so they lie over the coarse ones' larger dots.
    this.drawn.sort((a, b) => b.chunk.spacingFt - a.chunk.spacingFt);
  }

  /** Take blocks off the map, by id. */
  remove(ids: readonly string[]): void {
    const gone = new Set(ids);
    if (this.gl) for (const d of this.drawn) if (gone.has(d.id)) this.gl.deleteBuffer(d.buffer);
    this.drawn = this.drawn.filter((d) => !gone.has(d.id));
    this.pending = this.pending.filter((c) => !gone.has(chunkId(c)));
    this.map?.triggerRepaint();
  }

  clear(): void {
    if (this.gl) for (const d of this.drawn) this.gl.deleteBuffer(d.buffer);
    this.drawn = [];
    this.pending = [];
    this.map?.triggerRepaint();
  }

  /** The off-screen colour and depth textures, made to the size of the map's drawing buffer (and made again if that changes). Null if they cannot be made. */
  private ensureTarget(gl: WebGL2RenderingContext): Target | null {
    const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    if (this.target && this.target.width === width && this.target.height === height) return this.target;
    this.freeTarget(gl);
    const texture = (internal: number, format: number, type: number): WebGLTexture => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const colour = texture(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    const depth = texture(gl.R32F, gl.RED, gl.FLOAT);
    const renderbuffer = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    const fbo = gl.createFramebuffer()!;
    const before = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colour, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, depth, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, renderbuffer);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, before);
    this.target = { fbo, colour, depth, renderbuffer, width, height };
    if (!complete) {
      console.warn('the point cloud depth shading is not available: the off-screen buffer is incomplete');
      this.freeTarget(gl);
      this.canShade = false;
      return null;
    }
    return this.target;
  }

  private freeTarget(gl: WebGL2RenderingContext): void {
    if (!this.target) return;
    gl.deleteFramebuffer(this.target.fbo);
    gl.deleteTexture(this.target.colour);
    gl.deleteTexture(this.target.depth);
    gl.deleteRenderbuffer(this.target.renderbuffer);
    this.target = null;
  }

  /** Draw every block of points with a program (the plain one, or the one that also writes depth). */
  private drawPoints(gl: WebGL2RenderingContext, program: WebGLProgram, uniforms: Record<string, WebGLUniformLocation | null>, mvp: ArrayLike<number>): void {
    const map = this.map!;
    gl.useProgram(program);
    gl.bindVertexArray(this.vao);
    gl.uniform1f(uniforms['u_zMin']!, this.range[0]);
    gl.uniform1f(uniforms['u_zMax']!, this.range[1]);
    gl.uniform3fv(uniforms['u_ramp']!, new Float32Array(RAMP.flatMap((c) => [c[0] / 255, c[1] / 255, c[2] / 255])));
    const centre = map.getCenter();
    const lat = centre.lat;
    // The lowest ground is the bottom of the colour range; the height above it is stretched by the exaggeration, in Web Mercator units.
    gl.uniform1f(uniforms['u_zRef']!, this.range[0]);
    gl.uniform1f(uniforms['u_zScale']!, this.threeD ? FEET_TO_METRES * metreInMercator(lat) * this.exaggeration : 0);
    // The w that the middle of the view (at the lowest ground) has: dots are their nominal size there.
    const [cx, cy] = lonLatToMercator(centre.lng, lat);
    gl.uniform1f(uniforms['u_wRef']!, mvp[3]! * cx + mvp[7]! * cy + mvp[15]!);
    // Points stand up in front of each other, so nearer ones must hide farther ones.
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    // Metres a screen pixel covers at the map's centre (MapLibre's zoom counts 512 px tiles).
    const metresPerPixel = (78271.51696 * Math.cos((lat * Math.PI) / 180)) / 2 ** map.getZoom();
    const dpr = window.devicePixelRatio || 1;
    // For the depth of a dot's patch of ground: the size of the screen, and a step on the ground of about a pixel (in Web Mercator units).
    gl.uniform2f(uniforms['u_viewport']!, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(uniforms['u_gradStep']!, (metresPerPixel / dpr) * metreInMercator(lat));
    const matrix = new Float32Array(16);
    for (const d of this.drawn) {
      // The origin is folded into the matrix in double precision: matrix = mvp * translate(origin).
      const [ox, oy] = d.chunk.origin;
      for (let i = 0; i < 16; i++) matrix[i] = mvp[i]!;
      for (let r = 0; r < 4; r++) matrix[12 + r] = mvp[12 + r]! + mvp[r]! * ox + mvp[4 + r]! * oy;
      gl.uniformMatrix4fv(uniforms['u_matrix']!, false, matrix);
      // A dot is a bit wider than the spacing of its points, so the ground is covered, but never a speck or a blob.
      const px = Math.min(Math.max(((d.chunk.spacingFt * FEET_TO_METRES) / metresPerPixel) * this.sizeScale, 1.6), this.maxSizePx) * dpr;
      gl.uniform1f(uniforms['u_size']!, px);
      gl.bindBuffer(gl.ARRAY_BUFFER, d.buffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
      gl.drawArrays(gl.POINTS, 0, d.chunk.count);
    }
    gl.bindVertexArray(null);
  }

  /** With the depth shading on, the points are drawn here into off-screen textures (colour and depth), and `render` puts them on the map shaded. */
  prerender(gl: WebGL2RenderingContext, args: { defaultProjectionData: { mainMatrix: ArrayLike<number> } }): void {
    this.shadedThisFrame = false;
    if (!this.shaded || !this.targetsProgram || this.drawn.length === 0 || !this.map) return;
    const target = this.ensureTarget(gl);
    if (!target) return;
    const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.width, target.height);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.DEPTH, 0, [1]);
    this.drawPoints(gl, this.targetsProgram, this.targetUniforms, args.defaultProjectionData.mainMatrix);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(viewport[0]!, viewport[1]!, viewport[2]!, viewport[3]!);
    this.shadedThisFrame = true;
  }

  render(gl: WebGL2RenderingContext, args: { defaultProjectionData: { mainMatrix: ArrayLike<number> } }): void {
    if (!this.program || this.drawn.length === 0 || !this.map) return;
    // MapLibre 6 hands over two matrices: `modelViewProjectionMatrix` takes world-pixel coordinates, and `defaultProjectionData.mainMatrix` takes
    // Web Mercator units (0 to 1 round the world), which is what positions here are in. Both are in double precision.
    if (!this.shadedThisFrame || !this.target || !this.quadProgram) {
      this.drawPoints(gl, this.program, this.uniforms, args.defaultProjectionData.mainMatrix);
      return;
    }
    // Put the off-screen picture on the map, shaded by how much nearer each pixel's neighbours are.
    const target = this.target;
    gl.useProgram(this.quadProgram);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.colour);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, target.depth);
    gl.uniform1i(this.quadUniforms['u_colour']!, 0);
    gl.uniform1i(this.quadUniforms['u_depth']!, 1);
    gl.uniform2f(this.quadUniforms['u_texel']!, 1 / target.width, 1 / target.height);
    gl.uniform1f(this.quadUniforms['u_strength']!, this.shading);
    gl.uniform1f(this.quadUniforms['u_radius']!, 1.5);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // the shaded colour is not premultiplied by alpha, but alpha is 1 wherever there is a point
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
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

  remove(ids: readonly string[]): void {
    this.layer.remove(ids);
  }

  setHeight(threeD: boolean, exaggeration: number): void {
    this.layer.setHeight(threeD, exaggeration);
  }

  setLook(sizeScale: number, maxSizePx: number): void {
    this.layer.setLook(sizeScale, maxSizePx);
  }

  setShading(strength: number): void {
    this.layer.setShading(strength);
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
